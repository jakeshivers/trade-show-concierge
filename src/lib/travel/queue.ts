import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { type Actor } from '@/lib/auth/actor';
import { travelerScope } from '@/lib/shows/visibility';
import type { RequestStatus } from './machine';
import { offerStanding, type OfferStanding } from './review';

type Db = ReturnType<typeof getDb>;

/**
 * The read layer for the travel screens.
 *
 * Same posture as `src/lib/shows/store.ts`, for the same reason: **every query
 * is org-scoped in its predicate**, and per-person travel is narrowed by
 * `travelerScope` at the source rather than after loading. A Member's approvals
 * page does not receive a colleague's fare and then decline to render it — the
 * rows never reach the process.
 *
 * The one addition over the shows store is that a travel row is not readable on
 * its own. "Awaiting approval, $612" is not enough to decide on; the approver
 * needs to know whether $612 is a price or a ceiling, which depends on the
 * offer's expiry and any hold placed against it. So the queue joins the selected
 * snapshot and the hold, and hands both to `offerStanding` — the same function
 * `agent.ts` uses to decide what approving does.
 */

export class NotFoundError extends Error {
  constructor() {
    super('No such travel request in this workspace');
    this.name = 'NotFoundError';
  }
}

export type TravelRequestSummary = {
  id: string;
  status: RequestStatus;
  originAirport: string;
  destinationAirport: string;
  earliestDeparture: Date;
  latestArrival: Date;
  createdAt: Date;
  traveler: { id: string; fullName: string; email: string };
  requester: { id: string; fullName: string };
  show: { id: string; name: string; timezone: string } | null;
  /** The fare under consideration, from the selected snapshot. */
  quotedCents: number | null;
  currency: string;
  /** Null until an offer has actually been selected. */
  standing: OfferStanding | null;
  /** True when the parser's reading has not been signed off. SCOPE.md §6a. */
  awaitingConstraintConfirmation: boolean;
  /**
   * How long this has been open, measured against the same instant that judged
   * every offer's standing in this batch. Computed here rather than in the
   * queue's JSX: a server component that reads the clock mid-render gets a
   * different answer on every re-render, and the rows would disagree with each
   * other about what "now" is.
   */
  ageMs: number;
};

/**
 * The requests this actor may see, newest first.
 *
 * `scope` narrows further *within* what they may see: a travel manager viewing
 * their own list should not be shown the whole org by default, so the screens
 * pass `'mine'` for the personal list and `'all'` for the queue.
 */
export async function listRequests(
  actor: Actor,
  opts: { scope?: 'mine' | 'all'; statuses?: RequestStatus[] } = {},
  db: Db = getDb(),
): Promise<TravelRequestSummary[]> {
  const visible = travelerScope(actor);
  // A member is narrowed to themselves whatever they ask for; `scope: 'all'` is
  // a request, not an authorization.
  const traveler =
    visible.kind === 'self' ? visible.userId : opts.scope === 'mine' ? actor.userId : null;

  const where = [eq(s.travelRequests.orgId, actor.orgId)];
  if (traveler) where.push(eq(s.travelRequests.travelerId, traveler));
  if (opts.statuses?.length) where.push(inArray(s.travelRequests.status, opts.statuses));

  const rows = await db
    .select({ request: s.travelRequests, traveler: s.users, show: s.shows })
    .from(s.travelRequests)
    .innerJoin(s.users, eq(s.travelRequests.travelerId, s.users.id))
    .leftJoin(s.shows, eq(s.travelRequests.showId, s.shows.id))
    .where(and(...where))
    .orderBy(desc(s.travelRequests.createdAt));

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.request.id);

  const [snapshots, holds, requesters] = await Promise.all([
    db
      .select()
      .from(s.offerSnapshots)
      .where(
        and(inArray(s.offerSnapshots.travelRequestId, ids), eq(s.offerSnapshots.selected, true)),
      ),
    db.select().from(s.bookings).where(inArray(s.bookings.travelRequestId, ids)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(inArray(s.users.id, [...new Set(rows.map((r) => r.request.requesterId))])),
  ]);

  const now = new Date();

  return rows.map(({ request, traveler: t, show }) => {
    const snapshot = snapshots.find((x) => x.travelRequestId === request.id) ?? null;
    const hold = holds.find((b) => b.travelRequestId === request.id && b.isHold) ?? null;

    return {
      id: request.id,
      status: request.status as RequestStatus,
      originAirport: request.originAirport,
      destinationAirport: request.destinationAirport,
      earliestDeparture: request.earliestDeparture,
      latestArrival: request.latestArrival,
      createdAt: request.createdAt,
      traveler: { id: t.id, fullName: t.fullName, email: t.email },
      requester: {
        id: request.requesterId,
        fullName:
          requesters.find((u) => u.id === request.requesterId)?.fullName ?? 'Unknown',
      },
      show: show ? { id: show.id, name: show.name, timezone: show.timezone } : null,
      quotedCents: snapshot?.totalCents ?? null,
      currency: snapshot?.currency ?? 'USD',
      standing: snapshot
        ? offerStanding({ offerExpiresAt: snapshot.offerExpiresAt, hold }, now)
        : null,
      awaitingConstraintConfirmation:
        request.rawRequestText !== null && request.constraintsConfirmedAt === null,
      ageMs: now.getTime() - request.createdAt.getTime(),
    };
  });
}

/**
 * The approvals queue: everything waiting on a human, oldest first.
 *
 * Oldest first rather than newest, because this is a work queue and the thing
 * that has been waiting longest is the thing whose offer is deadest.
 *
 * Deliberately *not* filtered to requests this actor may personally approve.
 * A travel manager's own pending request belongs on the queue — they need to see
 * that it is stuck and that somebody else has to move it — and the per-row
 * controls carry the reason it is not theirs to sign. Filtering it out would
 * make the queue quietly disagree with the request's own page. SCOPE.md §3.
 */
export async function approvalsQueue(actor: Actor, db: Db = getDb()) {
  return listRequests(actor, { scope: 'all', statuses: ['pending_approval'] }, db);
}

/**
 * One request, org-scoped, with everything a decision needs.
 *
 * The heavy history — every offer seen, every verdict, the whole timeline —
 * comes from `getAuditTrail`, which already assembles it and is read-only by
 * construction. Rebuilding a second, thinner version of that here would create
 * a second answer to "why did this cost what it cost".
 */
export async function loadRequest(actor: Actor, id: string, db: Db = getDb()) {
  const row = await db.query.travelRequests.findFirst({
    // Org in the predicate, never loaded-then-checked.
    where: and(eq(s.travelRequests.id, id), eq(s.travelRequests.orgId, actor.orgId)),
  });
  if (!row) throw new NotFoundError();

  const visible = travelerScope(actor);
  if (visible.kind === 'self' && row.travelerId !== visible.userId && row.requesterId !== actor.userId) {
    // Indistinguishable from a request that does not exist, on purpose: a
    // "forbidden" here would confirm that a colleague is flying somewhere.
    throw new NotFoundError();
  }

  const [snapshot] = await db
    .select()
    .from(s.offerSnapshots)
    .where(and(eq(s.offerSnapshots.travelRequestId, id), eq(s.offerSnapshots.selected, true)))
    .limit(1);

  const [hold] = await db
    .select()
    .from(s.bookings)
    .where(and(eq(s.bookings.travelRequestId, id), eq(s.bookings.isHold, true)))
    .limit(1);

  return {
    request: row,
    snapshot: snapshot ?? null,
    standing: snapshot
      ? offerStanding({ offerExpiresAt: snapshot.offerExpiresAt, hold: hold ?? null }, new Date())
      : null,
  };
}

/** Cost centers the actor may book against, for the request form. */
export async function costCentersFor(actor: Actor, db: Db = getDb()) {
  return db
    .select({ id: s.costCenters.id, name: s.costCenters.name, code: s.costCenters.code })
    .from(s.costCenters)
    .where(eq(s.costCenters.orgId, actor.orgId))
    .orderBy(asc(s.costCenters.name));
}

/**
 * Who this actor may open a request for. A member gets themselves and nobody
 * else — booking travel on another person's behalf is a travel-manager
 * capability, and `submitTravelRequest` enforces it regardless of what the form
 * offers.
 */
export async function travelersFor(actor: Actor, db: Db = getDb()) {
  // `homeAirport` comes back with each traveler because the request form
  // prefills "From" with **the traveler's** default rather than the requester's
  // — a travel manager filing for somebody else is asking where *they* leave
  // from. It is on this query rather than fetched per selection so switching the
  // dropdown does not need a round trip.
  const columns = {
    id: s.users.id,
    fullName: s.users.fullName,
    email: s.users.email,
    homeAirport: s.users.homeAirport,
  };
  const scope = travelerScope(actor);
  return db
    .select(columns)
    .from(s.users)
    .where(
      scope.kind === 'self'
        ? eq(s.users.id, actor.userId)
        : eq(s.users.orgId, actor.orgId),
    )
    .orderBy(asc(s.users.fullName));
}

/** Upcoming shows, so a request can be attached to the trip it is for. */
export async function showsForRequest(actor: Actor, db: Db = getDb()) {
  return db
    .select({
      id: s.shows.id,
      name: s.shows.name,
      startsOn: s.shows.startsOn,
      airportCode: s.shows.airportCode,
      timezone: s.shows.timezone,
    })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId))
    .orderBy(asc(s.shows.startsOn));
}
