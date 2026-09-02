import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { estimateDrayage } from '@/lib/drayage/estimate';
import { estimable, isDrayable } from '@/lib/drayage/store';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { canSeeCost } from './access';
import {
  rollUpShowCost,
  summarizePortfolio,
  type CostInputs,
  type PortfolioCost,
  type ShowCost,
} from './rollup';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of the rollup, and the sentence §1 stakes the product on: this
 * file is a handful of `select`s. Nobody assembles a show's cost, because the
 * app already booked the flight, held the hotel row and tracked the crate.
 *
 * It loads **every** show's inputs in a fixed number of queries rather than
 * looping a show at a time, for the ordinary reason and one specific one: the
 * portfolio is the screen where a per-show loop would quietly become sixty
 * round trips, and the per-show page is the same code path so it cannot drift
 * from the portfolio's arithmetic. A show whose page says $54,120 and whose row
 * in the portfolio says something else is worse than either number alone.
 *
 * Org-scoping is through the show, as everywhere the subject is a show.
 */

async function loadCostInputs(shows: (typeof s.shows.$inferSelect)[], db: Db): Promise<Map<string, CostInputs>> {
  const ids = shows.map((sh) => sh.id);
  const inputs = new Map<string, CostInputs>();
  for (const show of shows) {
    inputs.set(show.id, {
      show: { id: show.id, name: show.name, startsOn: show.startsOn, endsOn: show.endsOn },
      expenses: [],
      bookings: [],
      enteredFlights: [],
      lodgings: [],
      shipments: [],
      drayage: null,
      collateral: [],
      attendees: [],
    });
  }
  if (ids.length === 0) return inputs;

  const [
    expenses,
    bookings,
    flights,
    lodgings,
    guests,
    shipments,
    rateCards,
    allocations,
    attendees,
  ] =
    await Promise.all([
      db.select().from(s.expenses).where(inArray(s.expenses.showId, ids)),

      // Through the travel request, because that is what carries the show. A
      // dry-run booking comes back too: `rollup.ts` is where `live` is read, so
      // the count of dry runs can be *reported* rather than silently dropped.
      db
        .select({
          showId: s.travelRequests.showId,
          chargedCents: s.bookings.chargedCents,
          creditAppliedCents: s.bookings.creditAppliedCents,
          live: s.bookings.live,
          cancelledAt: s.bookings.cancelledAt,
        })
        .from(s.bookings)
        .innerJoin(s.travelRequests, eq(s.bookings.travelRequestId, s.travelRequests.id))
        .where(inArray(s.travelRequests.showId, ids)),

      // Only the flights nobody bought here. A materialized flight carries the
      // booking's own charged figure on segment 0, so counting both would bill
      // every agent-bought ticket twice.
      db
        .select({
          showId: s.flights.showId,
          userId: s.flights.userId,
          priceCents: s.flights.priceCents,
          bookingId: s.flights.bookingId,
        })
        .from(s.flights)
        .where(inArray(s.flights.showId, ids)),

      db.select().from(s.lodgings).where(inArray(s.lodgings.showId, ids)),
      db
        .select({ lodgingId: s.lodgingGuests.lodgingId, userId: s.lodgingGuests.userId })
        .from(s.lodgingGuests)
        .innerJoin(s.lodgings, eq(s.lodgingGuests.lodgingId, s.lodgings.id))
        .where(inArray(s.lodgings.showId, ids)),

      db.select().from(s.shipments).where(inArray(s.shipments.showId, ids)),

      // The drayage estimate is built here, off the shipment rows this query
      // already returns, rather than by a second caller loading them again. Two
      // code paths that each compute the largest line on a show is exactly how
      // the portfolio and the show's own tab end up disagreeing — the reason
      // this file loads everything at once in the first place.
      db.select().from(s.drayageRateCards).where(inArray(s.drayageRateCards.showId, ids)),

      // Consumption comes off the append-only ledger, not off `quantity_allocated`
      // — promising stock is a claim and issuing it is a movement (§5h), and only
      // the second one costs anything.
      db
        .select({
          showId: s.collateralAllocations.showId,
          unitCostCents: s.collateralItems.unitCostCents,
          delta: sql<number>`coalesce(sum(${s.collateralEntries.delta}), 0)`,
        })
        .from(s.collateralAllocations)
        .innerJoin(
          s.collateralItems,
          eq(s.collateralAllocations.collateralItemId, s.collateralItems.id),
        )
        .leftJoin(
          s.collateralEntries,
          eq(s.collateralEntries.allocationId, s.collateralAllocations.id),
        )
        .where(inArray(s.collateralAllocations.showId, ids))
        .groupBy(s.collateralAllocations.id, s.collateralItems.unitCostCents),

      db.select().from(s.showAttendees).where(inArray(s.showAttendees.showId, ids)),
    ]);

  const guestCount = new Map<string, number>();
  const lodgingUsers = new Map<string, Set<string>>();
  for (const g of guests) {
    guestCount.set(g.lodgingId, (guestCount.get(g.lodgingId) ?? 0) + 1);
  }

  const lodgingShow = new Map(lodgings.map((l) => [l.id, l.showId]));
  for (const g of guests) {
    const showId = lodgingShow.get(g.lodgingId);
    if (!showId) continue;
    const set = lodgingUsers.get(showId) ?? new Set<string>();
    set.add(g.userId);
    lodgingUsers.set(showId, set);
  }

  const travellers = new Map<string, Set<string>>();
  for (const f of flights) {
    if (!f.showId) continue;
    const set = travellers.get(f.showId) ?? new Set<string>();
    set.add(f.userId);
    travellers.set(f.showId, set);
  }

  for (const e of expenses) {
    inputs.get(e.showId)?.expenses.push({
      category: e.category,
      amountCents: e.amountCents,
      paid: e.paid,
    });
  }
  for (const b of bookings) {
    if (!b.showId) continue;
    inputs.get(b.showId)?.bookings.push({
      chargedCents: b.chargedCents,
      creditAppliedCents: b.creditAppliedCents,
      live: b.live,
      cancelledAt: b.cancelledAt,
    });
  }
  for (const f of flights) {
    if (!f.showId || f.bookingId !== null) continue;
    inputs.get(f.showId)?.enteredFlights.push({ priceCents: f.priceCents });
  }
  for (const l of lodgings) {
    const nights =
      l.checkIn && l.checkOut
        ? Math.max(1, Math.round((l.checkOut.getTime() - l.checkIn.getTime()) / 86_400_000))
        : null;
    inputs.get(l.showId)?.lodgings.push({
      nightlyRateCents: l.nightlyRateCents,
      nights,
      guests: guestCount.get(l.id) ?? 0,
    });
  }
  const freightByShow = new Map<string, ReturnType<typeof estimable>[]>();
  for (const sh of shipments) {
    // The carrier's own charge counts for every row, parcel included: a $180
    // overnight to a hotel is real freight spend on this show. Only the drayage
    // estimate excludes parcels, because no contractor lifts one.
    inputs.get(sh.showId)?.shipments.push({ costCents: sh.costCents, direction: sh.direction });
    if (!isDrayable(sh)) continue;
    const list = freightByShow.get(sh.showId) ?? [];
    list.push(estimable(sh));
    freightByShow.set(sh.showId, list);
  }
  // Every show gets a drayage estimate, including the ones with no card and the
  // ones with no freight — `estimateDrayage` answers both with a sentence rather
  // than a zero, and a null here would put that decision back in the rollup.
  const cardByShow = new Map(rateCards.map((c) => [c.showId, c] as const));
  for (const show of shows) {
    const card = cardByShow.get(show.id);
    const input = inputs.get(show.id);
    if (input) {
      input.drayage = estimateDrayage(
        card
          ? {
              advanceCwtCents: card.advanceCwtCents,
              showSiteCwtCents: card.showSiteCwtCents,
              minimumLb: card.minimumLb,
              basis: card.basis,
              specialHandlingPct: card.specialHandlingPct,
              overtimePct: card.overtimePct,
              confirmedAt: card.confirmedAt,
            }
          : null,
        freightByShow.get(show.id) ?? [],
      );
    }
  }

  for (const a of allocations) {
    // `issued` is a negative delta and `returned` a positive one, so what the
    // show actually consumed is the negation of the sum — and an allocation
    // nobody has picked yet nets to zero rather than to a cost.
    inputs.get(a.showId)?.collateral.push({
      issued: -Number(a.delta),
      unitCostCents: a.unitCostCents,
    });
  }
  for (const a of attendees) {
    const hasTravel =
      (travellers.get(a.showId)?.has(a.userId) ?? false) ||
      (lodgingUsers.get(a.showId)?.has(a.userId) ?? false);
    inputs.get(a.showId)?.attendees.push({
      // The §5e rule, in a cost model: a `confirmed` typed by somebody else is
      // hearsay, and here it would inflate attendee-days and invent a hole in
      // the travel line for a trip nobody is taking.
      confirmed: a.status === 'confirmed' && a.respondedAt !== null,
      arrivesOn: a.arrivesOn,
      departsOn: a.departsOn,
      hasTravel,
    });
  }

  return inputs;
}

export async function getShowCost(
  actor: Actor,
  showId: string,
  opts: { asOf?: Date } = {},
  db: Db = getDb(),
): Promise<ShowCost> {
  if (!canSeeCost(actor)) {
    throw new ForbiddenError('A show’s cost is every colleague’s fare in one figure.');
  }
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');
  const inputs = await loadCostInputs([show], db);
  return rollUpShowCost(inputs.get(show.id)!, opts.asOf ?? new Date());
}

export type CostPortfolio = PortfolioCost & {
  /** Cost only means something beside what the show is: a prospect has none yet. */
  statuses: Map<string, string>;
};

export async function getCostPortfolio(
  actor: Actor,
  opts: { asOf?: Date } = {},
  db: Db = getDb(),
): Promise<CostPortfolio> {
  if (!canSeeCost(actor)) {
    throw new ForbiddenError('A show’s cost is every colleague’s fare in one figure.');
  }
  // Prospects and declined shows are excluded rather than shown at zero: a show
  // nobody committed to has not cost anything, and a $0 row in a cost table
  // reads as a bargain instead of as an absence. §5d's rule about an unplanned
  // checklist, applied to money.
  const shows = await db
    .select()
    .from(s.shows)
    .where(
      and(
        eq(s.shows.orgId, actor.orgId),
        inArray(s.shows.status, ['committed', 'planning', 'ready', 'live', 'complete']),
      ),
    );

  const inputs = await loadCostInputs(shows, db);
  const asOf = opts.asOf ?? new Date();
  const costs = shows.map((show) => rollUpShowCost(inputs.get(show.id)!, asOf));
  return {
    ...summarizePortfolio(costs),
    statuses: new Map(shows.map((sh) => [sh.id, sh.status])),
  };
}
