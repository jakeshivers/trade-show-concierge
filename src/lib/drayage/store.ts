import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { canConfirmRateCard, canEditRateCard, canRecordHandling } from './access';
import { validateRateCard, type RateCardDraft } from './edit';
import {
  estimateDrayage,
  type DrayageEstimate,
  type EstimableShipment,
  type HandlingKind,
  type RateCard,
} from './estimate';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half. Org-scoped through the show, the way `shipping/store.ts` is,
 * and every decision it makes was made by a pure function above it.
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

export type RateCardRow = typeof s.drayageRateCards.$inferSelect;

function toModel(row: RateCardRow): RateCard {
  return {
    advanceCwtCents: row.advanceCwtCents,
    showSiteCwtCents: row.showSiteCwtCents,
    minimumLb: row.minimumLb,
    basis: row.basis,
    specialHandlingPct: row.specialHandlingPct,
    overtimePct: row.overtimePct,
    confirmedAt: row.confirmedAt,
  };
}

/**
 * `weight_lb` is `numeric`, so it arrives as a string and **null stays null**.
 * `Number(null)` is 0, and a zero here would silently delete a crate from the
 * estimate while the estimate still read complete — `estimate.ts`'s refusal 3,
 * which lives or dies on this one line.
 */
function weightOf(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type ShowDrayage = {
  showId: string;
  showName: string;
  card: RateCardRow | null;
  estimate: DrayageEstimate;
  /**
   * The freight rows as the estimator saw them.
   *
   * Carried so the Logistics screen can render each crate's packing without a
   * second query and without widening `TrackedShipment`, which is the shipping
   * module's view model and has no business holding a pricing field. A crate the
   * estimator could not price is in here too — that is the point.
   */
  freight: EstimableShipment[];
};

export async function getShowDrayage(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<ShowDrayage> {
  const show = await requireShow(actor, showId, db);
  const [card, shipments] = await Promise.all([
    db.query.drayageRateCards.findFirst({ where: eq(s.drayageRateCards.showId, showId) }),
    db
      .select()
      .from(s.shipments)
      .where(eq(s.shipments.showId, showId))
      .orderBy(asc(s.shipments.mustArriveBy)),
  ]);

  const freight = shipments.filter(isDrayable).map(estimable);
  return {
    showId,
    showName: show.name,
    card: card ?? null,
    estimate: estimateDrayage(card ? toModel(card) : null, freight),
    freight,
  };
}

/**
 * Is this row something the general contractor will ever put a forklift under?
 *
 * A `direct` consignment is a parcel to a hotel, an office or a person: it never
 * reaches a show dock, no contractor handles it, and there is no drayage on it
 * to estimate. The estimator must never *see* one, which is why this filters
 * rather than the estimator branching — a parcel reaching `estimateDrayage`
 * lands in the `no_rate` gap and reports "1 crate consigned somewhere this card
 * does not price", turning a correct figure into a floor over freight that does
 * not exist. `EstimableShipment.consignment` stays narrow so the compiler is
 * what enforces this rather than a comment.
 *
 * Note what this deliberately does *not* key on: the size of the box. A FedEx
 * carton addressed to show-site receiving **is** drayed — contractors bill small
 * packages, usually at a flat rate per piece — so it stays in, and the exemption
 * is about the dock rather than the weight.
 */
export function isDrayable(row: ShipmentRow): row is DrayableRow {
  return row.consignment !== 'direct';
}

type ShipmentRow = typeof s.shipments.$inferSelect;
type DrayableRow = ShipmentRow & { consignment: Exclude<ShipmentRow['consignment'], 'direct'> };

export function estimable(row: DrayableRow): EstimableShipment {
  return {
    id: row.id,
    description: row.description,
    direction: row.direction,
    consignment: row.consignment,
    weightLb: weightOf(row.weightLb),
    handling: row.handling,
  };
}

/**
 * Every show's drayage in a fixed number of queries.
 *
 * `cost/store.ts`'s posture, and for its stated reason: the portfolio and a
 * show's own tab must not be able to disagree, which they can the moment one of
 * them computes a figure the other loads.
 */
export async function getPortfolioDrayage(
  actor: Actor,
  db: Db = getDb(),
): Promise<ShowDrayage[]> {
  const shows = await db
    .select({ id: s.shows.id, name: s.shows.name })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId))
    .orderBy(asc(s.shows.startsOn));
  if (shows.length === 0) return [];
  const ids = shows.map((sh) => sh.id);

  const [cards, shipments] = await Promise.all([
    db.select().from(s.drayageRateCards).where(inArray(s.drayageRateCards.showId, ids)),
    db.select().from(s.shipments).where(inArray(s.shipments.showId, ids)),
  ]);

  const cardByShow = new Map(cards.map((c) => [c.showId, c] as const));
  const freightByShow = new Map<string, EstimableShipment[]>();
  for (const row of shipments) {
    if (!isDrayable(row)) continue;
    const list = freightByShow.get(row.showId) ?? [];
    list.push(estimable(row));
    freightByShow.set(row.showId, list);
  }

  return shows.map((show) => {
    const card = cardByShow.get(show.id) ?? null;
    const freight = freightByShow.get(show.id) ?? [];
    return {
      showId: show.id,
      showName: show.name,
      card,
      estimate: estimateDrayage(card ? toModel(card) : null, freight),
      freight,
    };
  });
}

/* --------------------------------- writes ---------------------------------- */

/**
 * Create or replace this show's card.
 *
 * One row per show and an upsert rather than a history, which is the opposite
 * call from `org_login_policies` and `crm_sync_runs` and is deliberate: a rate
 * card is not a decision somebody made, it is a transcription of a document. The
 * thing worth keeping a record of is whether it was *checked* — which
 * `confirmed_at` holds, and which any edit withdraws.
 */
export async function saveRateCard(
  actor: Actor,
  showId: string,
  draft: RateCardDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canEditRateCard(actor)) throw new ForbiddenError('set a drayage rate card');
  await requireShow(actor, showId, db);
  const valid = validateRateCard(draft);

  await db
    .insert(s.drayageRateCards)
    .values({ showId, ...valid, confirmedAt: null, confirmedById: null, updatedAt: now })
    .onConflictDoUpdate({
      target: s.drayageRateCards.showId,
      // Editing withdraws the confirmation, exactly as re-dating a deadline
      // does: a confirmation is an assertion about the numbers that were there
      // when somebody looked, and carrying it onto different numbers would let
      // an edit launder a guess into a figure quoted as checked.
      set: { ...valid, confirmedAt: null, confirmedById: null, updatedAt: now },
    });
}

export async function setRateCardConfirmed(
  actor: Actor,
  showId: string,
  confirmed: boolean,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canConfirmRateCard(actor)) {
    throw new ForbiddenError('confirm a drayage rate card against this year’s manual');
  }
  await requireShow(actor, showId, db);
  await db
    .update(s.drayageRateCards)
    .set({
      confirmedAt: confirmed ? now : null,
      confirmedById: confirmed ? actor.userId : null,
      updatedAt: now,
    })
    .where(eq(s.drayageRateCards.showId, showId));
}

export async function deleteRateCard(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canEditRateCard(actor)) throw new ForbiddenError('delete a drayage rate card');
  await requireShow(actor, showId, db);
  await db.delete(s.drayageRateCards).where(eq(s.drayageRateCards.showId, showId));
}

/** How a crate is packed. Anybody, because only somebody next to it knows. */
export async function setShipmentHandling(
  actor: Actor,
  shipmentId: string,
  handling: HandlingKind,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canRecordHandling()) throw new ForbiddenError('record how a crate is packed');
  const [row] = await db
    .select({ id: s.shipments.id })
    .from(s.shipments)
    .innerJoin(s.shows, eq(s.shipments.showId, s.shows.id))
    .where(and(eq(s.shipments.id, shipmentId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('shipment');

  await db
    .update(s.shipments)
    .set({ handling, updatedAt: now })
    .where(eq(s.shipments.id, shipmentId));
}
