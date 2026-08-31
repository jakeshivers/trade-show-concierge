import { describe, expect, it } from 'vitest';
import {
  coverageFor,
  planPersonalClashes,
  standingFor,
  summarizeCoverage,
  overlaps,
  type AssignedStaff,
  type Shift,
} from './coverage';
import { planConflicts, conflictsForShow, type Attendance } from './conflicts';
import {
  describeDetachment,
  rsvpFits,
  TeamError,
  validateAttendee,
  validateRsvp,
  validateShift,
  validateSideEvent,
} from './edit';
import { validateLodging } from '@/lib/lodging/edit';

/**
 * The pure half of the team and lodging screens — no database, fixed clock.
 *
 * Most of the assertions worth writing here are about a *distinction* rather
 * than a total: rostered versus effective, certain versus possible, "3 of 3
 * assigned" versus "3 of 3 who can actually stand there". A count that collapses
 * either pair is the bug this step exists to avoid.
 */

const NOW = new Date('2026-05-01T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

const staff = (over: Partial<AssignedStaff> = {}): AssignedStaff => ({
  userId: 'u1',
  fullName: 'Priya Raman',
  attendeeStatus: 'confirmed',
  // An ordinary confirmed attendee answered for themselves. The cases where
  // somebody else did are spelled out, because that is the interesting one.
  respondedAt: days(-1),
  arrivesOn: null,
  departsOn: null,
  ...over,
});

const shift = (over: Partial<Shift> = {}): Shift => ({
  id: 'sh1',
  showId: 'show1',
  startsAt: days(10),
  endsAt: new Date(days(10).getTime() + 4 * 3_600_000),
  targetStaff: 2,
  notes: null,
  assigned: [staff(), staff({ userId: 'u2', fullName: 'Tomas Alvarez' })],
  presentUserIds: [],
  ...over,
});

describe('coverage — rostered is not staffed', () => {
  it('counts confirmed, in-town people, not assignment rows', () => {
    const c = coverageFor(shift(), NOW);
    expect(c.assignedCount).toBe(2);
    expect(c.effectiveCount).toBe(2);
    expect(c.shortBy).toBe(0);
    expect(c.overstated).toBe(false);
  });

  it('reports a full-looking shift as overstated when the roster cannot deliver it', () => {
    // The whole point of the file. A naive count says 2 of 2 and the lead moves
    // on; one of the two turned the show down and the booth is single-staffed.
    const c = coverageFor(
      shift({
        assigned: [staff(), staff({ userId: 'u2', fullName: 'Tomas Alvarez', attendeeStatus: 'declined' })],
      }),
      NOW,
    );
    expect(c.assignedCount).toBe(2);
    expect(c.effectiveCount).toBe(1);
    expect(c.shortBy).toBe(1);
    expect(c.overstated).toBe(true);
  });

  it('does not count somebody who is not on the roster at all', () => {
    const s = standingFor(shift(), staff({ attendeeStatus: null }));
    expect(s.kind).toBe('not_on_roster');
    expect(s.counts).toBe(false);
  });

  it('does not count an unanswered invitation — pencilled in is not staffed', () => {
    expect(standingFor(shift(), staff({ attendeeStatus: 'invited' })).kind).toBe('unconfirmed');
    expect(standingFor(shift(), staff({ attendeeStatus: 'waitlist' })).counts).toBe(false);
  });

  it('does not count a confirmation the subject never made', () => {
    // `confirmed` with no `responded_at` was typed by somebody else — the roster
    // editor, or an admin recording what they were told. It is a note of a
    // conversation, and counting it puts hearsay inside a staffing number.
    const secondhand = staff({ attendeeStatus: 'confirmed', respondedAt: null });
    const st = standingFor(shift(), secondhand);
    expect(st.kind).toBe('secondhand');
    expect(st.counts).toBe(false);
  });

  it('keeps secondhand distinct from unanswered, because they are different work', () => {
    // "Priya said she's coming, chase her to confirm" and "Priya has not
    // answered" get the same person doing different things. Collapsing them into
    // `unconfirmed` would lose the half that is nearly done.
    expect(standingFor(shift(), staff({ respondedAt: null })).kind).toBe('secondhand');
    expect(
      standingFor(shift(), staff({ attendeeStatus: 'invited', respondedAt: null })).kind,
    ).toBe('unconfirmed');
  });

  it('overstates a shift filled with confirmations nobody made', () => {
    // The failure this is really about: every slot assigned, every row reading
    // "confirmed", and not one person has said yes.
    const c = coverageFor(
      shift({
        assigned: [
          staff({ respondedAt: null }),
          staff({ userId: 'u2', fullName: 'Tomas Alvarez', respondedAt: null }),
        ],
      }),
      NOW,
    );
    expect(c.assignedCount).toBe(2);
    expect(c.effectiveCount).toBe(0);
    expect(c.overstated).toBe(true);
  });

  it('does not re-open a settled answer: a declined row stays declined', () => {
    // `responded_at` gates *confirmed*, not every status. Somebody who declined
    // is out whether or not the decline was recorded on their behalf, because
    // the wrong direction to be wrong in is counting them.
    const st = standingFor(shift(), staff({ attendeeStatus: 'declined', respondedAt: null }));
    expect(st.kind).toBe('declined');
    expect(st.counts).toBe(false);
  });

  it('does not count somebody whose flight lands after the shift starts', () => {
    const sh = shift();
    const late = staff({ arrivesOn: new Date(sh.startsAt.getTime() + 3_600_000) });
    expect(standingFor(sh, late).kind).toBe('arrives_late');
  });

  it('does not count somebody who leaves before the shift ends', () => {
    const sh = shift();
    const early = staff({ departsOn: new Date(sh.endsAt.getTime() - 60_000) });
    expect(standingFor(sh, early).kind).toBe('departs_early');
  });

  it('treats an unknown travel window as unknown, not as absence', () => {
    // Plenty of people drive. Flagging every unrecorded window would put the
    // whole roster in the hole list, which is the same as flagging nobody.
    expect(standingFor(shift(), staff({ arrivesOn: null, departsOn: null })).counts).toBe(true);
  });

  it('names one problem per person, worst first', () => {
    const sh = shift();
    const s = standingFor(sh, staff({ attendeeStatus: 'declined', arrivesOn: days(99) }));
    expect(s.kind).toBe('declined');
  });
});

describe('coverage — rostered versus present', () => {
  it('says nothing about presence for a shift that has not happened', () => {
    expect(coverageFor(shift(), NOW).presence).toBeNull();
  });

  it('counts a no-show only among people the roster was relying on', () => {
    const past = shift({
      startsAt: days(-2),
      endsAt: days(-2 + 0.1),
      assigned: [staff(), staff({ userId: 'u2', fullName: 'Tomas Alvarez', attendeeStatus: 'declined' })],
      presentUserIds: [],
    });
    const c = coverageFor(past, NOW);
    expect(c.presence?.present).toBe(0);
    // u2 declined the show — already reported as a roster problem. Listing them
    // again as a no-show would double-count one mistake as two.
    expect(c.presence?.noShows.map((n) => n.userId)).toEqual(['u1']);
  });

  it('reports no rostered-versus-present figure at all when nothing is in the past', () => {
    // `0 present` would read as "everybody skipped it".
    expect(summarizeCoverage([coverageFor(shift(), NOW)]).rosteredVersusPresent).toBeNull();
  });
});

describe('personal clashes', () => {
  it('catches the booth shift that runs into the customer dinner', () => {
    const clashes = planPersonalClashes([
      {
        userId: 'u1',
        fullName: 'Priya Raman',
        commitment: { kind: 'shift', id: 'sh1', label: 'Booth shift', startsAt: hours(1), endsAt: hours(5) },
      },
      {
        userId: 'u1',
        fullName: 'Priya Raman',
        commitment: { kind: 'side_event', id: 'e1', label: 'Customer dinner', startsAt: hours(4), endsAt: hours(7) },
      },
    ]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].summary).toContain('Customer dinner');
  });

  it('does not flag back-to-back commitments that merely touch', () => {
    const clashes = planPersonalClashes([
      {
        userId: 'u1',
        fullName: 'Priya Raman',
        commitment: { kind: 'shift', id: 'a', label: 'Morning', startsAt: hours(1), endsAt: hours(5) },
      },
      {
        userId: 'u1',
        fullName: 'Priya Raman',
        commitment: { kind: 'shift', id: 'b', label: 'Afternoon', startsAt: hours(5), endsAt: hours(9) },
      },
    ]);
    expect(clashes).toHaveLength(0);
    expect(overlaps(hours(1), hours(5), hours(5), hours(9))).toBe(false);
  });

  it('never clashes two different people', () => {
    const at = { startsAt: hours(1), endsAt: hours(5) };
    expect(
      planPersonalClashes([
        { userId: 'u1', fullName: 'A', commitment: { kind: 'shift', id: 'a', label: 'x', ...at } },
        { userId: 'u2', fullName: 'B', commitment: { kind: 'shift', id: 'b', label: 'y', ...at } },
      ]),
    ).toHaveLength(0);
  });
});

/* -------------------------------- conflicts -------------------------------- */

const attendance = (over: Partial<Attendance> = {}): Attendance => ({
  attendeeId: 'a1',
  showId: 'show1',
  showName: 'Automate 2026',
  showStatus: 'committed',
  userId: 'u1',
  userName: 'Priya Raman',
  status: 'confirmed',
  arrivesOn: days(10),
  departsOn: days(13),
  showStartsOn: days(10),
  showEndsOn: days(14),
  ...over,
});

describe('double-booking across shows', () => {
  it('does not flag two overlapping shows a person attends on different days', () => {
    // The correction. Show dates overlap; the person does not, and a warning
    // that fires on the ordinary busy week is one nobody reads.
    const conflicts = planConflicts([
      attendance({ arrivesOn: days(10), departsOn: days(11) }),
      attendance({
        attendeeId: 'a2',
        showId: 'show2',
        showName: 'MedTech Summit',
        arrivesOn: days(12),
        departsOn: days(14),
      }),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it('flags genuinely overlapping travel windows as certain', () => {
    const [c] = planConflicts([
      attendance({ arrivesOn: days(10), departsOn: days(13) }),
      attendance({
        attendeeId: 'a2',
        showId: 'show2',
        showName: 'MedTech Summit',
        arrivesOn: days(12),
        departsOn: days(15),
      }),
    ]);
    expect(c.certainty).toBe('certain');
    expect(c.severity).toBe('critical');
    expect(c.summary).toContain('at the same time');
  });

  it('falls back to show dates when a window is missing, and says the finding is a guess', () => {
    const [c] = planConflicts([
      attendance({ arrivesOn: null, departsOn: null }),
      attendance({
        attendeeId: 'a2',
        showId: 'show2',
        showName: 'MedTech Summit',
        arrivesOn: null,
        departsOn: null,
        showStartsOn: days(12),
        showEndsOn: days(16),
      }),
    ]);
    expect(c.certainty).toBe('possible');
    expect(c.severity).toBe('warning');
    expect(c.summary).toContain('No travel window');
    expect(c.a.windowKnown).toBe(false);
  });

  it('never escalates an unanswered invitation to critical', () => {
    const [c] = planConflicts([
      attendance({ status: 'invited' }),
      attendance({ attendeeId: 'a2', showId: 'show2', showName: 'MedTech Summit' }),
    ]);
    expect(c.severity).toBe('warning');
  });

  it('ignores shows somebody declined or is waitlisted for', () => {
    expect(
      planConflicts([
        attendance({ status: 'declined' }),
        attendance({ attendeeId: 'a2', showId: 'show2', showName: 'MedTech Summit' }),
      ]),
    ).toHaveLength(0);
    expect(
      planConflicts([
        attendance({ status: 'waitlist' }),
        attendance({ attendeeId: 'a2', showId: 'show2', showName: 'MedTech Summit' }),
      ]),
    ).toHaveLength(0);
  });

  it('ignores a cancelled show — nobody is going', () => {
    expect(
      planConflicts([
        attendance(),
        attendance({
          attendeeId: 'a2',
          showId: 'show2',
          showName: 'Declined show',
          showStatus: 'cancelled',
        }),
      ]),
    ).toHaveLength(0);
  });

  it('never conflicts a show with itself', () => {
    expect(planConflicts([attendance(), attendance({ attendeeId: 'a2' })])).toHaveLength(0);
  });

  it('narrows the org-wide list to one show without losing the other side of it', () => {
    const all = planConflicts([
      attendance(),
      attendance({ attendeeId: 'a2', showId: 'show2', showName: 'MedTech Summit' }),
    ]);
    const forShow2 = conflictsForShow(all, 'show2');
    expect(forShow2).toHaveLength(1);
    expect(forShow2[0].a.showName).toBe('Automate 2026');
  });
});

/* -------------------------------- validation ------------------------------- */

describe('attendee validation', () => {
  it('accepts a roster row with no travel window at all', () => {
    const v = validateAttendee({ userId: 'u1', role: 'Booth staff', status: 'invited' });
    expect(v.arrivesLocal).toBeNull();
    expect(v.departsLocal).toBeNull();
  });

  it('refuses half a travel window', () => {
    expect(() =>
      validateAttendee({ userId: 'u1', role: 'Booth staff', status: 'invited', arrivesAt: '09:00' }),
    ).toThrow(TeamError);
  });

  it('refuses a departure before the arrival', () => {
    expect(() =>
      validateAttendee({
        userId: 'u1',
        role: 'Booth staff',
        status: 'invited',
        arrivesOn: '2026-05-12',
        arrivesAt: '09:00',
        departsOn: '2026-05-11',
        departsAt: '09:00',
      }),
    ).toThrow(/after arrival/);
  });

  it('needs somebody to staff', () => {
    expect(() => validateAttendee({ userId: '', role: 'Booth staff', status: 'invited' })).toThrow(
      TeamError,
    );
  });
});

describe('shift validation', () => {
  const base = { startsOn: '2026-05-12', startsAt: '09:00', endsOn: '2026-05-12', targetStaff: 3 };

  it('requires a time of day, in the show’s zone', () => {
    expect(() => validateShift({ ...base, endsAt: '' })).toThrow(/time of day/);
  });

  it('refuses a shift that ends before it starts', () => {
    expect(() => validateShift({ ...base, endsAt: '08:00' })).toThrow(/end after it starts/);
  });

  it('refuses an implausibly long shift rather than quietly halving coverage', () => {
    expect(() =>
      validateShift({ ...base, endsOn: '2026-05-13', endsAt: '09:00' }),
    ).toThrow(/24-hour shift|split it into shifts/);
  });

  it('refuses a staffing target of zero', () => {
    expect(() => validateShift({ ...base, endsAt: '13:00', targetStaff: 0 })).toThrow(TeamError);
  });
});

describe('side events, guest lists and capacity', () => {
  const base = {
    name: 'Customer dinner',
    kind: 'dinner',
    startsOn: '2026-05-12',
    startsAt: '19:00',
    costCenterId: 'cc1',
  };

  it('parses a budget through the decimal parser, not parseFloat', () => {
    expect(validateSideEvent({ ...base, budget: '4500.10' }).budgetCents).toBe(450_010);
  });

  it('refuses a side event with no cost center — somebody pays for the dinner', () => {
    expect(() => validateSideEvent({ ...base, costCenterId: '' })).toThrow(/cost center/);
  });

  it('refuses an RSVP that is both a colleague and an outside guest', () => {
    expect(() => validateRsvp({ userId: 'u1', guestName: 'Alicia Ferrer', status: 'invited' })).toThrow(
      /not both/,
    );
  });

  it('refuses an RSVP that is neither', () => {
    expect(() => validateRsvp({ status: 'invited' })).toThrow(TeamError);
  });

  it('counts acceptances against capacity, not invitations', () => {
    // Eighteen seats, twenty invited, nine declined: the nineteenth invitation
    // is fine and the nineteenth *acceptance* is not.
    expect(rsvpFits(18, 11, 'invited', false)).toBe(true);
    expect(rsvpFits(18, 17, 'accepted', false)).toBe(true);
    expect(rsvpFits(18, 18, 'accepted', false)).not.toBe(true);
  });

  it('lets somebody who already accepted stay accepted at capacity', () => {
    expect(rsvpFits(18, 18, 'accepted', true)).toBe(true);
  });

  it('treats no capacity as no limit', () => {
    expect(rsvpFits(null, 900, 'accepted', false)).toBe(true);
  });
});

describe('un-staffing says what it does not cancel', () => {
  it('names the ticket, because removing somebody here does not tell the airline', () => {
    const words = describeDetachment({
      ticketedFlights: 1,
      lodgingRooms: 1,
      shifts: 2,
      acceptedSideEvents: 0,
    });
    expect(words).toContain('still with the airline');
    expect(words).toContain('stays with the hotel');
    expect(words).toContain('2 booth shifts');
  });

  it('says nothing when there is nothing attached', () => {
    expect(
      describeDetachment({ ticketedFlights: 0, lodgingRooms: 0, shifts: 0, acceptedSideEvents: 0 }),
    ).toBeNull();
  });
});

describe('lodging validation', () => {
  const base = { hotelName: 'Detroit Foundation Hotel', costCenterId: 'cc1' };

  it('defaults check-in and check-out to plausible hotel hours rather than midnight', () => {
    const v = validateLodging({ ...base, checkInOn: '2026-05-10', checkOutOn: '2026-05-14' });
    expect(v.checkInLocal).toBe('2026-05-10T15:00:00');
    expect(v.checkOutLocal).toBe('2026-05-14T11:00:00');
  });

  it('refuses a room block cutoff that falls inside the stay', () => {
    expect(() =>
      validateLodging({
        ...base,
        checkInOn: '2026-05-10',
        checkOutOn: '2026-05-14',
        roomBlockCutoffOn: '2026-05-12',
      }),
    ).toThrow(/precedes the stay|cannot be right/);
  });

  it('refuses lodging with no cost center', () => {
    expect(() => validateLodging({ ...base, costCenterId: '' })).toThrow(/cost center/);
  });

  it('parses the nightly rate as cents through the shared parser', () => {
    expect(validateLodging({ ...base, nightlyRate: '289.00' }).nightlyRateCents).toBe(28_900);
  });

  it('refuses a check-out before check-in', () => {
    expect(() =>
      validateLodging({ ...base, checkInOn: '2026-05-14', checkOutOn: '2026-05-10' }),
    ).toThrow(/after check-in/);
  });
});
