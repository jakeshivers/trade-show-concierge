import type { AttendeeStatus } from './coverage';
import { overlaps } from './coverage';

/**
 * Double-booking across shows. SCOPE.md §5, "Team & shifts": *"Double-booking
 * detection across overlapping shows."*
 *
 * The obvious implementation — flag anyone staffed on two shows whose dates
 * overlap — is wrong in both directions, and both mistakes are expensive in the
 * same way: they train people to ignore the flag.
 *
 * **1. A person is committed over their travel window, not over the show.**
 * Two three-day shows in the same week are not a conflict for somebody who is at
 * one Monday–Tuesday and the other Thursday–Friday, which is an ordinary and
 * deliberate way to work a busy quarter. Comparing show dates flags that as a
 * clash, and a warning that fires on the normal case is one nobody reads. So the
 * comparison is `arrives_on → departs_on`.
 *
 * **2. A missing travel window is not an absence of conflict — it is an absence
 * of information, and it must say so.** Most rosters are half-empty of arrival
 * dates, so a strict window comparison silently clears exactly the rows nobody
 * has planned yet. Where a window is missing we fall back to the show's own dates
 * and mark the finding `possible` rather than `certain`. Two words, and the
 * difference between "sort this out" and "check whether this needs sorting out".
 *
 * And the status matters: `declined` and `waitlist` are not commitments. Flagging
 * somebody for a show they turned down is how a conflict list becomes noise.
 *
 * Pure. The rows come from `store.ts`.
 */

export type Attendance = {
  attendeeId: string;
  showId: string;
  showName: string;
  showStatus: string;
  userId: string;
  userName: string;
  status: AttendeeStatus;
  arrivesOn: Date | null;
  departsOn: Date | null;
  showStartsOn: Date;
  showEndsOn: Date;
};

export type ConflictSide = {
  attendeeId: string;
  showId: string;
  showName: string;
  status: AttendeeStatus;
  /** The window actually compared, and where it came from. */
  from: Date;
  to: Date;
  windowKnown: boolean;
};

export type Conflict = {
  userId: string;
  userName: string;
  a: ConflictSide;
  b: ConflictSide;
  /** `certain` only when both travel windows are recorded. */
  certainty: 'certain' | 'possible';
  severity: 'warning' | 'critical';
  summary: string;
};

/** A show a `declined` or `waitlist` attendee is on is not a commitment. */
const COMMITTED: AttendeeStatus[] = ['invited', 'confirmed'];

/** A cancelled show cannot conflict with anything; nobody is going. */
const LIVE_SHOW_STATUSES = ['committed', 'planning', 'ready', 'live', 'prospect'];

function sideFor(a: Attendance): ConflictSide {
  const windowKnown = a.arrivesOn !== null && a.departsOn !== null;
  return {
    attendeeId: a.attendeeId,
    showId: a.showId,
    showName: a.showName,
    status: a.status,
    from: a.arrivesOn ?? a.showStartsOn,
    to: a.departsOn ?? a.showEndsOn,
    windowKnown,
  };
}

export function planConflicts(attendances: Attendance[]): Conflict[] {
  const eligible = attendances
    .filter((a) => COMMITTED.includes(a.status))
    .filter((a) => LIVE_SHOW_STATUSES.includes(a.showStatus));

  const byUser = new Map<string, Attendance[]>();
  for (const a of eligible) {
    byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  }

  const conflicts: Conflict[] = [];
  for (const [userId, rows] of byUser) {
    const sorted = [...rows].sort(
      (x, y) => (x.arrivesOn ?? x.showStartsOn).getTime() - (y.arrivesOn ?? y.showStartsOn).getTime(),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i].showId === sorted[j].showId) continue;
        const a = sideFor(sorted[i]);
        const b = sideFor(sorted[j]);
        if (!overlaps(a.from, a.to, b.from, b.to)) continue;

        const certain = a.windowKnown && b.windowKnown;
        // Two confirmed commitments is a decision somebody has to make. Anything
        // still `invited` resolves itself the moment they answer, so it is a
        // warning — and a guessed window never escalates past one either.
        const bothConfirmed = sorted[i].status === 'confirmed' && sorted[j].status === 'confirmed';

        conflicts.push({
          userId,
          userName: sorted[i].userName,
          a,
          b,
          certainty: certain ? 'certain' : 'possible',
          severity: certain && bothConfirmed ? 'critical' : 'warning',
          summary: describe(sorted[i].userName, a, b, certain),
        });
      }
    }
  }
  return conflicts;
}

function describe(name: string, a: ConflictSide, b: ConflictSide, certain: boolean): string {
  if (certain) {
    return (
      `${name} is booked to be at ${a.showName} and ${b.showName} at the same time — ` +
      'the travel windows on the two rosters overlap.'
    );
  }
  const missing = [!a.windowKnown ? a.showName : null, !b.windowKnown ? b.showName : null]
    .filter(Boolean)
    .join(' and ');
  return (
    `${name} may be double-booked between ${a.showName} and ${b.showName}. No travel window ` +
    `is recorded for ${missing}, so this compares the show dates instead — set the arrival ` +
    'and departure and this either resolves itself or becomes real.'
  );
}

/** Just this show's share of the org-wide list, for the show's Team tab. */
export function conflictsForShow(conflicts: Conflict[], showId: string): Conflict[] {
  return conflicts.filter((c) => c.a.showId === showId || c.b.showId === showId);
}
