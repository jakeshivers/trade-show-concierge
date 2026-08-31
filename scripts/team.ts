/**
 * The roster, booth coverage, and who is double-booked. SCOPE.md §5, "Team &
 * shifts".
 *
 *   pnpm roster            # every live show: coverage, holes, and conflicts
 *   pnpm roster <show id>  # one show, shift by shift
 *
 * (`team` is a pnpm builtin, hence `roster`.)
 *
 * The register is on screen at /shows/<id>/team. This exists for the part that
 * reads badly as a grid and matters most: the difference between a shift that is
 * *assigned* to its target and one that is *covered*. A roster count is computed
 * from `shift_assignments` alone and is wrong every time somebody has not
 * accepted the invitation, declined the show, or booked a flight that lands after
 * the shift starts — and it is wrong in the reassuring direction, which is the
 * only direction that matters. Lines marked OVERSTATED are shifts a naive count
 * would have called full.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import { coverageFor, planPersonalClashes, summarizeCoverage, type AssignedStaff, type Commitment, type Shift } from '../src/lib/team/coverage';
import { planConflicts, type Attendance } from '../src/lib/team/conflicts';

const db = getDb();
const now = new Date();

const when = (d: Date, tz: string) =>
  d.toLocaleString('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

async function theOrg() {
  const org = await db.query.organizations.findFirst();
  if (!org) throw new Error('No organization. Run `pnpm db:reset` first.');
  return org;
}

async function main() {
  const org = await theOrg();
  const only = process.argv[2];

  const shows = await db
    .select()
    .from(s.shows)
    .where(eq(s.shows.orgId, org.id))
    .orderBy(asc(s.shows.startsOn));
  const chosen = only ? shows.filter((sh) => sh.id === only) : shows;
  if (chosen.length === 0) throw new Error(only ? `No show ${only}.` : 'No shows.');

  const showIds = chosen.map((sh) => sh.id);

  const [attendeeRows, shiftRows] = await Promise.all([
    db
      .select({ attendee: s.showAttendees, user: s.users, show: s.shows })
      .from(s.showAttendees)
      .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
      .innerJoin(s.shows, eq(s.showAttendees.showId, s.shows.id))
      .where(eq(s.shows.orgId, org.id)),
    db
      .select()
      .from(s.boothShifts)
      .where(inArray(s.boothShifts.showId, showIds))
      .orderBy(asc(s.boothShifts.startsAt)),
  ]);

  const shiftIds = shiftRows.map((r) => r.id);
  const [assignments, presence, events, rsvps] = await Promise.all([
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
    db.select().from(s.sideEvents).where(inArray(s.sideEvents.showId, showIds)),
    db
      .select({ rsvp: s.sideEventRsvps, event: s.sideEvents })
      .from(s.sideEventRsvps)
      .innerJoin(s.sideEvents, eq(s.sideEventRsvps.sideEventId, s.sideEvents.id))
      .where(inArray(s.sideEvents.showId, showIds)),
  ]);

  const conflicts = planConflicts(
    attendeeRows.map(
      ({ attendee, user, show }): Attendance => ({
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
      }),
    ),
  );

  console.log(`\nBooth coverage — ${org.name}\n`);

  for (const show of chosen) {
    const roster = new Map(
      attendeeRows.filter((r) => r.show.id === show.id).map((r) => [r.user.id, r] as const),
    );
    const shifts: Shift[] = shiftRows
      .filter((r) => r.showId === show.id)
      .map((shift) => ({
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
              respondedAt: on?.attendee.respondedAt ?? null,
              arrivesOn: on?.attendee.arrivesOn ?? null,
              departsOn: on?.attendee.departsOn ?? null,
            };
          }),
        presentUserIds: presence.filter((p) => p.shiftId === shift.id).map((p) => p.userId),
      }));

    if (roster.size === 0 && shifts.length === 0) continue;

    console.log(`  ${show.name}  (${show.status}, ${show.timezone})`);
    console.log(
      `    roster: ${[...roster.values()]
        // `confirmed*` is confirmed by somebody other than its subject — the
        // distinction booth coverage counts, so it belongs on the roster line
        // and not only in the shift breakdown.
        .map(
          (r) =>
            `${r.user.fullName} [${r.attendee.status}` +
            `${r.attendee.status === 'confirmed' && !r.attendee.respondedAt ? '*' : ''}]`,
        )
        .join(', ') || '—'}`,
    );
    if ([...roster.values()].some((r) => r.attendee.status === 'confirmed' && !r.attendee.respondedAt)) {
      console.log('            * marked as going by somebody else; not counted as confirmed');
    }

    const coverages = shifts.map((sh) => coverageFor(sh, now));
    const summary = summarizeCoverage(coverages);

    for (const c of coverages) {
      const flag = c.overstated ? '  OVERSTATED' : c.shortBy > 0 ? '  short' : '';
      console.log(
        `    ${when(c.startsAt, show.timezone)} → ${when(c.endsAt, show.timezone)}   ` +
          `target ${c.targetStaff}, assigned ${c.assignedCount}, can actually work ${c.effectiveCount}${flag}`,
      );
      for (const st of c.standings.filter((x) => !x.counts)) {
        console.log(
          `        · ${st.fullName}: ${st.note}` +
            (st.at ? ` (${when(st.at, show.timezone)})` : ''),
        );
      }
      if (c.presence) {
        console.log(
          `        rostered ${c.effectiveCount}, actually present ${c.presence.present}` +
            (c.presence.noShows.length
              ? ` — no-show: ${c.presence.noShows.map((n) => n.fullName).join(', ')}`
              : ''),
        );
      }
    }

    if (shifts.length) {
      console.log(
        `    ${summary.short} of ${summary.shifts} shift(s) short, ${summary.missingSlots} slot(s) to fill` +
          (summary.overstated
            ? `; ${summary.overstated} would have read as full on a roster count.`
            : '.'),
      );
    }

    // The everyday double-booking: the booth shift that runs into the dinner.
    const commitments: { userId: string; fullName: string; commitment: Commitment }[] = [];
    for (const sh of shifts) {
      for (const a of sh.assigned) {
        commitments.push({
          userId: a.userId,
          fullName: a.fullName,
          commitment: { kind: 'shift', id: sh.id, label: 'Booth shift', startsAt: sh.startsAt, endsAt: sh.endsAt },
        });
      }
    }
    for (const { rsvp, event } of rsvps) {
      if (event.showId !== show.id || !rsvp.userId || rsvp.status !== 'accepted') continue;
      const who = roster.get(rsvp.userId);
      commitments.push({
        userId: rsvp.userId,
        fullName: who?.user.fullName ?? rsvp.userId,
        commitment: {
          kind: 'side_event',
          id: event.id,
          label: event.name,
          startsAt: event.startsAt,
          endsAt: event.endsAt ?? new Date(event.startsAt.getTime() + 3_600_000),
        },
      });
    }
    for (const clash of planPersonalClashes(commitments)) {
      console.log(`    clash: ${clash.summary}`);
    }
    console.log('');
  }

  const relevant = conflicts.filter(
    (c) => showIds.includes(c.a.showId) || showIds.includes(c.b.showId),
  );
  console.log(`  Double-booked across shows (${relevant.length}):`);
  if (relevant.length === 0) {
    console.log(
      '    nobody — and note that two shows overlapping is not the test. The comparison is\n' +
        '    the travel windows, so somebody who flies out of one on Tuesday and into the\n' +
        '    other on Wednesday is not a conflict and is not listed here.',
    );
  }
  for (const c of relevant) {
    console.log(`    [${c.severity.padEnd(8)}] ${c.certainty.padEnd(8)} ${c.summary}`);
  }
  console.log(`\n  ${events.length} side event(s) across these shows.\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
