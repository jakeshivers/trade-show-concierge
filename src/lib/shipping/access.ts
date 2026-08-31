import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who sees, refreshes, edits and receives a shipment.
 *
 * The same split every feature since step 10 has landed on — *reporting what is
 * true is not a privilege; changing the plan is* — with one line drawn in a
 * place none of the others needed.
 *
 * **Confirming a crate arrived is not a privilege, and it must not be.** The
 * person who finds the crate at the booth is whoever is standing in the booth at
 * 7am on move-in day, which is a Member with a box cutter and not a Travel
 * Manager. A `received_at` that only a manager can set is a `received_at` that
 * stays null — and `board.ts` counts an unreceived crate as a live problem, so
 * the tight gate would fill the screen with false alarms until people stopped
 * reading it. §1's corollary decides it: for a Member this app should be almost
 * invisible.
 *
 * Seeing is the one place shipping is *looser* than travel, deliberately. §3
 * narrows a Member's view of flights and lodging to their own, because a
 * colleague's fare and hotel room are personal. A crate is not personal — it is
 * the booth — and hiding it from the people unpacking it serves nobody.
 */

/** Anybody in the workspace sees the freight. It is the company's booth. */
export function canSeeShipments(): boolean {
  return true;
}

/** Asking a carrier a public question about a number we already hold. */
export function canRefreshTracking(): boolean {
  return true;
}

/** Creating, re-consigning, re-dating, deleting. This is planning. */
export function canManageShipments(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Saying the crate is physically here. Anyone — see the header.
 *
 * The owner of a shipment is not privileged over this either: they are usually
 * the person who booked the freight from a desk, not the person on the floor.
 */
export function canConfirmReceipt(): boolean {
  return true;
}
