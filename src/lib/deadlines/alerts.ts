import type { DeadlineStatus } from './edit';

/**
 * The escalation engine. SCOPE.md §5a: "escalating alerts at T-30 / T-14 / T-3 /
 * day-of."
 *
 * Pure, and the clock is a parameter, for the reason `score.ts` gives: every
 * sentence this file produces is a claim about a moment, and a function that
 * reads `Date.now()` itself cannot be tested against the day before a deadline.
 * The store turns the plan into `alerts` rows; nothing here writes.
 *
 * Four things this file exists to get right — three of them corrections to what
 * "escalating alerts at T-30 / T-14 / T-3" sounds like when you first read it.
 *
 * **1. An unconfirmed deadline alerts about itself, not about its money.**
 * The schema's rule is that a human confirms an extracted deadline "before it
 * becomes an alert" (§5a). Read literally that means silence on precisely the
 * rows most likely to be wrong — including every deadline a clone predicted by
 * shifting last year's date, which is a guess by construction. Silence is the
 * worst outcome available: the whole feature exists to stop a date passing
 * unnoticed. But announcing "$3,125 at risk on Feb 3" for a date nobody has
 * checked against this year's manual is worse than useless — it is a fabricated
 * bill, and once one of those turns out to be wrong nobody reads the next one.
 * So an unconfirmed deadline raises a *confirm this date* alert, earlier than the
 * money alerts and without quoting the penalty as established. Confirmation gates
 * the claim about money, not the reminder.
 *
 * **2. After the date passes, the tense changes and so does the audience.**
 * A T+1 alert that says "$3,125 at risk" is false: the surcharge is not at risk,
 * it has been incurred. And the person who needed the reminder is not the person
 * who needs the fact — a missed advance-order deadline stops being the owner's
 * to-do and becomes the show lead's cost. So past-due produces one alert, in the
 * past tense, addressed to whoever runs the show, and it does not repeat nightly.
 * `portfolio.ts` was already counting these cents as incurred; this is where
 * saying otherwise would have been the lie.
 *
 * **3. An unowned deadline is the most likely to be missed and — addressed to
 * its owner — the least likely to reach anybody.** `owner_id` is nullable and
 * plenty of real rows have no owner. An engine that mails the owner sends zero
 * alerts on exactly those, silently. So unownedness escalates rather than
 * mutes: the alert goes to whoever runs the show and says the row has no owner,
 * because that is the thing to fix.
 *
 * **4. An alert is a claim about a date, so the dedupe key carries the date.**
 * The credit ledger keys its expiry alerts on the bucket alone (`credit:…:90`),
 * which is sound there because a credit's expiry never moves. A deadline's does —
 * that is half of what editing the register is *for*. Key on the bucket alone and
 * moving a deadline from March to May leaves a "3 days left" warning standing for
 * a date that no longer exists, while suppressing the one the new date deserves.
 * So the key carries the due instant, and re-dating a deadline voids every alert
 * already sent about it.
 */

export type AlertableDeadline = {
  id: string;
  showId: string;
  title: string;
  kind: string;
  dueAt: Date;
  status: DeadlineStatus;
  penaltyEstimateCents: number | null;
  penaltyNote: string | null;
  ownerId: string | null;
  confirmedAt: Date | null;
};

/**
 * §5a's thresholds, in days before the deadline. `0` is day-of.
 *
 * Descending, and matched by "the smallest bucket whose window we are inside",
 * so a deadline first seen nine days out fires at 14 and not at 30 — the alert
 * that matters is the current one, and replaying the ones we slept through just
 * buries it.
 */
export const THRESHOLD_DAYS = [30, 14, 3, 0] as const;

/**
 * Confirmation is chased a fortnight ahead of the first money alert. A deadline
 * confirmed at T-30 is still cheap to act on; one confirmed at T-3 has already
 * spent the time it needed.
 */
export const CONFIRM_BY_DAYS = 45;

export type AlertAudience = 'owner' | 'show_runners';

export type PlannedAlert = {
  deadlineId: string;
  showId: string;
  /** `owner` still means "and the show runners see it too"; see `store.ts`. */
  audience: AlertAudience;
  ownerId: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  /** Stable per (deadline, due instant, reason). Correction 4. */
  dedupeKey: string;
  /** Which threshold this is, for tests and for the CLI's summary. `-1` past due. */
  bucketDays: number;
  daysUntil: number;
};

/** Whole days from `asOf` to `dueAt`, rounded toward the deadline being closer. */
export function daysUntilDue(dueAt: Date, asOf: Date): number {
  return Math.floor((dueAt.getTime() - asOf.getTime()) / 86_400_000);
}

/** The tightest threshold `daysUntil` has entered, or null if none yet. */
export function thresholdFor(daysUntil: number): number | null {
  if (daysUntil < 0) return null;
  const entered = THRESHOLD_DAYS.filter((t) => daysUntil <= t);
  return entered.length === 0 ? null : Math.min(...entered);
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

/** The dollar clause, or the honest absence of one. */
function penaltyClause(d: AlertableDeadline): string {
  if (d.penaltyEstimateCents == null) {
    return 'No penalty estimate is recorded, so nobody can tell from this row what missing it costs.';
  }
  const note = d.penaltyNote?.trim();
  const tail = note ? ` — ${/[.!?]$/.test(note) ? note : `${note}.`}` : '.';
  return `Estimated penalty ${usd(d.penaltyEstimateCents)}${tail}`;
}

function severityFor(bucket: number, cents: number | null): PlannedAlert['severity'] {
  if (bucket <= 3) return 'critical';
  if (bucket <= 14 || (cents ?? 0) >= 100_000) return 'warning';
  return 'info';
}

/**
 * What this deadline is owed at `asOf` — at most one alert per deadline per run.
 *
 * At most one is deliberate. A deadline that is unconfirmed *and* three days out
 * has one problem, not two, and the register that sends both teaches people that
 * two thirds of these can be closed unread.
 */
export function planDeadlineAlert(d: AlertableDeadline, asOf: Date): PlannedAlert | null {
  // A closed row has nothing to chase. `not_applicable` is why that state needs a
  // written reason and an approver (`edit.ts`) — it is how a deadline goes quiet.
  if (d.status !== 'open') return null;

  const daysUntil = daysUntilDue(d.dueAt, asOf);
  const stamp = d.dueAt.toISOString();
  const owned = d.ownerId !== null;
  const unownedClause = owned
    ? ''
    : ' Nobody owns this deadline, which is the part to fix first — an unowned row is one ' +
      'everybody assumes somebody else is handling.';

  // Correction 2: past the date, the money is spent, not at risk.
  if (daysUntil < 0) {
    const late = Math.abs(daysUntil);
    return {
      deadlineId: d.id,
      showId: d.showId,
      audience: 'show_runners',
      ownerId: d.ownerId,
      severity: 'critical',
      title:
        d.penaltyEstimateCents != null
          ? `Missed: ${d.title} — ${usd(d.penaltyEstimateCents)} in surcharges now applies`
          : `Missed: ${d.title}`,
      body:
        `The deadline passed ${late} day${late === 1 ? '' : 's'} ago. This is not a reminder — ` +
        'anything ordered against it is now billed at the late rate. ' +
        penaltyClause(d) +
        (d.confirmedAt
          ? ''
          : ' The date was never confirmed against this year’s manual, so check it before ' +
            'booking the loss.') +
        unownedClause,
      dedupeKey: `deadline:${d.id}:${stamp}:missed`,
      bucketDays: -1,
      daysUntil,
    };
  }

  // Correction 1: an unchecked date gets chased as a date, never quoted as a bill.
  if (!d.confirmedAt && daysUntil <= CONFIRM_BY_DAYS) {
    return {
      deadlineId: d.id,
      showId: d.showId,
      audience: owned ? 'owner' : 'show_runners',
      ownerId: d.ownerId,
      severity: daysUntil <= 14 ? 'warning' : 'info',
      title: `Confirm the date: ${d.title} (${daysUntil} days out, unconfirmed)`,
      body:
        'This date has not been checked against this year’s exhibitor manual — it was ' +
        'predicted, cloned, or typed from memory, so it is not yet something to spend against. ' +
        'Confirm it or correct it. Until then no penalty figure on this row is quoted as ' +
        'established.' +
        unownedClause,
      dedupeKey: `deadline:${d.id}:${stamp}:unconfirmed`,
      bucketDays: CONFIRM_BY_DAYS,
      daysUntil,
    };
  }

  const bucket = thresholdFor(daysUntil);
  if (bucket === null || !d.confirmedAt) return null;

  return {
    deadlineId: d.id,
    showId: d.showId,
    // Correction 3: unowned escalates rather than falling on the floor.
    audience: owned ? 'owner' : 'show_runners',
    ownerId: d.ownerId,
    severity: severityFor(bucket, d.penaltyEstimateCents),
    // The window in the label, the actual distance in the sentence. "T-30" on a
    // deadline 18 days out reads as a typo; "30-day warning … due in 18 days"
    // says both which escalation this is and how long is actually left.
    title:
      bucket === 0
        ? `Due today: ${d.title}`
        : `${bucket === 3 ? 'Final call' : `${bucket}-day warning`}: ${d.title} — due in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
    body: `${penaltyClause(d)}${unownedClause}`,
    dedupeKey: `deadline:${d.id}:${stamp}:t-${bucket}`,
    bucketDays: bucket,
    daysUntil,
  };
}

export function planDeadlineAlerts(deadlines: AlertableDeadline[], asOf: Date): PlannedAlert[] {
  return deadlines
    .map((d) => planDeadlineAlert(d, asOf))
    .filter((a): a is PlannedAlert => a !== null)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

/* -------------------------------- exposure --------------------------------- */

export type Exposure = {
  /** Open deadlines whose date is still ahead of us. */
  open: number;
  /** Open and past due — the money is spent. */
  missed: number;
  /** Open, ahead of us, and never checked against this year's manual. */
  unconfirmed: number;
  /** Open, ahead of us, with no owner. */
  unowned: number;
  /**
   * Estimated penalties still avoidable — open, not yet due. Confirmed and
   * unconfirmed are counted apart, because one is a figure from the manual and
   * the other is a guess, and adding them produces a number that is neither.
   */
  atRiskCents: number;
  atRiskUnconfirmedCents: number;
  /** Estimated penalties on deadlines already missed. Not at risk — incurred. */
  incurredCents: number;
};

export function summarizeExposure(deadlines: AlertableDeadline[], asOf: Date): Exposure {
  const e: Exposure = {
    open: 0,
    missed: 0,
    unconfirmed: 0,
    unowned: 0,
    atRiskCents: 0,
    atRiskUnconfirmedCents: 0,
    incurredCents: 0,
  };

  for (const d of deadlines) {
    if (d.status !== 'open') continue;
    const cents = d.penaltyEstimateCents ?? 0;
    if (daysUntilDue(d.dueAt, asOf) < 0) {
      e.missed += 1;
      e.incurredCents += cents;
      continue;
    }
    e.open += 1;
    if (d.ownerId === null) e.unowned += 1;
    if (d.confirmedAt) e.atRiskCents += cents;
    else {
      e.unconfirmed += 1;
      e.atRiskUnconfirmedCents += cents;
    }
  }

  return e;
}
