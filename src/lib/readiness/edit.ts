import type { TaskStatus } from './score';

/**
 * Checklist editing, as pure functions: what a task draft must contain, and what
 * a status change must carry with it.
 *
 * The rule worth stating up front, because it is the one that makes the score
 * mean anything: **`skipped` leaves the denominator.** Marking a task skipped
 * does not just fail to earn credit, it removes the work from the calculation
 * entirely — which makes "skip it" the fastest way to raise a readiness score
 * without doing anything. So a skip carries a written reason, and (in
 * `visibility.ts`) it is not a change a Member can make to their own task.
 * `blocked` carries one too, for a different reason: a blocked task with no
 * stated obstacle is a task nobody can unblock, and it is the state tasks go to
 * die in.
 *
 * Same shape as `shows/intake.ts` — validation here, rows in `store.ts`.
 */

export type TaskCategory =
  | 'booth'
  | 'collateral'
  | 'staffing'
  | 'travel'
  | 'lodging'
  | 'shipping'
  | 'marketing'
  | 'legal'
  | 'budget'
  | 'follow_up';

export const TASK_CATEGORIES: TaskCategory[] = [
  'booth',
  'collateral',
  'staffing',
  'travel',
  'lodging',
  'shipping',
  'marketing',
  'legal',
  'budget',
  'follow_up',
];

export const TASK_STATUSES: TaskStatus[] = [
  'not_started',
  'in_progress',
  'blocked',
  'complete',
  'skipped',
];

export class ChecklistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecklistError';
  }
}

/**
 * Shorter than a show's intake rationale (20) on purpose. That one argues a
 * budget; this one only has to name an obstacle — "waiting on legal redlines" is
 * a complete and useful answer at 27 characters, and demanding a paragraph for it
 * trains people to type "blocked blocked blocked".
 */
export const MIN_NOTE = 12;

/** Weights above 3 make one task outvote the rest of a category; 1–5 with 3 as "critical". */
export const MAX_WEIGHT = 5;

export type TaskDraft = {
  title: string;
  description?: string | null;
  category: string;
  weight: number;
  /** `YYYY-MM-DD` in the show's zone, or null. Resolved to an instant by the store. */
  dueOn?: string | null;
  assigneeId?: string | null;
};

export type ValidatedDraft = {
  title: string;
  description: string | null;
  category: TaskCategory;
  weight: number;
  dueOn: string | null;
  assigneeId: string | null;
};

export function validateDraft(draft: TaskDraft): ValidatedDraft {
  const title = draft.title.trim();
  if (title.length < 3) throw new ChecklistError('A task needs a title.');
  if (title.length > 200) throw new ChecklistError('Task titles are capped at 200 characters.');

  if (!TASK_CATEGORIES.includes(draft.category as TaskCategory)) {
    throw new ChecklistError(`"${draft.category}" is not a checklist category.`);
  }

  if (!Number.isInteger(draft.weight) || draft.weight < 1 || draft.weight > MAX_WEIGHT) {
    throw new ChecklistError(`Weight must be a whole number from 1 to ${MAX_WEIGHT}.`);
  }

  const dueOn = draft.dueOn?.trim() || null;
  if (dueOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw new ChecklistError('A due date must be YYYY-MM-DD, or blank.');
  }

  return {
    title,
    description: draft.description?.trim() || null,
    category: draft.category as TaskCategory,
    weight: draft.weight,
    dueOn,
    assigneeId: draft.assigneeId?.trim() || null,
  };
}

/** Statuses that must be accompanied by a written reason. */
export function requiresNote(status: TaskStatus): boolean {
  return status === 'blocked' || status === 'skipped';
}

export type StatusChange = {
  status: TaskStatus;
  note: string | null;
  /** Set on entering `complete`, cleared on leaving it. */
  completedAt: Date | null;
  completedById: string | null;
};

/**
 * Resolve a status change into exactly the columns it writes.
 *
 * Leaving `complete` clears `completedAt` rather than leaving it behind. A task
 * re-opened in March still carrying "completed in January" is the sort of stale
 * timestamp that later gets aggregated into a report about how fast the team
 * works.
 */
export function planStatusChange(
  next: string,
  note: string | null | undefined,
  actorId: string,
  now: Date,
): StatusChange {
  if (!TASK_STATUSES.includes(next as TaskStatus)) {
    throw new ChecklistError(`"${next}" is not a task status.`);
  }
  const status = next as TaskStatus;

  const trimmed = note?.trim() || null;
  if (requiresNote(status) && (trimmed === null || trimmed.length < MIN_NOTE)) {
    throw new ChecklistError(
      status === 'skipped'
        ? `Say why this task is being skipped — at least ${MIN_NOTE} characters. A skip drops ` +
          'the task out of the readiness score entirely, so it has to be a decision somebody ' +
          'made rather than a way to make the number go up.'
        : `Say what this task is blocked on — at least ${MIN_NOTE} characters. "Blocked" with ` +
          'no obstacle named is a task nobody else can pick up.',
    );
  }

  return {
    status,
    // The note belongs to the state that needed it. Carrying a stale "waiting on
    // legal" onto a completed task misreports why it took as long as it did.
    note: requiresNote(status) ? trimmed : null,
    completedAt: status === 'complete' ? now : null,
    completedById: status === 'complete' ? actorId : null,
  };
}
