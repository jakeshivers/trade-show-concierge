import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { scoreChecklist, type Readiness } from '@/lib/readiness/score';
import { zonedToInstant } from '@/lib/datetime/zoned';
import {
  assertDecidable,
  validateIntake,
  statusAfter,
  type Decision,
  type IntakeDraft,
  type ShowStatus,
} from './intake';
import { planClone, type CloneOptions, type ClonePlan } from './clone';
import { canCloneShow, canDecideShow, travelerScope } from './visibility';

type Db = ReturnType<typeof getDb>;

/**
 * The read and write layer for the planning core.
 *
 * Two invariants it holds so no screen has to remember them:
 *
 * - **Every query is org-scoped at the source.** A show id arriving from a URL is
 *   loaded with `orgId` in the predicate, never loaded and then checked, so a
 *   forgotten check cannot leak another workspace's row.
 * - **Per-person travel is filtered by `travelerScope`**, not by what the page
 *   chooses to render. A Member fetching a show detail does not receive their
 *   colleagues' fares in the payload and then have them hidden by JSX.
 */

export class NotFoundError extends Error {
  constructor(what = 'show') {
    super(`No such ${what} in this workspace`);
    this.name = 'NotFoundError';
  }
}

/** A show's local start-of-day and end-of-day, as instants. */
const SHOW_DAY_START = '09:00:00';
const SHOW_DAY_END = '17:00:00';

/* ---------------------------------- list ----------------------------------- */

export type ShowListEntry = {
  id: string;
  name: string;
  status: ShowStatus;
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string;
  startsOn: Date;
  endsOn: Date;
  boothNumber: string | null;
  budgetCents: number | null;
  readiness: Readiness;
  taskCount: number;
  attendeeCount: number;
  /** Whether the actor is staffed on it — the "mine" filter, not a permission. */
  mine: boolean;
};

export async function listShows(
  actor: Actor,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<ShowListEntry[]> {
  const rows = await db
    .select()
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId))
    .orderBy(asc(s.shows.startsOn));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [tasks, attendees] = await Promise.all([
    db
      .select({
        showId: s.showTasks.showId,
        status: s.showTasks.status,
        weight: s.showTasks.weight,
        dueOn: s.showTasks.dueOn,
      })
      .from(s.showTasks)
      .where(inArray(s.showTasks.showId, ids)),
    db
      .select({ showId: s.showAttendees.showId, userId: s.showAttendees.userId })
      .from(s.showAttendees)
      .where(inArray(s.showAttendees.showId, ids)),
  ]);

  return rows.map((show) => {
    const mine = tasks.filter((t) => t.showId === show.id);
    const team = attendees.filter((a) => a.showId === show.id);
    return {
      id: show.id,
      name: show.name,
      status: show.status,
      city: show.city,
      region: show.region,
      country: show.country,
      timezone: show.timezone,
      startsOn: show.startsOn,
      endsOn: show.endsOn,
      boothNumber: show.boothNumber,
      budgetCents: show.budgetCents,
      readiness: scoreChecklist(mine, asOf),
      taskCount: mine.length,
      attendeeCount: team.length,
      mine: team.some((a) => a.userId === actor.userId),
    };
  });
}

/* --------------------------------- detail ---------------------------------- */

export type ShowDetail = Awaited<ReturnType<typeof getShowDetail>>;

export async function getShowDetail(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();

  const scope = travelerScope(actor);
  const mineOnly = scope.kind === 'self';

  const [tasks, attendees, deadlines, lodgings, flights, requests, shipments, reservations, sideEvents, decisions, expenses] =
    await Promise.all([
      db
        .select({ task: s.showTasks, assignee: s.users })
        .from(s.showTasks)
        .leftJoin(s.users, eq(s.showTasks.assigneeId, s.users.id))
        .where(eq(s.showTasks.showId, showId))
        .orderBy(asc(s.showTasks.sortOrder)),
      db
        .select({ attendee: s.showAttendees, user: s.users })
        .from(s.showAttendees)
        .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
        .where(eq(s.showAttendees.showId, showId))
        .orderBy(asc(s.users.fullName)),
      db
        .select({ deadline: s.showDeadlines, owner: s.users })
        .from(s.showDeadlines)
        .leftJoin(s.users, eq(s.showDeadlines.ownerId, s.users.id))
        .where(eq(s.showDeadlines.showId, showId))
        .orderBy(asc(s.showDeadlines.dueAt)),
      db.select().from(s.lodgings).where(eq(s.lodgings.showId, showId)),
      db
        .select({ flight: s.flights, traveler: s.users })
        .from(s.flights)
        .innerJoin(s.users, eq(s.flights.userId, s.users.id))
        .where(
          mineOnly
            ? and(eq(s.flights.showId, showId), eq(s.flights.userId, scope.userId))
            : eq(s.flights.showId, showId),
        )
        .orderBy(asc(s.flights.scheduledDeparture)),
      db
        .select({ request: s.travelRequests, traveler: s.users })
        .from(s.travelRequests)
        .innerJoin(s.users, eq(s.travelRequests.travelerId, s.users.id))
        .where(
          mineOnly
            ? and(eq(s.travelRequests.showId, showId), eq(s.travelRequests.travelerId, scope.userId))
            : eq(s.travelRequests.showId, showId),
        )
        .orderBy(desc(s.travelRequests.createdAt)),
      db.select().from(s.shipments).where(eq(s.shipments.showId, showId)),
      db
        .select({ reservation: s.assetReservations, asset: s.assets })
        .from(s.assetReservations)
        .innerJoin(s.assets, eq(s.assetReservations.assetId, s.assets.id))
        .where(eq(s.assetReservations.showId, showId)),
      db
        .select()
        .from(s.sideEvents)
        .where(eq(s.sideEvents.showId, showId))
        .orderBy(asc(s.sideEvents.startsAt)),
      db
        .select({ decision: s.showDecisions, by: s.users })
        .from(s.showDecisions)
        .leftJoin(s.users, eq(s.showDecisions.decidedById, s.users.id))
        .where(eq(s.showDecisions.showId, showId))
        .orderBy(desc(s.showDecisions.decidedAt)),
      db.select().from(s.expenses).where(eq(s.expenses.showId, showId)),
    ]);

  // Lodging is a show-wide fact; who is *in* the room is per-person.
  const lodgingIds = lodgings.map((l) => l.id);
  const guests = lodgingIds.length
    ? await db
        .select({ guest: s.lodgingGuests, user: s.users })
        .from(s.lodgingGuests)
        .innerJoin(s.users, eq(s.lodgingGuests.userId, s.users.id))
        .where(inArray(s.lodgingGuests.lodgingId, lodgingIds))
    : [];

  return {
    show,
    tasks,
    attendees,
    deadlines,
    lodgings: lodgings.map((l) => ({
      lodging: l,
      guests: guests
        .filter((g) => g.guest.lodgingId === l.id)
        .filter((g) => !mineOnly || g.user.id === scope.userId),
    })),
    flights,
    requests,
    shipments,
    reservations,
    sideEvents,
    decisions,
    expenses,
    readiness: scoreChecklist(tasks.map((t) => t.task), asOf),
    committedCents: expenses.reduce((sum, e) => sum + e.amountCents, 0),
    /** True when travel rows on this page were narrowed to the actor. */
    travelNarrowed: mineOnly,
  };
}

/* -------------------------------- itinerary -------------------------------- */

/**
 * My Itinerary — the Member's home screen.
 *
 * SCOPE.md §1: "for a Member, this app should be almost invisible. Submit a
 * request, get a ticket, see your itinerary." So this reads one person's rows
 * across every show rather than one show's rows across every person, and it is
 * always the *actor's* own — a Travel Manager looking at someone else's travel
 * does that from the show, not from here.
 */
export async function getItinerary(actor: Actor, db: Db = getDb()) {
  const [attending, flights, requests, lodging, shifts] = await Promise.all([
    db
      .select({ attendee: s.showAttendees, show: s.shows })
      .from(s.showAttendees)
      .innerJoin(s.shows, eq(s.showAttendees.showId, s.shows.id))
      .where(and(eq(s.showAttendees.userId, actor.userId), eq(s.shows.orgId, actor.orgId)))
      .orderBy(asc(s.shows.startsOn)),
    db
      .select({ flight: s.flights, show: s.shows })
      .from(s.flights)
      .innerJoin(s.shows, eq(s.flights.showId, s.shows.id))
      .where(eq(s.flights.userId, actor.userId))
      .orderBy(asc(s.flights.scheduledDeparture)),
    db
      .select({ request: s.travelRequests, show: s.shows })
      .from(s.travelRequests)
      .leftJoin(s.shows, eq(s.travelRequests.showId, s.shows.id))
      .where(eq(s.travelRequests.travelerId, actor.userId))
      .orderBy(desc(s.travelRequests.createdAt)),
    db
      .select({ lodging: s.lodgings, show: s.shows })
      .from(s.lodgingGuests)
      .innerJoin(s.lodgings, eq(s.lodgingGuests.lodgingId, s.lodgings.id))
      .innerJoin(s.shows, eq(s.lodgings.showId, s.shows.id))
      .where(eq(s.lodgingGuests.userId, actor.userId)),
    db
      .select({ shift: s.boothShifts, show: s.shows })
      .from(s.shiftAssignments)
      .innerJoin(s.boothShifts, eq(s.shiftAssignments.shiftId, s.boothShifts.id))
      .innerJoin(s.shows, eq(s.boothShifts.showId, s.shows.id))
      .where(eq(s.shiftAssignments.userId, actor.userId))
      .orderBy(asc(s.boothShifts.startsAt)),
  ]);

  return attending.map(({ attendee, show }) => ({
    show,
    attendee,
    flights: flights.filter((f) => f.flight.showId === show.id).map((f) => f.flight),
    requests: requests.filter((r) => r.request.showId === show.id).map((r) => r.request),
    lodging: lodging.filter((l) => l.lodging.showId === show.id).map((l) => l.lodging),
    shifts: shifts.filter((sh) => sh.shift.showId === show.id).map((sh) => sh.shift),
  }));
}

/* --------------------------------- intake ---------------------------------- */

export async function createProspect(
  actor: Actor,
  draft: IntakeDraft,
  db: Db = getDb(),
): Promise<{ id: string }> {
  const valid = validateIntake(draft);

  const [row] = await db
    .insert(s.shows)
    .values({
      orgId: actor.orgId,
      name: valid.name,
      status: 'prospect',
      website: valid.website || null,
      venueName: valid.venueName || null,
      city: valid.city || null,
      region: valid.region || null,
      country: valid.country || null,
      airportCode: valid.airportCode,
      timezone: valid.timezone,
      startsOn: zonedToInstant(`${valid.startsOn}T${SHOW_DAY_START}`, valid.timezone),
      endsOn: zonedToInstant(`${valid.endsOn}T${SHOW_DAY_END}`, valid.timezone),
      budgetCents: valid.budgetCents ?? null,
      goals: valid.goals || null,
    })
    .returning({ id: s.shows.id });

  await db.insert(s.showDecisions).values({
    showId: row.id,
    decision: 'proposed',
    rationale: valid.rationale,
    decidedById: actor.userId,
  });

  return row;
}

/**
 * Commit or decline a prospect.
 *
 * The status change and the decision row go in together: a status with no
 * recorded reasoning is what this whole table exists to prevent, and writing them
 * separately means a crash between the two produces exactly that.
 */
export async function decideShow(
  actor: Actor,
  showId: string,
  decision: Decision,
  rationale: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canDecideShow(actor)) throw new ForbiddenError('commit or decline a show');

  const reason = rationale.trim();
  if (reason.length < 20) {
    throw new ForbiddenError(
      'record this decision without a written reason (at least 20 characters)',
    );
  }

  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  assertDecidable(show.status, decision);

  await db.transaction(async (tx) => {
    await tx
      .update(s.shows)
      .set({ status: statusAfter(decision), updatedAt: new Date() })
      .where(eq(s.shows.id, showId));
    await tx.insert(s.showDecisions).values({
      showId,
      decision,
      rationale: reason,
      decidedById: actor.userId,
    });
  });
}

/* ---------------------------------- clone ---------------------------------- */

/** Load a source show into the shape `planClone` reasons over. */
export async function loadCloneSource(actor: Actor, showId: string, db: Db = getDb()) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();

  const [tasks, deadlines, attendees, reservations] = await Promise.all([
    db.select().from(s.showTasks).where(eq(s.showTasks.showId, showId)).orderBy(asc(s.showTasks.sortOrder)),
    db.select().from(s.showDeadlines).where(eq(s.showDeadlines.showId, showId)),
    db.select().from(s.showAttendees).where(eq(s.showAttendees.showId, showId)),
    db.select().from(s.assetReservations).where(eq(s.assetReservations.showId, showId)),
  ]);

  return { show, tasks, deadlines, attendees, reservations };
}

export type CloneRequest = {
  name: string;
  /** `YYYY-MM-DD` — the new show's first day, read in the show's zone. */
  startsOn: string;
  timezone?: string;
  include: CloneOptions['include'];
};

export async function cloneShow(
  actor: Actor,
  sourceId: string,
  request: CloneRequest,
  db: Db = getDb(),
): Promise<{ id: string; plan: ClonePlan }> {
  if (!canCloneShow(actor)) throw new ForbiddenError('clone a show');

  const source = await loadCloneSource(actor, sourceId, db);
  const timezone = request.timezone || source.show.timezone;
  const plan = planClone(
    {
      show: source.show,
      tasks: source.tasks,
      deadlines: source.deadlines,
      attendees: source.attendees,
      reservations: source.reservations,
    },
    {
      name: request.name,
      startsOn: zonedToInstant(`${request.startsOn}T${SHOW_DAY_START}`, timezone),
      timezone,
      include: request.include,
    },
  );

  const id = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(s.shows)
      .values({ ...plan.show, orgId: actor.orgId })
      .returning({ id: s.shows.id });

    if (plan.tasks.length) {
      await tx.insert(s.showTasks).values(
        plan.tasks.map((t) => ({
          showId: created.id,
          title: t.title,
          description: t.description,
          category: t.category as (typeof s.taskCategoryEnum.enumValues)[number],
          status: t.status,
          assigneeId: t.assigneeId,
          dueOn: t.dueOn,
          weight: t.weight,
          sortOrder: t.sortOrder,
        })),
      );
    }
    if (plan.deadlines.length) {
      await tx.insert(s.showDeadlines).values(
        plan.deadlines.map((d) => ({
          showId: created.id,
          kind: d.kind as (typeof s.deadlineKindEnum.enumValues)[number],
          title: d.title,
          dueAt: d.dueAt,
          penaltyEstimateCents: d.penaltyEstimateCents,
          penaltyNote: d.penaltyNote,
          ownerId: d.ownerId,
          sourceUrl: d.sourceUrl,
          confirmedAt: d.confirmedAt,
        })),
      );
    }
    if (plan.attendees.length) {
      await tx.insert(s.showAttendees).values(
        plan.attendees.map((a) => ({
          showId: created.id,
          userId: a.userId,
          role: a.role,
          status: a.status,
        })),
      );
    }
    if (plan.reservations.length) {
      await tx.insert(s.assetReservations).values(
        plan.reservations.map((r) => ({
          showId: created.id,
          assetId: r.assetId,
          reservedFrom: r.reservedFrom,
          reservedTo: r.reservedTo,
          notes: r.notes,
        })),
      );
    }

    await tx.insert(s.showDecisions).values({
      showId: created.id,
      decision: 'cloned',
      rationale: `Cloned from "${source.show.name}", shifted ${plan.shiftDays} days. ` +
        `Carried: ${plan.carried.join('; ') || 'nothing but the show record'}.`,
      decidedById: actor.userId,
      clonedFromId: source.show.id,
    });

    return created.id;
  });

  return { id, plan };
}

export async function listDecisions(actor: Actor, showId: string, db: Db = getDb()) {
  return db
    .select({ decision: s.showDecisions, by: s.users })
    .from(s.showDecisions)
    .innerJoin(s.shows, eq(s.showDecisions.showId, s.shows.id))
    .leftJoin(s.users, eq(s.showDecisions.decidedById, s.users.id))
    .where(and(eq(s.showDecisions.showId, showId), eq(s.shows.orgId, actor.orgId)))
    .orderBy(desc(s.showDecisions.decidedAt));
}
