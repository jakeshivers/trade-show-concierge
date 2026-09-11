/**
 * How far a show is from now, in either direction.
 *
 * Every board in this product moved to clock-first ordering on 2026-09-02, and
 * three of them needed the same question answered — *which show is nearest?* —
 * where "nearest" cannot be a subtraction, because a show is an interval rather
 * than an instant. A show running today is at distance zero for its whole run;
 * one that ended yesterday is nearer than one opening next month.
 *
 * It exists as a module because it had already been written twice by hand, in
 * `_components/go-to-show.tsx` and in the shipping board's own picker, which is
 * one short of the four copies of `toISOString().slice(0, 10)` the UI rework
 * found. A comparator is exactly the kind of thing that gets re-derived slightly
 * differently each time and never disagrees loudly enough to be noticed.
 */

export type ShowWindow = { startsOn: Date; endsOn: Date };

/** Milliseconds to the nearest edge of the show. Zero while it is running. */
export function distanceToNow(show: ShowWindow, asOf: Date): number {
  const now = asOf.getTime();
  if (now < show.startsOn.getTime()) return show.startsOn.getTime() - now;
  if (now > show.endsOn.getTime()) return now - show.endsOn.getTime();
  return 0;
}

/** Has the show opened yet? A show running now counts as opened. */
export function hasOpened(show: { startsOn: Date }, asOf: Date): boolean {
  return asOf.getTime() >= show.startsOn.getTime();
}

/**
 * The retrospective order, discovered on `/leads` and reused by `/roi`.
 *
 * Boards that list *obligations* run soonest-first: the next thing due is the
 * most urgent. Boards that report on what already happened run the other way —
 * the nearest thing to now is the show that just ended, and the clock runs
 * backwards from there. Ascending on a retrospective page opens it on 2024.
 *
 * Shows that have not opened sort after every show being reported on, because
 * they have nothing to report rather than a bad result, and within that tail the
 * order flips back to soonest-first since those rows are prospective again.
 */
export function byMostRecentlyOpened(
  a: ShowWindow,
  b: ShowWindow,
  asOf: Date,
): number {
  const ao = hasOpened(a, asOf);
  const bo = hasOpened(b, asOf);
  if (ao !== bo) return ao ? -1 : 1;
  return ao
    ? b.startsOn.getTime() - a.startsOn.getTime()
    : a.startsOn.getTime() - b.startsOn.getTime();
}
