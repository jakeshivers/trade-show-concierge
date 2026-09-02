import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may start a roll call, and who may answer one.
 *
 * The split every feature since step 10 has landed on, with one line drawn
 * somewhere none of the others needed and one drawn *looser* than anywhere else
 * in the product.
 *
 * - **Starting a roll call belongs to whoever runs the show.** It messages
 *   everybody at a venue and asks them to stop what they are doing, so a
 *   mistaken one is expensive in exactly the way a false alarm is: the second
 *   one gets answered by fewer people than the first.
 * - **Answering belongs to the person, always.** §5e's rule at the highest
 *   stakes this product has.
 * - **Recording somebody else's answer belongs to anybody**, and that is the
 *   loosest gate in the codebase. The colleague who has the missing person on
 *   the phone is whoever happened to have their number, and a permission check
 *   between that call and the roll call is a permission check that gets worked
 *   around by shouting across a room. It is recorded as relayed rather than
 *   refused — `rollcall.ts` refusal 2.
 * - **Reading the roll call belongs to everybody at the show.** This is the
 *   deliberate loosening. Cost is narrowed to approvers because a total is every
 *   colleague's fare; a travel *itinerary* is narrowed for the same reason. A
 *   roll call is neither — it is a list of names and whether they have answered,
 *   and the people best placed to find a missing colleague at a convention centre
 *   are the ones standing in it. §1's corollary decides it: a Member who has to
 *   ask a manager to see who is unaccounted for is a Member who goes and looks
 *   instead.
 *
 * **What is deliberately not here: there is no way to mark somebody safe in
 * bulk, and no permission that would allow it.** Every closing of a name is one
 * person, named, at an instant. A control that clears a board is a control that
 * produces a complete headcount without anybody having spoken.
 */

/** Starting one interrupts everybody at a venue. */
export function canStartRollCall(actor: Actor): boolean {
  return canApprove(actor);
}

/** Reading it is everybody's — see the header. */
export function canSeeRollCall(): boolean {
  return true;
}

/** Answering for yourself. Always. */
export function canAnswerFor(actor: Actor, userId: string): boolean {
  return actor.userId === userId;
}

/**
 * Relaying somebody else's answer. Anybody.
 *
 * Not a weaker version of `canAnswerFor` — a different act, recorded
 * differently, and the screen says which one happened.
 */
export function canRelayAnswer(): boolean {
  return true;
}
