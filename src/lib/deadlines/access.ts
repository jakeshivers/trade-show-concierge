import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may change the deadline register.
 *
 * The split is `readiness/access.ts`'s, arrived at independently and landing in
 * the same place, which is the argument for it: **reporting that work is done is
 * not a privilege; changing what the work is, is.**
 *
 * - Anyone who owns a deadline may mark it complete. The person who submitted the
 *   electrical order is the person who knows it went in, and a register only a
 *   manager can tick is a register maintained by asking around.
 * - Adding, editing, re-dating, re-assigning and deleting sit with whoever runs
 *   the show. A date here is what the alerts fire against and what the exposure
 *   figure is computed from.
 * - **Confirming is not editing, and it is not reporting either.** Confirmation
 *   is the assertion that this date was read off *this year's* manual, and it is
 *   what promotes a row from a guess to a figure the engine will quote in
 *   dollars (`alerts.ts`, correction 1). That is a claim about a document, so it
 *   needs the authority to make claims about the plan — not the authority of
 *   whoever happens to be assigned the task.
 * - **Not-applicable needs the same authority as deleting**, for the reason
 *   `edit.ts` gives: it removes money from the show's exposure.
 */

export function canEditDeadlines(actor: Actor): boolean {
  return canApprove(actor);
}

/** Confirming promotes a guess into a dollar figure the engine will quote. */
export function canConfirmDeadline(actor: Actor): boolean {
  return canApprove(actor);
}

/** It takes a penalty out of the exposure, so it is an edit wearing a status. */
export function canWaiveDeadline(actor: Actor): boolean {
  return canEditDeadlines(actor);
}

/** The owner reports their own; whoever runs the show reports anybody's. */
export function canCompleteDeadline(actor: Actor, deadline: { ownerId: string | null }): boolean {
  return canEditDeadlines(actor) || deadline.ownerId === actor.userId;
}
