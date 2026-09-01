/**
 * The feed's model: what an alert row *means* by the time somebody reads it.
 *
 * Pure, and the argument is one sentence long: an alert row is a record that a
 * notification was owed at some instant, and a feed renders it later. Four
 * things can have happened in between, and a screen that shows the row as
 * written reports none of them.
 *
 * 1. **The condition ended.** The crate arrived, the deadline was completed, the
 *    credit was spent. The sweep records that in `resolvedAt` — see the table's
 *    header for why a person cannot — and a resolved alert is history, not work.
 * 2. **Nothing has re-checked it.** The sweeps are a nightly job that this
 *    product does not yet run on a schedule (§10 step 21), so an alert's claim
 *    is exactly as fresh as the last sweep. Rendering a five-day-old row as
 *    tonight's news is `flights/status.ts`'s rule about an unchecked flight,
 *    one layer up: **not knowing is not the same as still true.** `staleAfter`
 *    is generous, because a sweep that runs daily should not make every alert
 *    read as doubtful by lunchtime.
 * 3. **It kept happening.** `occurrences` is the difference between "a crate
 *    went quiet" and "a crate has been quiet for nine days and nine sweeps have
 *    said so". The second is a different conversation.
 * 4. **Somebody acknowledged it.** Which changes nothing in the world, and says
 *    only that a person has seen it. That is worth recording and is not a fix,
 *    so an acknowledged alert whose condition still holds stays visible under
 *    its own heading rather than leaving the screen.
 *
 * Ordering is the house rule for the fifth time: worst first, and the date only
 * breaks ties. But "worst" here is severity *and* standing — a critical alert
 * that has been true for three weeks outranks tonight's, because the one nobody
 * has dealt with in three weeks is the one the product failed to communicate.
 */

export type AlertSource =
  | 'deadline'
  | 'flight'
  | 'shipping'
  | 'asset'
  | 'credit'
  | 'lead'
  | 'roi'
  | 'booking'
  | 'unknown';

export type AlertKind = 'condition' | 'notice';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type FeedAlert = {
  id: string;
  source: AlertSource;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string | null;
  showId: string | null;
  showName: string | null;
  dedupeKey: string;
  createdAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  resolvedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
};

/**
 * How long a condition's last sighting is worth trusting.
 *
 * A day and a half: long enough that a nightly sweep never makes its own output
 * look doubtful, short enough that a week of nobody running one is visible on
 * the screen rather than inferred from a timestamp nobody reads.
 */
export const STALE_AFTER_HOURS = 36;

export type AlertStanding =
  /** Reported once, recently, and still true as far as anything knows. */
  | 'new'
  /** Several sweeps have now said the same thing. */
  | 'repeating'
  /** True when last checked, and nothing has checked since. */
  | 'unchecked'
  /** Somebody has seen it. The condition still holds. */
  | 'acknowledged'
  /** The condition ended. */
  | 'resolved';

export function standingOf(a: FeedAlert, asOf: Date): AlertStanding {
  if (a.resolvedAt) return 'resolved';
  if (a.acknowledgedAt) return 'acknowledged';
  // A notice is an event, not a claim about now, so it can never go stale and
  // never repeats: there is nothing to re-check about a ticket that was bought.
  if (a.kind === 'notice') return 'new';
  const ageHours = (asOf.getTime() - a.lastSeenAt.getTime()) / 3_600_000;
  if (ageHours > STALE_AFTER_HOURS) return 'unchecked';
  return a.occurrences > 1 ? 'repeating' : 'new';
}

/** How long this has been outstanding, in whole days. */
export function standingDays(a: FeedAlert, asOf: Date): number {
  return Math.max(0, Math.floor((asOf.getTime() - a.createdAt.getTime()) / 86_400_000));
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Where a person goes to do something about it.
 *
 * Read off `source` rather than parsed out of the dedupe key. The keys are the
 * engines' own business and gain segments as the engines learn things — a feed
 * that regexes them is a feed that silently stops linking the day one of them
 * changes shape, which is the class of failure nothing catches.
 */
export function linkFor(a: FeedAlert): string | null {
  switch (a.source) {
    case 'deadline':
      return a.showId ? `/shows/${a.showId}/readiness` : '/readiness';
    case 'flight':
      return '/flights';
    case 'shipping':
      return a.showId ? `/shows/${a.showId}/logistics` : '/shipping';
    case 'asset':
      return a.showId ? `/shows/${a.showId}/logistics` : '/assets';
    case 'lead':
      return a.showId ? `/shows/${a.showId}/leads` : '/leads';
    case 'roi':
      return a.showId ? `/shows/${a.showId}/roi` : '/roi';
    case 'credit':
    case 'booking':
      return '/travel';
    default:
      return a.showId ? `/shows/${a.showId}` : null;
  }
}

export const SOURCE_LABEL: Record<AlertSource, string> = {
  deadline: 'Deadline',
  flight: 'Flight',
  shipping: 'Freight',
  asset: 'Asset',
  credit: 'Credit',
  lead: 'Leads',
  roi: 'ROI',
  booking: 'Booking',
  unknown: 'Other',
};

/** Live work, worst first, oldest first within a severity. */
export function orderFeed(alerts: FeedAlert[], asOf: Date): FeedAlert[] {
  return [...alerts].sort((a, b) => {
    const aStanding = standingOf(a, asOf);
    const bStanding = standingOf(b, asOf);
    const settled = (s: AlertStanding) => (s === 'resolved' ? 2 : s === 'acknowledged' ? 1 : 0);
    const bySettled = settled(aStanding) - settled(bStanding);
    if (bySettled !== 0) return bySettled;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export type FeedSummary = {
  /** Unresolved, unacknowledged, and still being confirmed by a sweep. */
  outstanding: number;
  critical: number;
  warning: number;
  /** Seen by somebody, and still true. */
  acknowledged: number;
  /**
   * Outstanding conditions no sweep has confirmed lately. Counted separately
   * because the number is a statement about *us*, not about the crates.
   */
  unchecked: number;
  /** Ended without anybody clearing them — the engines' own good news. */
  resolved: number;
  /** The oldest outstanding alert, in days. */
  oldestDays: number;
};

export function summarizeFeed(alerts: FeedAlert[], asOf: Date): FeedSummary {
  const s: FeedSummary = {
    outstanding: 0,
    critical: 0,
    warning: 0,
    acknowledged: 0,
    unchecked: 0,
    resolved: 0,
    oldestDays: 0,
  };
  for (const a of alerts) {
    const standing = standingOf(a, asOf);
    if (standing === 'resolved') {
      s.resolved += 1;
      continue;
    }
    if (standing === 'acknowledged') {
      s.acknowledged += 1;
      continue;
    }
    s.outstanding += 1;
    if (standing === 'unchecked') s.unchecked += 1;
    if (a.severity === 'critical') s.critical += 1;
    if (a.severity === 'warning') s.warning += 1;
    s.oldestDays = Math.max(s.oldestDays, standingDays(a, asOf));
  }
  return s;
}

/* --------------------------------- grouping -------------------------------- */

/**
 * One sentence, once.
 *
 * The first thing the feed showed on real seeded data, and it was not visible
 * from any of the five per-engine screens: eleven identical "the airline moved
 * DL 1422" rows, addressed to one admin, because eleven people are on that
 * flight and each of their legs is its own row with its own — correct — alert.
 *
 * Every engine dedupes a **fact**: `alerts.ts` in four different features argues
 * about keying on the date, or the bucket, or the standing, so that one crate or
 * one deadline speaks once. Nothing deduped a **sentence**, because until there
 * was a feed nothing ever put two engines' output, or one engine's output about
 * eleven rows, in front of the same pair of eyes. The failure is the one this
 * product keeps naming: an alert that repeats is an alert people learn to scroll
 * past, and they scroll past the next one too.
 *
 * So the reader's copy groups on what it *says* — source, severity and title —
 * while the rows stay individual underneath, because each of them is somebody's
 * actual leg and the traveler's own feed shows exactly one. Grouping is a view
 * concern and it is deliberately not a change to any dedupe key: keys are how an
 * engine avoids writing twice, and this is how a person avoids reading twice.
 */
export type FeedGroup = {
  /** The oldest, most severe member — the one the group is titled by. */
  lead: FeedAlert;
  /** Everything else saying the same sentence, ordered with it. */
  rest: FeedAlert[];
  /** Distinct shows the group touches, for a row that spans several. */
  showNames: string[];
};

export function groupFeed(alerts: FeedAlert[], asOf: Date): FeedGroup[] {
  const ordered = orderFeed(alerts, asOf);
  const groups = new Map<string, FeedGroup>();
  for (const a of ordered) {
    // Standing is part of the key: a resolved copy and a live one are not the
    // same news, and collapsing them would let one arrival close nine crates.
    const key = `${a.source}|${a.severity}|${standingOf(a, asOf)}|${a.title}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { lead: a, rest: [], showNames: a.showName ? [a.showName] : [] });
      continue;
    }
    existing.rest.push(a);
    if (a.showName && !existing.showNames.includes(a.showName)) {
      existing.showNames.push(a.showName);
    }
  }
  return [...groups.values()];
}
