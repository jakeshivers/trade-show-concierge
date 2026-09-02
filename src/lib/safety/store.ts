import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { canRelayAnswer, canSeeRollCall, canStartRollCall } from './access';
import { presenceFor, type PresenceEvidence } from './presence';
import {
  buildRollCall,
  type RollCall,
  type SafetyResponse,
  type SafetyStanding,
} from './rollcall';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half. Org-scoped through the show.
 *
 * The read builds every person's evidence in a **fixed number of queries** and
 * then hands it to pure functions — the posture since step 8, and load-bearing
 * here for a reason the other modules did not have: this screen is read while
 * something is going wrong, so a per-person loop is not merely slow, it is slow
 * at the one moment nobody can wait.
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

export type ShowRollCall = RollCall & { showId: string; showName: string };

export async function getRollCall(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<ShowRollCall> {
  if (!canSeeRollCall()) throw new ForbiddenError('read a roll call');
  const show = await requireShow(actor, showId, db);

  const [attendees, checkIns, flights, stays, openCheck] = await Promise.all([
    db
      .select({ attendee: s.showAttendees, user: s.users })
      .from(s.showAttendees)
      .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
      .where(eq(s.showAttendees.showId, showId)),

    // The strongest evidence in the product, and the only one about *the
    // building*. Joined through the shift because presence hangs off a shift
    // rather than a show.
    db
      .select({ userId: s.shiftPresence.userId, checkedInAt: s.shiftPresence.checkedInAt })
      .from(s.shiftPresence)
      .innerJoin(s.boothShifts, eq(s.shiftPresence.shiftId, s.boothShifts.id))
      .where(eq(s.boothShifts.showId, showId)),

    db.select().from(s.flights).where(eq(s.flights.showId, showId)),

    db
      .select({
        userId: s.lodgingGuests.userId,
        checkIn: s.lodgings.checkIn,
        checkOut: s.lodgings.checkOut,
      })
      .from(s.lodgingGuests)
      .innerJoin(s.lodgings, eq(s.lodgingGuests.lodgingId, s.lodgings.id))
      .where(eq(s.lodgings.showId, showId)),

    db.query.safetyChecks.findFirst({
      where: eq(s.safetyChecks.showId, showId),
      orderBy: desc(s.safetyChecks.startedAt),
    }),
  ]);

  const latestCheckIn = new Map<string, Date>();
  for (const c of checkIns) {
    const held = latestCheckIn.get(c.userId);
    if (!held || c.checkedInAt.getTime() > held.getTime()) {
      latestCheckIn.set(c.userId, c.checkedInAt);
    }
  }

  const legsByUser = new Map<string, PresenceEvidence['flights']>();
  for (const f of flights) {
    const list = legsByUser.get(f.userId) ?? [];
    list.push({
      direction: f.legDirection,
      status: f.status,
      // The carrier's live view where there is one, and the plan where there is
      // not — §5f's rule that an unchecked flight is not an on-time flight is
      // about the *status*, which is carried through untouched rather than
      // second-guessed here.
      departure: f.estimatedDeparture ?? f.scheduledDeparture,
      arrival: f.estimatedArrival ?? f.scheduledArrival,
      destinationAirport: f.destinationAirport,
    });
    legsByUser.set(f.userId, list);
  }

  const staysByUser = new Map<string, PresenceEvidence['lodging']>();
  for (const l of stays) {
    const list = staysByUser.get(l.userId) ?? [];
    list.push({ checkIn: l.checkIn, checkOut: l.checkOut });
    staysByUser.set(l.userId, list);
  }

  const evidence: PresenceEvidence[] = attendees.map(({ attendee, user }) => ({
    userId: user.id,
    fullName: user.fullName,
    attendeeStatus: attendee.status,
    arrivesOn: attendee.arrivesOn,
    departsOn: attendee.departsOn,
    lastCheckInAt: latestCheckIn.get(user.id) ?? null,
    flights: legsByUser.get(user.id) ?? [],
    lodging: staysByUser.get(user.id) ?? [],
    phone: user.phone,
    email: user.email,
  }));

  const responses: SafetyResponse[] = openCheck
    ? (
        await db
          .select()
          .from(s.safetyResponses)
          .where(eq(s.safetyResponses.checkId, openCheck.id))
      ).map((r) => ({
        userId: r.userId,
        standing: r.standing,
        respondedAt: r.respondedAt,
        recordedById: r.recordedById ?? r.userId,
        note: r.note,
      }))
    : [];

  const call = buildRollCall(
    openCheck
      ? {
          id: openCheck.id,
          showId: openCheck.showId,
          startedAt: openCheck.startedAt,
          startedById: openCheck.startedById ?? '',
          note: openCheck.note,
        }
      : null,
    evidence,
    evidence.map((e) => presenceFor(e, asOf)),
    responses,
  );

  return { ...call, showId, showName: show.name };
}

/** Every show with somebody travelling, for the portfolio view. */
export async function getRollCallPortfolio(
  actor: Actor,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<ShowRollCall[]> {
  const shows = await db
    .select({ id: s.shows.id })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId));
  return Promise.all(shows.map((sh) => getRollCall(actor, sh.id, asOf, db)));
}

/* --------------------------------- writes ---------------------------------- */

export async function startRollCall(
  actor: Actor,
  showId: string,
  note: string | null,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canStartRollCall(actor)) throw new ForbiddenError('start a roll call');
  await requireShow(actor, showId, db);

  // Any earlier one is closed first. Two open roll calls on one show means two
  // sets of responses and a headcount that depends on which somebody looked at.
  await db
    .update(s.safetyChecks)
    .set({ closedAt: now, closedById: actor.userId })
    .where(and(eq(s.safetyChecks.showId, showId), isNull(s.safetyChecks.closedAt)));

  const [row] = await db
    .insert(s.safetyChecks)
    .values({ orgId: actor.orgId, showId, startedById: actor.userId, startedAt: now, note })
    .returning({ id: s.safetyChecks.id });
  return row;
}

export async function closeRollCall(
  actor: Actor,
  checkId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canStartRollCall(actor)) throw new ForbiddenError('close a roll call');
  const [row] = await db
    .select({ id: s.safetyChecks.id })
    .from(s.safetyChecks)
    .where(and(eq(s.safetyChecks.id, checkId), eq(s.safetyChecks.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('roll call');

  // Closing records that whoever started it considered it finished. It
  // deliberately does not mark anybody as anything: an unanswered name at the
  // moment of closing stays an unanswered name in the record forever.
  await db
    .update(s.safetyChecks)
    .set({ closedAt: now, closedById: actor.userId })
    .where(eq(s.safetyChecks.id, checkId));
}

/**
 * Record an answer.
 *
 * One function for both cases on purpose — the difference between answering for
 * yourself and relaying somebody else's answer is `recordedById`, which is a
 * *fact about the answer* rather than a branch in the permission. Splitting it
 * into two entry points would invite one of them to forget the column.
 */
export async function recordSafetyResponse(
  actor: Actor,
  checkId: string,
  userId: string,
  standing: SafetyStanding,
  note: string | null,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canRelayAnswer()) throw new ForbiddenError('record a safety response');

  const [check] = await db
    .select({ id: s.safetyChecks.id })
    .from(s.safetyChecks)
    .where(and(eq(s.safetyChecks.id, checkId), eq(s.safetyChecks.orgId, actor.orgId)));
  if (!check) throw new NotFoundError('roll call');

  const [subject] = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.id, userId), eq(s.users.orgId, actor.orgId)));
  if (!subject) throw new NotFoundError('person');

  // Append-only: somebody who said they need help and later says they are fine
  // has said two things, and the first is part of the record.
  await db.insert(s.safetyResponses).values({
    checkId,
    userId,
    standing,
    respondedAt: now,
    recordedById: actor.userId,
    note,
  });
}

export type RollCallHistory = typeof s.safetyChecks.$inferSelect;

export async function listRollCalls(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<RollCallHistory[]> {
  return db
    .select()
    .from(s.safetyChecks)
    .where(and(eq(s.safetyChecks.showId, showId), eq(s.safetyChecks.orgId, actor.orgId)))
    .orderBy(desc(s.safetyChecks.startedAt));
}
