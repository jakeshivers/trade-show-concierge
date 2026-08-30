/**
 * Weighted readiness scoring.
 *
 * Preview of build step 10 — kept minimal and pure so the dev console can show a
 * real number rather than a placeholder.
 */

export type ScorableTask = {
  status: 'not_started' | 'in_progress' | 'blocked' | 'complete' | 'skipped';
  weight: number;
};

/** Partial credit for in-progress work, so the score moves as work happens. */
const CREDIT: Record<ScorableTask['status'], number> = {
  complete: 1,
  in_progress: 0.5,
  blocked: 0,
  not_started: 0,
  skipped: 0,
};

export function readinessScore(tasks: ScorableTask[]): number {
  // Skipped tasks leave the denominator: they are decisions, not outstanding work.
  const counted = tasks.filter((t) => t.status !== 'skipped');
  if (counted.length === 0) return 100;

  const total = counted.reduce((sum, t) => sum + t.weight, 0);
  if (total === 0) return 100;

  const earned = counted.reduce((sum, t) => sum + t.weight * CREDIT[t.status], 0);
  return Math.round((earned / total) * 100);
}
