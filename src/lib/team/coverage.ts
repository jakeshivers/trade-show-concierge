/**
 * Booth coverage — the difference between a shift that *looks* staffed and one
 * that is.
 *
 * SCOPE.md §4 already insists that `booth_shift` and `shift_presence` are
 * separate tables: "rostered ≠ present, and the gap between them is the staffing
 * insight." Building the roster made a second gap visible, earlier and cheaper
 * than presence, and it is the one this file exists for:
 *
 * **A roster count lies about the future the same way a presence count reports
 * the past.** "3 of 3 assigned" is computed from `shift_assignments` alone, and
 * every one of those three can be someone who has not accepted the invitation,
 * someone who *declined* the show, someone nobody ever put on the roster, or
 * someone whose flight lands two hours after the shift starts. Each of those is a
 * hole that renders as a filled slot — and a filled slot is the one thing nobody
 * looks at again. The screen that reassures you is worse than no screen.
 *
 * So coverage is counted from people who can actually stand in the booth:
 * on the roster, confirmed, and in town for the whole slot. `assignedCount` is
 * still reported beside `effectiveCount`, because the gap between them *is* the
 * work list — and `overstated` names the case where the naive count would have
 * said the shift was full.
 *
 * Pure, clock injected, same reasons as `deadlines/alerts.ts` and
 * `readiness/score.ts`: every sentence here is a claim about a moment.
 */

export type AttendeeStatus = 'invited' | 'confirmed' | 'declined' | 'waitlist';

/** A person assigned to a shift, plus what the roster says about them. */
export type AssignedStaff = {
  userId: string;
  fullName: string;
  /** `null` means they are assigned to a shift on a show they are not staffed on. */
  attendeeStatus: AttendeeStatus | null;
  arrivesOn: Date | null;
  departsOn: Date | null;
};

export type StandingKind =
  | 'covered'
  | 'not_on_roster'
  | 'declined'
  | 'unconfirmed'
  | 'arrives_late'
  | 'departs_early';

export type Standing = {
  userId: string;
  fullName: string;
  kind: StandingKind;
  /** Why this person does or does not count, in words a lead can act on. */
  note: string;
  counts: boolean;
  /**
   * The instant the note is about — an arrival or a departure — or null when the
   * problem is not a time. Kept as an instant rather than baked into `note`
   * because this file has no time zone and a booth grid is read in the show's,
   * not the reader's. The screen renders it with `showDateTime`.
   */
  at: Date | null;
};

export type Shift = {
  id: string;
  showId: string;
  startsAt: Date;
  endsAt: Date;
  targetStaff: number;
  notes: string | null;
  assigned: AssignedStaff[];
  /** Who actually turned up. Only meaningful once the shift is in the past. */
  presentUserIds: string[];
};

export type ShiftCoverage = {
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
  targetStaff: number;
  /** What the roster says. */
  assignedCount: number;
  /** What the roster can actually deliver. */
  effectiveCount: number;
  shortBy: number;
  standings: Standing[];
  /**
   * The roster says this shift is full and it is not. The single most useful bit
   * on the page, because it is the one nobody would have gone looking for.
   */
  overstated: boolean;
  /** Past shifts only: rostered-versus-present, §4's original gap. */
  presence: { present: number; noShows: Standing[] } | null;
};

/** Does `[aStart, aEnd)` overlap `[bStart, bEnd)`? Touching ends do not overlap. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * Whether one assigned person can actually work one slot.
 *
 * Ordered worst-first: someone who declined the show *and* has no travel window
 * has one problem to fix, not two, and listing both trains people to skim.
 */
export function standingFor(shift: Shift, staff: AssignedStaff): Standing {
  const base = { userId: staff.userId, fullName: staff.fullName, at: null };

  if (staff.attendeeStatus === null) {
    return {
      ...base,
      kind: 'not_on_roster',
      counts: false,
      note: 'Assigned to a booth shift but not staffed on this show at all — add them to the roster or take the shift off them.',
    };
  }
  if (staff.attendeeStatus === 'declined') {
    return {
      ...base,
      kind: 'declined',
      counts: false,
      note: 'Declined this show. The assignment is still on the shift, which is why the shift looked covered.',
    };
  }
  if (staff.attendeeStatus !== 'confirmed') {
    return {
      ...base,
      kind: 'unconfirmed',
      counts: false,
      note:
        staff.attendeeStatus === 'waitlist'
          ? 'On the waitlist for this show — not yet a person who is going.'
          : 'Invited but has not accepted. Pencilled in is not staffed.',
    };
  }
  // Confirmed, so the only question left is whether they are physically there.
  // An unknown travel window is not a hole: plenty of people drive, and treating
  // "we have not recorded a flight yet" as absence would flag the whole roster.
  if (staff.arrivesOn && staff.arrivesOn.getTime() > shift.startsAt.getTime()) {
    return {
      ...base,
      kind: 'arrives_late',
      counts: false,
      at: staff.arrivesOn,
      note: 'Does not land until after this shift starts.',
    };
  }
  if (staff.departsOn && staff.departsOn.getTime() < shift.endsAt.getTime()) {
    return {
      ...base,
      kind: 'departs_early',
      counts: false,
      at: staff.departsOn,
      note: 'Leaves before this shift ends.',
    };
  }
  return { ...base, kind: 'covered', counts: true, note: 'Confirmed and in town.' };
}

export function coverageFor(shift: Shift, asOf: Date): ShiftCoverage {
  const standings = shift.assigned.map((staff) => standingFor(shift, staff));
  const effectiveCount = standings.filter((s) => s.counts).length;
  const assignedCount = shift.assigned.length;
  const past = shift.endsAt.getTime() <= asOf.getTime();

  return {
    shiftId: shift.id,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    targetStaff: shift.targetStaff,
    assignedCount,
    effectiveCount,
    shortBy: Math.max(0, shift.targetStaff - effectiveCount),
    standings,
    overstated: assignedCount >= shift.targetStaff && effectiveCount < shift.targetStaff,
    presence: past
      ? {
          present: shift.presentUserIds.length,
          // A no-show is somebody the roster was counting on. Somebody who was
          // never going to be there is a roster problem, already named above.
          noShows: standings.filter(
            (s) => s.counts && !shift.presentUserIds.includes(s.userId),
          ),
        }
      : null,
  };
}

export type CoverageSummary = {
  shifts: number;
  /** Shifts that cannot meet their target with the people who can actually work. */
  short: number;
  /** …of those, the ones a naive roster count would have called full. */
  overstated: number;
  /** Person-slots missing, summed. The size of the hiring ask, not its shape. */
  missingSlots: number;
  /** Past shifts only, and null when there are none — 0 would read as "all present". */
  rosteredVersusPresent: { rostered: number; present: number } | null;
};

export function summarizeCoverage(coverages: ShiftCoverage[]): CoverageSummary {
  const past = coverages.filter((c) => c.presence !== null);
  return {
    shifts: coverages.length,
    short: coverages.filter((c) => c.shortBy > 0).length,
    overstated: coverages.filter((c) => c.overstated).length,
    missingSlots: coverages.reduce((n, c) => n + c.shortBy, 0),
    rosteredVersusPresent: past.length
      ? {
          rostered: past.reduce((n, c) => n + c.effectiveCount, 0),
          present: past.reduce((n, c) => n + (c.presence?.present ?? 0), 0),
        }
      : null,
  };
}

/* ----------------------------- personal clashes ---------------------------- */

/**
 * One person, two places, same hour — inside a single show.
 *
 * Cross-show double-booking lives in `conflicts.ts`; this is the everyday version
 * that actually happens, and the one a roster builder creates by accident: the SE
 * who is on the booth 1–5 is also at the customer dinner that starts at 4:30, and
 * the person who signed them up for the dinner was not looking at the shift grid.
 */
export type Commitment = {
  kind: 'shift' | 'side_event';
  id: string;
  label: string;
  startsAt: Date;
  endsAt: Date;
};

export type PersonalClash = {
  userId: string;
  a: Commitment;
  b: Commitment;
  summary: string;
};

export function planPersonalClashes(
  commitments: { userId: string; fullName: string; commitment: Commitment }[],
): PersonalClash[] {
  const byUser = new Map<string, { fullName: string; items: Commitment[] }>();
  for (const c of commitments) {
    const entry = byUser.get(c.userId) ?? { fullName: c.fullName, items: [] };
    entry.items.push(c.commitment);
    byUser.set(c.userId, entry);
  }

  const clashes: PersonalClash[] = [];
  for (const [userId, { fullName, items }] of byUser) {
    const sorted = [...items].sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        // Sorted by start, so once b starts after a ends nothing later can clash.
        if (b.startsAt.getTime() >= a.endsAt.getTime()) break;
        if (!overlaps(a.startsAt, a.endsAt, b.startsAt, b.endsAt)) continue;
        clashes.push({
          userId,
          a,
          b,
          summary: `${fullName} is down for “${a.label}” and “${b.label}” at the same time.`,
        });
      }
    }
  }
  return clashes;
}
