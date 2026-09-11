import type { Actor } from '@/lib/auth/actor';
import { canApprove, isAdmin } from '@/lib/auth/actor';

/**
 * Who may see, capture, erase — and the one split this feature adds that no
 * previous one needed.
 *
 * Every access decision before this was about *our* data: a colleague's fare, a
 * show's cost, a crate's location. A lead is personal data about somebody who
 * never agreed to anything with us and is not in the room. §9.8 makes that
 * regulated from the first row, and the practical form of "regulated" is data
 * minimisation: the number of people who can read a stranger's phone number
 * should be the number who need to.
 *
 * So the reads split in two, and the split is not the usual one:
 *
 * - **The count is everybody's.** A lead count is the show's scoreboard, it is
 *   the input to every ROI figure, and §8c's whole mitigation is making thin
 *   capture *visible* — which fails immediately if the person who could fix it
 *   cannot see it. Nobody's privacy is engaged by "34 leads from 3 of 6 staff".
 * - **The PII is yours and your approvers'.** You read the leads you captured;
 *   a Travel Manager or Admin reads all of them, being the audience §3 already
 *   trusts with everyone's travel. `travelerScope`'s shape, applied to a third
 *   party's data rather than a colleague's — and, as there, the narrowing
 *   happens in the query, so a Member's page never contains a stranger's phone
 *   number in the first place.
 *
 * **Capturing is anybody's, and it has to be.** This is `canConfirmReceipt` for
 * the third time, and here it is not merely convenient — it is the entire
 * feature. §8c says the lead count is bad because reps do not log leads; a
 * capture flow gated on a role is a capture flow that produces the bad number by
 * construction. The person holding the badge at hour six of day two is a Member.
 *
 * **Erasing is not.** Redaction is irreversible and takes a person out of the
 * record permanently, which is the right outcome when they asked for it and a
 * destroyed follow-up when somebody clicked the wrong row. Same bar as skipping
 * a task or waiving a deadline: it changes the plan, so it needs the authority
 * to change the plan.
 */

/** The count, the coverage, and every figure derived from them. */
export function canSeeLeadCounts(): boolean {
  return true;
}

/**
 * All of a show's lead detail, including the leads other people captured.
 * A Member is not refused — `store.ts` narrows their query to their own.
 */
export function canSeeAllLeadDetail(actor: Actor): boolean {
  return canApprove(actor);
}

/** Whether this specific row's personal data is readable by this actor. */
export function canSeeLeadDetail(actor: Actor, capturedById: string | null): boolean {
  return canSeeAllLeadDetail(actor) || capturedById === actor.userId;
}

/** Standing at a booth with a badge. Anybody. See the header. */
export function canCaptureLead(): boolean {
  return true;
}

/** Recording a meeting that happened. Anybody, for the same reason. */
export function canRecordMeeting(): boolean {
  return true;
}

/**
 * Editing a lead somebody else captured, importing a file, marking a duplicate.
 * Planning-shaped rather than reporting-shaped.
 */
export function canManageLeads(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Correcting a lead already captured.
 *
 * The same shape as reading it, and deliberately not a new audience: editing a
 * row you cannot see is not a thing to have a rule about. So your own are
 * yours, and an approver's reach is the one §3 already grants.
 *
 * **Anybody may fix their own, for `canCaptureLead`'s reason one step later.**
 * The commonest edit in this product is recording what a person was told —
 * `consent.ts` withholds a row from anything outbound until somebody does, and
 * the coverage note says "open the lead to record it" in those words. Gating
 * that on a role makes the fix unavailable to precisely the person who was
 * standing there and knows the answer, which is how `unknown` becomes permanent.
 *
 * A lead nobody captured — imported, or posted by a scanner — has a null
 * capturer and is therefore an approver's. That falls out rather than being
 * chosen, and it is right: there is no "the person who was there" to defer to.
 */
export function canEditLead(actor: Actor, capturedById: string | null): boolean {
  return canManageLeads(actor) || (capturedById !== null && capturedById === actor.userId);
}

/** Erasure. Irreversible, so it sits with changing the plan. */
export function canRedactLead(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Issuing and revoking an intake key.
 *
 * Admin only, and one bar higher than managing leads, because a key is a
 * credential that writes to this workspace from outside every gate in this file.
 * §3 puts "restrict permitted login methods" with Admin for the same reason: it
 * is authentication, not data.
 */
export function canManageIntakeKeys(actor: Actor): boolean {
  return isAdmin(actor);
}

/** Running the retention sweep. Not a privilege: it only ever erases. */
export function canRunRetention(): boolean {
  return true;
}
