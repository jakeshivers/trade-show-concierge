import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who sets a rate card, and who says how a crate is packed.
 *
 * The split lands where `shipping/access.ts` put it and for the same reason,
 * which is the argument for it: **reporting what is true is not a privilege;
 * changing the plan is.** What is new here is which side each act falls on, and
 * they fall on opposite sides of one screen.
 *
 * - **The rate card is money.** It is the multiplier on the largest silent line
 *   in `cost/rollup.ts`, and `basis` alone is a 100% error in either direction.
 *   Typing it is not recording a fact about a crate, it is setting what every
 *   crate on the show costs — so it sits with whoever runs the show, next to
 *   adding a deadline and waiving one.
 * - **How a crate is packed is a fact, and the person who packed it holds it.**
 *   Crated or pad-wrapped is knowable only by somebody standing next to it in
 *   the warehouse at 6am — `canConfirmReceipt` and `canSignOutAsset` exactly. A
 *   gate here would leave `handling` at `unknown` on every row forever, and the
 *   estimator would then correctly report every show as a floor, permanently,
 *   until the sentence stopped meaning anything.
 *
 * **Reading the estimate is `canSeeCost`, inherited rather than chosen.** It is a
 * cost figure for the show, so it belongs to the audience that may read cost
 * figures — and the alternative, a second and quietly looser rule beside the
 * first, is the trap step 19 named when it made ROI inherit this same gate.
 */

/** Setting the rates every crate on the show is multiplied by. */
export function canEditRateCard(actor: Actor): boolean {
  return canApprove(actor);
}

/** Confirming the card came off *this year's* manual. §5a's rule on a rate. */
export function canConfirmRateCard(actor: Actor): boolean {
  return canApprove(actor);
}

/** Saying how a crate is packed. Anybody — see the header. */
export function canRecordHandling(): boolean {
  return true;
}
