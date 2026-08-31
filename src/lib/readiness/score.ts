/**
 * Weighted readiness scoring.
 *
 * Step 3 shipped a nine-line placeholder here so the show list could print a real
 * number. Step 10 makes the number load-bearing — it is what the portfolio rollup
 * ranks on and what a show lead reads before deciding whether to worry — and two
 * things about the placeholder do not survive that promotion:
 *
 * 1. **`readinessScore([]) === 100` says an unplanned show is a finished one.** On
 *    one show page that reads as a rounding decision. On a portfolio ranked by
 *    score it is a lie with consequences: the show nobody has touched sorts above
 *    every show somebody is working on, so the one that most needs attention is
 *    the one the screen most reassures you about. A show with no checklist is
 *    *unplanned*, which is a different state from ready, so the score is `null`
 *    and every caller has to say what it renders for that.
 *
 * 2. **A single percentage hides the shape of what is left.** Blocked and
 *    not-started both earn zero credit and are not the same problem — one needs
 *    somebody to do the work, the other needs somebody to remove an obstacle —
 *    and an overdue task does not move the percentage at all, because the score
 *    has no clock in it. So scoring returns a breakdown, not a number, and the
 *    screens lead with what is wrong rather than with the headline.
 *
 * Pure, and the clock is a parameter: "overdue" is a claim about now, and a
 * function that reads `Date.now()` itself cannot be tested against the day before
 * a deadline.
 */

export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'complete' | 'skipped';

export type ScorableTask = {
  status: TaskStatus;
  weight: number;
  dueOn?: Date | null;
};

/** Partial credit for in-progress work, so the score moves as work happens. */
const CREDIT: Record<TaskStatus, number> = {
  complete: 1,
  in_progress: 0.5,
  blocked: 0,
  not_started: 0,
  skipped: 0,
};

export type Readiness = {
  /**
   * 0–100, or `null` when there is nothing to score. `null` means *unplanned*:
   * no checklist exists, or every task on it was skipped. Never render it as 0
   * (which reads as "behind") or as 100 (which reads as "done").
   */
  score: number | null;
  /** Tasks that count toward the score — everything not skipped. */
  counted: number;
  total: number;
  byStatus: Record<TaskStatus, number>;
  /** Not complete, not skipped, and past due as of `asOf`. */
  overdue: number;
  blocked: number;
  /**
   * Weight sitting in blocked tasks as a share of counted weight. A 90% show with
   * its remaining 10% blocked on a contract is not a 90% show, and this is the
   * number that says so.
   */
  blockedShare: number;
};

const EMPTY_BY_STATUS: Record<TaskStatus, number> = {
  not_started: 0,
  in_progress: 0,
  blocked: 0,
  complete: 0,
  skipped: 0,
};

export function isOverdue(task: ScorableTask, asOf: Date): boolean {
  if (task.status === 'complete' || task.status === 'skipped') return false;
  return task.dueOn != null && task.dueOn.getTime() < asOf.getTime();
}

export function scoreChecklist(tasks: ScorableTask[], asOf: Date): Readiness {
  const byStatus = { ...EMPTY_BY_STATUS };
  for (const t of tasks) byStatus[t.status] += 1;

  // Skipped tasks leave the denominator: they are decisions, not outstanding
  // work. `edit.ts` is what stops that from being a free way to raise the score —
  // a skip needs a written reason and an approver.
  const counted = tasks.filter((t) => t.status !== 'skipped');
  const totalWeight = counted.reduce((sum, t) => sum + t.weight, 0);
  const blockedWeight = counted
    .filter((t) => t.status === 'blocked')
    .reduce((sum, t) => sum + t.weight, 0);

  return {
    // No countable work is not 100%. See the header.
    score:
      counted.length === 0 || totalWeight === 0
        ? null
        : Math.round(
            (counted.reduce((sum, t) => sum + t.weight * CREDIT[t.status], 0) / totalWeight) * 100,
          ),
    counted: counted.length,
    total: tasks.length,
    byStatus,
    overdue: tasks.filter((t) => isOverdue(t, asOf)).length,
    blocked: byStatus.blocked,
    blockedShare: totalWeight === 0 ? 0 : blockedWeight / totalWeight,
  };
}
