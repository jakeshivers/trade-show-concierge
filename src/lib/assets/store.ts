import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { NotFoundError } from '@/lib/shows/store';
import { canCountStock, canHandleAssets, canManageAssets, canReserveAssets } from './access';
import {
  buildAssetRow,
  offerAssets,
  orderAssets,
  summarizeAssets,
  type AssetBoardSummary,
  type AssetOption,
  type AssetRow,
} from './board';
import {
  planClashAlert,
  planReservationAlert,
  planStockAlert,
  planUnreconciledAlert,
  type PlannedAssetAlert,
} from './alerts';
import { findAssetClashes, type AssetClash } from './conflicts';
import {
  AssetError,
  describeReservationRelease,
  validateAllocation,
  validateAsset,
  validateCheckIn,
  validateCollateral,
  validateMovement,
  validateReservation,
  type AllocationDraft,
  type AssetDraft,
  type CheckInDraft,
  type CollateralDraft,
  type MovementDraft,
  type ReservationDraft,
} from './edit';
import type { FreightBounds, Reservation, TrackedAsset } from './custody';
import {
  allocationStanding,
  projectQuantity,
  reconcileAllocation,
  signOf,
  stockStanding,
  type Allocation,
  type CollateralItem,
  type StockStanding,
} from './inventory';
import {
  syncConditionAlerts,
  type AlertSyncResult,
  type AlertWrite,
} from '@/lib/alerts/store';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of assets. Org-scoped at the source, like every store since step
 * 8, and it decides nothing: every judgment came from `custody.ts`,
 * `conflicts.ts`, `inventory.ts`, `alerts.ts` or `board.ts` above it.
 *
 * Scoping is through the **asset's own org** rather than through a show, which
 * is a third posture beside `shipping/store.ts` (through the show) and
 * `flights/store.ts` (through the traveler), and it falls out of the domain
 * rather than being chosen: a booth belongs to the company between shows, which
 * is most of its life and all of the time it goes missing. A reservation is
 * scoped through the asset, and the show is checked separately — so a show id
 * from another workspace cannot reach an asset in this one, and vice versa.
 */

export function trackedAsset(row: typeof s.assets.$inferSelect): TrackedAsset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    assetTag: row.assetTag,
    condition: row.condition,
    storageLocation: row.storageLocation,
    purchaseValueCents: row.purchaseValueCents,
  };
}

export function reservationOf(row: typeof s.assetReservations.$inferSelect): Reservation {
  return {
    id: row.id,
    assetId: row.assetId,
    showId: row.showId,
    reservedFrom: row.reservedFrom,
    reservedTo: row.reservedTo,
    checkedOutAt: row.checkedOutAt,
    checkedOutById: row.checkedOutById,
    conditionOnCheckout: row.conditionOnCheckout,
    returnedAt: row.returnedAt,
    returnedById: row.returnedById,
    conditionOnReturn: row.conditionOnReturn,
  };
}

function itemOf(row: typeof s.collateralItems.$inferSelect): CollateralItem {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    quantityOnHand: row.quantityOnHand,
    lowStockThreshold: row.lowStockThreshold,
    unitCostCents: row.unitCostCents,
    storageLocation: row.storageLocation,
  };
}

function allocationOf(row: typeof s.collateralAllocations.$inferSelect): Allocation {
  return {
    id: row.id,
    itemId: row.collateralItemId,
    showId: row.showId,
    quantityAllocated: row.quantityAllocated,
    issuedAt: row.issuedAt,
    quantityReturned: row.quantityReturned,
    returnedAt: row.returnedAt,
  };
}

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');
  return show;
}

async function requireAsset(actor: Actor, assetId: string, db: Db) {
  const row = await db.query.assets.findFirst({
    where: and(eq(s.assets.id, assetId), eq(s.assets.orgId, actor.orgId)),
  });
  if (!row) throw new NotFoundError('asset');
  return row;
}

async function requireItem(actor: Actor, itemId: string, db: Db) {
  const row = await db.query.collateralItems.findFirst({
    where: and(eq(s.collateralItems.id, itemId), eq(s.collateralItems.orgId, actor.orgId)),
  });
  if (!row) throw new NotFoundError('collateral item');
  return row;
}

async function requireReservation(actor: Actor, reservationId: string, db: Db) {
  const [row] = await db
    .select({ reservation: s.assetReservations, asset: s.assets, show: s.shows })
    .from(s.assetReservations)
    .innerJoin(s.assets, eq(s.assetReservations.assetId, s.assets.id))
    .innerJoin(s.shows, eq(s.assetReservations.showId, s.shows.id))
    .where(and(eq(s.assetReservations.id, reservationId), eq(s.assets.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('reservation');
  return row;
}

/* ------------------------------ freight bounds ------------------------------ */

/**
 * When the asset is *actually* gone, read off the freight rather than guessed.
 *
 * §5g refused to prefill an advance-warehouse cutoff from move-in because a
 * date wrong by a fortnight looks right on every screen. The same refusal here
 * takes a different form: the reservation window is asked for, and this is what
 * it gets *checked against* afterwards. A show with no shipments produces two
 * nulls and `freightCoverage` returns `unverified` — not a pass.
 */
export async function freightBoundsFor(showIds: string[], db: Db): Promise<Map<string, FreightBounds>> {
  const out = new Map<string, FreightBounds>();
  if (showIds.length === 0) return out;
  const rows = await db
    .select()
    .from(s.shipments)
    .where(inArray(s.shipments.showId, showIds));
  for (const showId of showIds) out.set(showId, { outboundBy: null, homeBy: null });
  for (const r of rows) {
    const b = out.get(r.showId)!;
    if (r.direction === 'outbound') {
      const at = r.shippedAt ?? r.mustArriveBy;
      if (at && (!b.outboundBy || at < b.outboundBy)) b.outboundBy = at;
    } else {
      const at = r.deliveredAt ?? r.estimatedDelivery ?? r.mustArriveBy;
      if (at && (!b.homeBy || at > b.homeBy)) b.homeBy = at;
    }
  }
  return out;
}

/* -------------------------------- the board -------------------------------- */

export type AssetRegister = {
  rows: AssetRow[];
  summary: AssetBoardSummary;
  clashes: AssetClash[];
};

/**
 * How long a returned reservation stays on the workspace register.
 *
 * Long enough that checking a booth back in does not make the row vanish under
 * the hand that did it, short enough that last quarter's completed trips are not
 * what somebody reads first.
 */
export const REGISTER_CLOSED_OUT_DAYS = 30;

/**
 * Every asset, with its outstanding reservation if it has one, soonest first.
 *
 * An asset with nothing booked still gets a row — it is a thing we own, and
 * "where is the second booth" is a question about the ones nothing is happening
 * to. An asset with two outstanding reservations gets two, which is how a
 * double-booking is visible on the board rather than only in the clash list.
 */
export async function getAssetRegister(
  actor: Actor,
  opts: { showId?: string; asOf?: Date } = {},
  db: Db = getDb(),
): Promise<AssetRegister> {
  const asOf = opts.asOf ?? new Date();

  const assetRows = await db
    .select({ asset: s.assets, costCenter: s.costCenters })
    .from(s.assets)
    .leftJoin(s.costCenters, eq(s.assets.costCenterId, s.costCenters.id))
    .where(eq(s.assets.orgId, actor.orgId))
    .orderBy(asc(s.assets.name));

  const assetIds = assetRows.map((a) => a.asset.id);
  const reservationRows = assetIds.length
    ? await db
        .select({ reservation: s.assetReservations, show: s.shows, holder: s.users })
        .from(s.assetReservations)
        .innerJoin(s.shows, eq(s.assetReservations.showId, s.shows.id))
        .leftJoin(s.users, eq(s.assetReservations.checkedOutById, s.users.id))
        .where(inArray(s.assetReservations.assetId, assetIds))
        .orderBy(asc(s.assetReservations.reservedFrom))
    : [];

  const showIds = [...new Set(reservationRows.map((r) => r.show.id))];
  const freight = await freightBoundsFor(showIds, db);

  // The workspace register is an operations screen: it answers *what does this
  // asset need from somebody*, and a reservation that came back two months ago
  // needs nothing. Left in, it sorts on a date that has passed and pushes the
  // crate leaving on Thursday down the page — the flight and shipping boards'
  // finding, reached a third time.
  //
  // Two things keep it honest. **The asset never disappears**: an asset whose
  // only reservation is filtered here falls through to the `reservations.length
  // === 0` branch below and renders as a row with nothing booked, so the
  // register stays a register rather than becoming a list of active jobs. And
  // **the custody log is untouched** — this filters what the board *ranks*, not
  // what happened, and one show's own tab (`opts.showId`) sees every
  // reservation, which is where "signed out by Marcus on 9 July, returned
  // damaged" is read.
  //
  // Note what is deliberately *not* here, because `shipping/store.ts` has it and
  // the asymmetry is the point. That board also drops freight for a show that
  // closed out a month ago; this one must not, and §5h is why. A crate is
  // consumable and belongs to one show — past a point, "get it there" stops
  // meaning anything. An asset is **capital we own until somebody finds it**, so
  // a booth signed out to last spring's Detroit show and never checked in stays
  // on this register indefinitely, and sorts first because its return date is the
  // furthest past. That row is where the "capital unaccounted for" figure at the
  // top of the page comes from. Only a `returnedAt` closes an asset's question.
  const settledBefore = new Date(asOf.getTime() - REGISTER_CLOSED_OUT_DAYS * 86_400_000);
  const scoped = opts.showId
    ? reservationRows.filter((r) => r.show.id === opts.showId)
    : reservationRows.filter(
        (r) => !r.reservation.returnedAt || r.reservation.returnedAt >= settledBefore,
      );

  const byAsset = new Map<string, typeof reservationRows>();
  for (const r of scoped) {
    const list = byAsset.get(r.reservation.assetId) ?? [];
    list.push(r);
    byAsset.set(r.reservation.assetId, list);
  }

  const rows: AssetRow[] = [];
  for (const { asset, costCenter } of assetRows) {
    const reservations = byAsset.get(asset.id) ?? [];
    if (reservations.length === 0) {
      if (opts.showId) continue;
      rows.push(
        buildAssetRow(
          {
            asset: trackedAsset(asset),
            costCenterCode: costCenter?.code ?? null,
            reservation: null,
            showId: null,
            showName: null,
            showTimezone: null,
            moveInAt: null,
            holderId: null,
            holderName: null,
          },
          asOf,
        ),
      );
      continue;
    }
    for (const r of reservations) {
      rows.push(
        buildAssetRow(
          {
            asset: trackedAsset(asset),
            costCenterCode: costCenter?.code ?? null,
            reservation: reservationOf(r.reservation),
            showId: r.show.id,
            showName: r.show.name,
            showTimezone: r.show.timezone,
            moveInAt: r.show.moveInAt,
            holderId: r.holder?.id ?? null,
            holderName: r.holder?.fullName ?? null,
            freight: freight.get(r.show.id),
          },
          asOf,
        ),
      );
    }
  }

  // Clashes are always computed across the *whole* workspace, even when the
  // board is filtered to one show. A double-booking is between two shows by
  // definition, and a per-show view that only compared within itself would be
  // structurally unable to report the one thing it is looking for.
  const assetById = new Map(assetRows.map((a) => [a.asset.id, trackedAsset(a.asset)]));
  const clashes = findAssetClashes(
    reservationRows.map((r) => ({
      asset: assetById.get(r.reservation.assetId)!,
      reservation: reservationOf(r.reservation),
      showName: r.show.name,
    })),
  );

  return {
    rows: orderAssets(rows),
    summary: summarizeAssets(rows),
    clashes: opts.showId ? clashes.filter((c) => c.a.showId === opts.showId || c.b.showId === opts.showId) : clashes,
  };
}

/** What can honestly be offered for a window, and a reason attached to each refusal. */
export async function availableAssetsFor(
  actor: Actor,
  window: { from: Date; to: Date },
  exceptShowId?: string,
  db: Db = getDb(),
): Promise<AssetOption[]> {
  const assets = await db
    .select()
    .from(s.assets)
    .where(eq(s.assets.orgId, actor.orgId))
    .orderBy(asc(s.assets.name));
  const ids = assets.map((a) => a.id);
  const reservations = ids.length
    ? await db.select().from(s.assetReservations).where(inArray(s.assetReservations.assetId, ids))
    : [];
  const byAsset = new Map<string, Reservation[]>();
  for (const r of reservations) {
    if (exceptShowId && r.showId === exceptShowId) continue;
    const list = byAsset.get(r.assetId) ?? [];
    list.push(reservationOf(r));
    byAsset.set(r.assetId, list);
  }
  return offerAssets(assets.map(trackedAsset), byAsset, window);
}

/* ---------------------------------- assets --------------------------------- */

export async function createAsset(actor: Actor, draft: AssetDraft, db: Db = getDb()) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin adds capital assets.');
  const v = validateAsset(draft);
  const [row] = await db
    .insert(s.assets)
    .values({ orgId: actor.orgId, ...v })
    .returning();
  return row;
}

export async function editAsset(actor: Actor, assetId: string, draft: AssetDraft, db: Db = getDb()) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin edits assets.');
  await requireAsset(actor, assetId, db);
  const v = validateAsset(draft);
  const [row] = await db
    .update(s.assets)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(s.assets.id, assetId))
    .returning();
  return row;
}

export async function deleteAsset(actor: Actor, assetId: string, db: Db = getDb()) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin deletes assets.');
  const asset = await requireAsset(actor, assetId, db);
  const unreturned = await db
    .select({ id: s.assetReservations.id })
    .from(s.assetReservations)
    .where(
      and(
        eq(s.assetReservations.assetId, assetId),
        isNotNull(s.assetReservations.checkedOutAt),
        sql`${s.assetReservations.returnedAt} is null`,
      ),
    );
  if (unreturned.length > 0) {
    throw new AssetError(
      `${asset.name} is signed out and has not been checked back in. Deleting it deletes the only ` +
        'record of who has it, which is the opposite of what a chain of custody is for. Check it in first.',
    );
  }
  await db.delete(s.assets).where(eq(s.assets.id, assetId));
}

/* ------------------------------- reservations ------------------------------- */

export async function reserveAsset(
  actor: Actor,
  showId: string,
  draft: ReservationDraft,
  db: Db = getDb(),
) {
  if (!canReserveAssets(actor)) throw new ForbiddenError('Only a travel manager or admin reserves assets.');
  const show = await requireShow(actor, showId, db);
  const asset = await requireAsset(actor, draft.assetId, db);
  const v = validateReservation(draft);
  const zone = show.timezone ?? 'UTC';
  const from = zonedToInstant(v.reservedFromLocal, zone);
  const to = zonedToInstant(v.reservedToLocal, zone);

  const [row] = await db
    .insert(s.assetReservations)
    .values({ assetId: asset.id, showId, reservedFrom: from, reservedTo: to, notes: v.notes })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new AssetError(`${asset.name} is already reserved for ${show.name}.`);
  return row;
}

export async function editReservation(
  actor: Actor,
  reservationId: string,
  draft: ReservationDraft,
  db: Db = getDb(),
) {
  if (!canReserveAssets(actor)) throw new ForbiddenError('Only a travel manager or admin re-windows a reservation.');
  const { show } = await requireReservation(actor, reservationId, db);
  const v = validateReservation(draft);
  const zone = show.timezone ?? 'UTC';
  const [row] = await db
    .update(s.assetReservations)
    .set({
      reservedFrom: zonedToInstant(v.reservedFromLocal, zone),
      reservedTo: zonedToInstant(v.reservedToLocal, zone),
      notes: v.notes,
      updatedAt: new Date(),
    })
    .where(eq(s.assetReservations.id, reservationId))
    .returning();
  return row;
}

/**
 * Releasing a reservation cancels nothing outside this app — §5e's rule about
 * un-staffing somebody, applied to a thing. The first press names what is
 * attached; the second carries the acknowledgement.
 */
export async function releaseReservation(
  actor: Actor,
  reservationId: string,
  acknowledged: boolean,
  db: Db = getDb(),
) {
  if (!canReserveAssets(actor)) throw new ForbiddenError('Only a travel manager or admin releases a reservation.');
  const { reservation, asset, show } = await requireReservation(actor, reservationId, db);
  const shipments = await db
    .select({ id: s.shipments.id })
    .from(s.shipments)
    .where(eq(s.shipments.showId, show.id));
  const warning = describeReservationRelease({
    assetName: asset.name,
    checkedOut: reservation.checkedOutAt !== null && reservation.returnedAt === null,
    shipmentCount: shipments.length,
  });
  if (warning && !acknowledged) throw new AssetError(warning);
  await db.delete(s.assetReservations).where(eq(s.assetReservations.id, reservationId));
  return warning;
}

/**
 * Signing it out. Anybody — `access.ts` has the argument.
 *
 * The condition is snapshotted here rather than read off the asset later,
 * because `assets.condition` is mutable and by the time anybody asks it agrees
 * with the return and cannot say when it started.
 */
export async function checkOutAsset(
  actor: Actor,
  reservationId: string,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canHandleAssets()) throw new ForbiddenError('unreachable');
  const { reservation, asset } = await requireReservation(actor, reservationId, db);
  if (reservation.checkedOutAt) throw new AssetError(`${asset.name} is already signed out.`);
  if (reservation.returnedAt) throw new AssetError('This reservation is already closed.');
  const [row] = await db
    .update(s.assetReservations)
    .set({
      checkedOutAt: now,
      checkedOutById: actor.userId,
      conditionOnCheckout: asset.condition,
      updatedAt: now,
    })
    .where(eq(s.assetReservations.id, reservationId))
    .returning();
  return row;
}

/**
 * Checking it back in — and the only place `assets.condition` moves, which is
 * the point: an asset's condition is a fact discovered on a return, so it is
 * written by the person who found it rather than typed on an edit form.
 */
export async function checkInAsset(
  actor: Actor,
  reservationId: string,
  draft: CheckInDraft,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canHandleAssets()) throw new ForbiddenError('unreachable');
  const { reservation, asset } = await requireReservation(actor, reservationId, db);
  if (!reservation.checkedOutAt) {
    throw new AssetError(
      `${asset.name} was never signed out against this reservation, so there is nothing to check ` +
        'in. If it went out without being recorded, sign it out first — the log is the point.',
    );
  }
  if (reservation.returnedAt) throw new AssetError(`${asset.name} is already checked in.`);
  const v = validateCheckIn({
    conditionOnReturn: draft.conditionOnReturn,
    conditionOnCheckout: reservation.conditionOnCheckout,
    note: draft.note,
  });

  const [row] = await db
    .update(s.assetReservations)
    .set({
      returnedAt: now,
      returnedById: actor.userId,
      conditionOnReturn: v.conditionOnReturn,
      notes: v.note ? [reservation.notes, v.note].filter(Boolean).join('\n') : reservation.notes,
      updatedAt: now,
    })
    .where(eq(s.assetReservations.id, reservationId))
    .returning();

  await db
    .update(s.assets)
    .set({ condition: v.conditionOnReturn, updatedAt: now })
    .where(eq(s.assets.id, asset.id));

  return row;
}

/* -------------------------------- collateral -------------------------------- */

export type CollateralRow = {
  item: CollateralItem;
  costCenterCode: string | null;
  standing: StockStanding;
  alert: PlannedAssetAlert | null;
};

export async function getCollateral(
  actor: Actor,
  db: Db = getDb(),
): Promise<CollateralRow[]> {
  const items = await db
    .select({ item: s.collateralItems, costCenter: s.costCenters })
    .from(s.collateralItems)
    .leftJoin(s.costCenters, eq(s.collateralItems.costCenterId, s.costCenters.id))
    .where(eq(s.collateralItems.orgId, actor.orgId))
    .orderBy(asc(s.collateralItems.name));
  const ids = items.map((i) => i.item.id);
  const allocations = ids.length
    ? await db
        .select()
        .from(s.collateralAllocations)
        .where(inArray(s.collateralAllocations.collateralItemId, ids))
    : [];
  const all = allocations.map(allocationOf);

  return items.map(({ item, costCenter }) => {
    const model = itemOf(item);
    const standing = stockStanding(model, all);
    return {
      item: model,
      costCenterCode: costCenter?.code ?? null,
      standing,
      alert: planStockAlert({ item: model, standing }),
    };
  });
}

export async function createCollateralItem(actor: Actor, draft: CollateralDraft, db: Db = getDb()) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin adds collateral.');
  const v = validateCollateral(draft);
  const [row] = await db
    .insert(s.collateralItems)
    .values({ orgId: actor.orgId, ...v, quantityOnHand: 0 })
    .returning();
  return row;
}

export async function editCollateralItem(
  actor: Actor,
  itemId: string,
  draft: CollateralDraft,
  db: Db = getDb(),
) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin edits collateral.');
  await requireItem(actor, itemId, db);
  const v = validateCollateral(draft);
  const [row] = await db
    .update(s.collateralItems)
    // `quantityOnHand` is deliberately absent: it is a projection of the ledger,
    // and a form that could set it directly would be the second way to move a
    // balance, which is exactly what the credit ground rule forbids.
    .set({ ...v, updatedAt: new Date() })
    .where(eq(s.collateralItems.id, itemId))
    .returning();
  return row;
}

export async function deleteCollateralItem(actor: Actor, itemId: string, db: Db = getDb()) {
  if (!canManageAssets(actor)) throw new ForbiddenError('Only a travel manager or admin deletes collateral.');
  await requireItem(actor, itemId, db);
  await db.delete(s.collateralItems).where(eq(s.collateralItems.id, itemId));
}

/**
 * The only thing that moves `quantity_on_hand`, by appending a signed delta —
 * `recordEntry()` for things instead of money. Never a set-to value.
 */
export async function recordMovement(
  actor: Actor,
  itemId: string,
  draft: MovementDraft,
  opts: { allocationId?: string | null; showId?: string | null; now?: Date } = {},
  db: Db = getDb(),
) {
  if (!canCountStock()) throw new ForbiddenError('unreachable');
  const item = await requireItem(actor, itemId, db);
  const v = validateMovement(draft);
  const now = opts.now ?? new Date();

  const sign = signOf(v.kind);
  // A `counted` entry is the only two-way one: it carries whatever delta
  // reconciles the ledger with the shelf, which may be either sign or zero.
  const delta = v.kind === 'counted' ? v.quantity - item.quantityOnHand : sign * v.quantity;
  const quantityAfter = item.quantityOnHand + delta;
  if (quantityAfter < 0) {
    throw new AssetError(
      `${item.name} has ${item.quantityOnHand} on hand; taking ${v.quantity} off the shelf would ` +
        'leave a negative count. Stock that is not there cannot be issued, and a negative on-hand ' +
        'reads on every later screen as if it were real.',
    );
  }

  const inserted = await db
    .insert(s.collateralEntries)
    .values({
      itemId,
      orgId: actor.orgId,
      kind: v.kind,
      delta,
      quantityAfter,
      allocationId: opts.allocationId ?? null,
      showId: opts.showId ?? null,
      actorId: actor.userId,
      reason: v.reason,
      occurredAt: now,
    })
    .onConflictDoNothing()
    .returning();

  // The unique index on (allocation, kind) is the rail: a retried "pack the
  // crate" must not empty the shelf twice. Nothing conflicted means nothing
  // moved, so the projection must not move either.
  if (inserted.length === 0) return null;

  await db
    .update(s.collateralItems)
    .set({ quantityOnHand: quantityAfter, updatedAt: now })
    .where(eq(s.collateralItems.id, itemId));

  return inserted[0];
}

export async function getCollateralLedger(actor: Actor, itemId: string, db: Db = getDb()) {
  const item = await requireItem(actor, itemId, db);
  const entries = await db
    .select()
    .from(s.collateralEntries)
    .where(eq(s.collateralEntries.itemId, itemId))
    .orderBy(asc(s.collateralEntries.occurredAt));
  return {
    item: itemOf(item),
    entries,
    // Offered so a caller can check the column against the trail; a balance that
    // has drifted from its ledger is worth nothing.
    projected: projectQuantity(
      entries.map((e) => ({
        kind: e.kind,
        delta: e.delta,
        quantityAfter: e.quantityAfter,
        occurredAt: e.occurredAt,
        reason: e.reason,
      })),
    ),
  };
}

/* ------------------------------- allocations -------------------------------- */

export type ShowAllocationRow = {
  allocation: Allocation;
  itemName: string;
  unitCostCents: number | null;
  standing: ReturnType<typeof allocationStanding>;
  /** What is available to allocate right now, so a screen can say "and it is short". */
  itemStanding: StockStanding;
};

export async function getShowCollateral(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<ShowAllocationRow[]> {
  await requireShow(actor, showId, db);
  const rows = await db
    .select({ allocation: s.collateralAllocations, item: s.collateralItems })
    .from(s.collateralAllocations)
    .innerJoin(s.collateralItems, eq(s.collateralAllocations.collateralItemId, s.collateralItems.id))
    .where(
      and(eq(s.collateralAllocations.showId, showId), eq(s.collateralItems.orgId, actor.orgId)),
    )
    .orderBy(asc(s.collateralItems.name));

  const itemIds = [...new Set(rows.map((r) => r.item.id))];
  const siblings = itemIds.length
    ? await db
        .select()
        .from(s.collateralAllocations)
        .where(inArray(s.collateralAllocations.collateralItemId, itemIds))
    : [];
  const all = siblings.map(allocationOf);

  return rows.map(({ allocation, item }) => ({
    allocation: allocationOf(allocation),
    itemName: item.name,
    unitCostCents: item.unitCostCents,
    standing: allocationStanding(allocationOf(allocation)),
    itemStanding: stockStanding(itemOf(item), all),
  }));
}

export async function allocateCollateral(
  actor: Actor,
  showId: string,
  draft: AllocationDraft,
  db: Db = getDb(),
) {
  if (!canReserveAssets(actor)) throw new ForbiddenError('Only a travel manager or admin allocates stock.');
  await requireShow(actor, showId, db);
  const v = validateAllocation(draft);
  const item = await requireItem(actor, v.itemId, db);
  const [row] = await db
    .insert(s.collateralAllocations)
    .values({
      collateralItemId: item.id,
      showId,
      quantityAllocated: v.quantity,
      notes: v.notes,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw new AssetError(
      `${item.name} is already allocated to this show. Edit that allocation rather than adding a ` +
        'second — two rows for one promise is how the committed figure drifts.',
    );
  }
  return row;
}

/**
 * Picking the stock off the shelf. This is the movement; the allocation was only
 * the promise, which is why nothing left `quantity_on_hand` until now.
 */
export async function issueAllocation(
  actor: Actor,
  allocationId: string,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canCountStock()) throw new ForbiddenError('unreachable');
  const [row] = await db
    .select({ allocation: s.collateralAllocations, item: s.collateralItems, show: s.shows })
    .from(s.collateralAllocations)
    .innerJoin(s.collateralItems, eq(s.collateralAllocations.collateralItemId, s.collateralItems.id))
    .innerJoin(s.shows, eq(s.collateralAllocations.showId, s.shows.id))
    .where(
      and(eq(s.collateralAllocations.id, allocationId), eq(s.collateralItems.orgId, actor.orgId)),
    );
  if (!row) throw new NotFoundError('allocation');
  if (row.allocation.issuedAt) throw new AssetError('This allocation has already been packed.');

  await recordMovement(
    actor,
    row.item.id,
    {
      kind: 'issued',
      quantity: String(row.allocation.quantityAllocated),
      reason: `Packed for ${row.show.name}`,
    },
    { allocationId, showId: row.show.id, now },
    db,
  );

  const [updated] = await db
    .update(s.collateralAllocations)
    .set({ issuedAt: now, issuedById: actor.userId, updatedAt: now })
    .where(eq(s.collateralAllocations.id, allocationId))
    .returning();
  return updated;
}

/**
 * Counting a box back. Zero is a real, ordinary answer for swag and a bad one
 * for a demo unit; what the app must never do is guess which, which is why
 * `quantity_returned` stays null until somebody types a number.
 */
export async function countBackAllocation(
  actor: Actor,
  allocationId: string,
  counted: number,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canCountStock()) throw new ForbiddenError('unreachable');
  const [row] = await db
    .select({ allocation: s.collateralAllocations, item: s.collateralItems, show: s.shows })
    .from(s.collateralAllocations)
    .innerJoin(s.collateralItems, eq(s.collateralAllocations.collateralItemId, s.collateralItems.id))
    .innerJoin(s.shows, eq(s.collateralAllocations.showId, s.shows.id))
    .where(
      and(eq(s.collateralAllocations.id, allocationId), eq(s.collateralItems.orgId, actor.orgId)),
    );
  if (!row) throw new NotFoundError('allocation');
  if (row.allocation.returnedAt) throw new AssetError('This allocation has already been counted back.');

  const verdict = reconcileAllocation(allocationOf(row.allocation), counted);
  if (verdict.kind === 'refused') throw new AssetError(verdict.why);

  if (verdict.returned > 0) {
    await recordMovement(
      actor,
      row.item.id,
      {
        kind: 'returned',
        quantity: String(verdict.returned),
        reason: `Counted back from ${row.show.name}; ${verdict.consumed} consumed`,
      },
      { allocationId, showId: row.show.id, now },
      db,
    );
  }

  const [updated] = await db
    .update(s.collateralAllocations)
    .set({
      quantityReturned: verdict.returned,
      returnedAt: now,
      returnedById: actor.userId,
      updatedAt: now,
    })
    .where(eq(s.collateralAllocations.id, allocationId))
    .returning();
  return updated;
}

export async function deleteAllocation(actor: Actor, allocationId: string, db: Db = getDb()) {
  if (!canReserveAssets(actor)) throw new ForbiddenError('Only a travel manager or admin removes an allocation.');
  const [row] = await db
    .select({ allocation: s.collateralAllocations, item: s.collateralItems })
    .from(s.collateralAllocations)
    .innerJoin(s.collateralItems, eq(s.collateralAllocations.collateralItemId, s.collateralItems.id))
    .where(
      and(eq(s.collateralAllocations.id, allocationId), eq(s.collateralItems.orgId, actor.orgId)),
    );
  if (!row) throw new NotFoundError('allocation');
  if (row.allocation.issuedAt && !row.allocation.returnedAt) {
    throw new AssetError(
      'This stock is already off the shelf and in a crate. Deleting the allocation deletes the only ' +
        'record of where it went — count it back first, even if the count is zero.',
    );
  }
  await db.delete(s.collateralAllocations).where(eq(s.collateralAllocations.id, allocationId));
}

/* ---------------------------------- sweep ----------------------------------- */

export type AssetSweepResult = {
  reservations: number;
  planned: PlannedAssetAlert[];
  alertsWritten: number;
  /** Conditions this sweep no longer finds. The crate is back on the shelf. */
  alertsResolved: number;
};

/**
 * Tonight's asset alerts, planned against **every** row rather than the ones
 * that changed — §5g's reason, with more force. Two of the four reservation
 * alerts here (`never_collected`, `unserviceable_reservation`) have no
 * transition behind them at all: they are conditions that arise from a date
 * passing and a fact staying true, and an engine that spoke on changes would be
 * structurally silent on both.
 */
export async function sweepAssetAlerts(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<AssetSweepResult> {
  const reservationRows = await db
    .select({ reservation: s.assetReservations, asset: s.assets, show: s.shows, holder: s.users })
    .from(s.assetReservations)
    .innerJoin(s.assets, eq(s.assetReservations.assetId, s.assets.id))
    .innerJoin(s.shows, eq(s.assetReservations.showId, s.shows.id))
    .leftJoin(s.users, eq(s.assetReservations.checkedOutById, s.users.id))
    .where(eq(s.assets.orgId, orgId));

  const freight = await freightBoundsFor([...new Set(reservationRows.map((r) => r.show.id))], db);

  const planned: PlannedAssetAlert[] = [];
  for (const r of reservationRows) {
    const alert = planReservationAlert(
      {
        asset: trackedAsset(r.asset),
        reservation: reservationOf(r.reservation),
        showId: r.show.id,
        showName: r.show.name,
        moveInAt: r.show.moveInAt,
        holderId: r.holder?.id ?? null,
        holderName: r.holder?.fullName ?? null,
        freight: freight.get(r.show.id),
      },
      now,
    );
    if (alert) planned.push(alert);
  }

  const assetById = new Map(reservationRows.map((r) => [r.asset.id, trackedAsset(r.asset)]));
  for (const clash of findAssetClashes(
    reservationRows.map((r) => ({
      asset: assetById.get(r.asset.id)!,
      reservation: reservationOf(r.reservation),
      showName: r.show.name,
    })),
  )) {
    planned.push(planClashAlert(clash));
  }

  const items = await db
    .select()
    .from(s.collateralItems)
    .where(eq(s.collateralItems.orgId, orgId));
  const itemIds = items.map((i) => i.id);
  const allocationRows = itemIds.length
    ? await db
        .select({ allocation: s.collateralAllocations, item: s.collateralItems, show: s.shows })
        .from(s.collateralAllocations)
        .innerJoin(s.collateralItems, eq(s.collateralAllocations.collateralItemId, s.collateralItems.id))
        .innerJoin(s.shows, eq(s.collateralAllocations.showId, s.shows.id))
        .where(inArray(s.collateralAllocations.collateralItemId, itemIds))
    : [];
  const allAllocations = allocationRows.map((r) => allocationOf(r.allocation));

  for (const item of items) {
    const model = itemOf(item);
    const alert = planStockAlert({ item: model, standing: stockStanding(model, allAllocations) });
    if (alert) planned.push(alert);
  }

  for (const r of allocationRows) {
    if (allocationStanding(allocationOf(r.allocation)) !== 'issued') continue;
    const alert = planUnreconciledAlert(
      {
        itemId: r.item.id,
        itemName: r.item.name,
        allocationId: r.allocation.id,
        showId: r.show.id,
        showName: r.show.name,
        quantityAllocated: r.allocation.quantityAllocated,
        moveOutAt: r.show.moveOutAt,
      },
      now,
    );
    if (alert) planned.push(alert);
  }

  const { raised, resolved } = await writeAssetAlerts(orgId, planned, now, db);
  return {
    reservations: reservationRows.length,
    planned,
    alertsWritten: raised,
    alertsResolved: resolved,
  };
}

/**
 * Who hears about an asset.
 *
 * Whoever signed it out when somebody did, and the show's runners when nobody
 * did — §5a's third correction for the fifth time. The asymmetry is sharper here
 * than for a crate: on `never_collected` and `unserviceable_reservation` there
 * is *never* a holder, by construction, so an addressed-to-the-holder engine
 * would be silent on exactly the two alerts nothing else on any screen reports.
 */
async function writeAssetAlerts(
  orgId: string,
  planned: PlannedAssetAlert[],
  now: Date,
  db: Db,
): Promise<AlertSyncResult> {
  const runners = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  const writes: AlertWrite[] = [];
  for (const alert of planned) {
    const recipients = new Set<string>(runners.map((r) => r.id));
    if (alert.userId) recipients.add(alert.userId);
    for (const userId of recipients) {
      writes.push({
        showId: alert.showId,
        userId,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        dedupeKey: `${alert.dedupeKey}:${userId}`,
      });
    }
  }

  // The booth came back, or somebody counted the shelf. Absence from tonight's
  // plan is the only signal either of those produces.
  return syncConditionAlerts(db, { orgId, source: 'asset', writes, now });
}
