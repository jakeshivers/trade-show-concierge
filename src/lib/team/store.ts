import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { NotFoundError } from '@/lib/shows/store';
import {
  canManageSideEvent,
  canRecordPresence,
  canRespondForAttendee,
  canRsvpFor,
  canStaffShow,
} from './access';
import {
  coverageFor,
  planPersonalClashes,
  summarizeCoverage,
  type AssignedStaff,
  type Commitment,
  type CoverageSummary,
  type PersonalClash,
  type Shift,
  type ShiftCoverage,
} from './coverage';
import { conflictsForShow, planConflicts, type Attendance, type Conflict } from './conflicts';
import {
  describeDetachment,
  rsvpFits,
  TeamError,
  validateAttendee,
  validateRsvp,
  validateShift,
  validateSideEvent,
  type AttendeeDraft,
  type RsvpDraft,
  type ShiftDraft,
  type SideEventDraft,
} from './edit';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of the team screens. Same posture as `readiness/store.ts` and
 * `deadlines/store.ts`: org-scoped at the source rather than load-then-check, and
 * every decision it makes was made by a pure function above it.
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

async function requireAttendee(actor: Actor, attendeeId: string, db: Db) {
  const [row] = await db
    .select({ attendee: s.showAttendees, show: s.shows })
    .from(s.showAttendees)
    .innerJoin(s.shows, eq(s.showAttendees.showId, s.shows.id))
    .where(and(eq(s.showAttendees.id, attendeeId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('attendee');
  return row;
}

async function requireShift(actor: Actor, shiftId: string, db: Db) {
  const [row] = await db
    .select({ shift: s.boothShifts, show: s.shows })
    .from(s.boothShifts)
    .innerJoin(s.shows, eq(s.boothShifts.showId, s.shows.id))
    .where(and(eq(s.boothShifts.id, shiftId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('shift');
  return row;
}

async function requireSideEvent(actor: Actor, eventId: string, db: Db) {
  const [row] = await db
    .select({ event: s.sideEvents, show: s.shows })
    .from(s.sideEvents)
    .innerJoin(s.shows, eq(s.sideEvents.showId, s.shows.id))
    .where(and(eq(s.sideEvents.id, eventId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('side event');
  return row;
}

/* ---------------------------------- read ----------------------------------- */

export type RosterEntry = {
  attendee: typeof s.showAttendees.$inferSelect;
  user: { id: string; fullName: string; email: string };
  /** What this actor may do to this row — computed once, server-side. */
  mayRespond: boolean;
  /**
   * Whether this row *is* the acting user's.
   *
   * `mayRespond` is own-row **or** an approver, and both halves are right — a
   * roster nobody but its subject can correct accumulates permanently stale rows
   * when people go on leave. But answering for yourself and answering on
   * somebody's behalf are different acts, and a screen given only `mayRespond`
   * cannot tell them apart, so it renders the first-person form on everybody.
   */
  isSelf: boolean;
  /** Cross-show double-booking touching this person. */
  conflicts: Conflict[];
};

export type ShiftEntry = ShiftCoverage & {
  notes: string | null;
  /** Roster members not already on this shift, for the assign control. */
  assignable: { id: string; fullName: string }[];
};

export type SideEventEntry = {
  event: typeof s.sideEvents.$inferSelect;
  host: { id: string; fullName: string } | null;
  rsvps: {
    rsvp: typeof s.sideEventRsvps.$inferSelect;
    user: { id: string; fullName: string } | null;
  }[];
  accepted: number;
  /** `null` when there is no capacity set — which is not the same as zero left. */
  seatsLeft: number | null;
  mayManage: boolean;
};

export type TeamBoard = {
  show: typeof s.shows.$inferSelect;
  roster: RosterEntry[];
  shifts: ShiftEntry[];
  coverage: CoverageSummary;
  clashes: PersonalClash[];
  sideEvents: SideEventEntry[];
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
  may: { staff: boolean };
  actorId: string;
};

export async function getTeamBoard(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<TeamBoard> {
  const show = await requireShow(actor, showId, db);

  const [attendeeRows, shiftRows, eventRows, people, costCenters] = await Promise.all([
    db
      .select({ attendee: s.showAttendees, user: s.users })
      .from(s.showAttendees)
      .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
      .where(eq(s.showAttendees.showId, showId))
      .orderBy(asc(s.users.fullName)),
    db
      .select()
      .from(s.boothShifts)
      .where(eq(s.boothShifts.showId, showId))
      .orderBy(asc(s.boothShifts.startsAt)),
    db
      .select({ event: s.sideEvents, host: s.users })
      .from(s.sideEvents)
      .leftJoin(s.users, eq(s.sideEvents.hostId, s.users.id))
      .where(eq(s.sideEvents.showId, showId))
      .orderBy(asc(s.sideEvents.startsAt)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
    db
      .select({ id: s.costCenters.id, code: s.costCenters.code, name: s.costCenters.name })
      .from(s.costCenters)
      .where(eq(s.costCenters.orgId, actor.orgId))
      .orderBy(asc(s.costCenters.code)),
  ]);

  const shiftIds = shiftRows.map((r) => r.id);
  const eventIds = eventRows.map((r) => r.event.id);

  const [assignments, presence, rsvps] = await Promise.all([
    shiftIds.length
      ? db
          .select({ assignment: s.shiftAssignments, user: s.users })
          .from(s.shiftAssignments)
          .innerJoin(s.users, eq(s.shiftAssignments.userId, s.users.id))
          .where(inArray(s.shiftAssignments.shiftId, shiftIds))
      : [],
    shiftIds.length
      ? db.select().from(s.shiftPresence).where(inArray(s.shiftPresence.shiftId, shiftIds))
      : [],
    eventIds.length
      ? db
          .select({ rsvp: s.sideEventRsvps, user: s.users })
          .from(s.sideEventRsvps)
          .leftJoin(s.users, eq(s.sideEventRsvps.userId, s.users.id))
          .where(inArray(s.sideEventRsvps.sideEventId, eventIds))
      : [],
  ]);

  // The roster, indexed — `coverage.ts` needs to distinguish "invited" from
  // "not on this show at all", and only the roster can tell it which.
  const roster = new Map(attendeeRows.map((r) => [r.user.id, r] as const));

  const shifts: Shift[] = shiftRows.map((shift) => ({
    id: shift.id,
    showId: shift.showId,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    targetStaff: shift.targetStaff,
    notes: shift.notes,
    assigned: assignments
      .filter((a) => a.assignment.shiftId === shift.id)
      .map((a): AssignedStaff => {
        const on = roster.get(a.user.id);
        return {
          userId: a.user.id,
          fullName: a.user.fullName,
          attendeeStatus: on ? on.attendee.status : null,
          arrivesOn: on?.attendee.arrivesOn ?? null,
          departsOn: on?.attendee.departsOn ?? null,
        };
      }),
    presentUserIds: presence.filter((p) => p.shiftId === shift.id).map((p) => p.userId),
  }));

  const coverages = shifts.map((shift) => coverageFor(shift, asOf));

  // Cross-show conflicts are org-wide by nature: the other half of a
  // double-booking is on a different show's roster, and a query scoped to this
  // show can never see it.
  const conflicts = conflictsForShow(await loadConflicts(actor.orgId, db), showId);

  const commitments: { userId: string; fullName: string; commitment: Commitment }[] = [];
  for (const shift of shifts) {
    for (const a of shift.assigned) {
      commitments.push({
        userId: a.userId,
        fullName: a.fullName,
        commitment: {
          kind: 'shift',
          id: shift.id,
          label: 'Booth shift',
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
        },
      });
    }
  }
  for (const { event } of eventRows) {
    for (const r of rsvps) {
      if (r.rsvp.sideEventId !== event.id || !r.user || r.rsvp.status !== 'accepted') continue;
      commitments.push({
        userId: r.user.id,
        fullName: r.user.fullName,
        commitment: {
          kind: 'side_event',
          id: event.id,
          label: event.name,
          startsAt: event.startsAt,
          // A dinner with no end time still blocks the evening. An hour is the
          // shortest honest guess and it is only used to detect an overlap.
          endsAt: event.endsAt ?? new Date(event.startsAt.getTime() + 3_600_000),
        },
      });
    }
  }

  return {
    show,
    roster: attendeeRows.map(({ attendee, user }) => ({
      attendee,
      user: { id: user.id, fullName: user.fullName, email: user.email },
      mayRespond: canRespondForAttendee(actor, attendee),
      isSelf: attendee.userId === actor.userId,
      conflicts: conflicts.filter((c) => c.userId === user.id),
    })),
    shifts: coverages.map((c) => {
      const shift = shifts.find((x) => x.id === c.shiftId)!;
      const already = new Set(shift.assigned.map((a) => a.userId));
      return {
        ...c,
        notes: shift.notes,
        assignable: attendeeRows
          .filter((r) => !already.has(r.user.id))
          .map((r) => ({ id: r.user.id, fullName: r.user.fullName })),
      };
    }),
    coverage: summarizeCoverage(coverages),
    clashes: planPersonalClashes(commitments),
    sideEvents: eventRows.map(({ event, host }) => {
      const mine = rsvps.filter((r) => r.rsvp.sideEventId === event.id);
      const accepted = mine.filter((r) => r.rsvp.status === 'accepted').length;
      return {
        event,
        host: host ? { id: host.id, fullName: host.fullName } : null,
        rsvps: mine.map(({ rsvp, user }) => ({
          rsvp,
          user: user ? { id: user.id, fullName: user.fullName } : null,
        })),
        accepted,
        seatsLeft: event.capacity === null ? null : Math.max(0, event.capacity - accepted),
        mayManage: canManageSideEvent(actor, event),
      };
    }),
    people,
    costCenters,
    may: { staff: canStaffShow(actor) },
    actorId: actor.userId,
  };
}

/** Every commitment in the org, as `conflicts.ts` wants it. */
async function loadConflicts(orgId: string, db: Db): Promise<Conflict[]> {
  const rows = await db
    .select({ attendee: s.showAttendees, show: s.shows, user: s.users })
    .from(s.showAttendees)
    .innerJoin(s.shows, eq(s.showAttendees.showId, s.shows.id))
    .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
    .where(eq(s.shows.orgId, orgId));

  const attendances: Attendance[] = rows.map(({ attendee, show, user }) => ({
    attendeeId: attendee.id,
    showId: show.id,
    showName: show.name,
    showStatus: show.status,
    userId: user.id,
    userName: user.fullName,
    status: attendee.status,
    arrivesOn: attendee.arrivesOn,
    departsOn: attendee.departsOn,
    showStartsOn: show.startsOn,
    showEndsOn: show.endsOn,
  }));

  return planConflicts(attendances);
}

/** Org-wide double-booking, for the CLI and anything that wants the whole list. */
export async function getConflicts(actor: Actor, db: Db = getDb()): Promise<Conflict[]> {
  return loadConflicts(actor.orgId, db);
}

/* -------------------------------- attendees -------------------------------- */

function instant(local: string | null, timezone: string): Date | null {
  return local === null ? null : zonedToInstant(local, timezone);
}

export async function addAttendee(
  actor: Actor,
  showId: string,
  draft: AttendeeDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canStaffShow(actor)) throw new ForbiddenError('staff a show');
  const show = await requireShow(actor, showId, db);
  const valid = validateAttendee(draft);

  // Same-org check on the person, not just on the show: a user id from another
  // workspace would otherwise be staffed onto this one by hand-posted form data.
  const user = await db.query.users.findFirst({
    where: and(eq(s.users.id, valid.userId), eq(s.users.orgId, actor.orgId)),
  });
  if (!user) throw new NotFoundError('user');

  const existing = await db.query.showAttendees.findFirst({
    where: and(eq(s.showAttendees.showId, showId), eq(s.showAttendees.userId, valid.userId)),
  });
  if (existing) throw new TeamError(`${user.fullName} is already on this show’s roster.`);

  const [row] = await db
    .insert(s.showAttendees)
    .values({
      showId,
      userId: valid.userId,
      role: valid.role,
      // Whoever builds a roster invites; they do not answer. `respondedAt` stays
      // null until the person themselves says yes — `coverage.ts` counts
      // confirmations, and a confirmation nobody gave is hearsay in a number.
      status: valid.status === 'confirmed' ? 'invited' : valid.status,
      arrivesOn: instant(valid.arrivesLocal, show.timezone),
      departsOn: instant(valid.departsLocal, show.timezone),
      notes: valid.notes,
      updatedAt: now,
    })
    .returning({ id: s.showAttendees.id });

  return row;
}

export async function editAttendee(
  actor: Actor,
  attendeeId: string,
  draft: AttendeeDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('edit a show roster');
  const { attendee, show } = await requireAttendee(actor, attendeeId, db);
  const valid = validateAttendee({ ...draft, userId: attendee.userId });

  await db
    .update(s.showAttendees)
    .set({
      role: valid.role,
      status: valid.status,
      arrivesOn: instant(valid.arrivesLocal, show.timezone),
      departsOn: instant(valid.departsLocal, show.timezone),
      notes: valid.notes,
      updatedAt: now,
    })
    .where(eq(s.showAttendees.id, attendee.id));
}

/**
 * Answer an invitation, and say when you land.
 *
 * The Member's whole interaction with this feature (§1: "almost invisible"), and
 * the reason `respondedAt` exists — a `confirmed` the person set themselves and
 * a `confirmed` somebody pencilled in look identical in the column, and only one
 * of them is a fact.
 */
export async function respondToInvitation(
  actor: Actor,
  attendeeId: string,
  status: string,
  window: { arrivesOn?: string | null; arrivesAt?: string | null; departsOn?: string | null; departsAt?: string | null },
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { attendee, show } = await requireAttendee(actor, attendeeId, db);
  if (!canRespondForAttendee(actor, attendee)) {
    throw new ForbiddenError('answer somebody else’s invitation');
  }

  const valid = validateAttendee({ ...window, userId: attendee.userId, role: attendee.role, status });

  await db
    .update(s.showAttendees)
    .set({
      status: valid.status,
      arrivesOn: instant(valid.arrivesLocal, show.timezone),
      departsOn: instant(valid.departsLocal, show.timezone),
      respondedAt: attendee.userId === actor.userId ? now : attendee.respondedAt,
      updatedAt: now,
    })
    .where(eq(s.showAttendees.id, attendee.id));
}

export type Detachment = {
  ticketedFlights: number;
  lodgingRooms: number;
  shifts: number;
  acceptedSideEvents: number;
};

/** What is already attached to this person on this show. See `edit.ts`. */
export async function describeAttendeeDetachment(
  actor: Actor,
  attendeeId: string,
  db: Db = getDb(),
): Promise<Detachment> {
  const { attendee } = await requireAttendee(actor, attendeeId, db);
  const [flights, rooms, shifts, events] = await Promise.all([
    // A flight is "ticketed" when a carrier has issued something against it —
    // a ticket number, or the booking reference a manually-entered PNR carries.
    // Those are the rows removing somebody here demonstrably does not cancel.
    db
      .select({ ticketNumber: s.flights.ticketNumber, reference: s.flights.bookingReference })
      .from(s.flights)
      .where(and(eq(s.flights.showId, attendee.showId), eq(s.flights.userId, attendee.userId))),
    db
      .select({ id: s.lodgingGuests.id })
      .from(s.lodgingGuests)
      .innerJoin(s.lodgings, eq(s.lodgingGuests.lodgingId, s.lodgings.id))
      .where(
        and(eq(s.lodgings.showId, attendee.showId), eq(s.lodgingGuests.userId, attendee.userId)),
      ),
    db
      .select({ id: s.shiftAssignments.id })
      .from(s.shiftAssignments)
      .innerJoin(s.boothShifts, eq(s.shiftAssignments.shiftId, s.boothShifts.id))
      .where(
        and(
          eq(s.boothShifts.showId, attendee.showId),
          eq(s.shiftAssignments.userId, attendee.userId),
        ),
      ),
    db
      .select({ id: s.sideEventRsvps.id })
      .from(s.sideEventRsvps)
      .innerJoin(s.sideEvents, eq(s.sideEventRsvps.sideEventId, s.sideEvents.id))
      .where(
        and(
          eq(s.sideEvents.showId, attendee.showId),
          eq(s.sideEventRsvps.userId, attendee.userId),
          eq(s.sideEventRsvps.status, 'accepted'),
        ),
      ),
  ]);

  return {
    ticketedFlights: flights.filter((f) => f.ticketNumber || f.reference).length,
    lodgingRooms: rooms.length,
    shifts: shifts.length,
    acceptedSideEvents: events.length,
  };
}

/**
 * Take somebody off a show.
 *
 * Allowed — people drop off shows constantly. Refused *silently* would be worse
 * and refused *outright* would be wrong, so the rule is the one step 9 settled
 * for cancelling a ticketed request (SCOPE.md §6d): the app does not pretend to
 * have told the airline. It names what is still out there and makes the person
 * say yes with the list in front of them.
 */
export async function removeAttendee(
  actor: Actor,
  attendeeId: string,
  acknowledged: boolean,
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('remove somebody from a show');
  const { attendee } = await requireAttendee(actor, attendeeId, db);

  const detachment = await describeAttendeeDetachment(actor, attendeeId, db);
  const warning = describeDetachment(detachment);
  if (warning && !acknowledged) {
    throw new TeamError(
      `${warning} Removing them here changes nothing outside this app. Confirm to go ahead.`,
    );
  }

  // Shifts and RSVPs go with them: a shift assignment for somebody not on the
  // show is precisely the phantom `coverage.ts` has to special-case, and leaving
  // one behind manufactures the bug the model exists to catch.
  await db
    .delete(s.shiftAssignments)
    .where(
      and(
        eq(s.shiftAssignments.userId, attendee.userId),
        inArray(
          s.shiftAssignments.shiftId,
          db
            .select({ id: s.boothShifts.id })
            .from(s.boothShifts)
            .where(eq(s.boothShifts.showId, attendee.showId)),
        ),
      ),
    );
  await db
    .delete(s.sideEventRsvps)
    .where(
      and(
        eq(s.sideEventRsvps.userId, attendee.userId),
        inArray(
          s.sideEventRsvps.sideEventId,
          db
            .select({ id: s.sideEvents.id })
            .from(s.sideEvents)
            .where(eq(s.sideEvents.showId, attendee.showId)),
        ),
      ),
    );
  await db.delete(s.showAttendees).where(eq(s.showAttendees.id, attendee.id));
}

/* ---------------------------------- shifts --------------------------------- */

export async function addShift(
  actor: Actor,
  showId: string,
  draft: ShiftDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canStaffShow(actor)) throw new ForbiddenError('create a booth shift');
  const show = await requireShow(actor, showId, db);
  const valid = validateShift(draft);

  const [row] = await db
    .insert(s.boothShifts)
    .values({
      showId,
      startsAt: zonedToInstant(valid.startsLocal, show.timezone),
      endsAt: zonedToInstant(valid.endsLocal, show.timezone),
      targetStaff: valid.targetStaff,
      notes: valid.notes,
      updatedAt: now,
    })
    .returning({ id: s.boothShifts.id });

  return row;
}

export async function editShift(
  actor: Actor,
  shiftId: string,
  draft: ShiftDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('edit a booth shift');
  const { shift, show } = await requireShift(actor, shiftId, db);
  const valid = validateShift(draft);

  await db
    .update(s.boothShifts)
    .set({
      startsAt: zonedToInstant(valid.startsLocal, show.timezone),
      endsAt: zonedToInstant(valid.endsLocal, show.timezone),
      targetStaff: valid.targetStaff,
      notes: valid.notes,
      updatedAt: now,
    })
    .where(eq(s.boothShifts.id, shift.id));
}

export async function deleteShift(
  actor: Actor,
  shiftId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('delete a booth shift');
  const { shift } = await requireShift(actor, shiftId, db);
  await db.delete(s.boothShifts).where(eq(s.boothShifts.id, shift.id));
}

export async function assignToShift(
  actor: Actor,
  shiftId: string,
  userId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('assign somebody to a booth shift');
  const { shift } = await requireShift(actor, shiftId, db);

  // Assigning somebody who is not on the roster is allowed and is *reported*
  // rather than blocked — `coverage.ts` has a standing for exactly that case,
  // and refusing here would only push the roster gap somewhere less visible.
  // What is not allowed is somebody from another workspace.
  const user = await db.query.users.findFirst({
    where: and(eq(s.users.id, userId), eq(s.users.orgId, actor.orgId)),
  });
  if (!user) throw new NotFoundError('user');

  await db
    .insert(s.shiftAssignments)
    .values({ shiftId: shift.id, userId })
    .onConflictDoNothing();
}

export async function unassignFromShift(
  actor: Actor,
  shiftId: string,
  userId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canStaffShow(actor)) throw new ForbiddenError('unassign somebody from a booth shift');
  const { shift } = await requireShift(actor, shiftId, db);
  await db
    .delete(s.shiftAssignments)
    .where(and(eq(s.shiftAssignments.shiftId, shift.id), eq(s.shiftAssignments.userId, userId)));
}

/**
 * Booth check-in — §4's "who was *actually* there", kept in its own table so the
 * roster is never quietly overwritten by what happened.
 */
export async function recordPresence(
  actor: Actor,
  shiftId: string,
  userId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { shift } = await requireShift(actor, shiftId, db);
  if (!canRecordPresence(actor, userId)) {
    throw new ForbiddenError('record somebody else’s booth presence');
  }
  const existing = await db.query.shiftPresence.findFirst({
    where: and(eq(s.shiftPresence.shiftId, shift.id), eq(s.shiftPresence.userId, userId)),
  });
  if (existing) return;

  await db.insert(s.shiftPresence).values({ shiftId: shift.id, userId, checkedInAt: now });
}

export async function clearPresence(
  actor: Actor,
  shiftId: string,
  userId: string,
  db: Db = getDb(),
): Promise<void> {
  const { shift } = await requireShift(actor, shiftId, db);
  if (!canRecordPresence(actor, userId)) {
    throw new ForbiddenError('change somebody else’s booth presence');
  }
  await db
    .delete(s.shiftPresence)
    .where(and(eq(s.shiftPresence.shiftId, shift.id), eq(s.shiftPresence.userId, userId)));
}

/* ------------------------------- side events ------------------------------- */

async function requireCostCenter(actor: Actor, costCenterId: string, db: Db) {
  const cc = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.id, costCenterId), eq(s.costCenters.orgId, actor.orgId)),
  });
  if (!cc) throw new NotFoundError('cost center');
  return cc;
}

export async function addSideEvent(
  actor: Actor,
  showId: string,
  draft: SideEventDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canStaffShow(actor)) throw new ForbiddenError('add a side event');
  const show = await requireShow(actor, showId, db);
  const valid = validateSideEvent(draft);
  await requireCostCenter(actor, valid.costCenterId, db);

  const [row] = await db
    .insert(s.sideEvents)
    .values({
      showId,
      kind: valid.kind,
      name: valid.name,
      location: valid.location,
      startsAt: zonedToInstant(valid.startsLocal, show.timezone),
      endsAt: valid.endsLocal ? zonedToInstant(valid.endsLocal, show.timezone) : null,
      capacity: valid.capacity,
      budgetCents: valid.budgetCents,
      hostId: valid.hostId,
      costCenterId: valid.costCenterId,
      notes: valid.notes,
      updatedAt: now,
    })
    .returning({ id: s.sideEvents.id });

  return row;
}

export async function editSideEvent(
  actor: Actor,
  eventId: string,
  draft: SideEventDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { event, show } = await requireSideEvent(actor, eventId, db);
  if (!canManageSideEvent(actor, event)) throw new ForbiddenError('edit this side event');
  const valid = validateSideEvent(draft);
  await requireCostCenter(actor, valid.costCenterId, db);

  await db
    .update(s.sideEvents)
    .set({
      kind: valid.kind,
      name: valid.name,
      location: valid.location,
      startsAt: zonedToInstant(valid.startsLocal, show.timezone),
      endsAt: valid.endsLocal ? zonedToInstant(valid.endsLocal, show.timezone) : null,
      capacity: valid.capacity,
      budgetCents: valid.budgetCents,
      hostId: valid.hostId,
      costCenterId: valid.costCenterId,
      notes: valid.notes,
      updatedAt: now,
    })
    .where(eq(s.sideEvents.id, event.id));
}

export async function deleteSideEvent(
  actor: Actor,
  eventId: string,
  db: Db = getDb(),
): Promise<void> {
  const { event } = await requireSideEvent(actor, eventId, db);
  if (!canManageSideEvent(actor, event)) throw new ForbiddenError('delete this side event');
  await db.delete(s.sideEvents).where(eq(s.sideEvents.id, event.id));
}

export async function addRsvp(
  actor: Actor,
  eventId: string,
  draft: RsvpDraft,
  db: Db = getDb(),
): Promise<void> {
  const { event } = await requireSideEvent(actor, eventId, db);
  if (!canManageSideEvent(actor, event)) throw new ForbiddenError('add to this guest list');
  const valid = validateRsvp(draft);

  if (valid.userId) {
    const user = await db.query.users.findFirst({
      where: and(eq(s.users.id, valid.userId), eq(s.users.orgId, actor.orgId)),
    });
    if (!user) throw new NotFoundError('user');
  }

  const fits = rsvpFits(event.capacity, await acceptedCount(event.id, db), valid.status, false);
  if (fits !== true) throw new TeamError(fits);

  await db.insert(s.sideEventRsvps).values({
    sideEventId: event.id,
    userId: valid.userId,
    guestName: valid.guestName,
    guestEmail: valid.guestEmail,
    guestCompany: valid.guestCompany,
    status: valid.status,
  });
}

export async function setRsvpStatus(
  actor: Actor,
  rsvpId: string,
  status: string,
  db: Db = getDb(),
): Promise<void> {
  const [row] = await db
    .select({ rsvp: s.sideEventRsvps, event: s.sideEvents })
    .from(s.sideEventRsvps)
    .innerJoin(s.sideEvents, eq(s.sideEventRsvps.sideEventId, s.sideEvents.id))
    .innerJoin(s.shows, eq(s.sideEvents.showId, s.shows.id))
    .where(and(eq(s.sideEventRsvps.id, rsvpId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('RSVP');

  if (!canRsvpFor(actor, row.event, row.rsvp)) throw new ForbiddenError('answer this RSVP');
  const valid = validateRsvp({ ...row.rsvp, status });

  const fits = rsvpFits(
    row.event.capacity,
    await acceptedCount(row.event.id, db),
    valid.status,
    row.rsvp.status === 'accepted',
  );
  if (fits !== true) throw new TeamError(fits);

  await db
    .update(s.sideEventRsvps)
    .set({ status: valid.status })
    .where(eq(s.sideEventRsvps.id, row.rsvp.id));
}

export async function removeRsvp(actor: Actor, rsvpId: string, db: Db = getDb()): Promise<void> {
  const [row] = await db
    .select({ rsvp: s.sideEventRsvps, event: s.sideEvents })
    .from(s.sideEventRsvps)
    .innerJoin(s.sideEvents, eq(s.sideEventRsvps.sideEventId, s.sideEvents.id))
    .innerJoin(s.shows, eq(s.sideEvents.showId, s.shows.id))
    .where(and(eq(s.sideEventRsvps.id, rsvpId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('RSVP');
  if (!canManageSideEvent(actor, row.event)) throw new ForbiddenError('edit this guest list');
  await db.delete(s.sideEventRsvps).where(eq(s.sideEventRsvps.id, row.rsvp.id));
}

async function acceptedCount(eventId: string, db: Db): Promise<number> {
  const rows = await db
    .select({ id: s.sideEventRsvps.id })
    .from(s.sideEventRsvps)
    .where(
      and(eq(s.sideEventRsvps.sideEventId, eventId), eq(s.sideEventRsvps.status, 'accepted')),
    );
  return rows.length;
}

export { TeamError };
