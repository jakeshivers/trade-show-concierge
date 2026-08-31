import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may change a checklist.
 *
 * This is a finer line than the rest of the planning screens draw, and the split
 * is the point:
 *
 * - **Reporting progress is not a privilege.** A checklist where the engineer who
 *   built the demo cannot tick "demo built" is a checklist somebody else
 *   maintains by asking around, which is the spreadsheet we are replacing. So
 *   anyone may move a task they are assigned to between not-started, in-progress,
 *   blocked and complete.
 * - **Changing the plan is.** Adding, deleting, re-weighting, re-assigning, and
 *   applying a template decide what the score is measured against, so they sit
 *   with whoever is running the show — the same bar as cloning (`canCloneShow`),
 *   and for the same reason: it is planning, not spending.
 * - **Skipping is changing the plan, not reporting progress**, even though it
 *   looks like a status. A skipped task leaves the denominator entirely
 *   (`score.ts`), so letting a Member skip their own task is letting anyone raise
 *   the show's readiness score by declaring their work unnecessary. It needs the
 *   same authority as deleting the task, because that is what it does to the
 *   number.
 *
 * SCOPE.md §3's table does not resolve this on its own — "Manage shows" is admin
 * and would put every tick of a checkbox behind an admin, which is not a security
 * posture, it is an unused feature.
 */

export function canEditChecklist(actor: Actor): boolean {
  return canApprove(actor);
}

export function canApplyTemplate(actor: Actor): boolean {
  return canApprove(actor);
}

/** Skipping removes work from the score, so it is an edit wearing a status. */
export function canSkipTask(actor: Actor): boolean {
  return canApprove(actor);
}

/** Anyone may report progress on their own task; an approver on anybody's. */
export function canUpdateStatus(actor: Actor, task: { assigneeId: string | null }): boolean {
  return canEditChecklist(actor) || task.assigneeId === actor.userId;
}
