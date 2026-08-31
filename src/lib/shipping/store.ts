import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { NotFoundError } from '@/lib/shows/store';
import type { ShipmentTrackingProvider, TrackingScan } from '@/lib/integrations/shipping/types';
import { isNoRecord } from '@/lib/integrations/shipping/types';
import { canConfirmReceipt, canManageShipments } from './access';
import {
  buildShipmentRow,
  orderShipments,
  summarizeShipments,
  type ShipmentBoardSummary,
  type ShipmentRow,
} from './board';
import {
  planReturnGapAlert,
  planShipmentAlert,
  type PlannedShipmentAlert,
} from './alerts';
import { ShippingError, describeDeletion, validateShipment, type ShipmentDraft } from './edit';
import { expectedCheckIntervalMinutes, reconcile, type TrackedShipment } from './status';

type Db = ReturnType<typeof getDb>;
type ShipmentRecord = typeof s.shipments.$inferSelect;

/**
 * The rows half of shipping. Org-scoped at the source, like every store since
 * step 8, and it decides nothing: every judgment it applies came from
 * `status.ts`, `alerts.ts` or `board.ts` above it.
 *
 * Scoping goes through the **show**, not through a person, which is the mirror
 * image of `flights/store.ts` and for a stated reason: `flights.show_id` is
 * nullable because a trip with no show is still a trip, so a flight is scoped
 * through its traveler. A shipment has no traveler at all and `show_id` is not
 * null — freight is always going to or coming from a floor. There is no
 * traveler narrowing either: `access.ts` explains why a crate is not personal
 * the way a fare is.
 */

/** The scan history is what `status.ts` reads as `lastScanAt`. */
export function tracked(row: ShipmentRecord, lastScanAt: Date | null): TrackedShipment {
  return {
    id: row.id,
    description: row.description,
    direction: row.direction,
    consignment: row.consignment,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    status: row.status,
    pieces: row.pieces,
    mustArriveBy: row.mustArriveBy,
    receivingOpensAt: row.receivingOpensAt,
    shippedAt: row.shippedAt,
    estimatedDelivery: row.estimatedDelivery,
    promisedDelivery: row.promisedDelivery,
    estimateChangedAt: row.estimateChangedAt,
    deliveredAt: row.deliveredAt,
    receivedAt: row.receivedAt,
    lastCheckedAt: row.lastCheckedAt,
    trackingProvider: row.trackingProvider,
    lastScanAt,
  };
}

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');
  return show;
}

async function requireShipment(actor: Actor, shipmentId: string, db: Db) {
  const [row] = await db
    .select({ shipment: s.shipments, show: s.shows })
    .from(s.shipments)
    .innerJoin(s.shows, eq(s.shipments.showId, s.shows.id))
    .where(and(eq(s.shipments.id, shipmentId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('shipment');
  return row;
}

async function requireCostCenter(actor: Actor, costCenterId: string, db: Db) {
  const cc = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.id, costCenterId), eq(s.costCenters.orgId, actor.orgId)),
  });
  if (!cc) throw new NotFoundError('cost center');
  return cc;
}

/** The latest scan per shipment, which is the whole of the stall model's input. */
async function lastScans(shipmentIds: string[], db: Db): Promise<Map<string, Date>> {
  if (shipmentIds.length === 0) return new Map();
  const rows = await db
    .select({ shipmentId: s.shipmentEvents.shipmentId, occurredAt: s.shipmentEvents.occurredAt })
    .from(s.shipmentEvents)
    .where(inArray(s.shipmentEvents.shipmentId, shipmentIds));
  const out = new Map<string, Date>();
  for (const r of rows) {
    const seen = out.get(r.shipmentId);
    if (!seen || r.occurredAt.getTime() > seen.getTime()) out.set(r.shipmentId, r.occurredAt);
  }
  return out;
}

/* ---------------------------------- read ----------------------------------- */

export type ShipmentBoard = {
  rows: ShipmentRow[];
  summary: ShipmentBoardSummary;
  /** True when every reading on the board came from replayed payloads. */
  replayed: boolean;
};

type LoadedShipment = {
  shipment: ShipmentRecord;
  show: { id: string; name: string; timezone: string; moveInAt: Date | null; moveOutAt: Date | null };
  owner: { id: string; fullName: string } | null;
};

async function loadShipments(actor: Actor, db: Db, showId?: string): Promise<LoadedShipment[]> {
  const rows = await db
    .select({ shipment: s.shipments, show: s.shows, owner: s.users })
    .from(s.shipments)
    .innerJoin(s.shows, eq(s.shipments.showId, s.shows.id))
    .leftJoin(s.users, eq(s.shipments.ownerId, s.users.id))
    .where(and(eq(s.shows.orgId, actor.orgId), showId ? eq(s.shipments.showId, showId) : undefined))
    .orderBy(asc(s.shipments.mustArriveBy));

  return rows.map((r) => ({
    shipment: r.shipment,
    show: {
      id: r.show.id,
      name: r.show.name,
      timezone: r.show.timezone,
      moveInAt: r.show.moveInAt,
      moveOutAt: r.show.moveOutAt,
    },
    owner: r.owner ? { id: r.owner.id, fullName: r.owner.fullName } : null,
  }));
}

function toRow(i: LoadedShipment, lastScanAt: Date | null, asOf: Date): ShipmentRow {
  return buildShipmentRow(
    {
      shipment: tracked(i.shipment, lastScanAt),
      showId: i.show.id,
      showName: i.show.name,
      showTimezone: i.show.timezone,
      moveInAt: i.show.moveInAt,
      ownerId: i.owner?.id ?? null,
      ownerName: i.owner?.fullName ?? null,
      costs: {
        costCents: i.shipment.costCents,
        declaredValueCents: i.shipment.declaredValueCents,
        pieces: i.shipment.pieces,
        weightLb: i.shipment.weightLb,
      },
    },
    asOf,
  );
}

export async function getShipmentBoard(
  actor: Actor,
  opts: { showId?: string; asOf?: Date; replayed?: boolean } = {},
  db: Db = getDb(),
): Promise<ShipmentBoard> {
  const asOf = opts.asOf ?? new Date();
  const items = await loadShipments(actor, db, opts.showId);
  const scans = await lastScans(items.map((i) => i.shipment.id), db);

  const rows = orderShipments(
    items.map((i) => toRow(i, scans.get(i.shipment.id) ?? null, asOf)),
  );

  return {
    rows,
    summary: summarizeShipments(rows),
    replayed:
      opts.replayed ??
      (rows.length > 0 &&
        rows.every((r) => r.shipment.trackingProvider === 'recorded' || r.shipment.trackingProvider === null) &&
        rows.some((r) => r.shipment.trackingProvider === 'recorded')),
  };
}

export type ShipmentTimeline = {
  row: ShipmentRow;
  events: (typeof s.shipmentEvents.$inferSelect)[];
  costCenter: { id: string; code: string; name: string } | null;
};

/** One shipment with its whole scan history, newest first. */
export async function getShipmentTimeline(
  actor: Actor,
  shipmentId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<ShipmentTimeline> {
  const { shipment, show } = await requireShipment(actor, shipmentId, db);
  const [owner] = shipment.ownerId
    ? await db
        .select({ id: s.users.id, fullName: s.users.fullName })
        .from(s.users)
        .where(eq(s.users.id, shipment.ownerId))
    : [];
  const [costCenter] = shipment.costCenterId
    ? await db
        .select({ id: s.costCenters.id, code: s.costCenters.code, name: s.costCenters.name })
        .from(s.costCenters)
        .where(eq(s.costCenters.id, shipment.costCenterId))
    : [];

  const events = await db
    .select()
    .from(s.shipmentEvents)
    .where(eq(s.shipmentEvents.shipmentId, shipmentId))
    .orderBy(desc(s.shipmentEvents.occurredAt));

  const row = toRow(
    {
      shipment,
      show: {
        id: show.id,
        name: show.name,
        timezone: show.timezone,
        moveInAt: show.moveInAt,
        moveOutAt: show.moveOutAt,
      },
      owner: owner ?? null,
    },
    events[0]?.occurredAt ?? null,
    asOf,
  );

  return { row, events, costCenter: costCenter ?? null };
}

/* ---------------------------------- write ---------------------------------- */

function resolveDates(v: ReturnType<typeof validateShipment>, timezone: string) {
  return {
    mustArriveBy: v.mustArriveByLocal ? zonedToInstant(v.mustArriveByLocal, timezone) : null,
    receivingOpensAt: v.receivingOpensLocal ? zonedToInstant(v.receivingOpensLocal, timezone) : null,
  };
}

export async function addShipment(
  actor: Actor,
  showId: string,
  draft: ShipmentDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<ShipmentRecord> {
  const show = await requireShow(actor, showId, db);
  if (!canManageShipments(actor)) {
    throw new ForbiddenError('Only a travel manager or admin can add freight to a show.');
  }
  const v = validateShipment(draft);
  await requireCostCenter(actor, v.costCenterId, db);
  if (v.ownerId) await requireOrgUser(actor, v.ownerId, db);

  const [row] = await db
    .insert(s.shipments)
    .values({
      showId,
      description: v.description,
      direction: v.direction,
      consignment: v.consignment,
      carrier: v.carrier as ShipmentRecord['carrier'],
      trackingNumber: v.trackingNumber,
      ownerId: v.ownerId,
      ...resolveDates(v, show.timezone),
      pieces: v.pieces,
      weightLb: v.weightLb,
      declaredValueCents: v.declaredValueCents,
      costCents: v.costCents,
      costCenterId: v.costCenterId,
      notes: v.notes,
      // A row arrives as a plan. A tracking number makes it a label that exists;
      // only a carrier scan makes it freight that has moved, and that comes from
      // the sweep rather than from this form.
      status: v.trackingNumber ? 'label_created' : 'draft',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function editShipment(
  actor: Actor,
  shipmentId: string,
  draft: ShipmentDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<ShipmentRecord> {
  const { shipment, show } = await requireShipment(actor, shipmentId, db);
  if (!canManageShipments(actor)) {
    throw new ForbiddenError('Only a travel manager or admin can change a shipment.');
  }
  const v = validateShipment(draft);
  await requireCostCenter(actor, v.costCenterId, db);
  if (v.ownerId) await requireOrgUser(actor, v.ownerId, db);

  // A new tracking number is a new crate as far as tracking is concerned: the
  // old label's scans describe freight that is not this freight. Keeping them
  // would leave a timeline whose last scan is from a shipment nobody is
  // watching, and `stallOf` would read that as movement.
  const numberChanged = v.trackingNumber !== shipment.trackingNumber;
  if (numberChanged) {
    await db.delete(s.shipmentEvents).where(eq(s.shipmentEvents.shipmentId, shipmentId));
  }

  const [row] = await db
    .update(s.shipments)
    .set({
      description: v.description,
      direction: v.direction,
      consignment: v.consignment,
      carrier: v.carrier as ShipmentRecord['carrier'],
      trackingNumber: v.trackingNumber,
      ownerId: v.ownerId,
      ...resolveDates(v, show.timezone),
      pieces: v.pieces,
      weightLb: v.weightLb,
      declaredValueCents: v.declaredValueCents,
      costCents: v.costCents,
      costCenterId: v.costCenterId,
      notes: v.notes,
      ...(numberChanged
        ? {
            status: (v.trackingNumber ? 'label_created' : 'draft') as ShipmentRecord['status'],
            estimatedDelivery: null,
            // The promise goes with the label it was made against. Carrying it
            // over would let a new crate inherit an old crate's "this slipped
            // after we committed" verdict, which is a claim about a truck that
            // has already been somewhere else.
            promisedDelivery: null,
            estimateChangedAt: null,
            deliveredAt: null,
            lastCheckedAt: null,
            trackingProvider: null,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(s.shipments.id, shipmentId))
    .returning();
  return row;
}

export async function deleteShipment(
  actor: Actor,
  shipmentId: string,
  acknowledged: boolean,
  db: Db = getDb(),
): Promise<void> {
  const { shipment } = await requireShipment(actor, shipmentId, db);
  if (!canManageShipments(actor)) {
    throw new ForbiddenError('Only a travel manager or admin can delete a shipment.');
  }
  // Same shape as un-staffing somebody and as cancelling a ticketed request: the
  // app names what it does not control, once, and the second press carries the
  // acknowledgement.
  const warning = describeDeletion(shipment);
  if (warning && !acknowledged) throw new ShippingError(warning);
  await db.delete(s.shipments).where(eq(s.shipments.id, shipmentId));
}

/**
 * A person saying the crate is physically here.
 *
 * The counterpart of `show_attendees.responded_at`, and the reason
 * `shipments.delivered_at` alone is not enough: the carrier's claim is about a
 * dock, and the dock is not the booth. Anybody may set this — `access.ts` has
 * the argument — because the person who finds the crate is whoever is standing
 * in the booth at 7am, not whoever booked the freight.
 */
export async function confirmReceipt(
  actor: Actor,
  shipmentId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  await requireShipment(actor, shipmentId, db);
  if (!canConfirmReceipt()) throw new ForbiddenError('Cannot confirm receipt.');
  await db
    .update(s.shipments)
    .set({ receivedAt: now, receivedById: actor.userId, updatedAt: now })
    .where(eq(s.shipments.id, shipmentId));
}

export async function undoReceipt(
  actor: Actor,
  shipmentId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { shipment } = await requireShipment(actor, shipmentId, db);
  // Withdrawing somebody else's confirmation is changing the record, not
  // reporting on it — the same asymmetry the roster draws around answering for
  // yourself. Undoing your own mistake stays yours.
  if (shipment.receivedById !== actor.userId && !canManageShipments(actor)) {
    throw new ForbiddenError(
      'This was confirmed by somebody else. Only they, or a travel manager, can withdraw it.',
    );
  }
  await db
    .update(s.shipments)
    .set({ receivedAt: null, receivedById: null, updatedAt: now })
    .where(eq(s.shipments.id, shipmentId));
}

/**
 * A scan somebody typed, for the carriers no tracker covers.
 *
 * Freight forwarders and show-service contractors are a phone call, not an API,
 * and `carrier: 'other'` exists for exactly them. A hand-typed scan carries
 * `source: 'manual'` so the timeline never implies a carrier said it, and its
 * fingerprint is built the same way the normalizer builds one — so if a tracker
 * is configured later, the same scan arriving from EasyPost does not double.
 */
export async function recordScan(
  actor: Actor,
  shipmentId: string,
  scan: { occurredAt: Date; status: string; message: string; location?: string | null },
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  await requireShipment(actor, shipmentId, db);
  if (!canManageShipments(actor)) {
    throw new ForbiddenError('Only a travel manager or admin can add to a shipment timeline.');
  }
  const message = scan.message.trim();
  if (message.length < 2) throw new ShippingError('A timeline entry needs a description.');
  const location = scan.location?.trim() || null;

  await db
    .insert(s.shipmentEvents)
    .values({
      shipmentId,
      occurredAt: scan.occurredAt,
      status: scan.status,
      message,
      location,
      source: 'manual',
      fingerprint: `${scan.occurredAt.toISOString()}|${scan.status}|${location ?? ''}`,
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function requireOrgUser(actor: Actor, userId: string, db: Db) {
  const user = await db.query.users.findFirst({
    where: and(eq(s.users.id, userId), eq(s.users.orgId, actor.orgId)),
  });
  if (!user) throw new NotFoundError('user');
  return user;
}

/* ----------------------------------- sync ---------------------------------- */

export type ShipmentSyncResult = {
  checked: number;
  changed: number;
  scansAdded: number;
  noRecord: number;
  planned: PlannedShipmentAlert[];
  alertsWritten: number;
  unavailable?: string;
};

/**
 * A shipment is worth asking about when it is due a check and has not settled.
 * `expectedCheckIntervalMinutes` is the same function the board reads to decide
 * what is stale, so the board can never call fresh something this is not
 * refreshing.
 */
function dueForCheck(row: ShipmentRecord, lastScanAt: Date | null, now: Date): boolean {
  if (!row.trackingNumber) return false;
  if (row.status === 'delivered' || row.status === 'cancelled' || row.status === 'returned') {
    return false;
  }
  // Nothing to learn about a crate whose deadline was a fortnight ago and which
  // nobody has touched since.
  if (row.mustArriveBy && row.mustArriveBy.getTime() < now.getTime() - 14 * 86_400_000) return false;
  if (!row.lastCheckedAt) return true;
  const ageMinutes = (now.getTime() - row.lastCheckedAt.getTime()) / 60_000;
  return ageMinutes >= expectedCheckIntervalMinutes(tracked(row, lastScanAt), now);
}

export async function syncShipmentTracking(
  orgId: string,
  provider: ShipmentTrackingProvider,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<ShipmentSyncResult> {
  const rows = await db
    .select({ shipment: s.shipments, show: s.shows, owner: s.users })
    .from(s.shipments)
    .innerJoin(s.shows, eq(s.shipments.showId, s.shows.id))
    .leftJoin(s.users, eq(s.shipments.ownerId, s.users.id))
    .where(eq(s.shows.orgId, orgId))
    .orderBy(asc(s.shipments.mustArriveBy));

  const scans = await lastScans(rows.map((r) => r.shipment.id), db);
  const due = rows.filter((r) => dueForCheck(r.shipment, scans.get(r.shipment.id) ?? null, now));

  let changed = 0;
  let scansAdded = 0;
  let noRecord = 0;
  const updated = new Map<string, ShipmentRecord>();

  for (const { shipment } of due) {
    const lookup = await provider.lookup({
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber!,
      mustArriveBy: shipment.mustArriveBy,
      shippedAt: shipment.shippedAt,
    });

    if (isNoRecord(lookup)) {
      noRecord += 1;
      continue;
    }

    const known = new Set(
      (
        await db
          .select({ fingerprint: s.shipmentEvents.fingerprint })
          .from(s.shipmentEvents)
          .where(eq(s.shipmentEvents.shipmentId, shipment.id))
      ).map((e) => e.fingerprint),
    );

    const { changes, newScans, patch } = reconcile(
      tracked(shipment, scans.get(shipment.id) ?? null),
      lookup,
      known,
    );
    if (!patch) continue;

    scansAdded += await appendScans(shipment.id, newScans, lookup.provider, now, db);

    const [row] = await db
      .update(s.shipments)
      .set({
        ...patch,
        // The first scan the carrier reports is when the freight actually left,
        // which is a fact nobody types accurately and everybody needs.
        shippedAt: shipment.shippedAt ?? firstMovement(newScans),
        updatedAt: now,
      })
      .where(eq(s.shipments.id, shipment.id))
      .returning();
    updated.set(shipment.id, row);
    if (!changes.includes('none')) changed += 1;
    if (newScans.length > 0) {
      const latest = newScans[newScans.length - 1].occurredAt;
      const seen = scans.get(shipment.id);
      if (!seen || latest.getTime() > seen.getTime()) scans.set(shipment.id, latest);
    }
  }

  // Alerts are planned against every shipment, not only the ones that just
  // moved. `flights/store.ts`'s reason applies with more force here, because the
  // condition this engine most needs to catch is *nothing happening*: an engine
  // that only speaks on transitions is structurally incapable of reporting a
  // stall, which is the failure mode with no transition at all.
  const all = rows.map((r) => ({ ...r, shipment: updated.get(r.shipment.id) ?? r.shipment }));

  const planned: PlannedShipmentAlert[] = [];
  for (const r of all) {
    const alert = planShipmentAlert(
      {
        shipment: tracked(r.shipment, scans.get(r.shipment.id) ?? null),
        showId: r.show.id,
        showName: r.show.name,
        moveInAt: r.show.moveInAt,
        ownerId: r.owner?.id ?? null,
        ownerName: r.owner?.fullName ?? null,
      },
      now,
    );
    if (alert) planned.push(alert);
  }

  planned.push(...planReturnGaps(all, now));

  const alertsWritten = await writeShipmentAlerts(orgId, planned, now, db);
  return { checked: due.length, changed, scansAdded, noRecord, planned, alertsWritten };
}

function firstMovement(scans: TrackingScan[]): Date | null {
  const moved = scans.find((s) => s.phase !== 'pre_transit');
  return moved?.occurredAt ?? null;
}

async function appendScans(
  shipmentId: string,
  newScans: TrackingScan[],
  provider: string,
  now: Date,
  db: Db,
): Promise<number> {
  let written = 0;
  for (const scan of newScans) {
    const inserted = await db
      .insert(s.shipmentEvents)
      .values({
        shipmentId,
        occurredAt: scan.occurredAt,
        status: scan.phase,
        message: scan.message,
        location: scan.location,
        source: provider,
        fingerprint: scan.fingerprint,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: s.shipmentEvents.id });
    written += inserted.length;
  }
  return written;
}

/** The alert with no row behind it. `alerts.ts` has the argument. */
function planReturnGaps(
  all: { shipment: ShipmentRecord; show: typeof s.shows.$inferSelect }[],
  now: Date,
): PlannedShipmentAlert[] {
  const byShow = new Map<string, { show: typeof s.shows.$inferSelect; out: boolean; back: boolean }>();
  for (const r of all) {
    const entry = byShow.get(r.show.id) ?? { show: r.show, out: false, back: false };
    if (r.shipment.direction === 'outbound') entry.out = true;
    else entry.back = true;
    byShow.set(r.show.id, entry);
  }
  const out: PlannedShipmentAlert[] = [];
  for (const { show, out: hasOut, back } of byShow.values()) {
    const alert = planReturnGapAlert(show, hasOut, back, now);
    if (alert) out.push(alert);
  }
  return out;
}

/**
 * Who hears about a crate.
 *
 * The owner when there is one, and the show's runners when there is not — §5a's
 * third correction, which was written about deadlines and is the same rule here.
 * Unlike a flight there is no traveler to fall back on: freight belongs to
 * nobody by default, which is precisely why the unowned case had to be the one
 * that escalates rather than the one that goes quiet.
 */
async function writeShipmentAlerts(
  orgId: string,
  planned: PlannedShipmentAlert[],
  now: Date,
  db: Db,
): Promise<number> {
  if (planned.length === 0) return 0;

  const runners = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  let written = 0;
  for (const alert of planned) {
    const recipients = new Set<string>(runners.map((r) => r.id));
    if (alert.ownerId) recipients.add(alert.ownerId);

    for (const userId of recipients) {
      const inserted = await db
        .insert(s.alerts)
        .values({
          orgId,
          showId: alert.showId,
          userId,
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          dedupeKey: `${alert.dedupeKey}:${userId}`,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: s.alerts.id });
      written += inserted.length;
    }
  }
  return written;
}

/** Shows with outbound freight but nothing recorded coming back. For the CLI. */
export async function showsMissingReturnLeg(orgId: string, now: Date, db: Db = getDb()) {
  const rows = await db
    .select({ show: s.shows, shipment: s.shipments })
    .from(s.shipments)
    .innerJoin(s.shows, eq(s.shipments.showId, s.shows.id))
    .where(and(eq(s.shows.orgId, orgId), isNotNull(s.shows.moveOutAt)));
  return planReturnGaps(rows, now);
}
