import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who sees, reserves, signs out, checks in and counts.
 *
 * The split every feature since step 10 has landed on — *reporting what is true
 * is not a privilege; changing the plan is* — with the line drawn where §5g drew
 * it rather than where §5e did, and for the same reason.
 *
 * **Signing an asset out and checking it back in is available to anybody.** The
 * person who wheels the crate onto the truck is whoever is in the warehouse at
 * 6am, and the person who finds it back on the dock is whoever unloads it. A
 * `returned_at` only a Travel Manager can set is a `returned_at` that stays null
 * — after which `board.ts` flags every reservation as overdue and the flag stops
 * meaning anything. This is `canConfirmReceipt` from §5g, one layer up: the same
 * failure, at the same hour of the same morning, about the thing inside the
 * crate rather than the crate.
 *
 * **Recording a physical count is the same act.** A count is a fact about a
 * shelf. Gating it turns inventory into something maintained by asking around,
 * which is the spreadsheet this product replaces — §5d's argument about ticking
 * a checklist, in a warehouse.
 *
 * What needs authority is everything that changes what is *promised*: creating
 * assets and items, reserving, re-windowing, allocating, deleting. Those move
 * money and other people's shows.
 */

/** The booth is the company's. Hiding it from the people unpacking it serves nobody. */
export function canSeeAssets(): boolean {
  return true;
}

/** Creating, editing, retiring an asset or a collateral item. Capital and budget. */
export function canManageAssets(actor: Actor): boolean {
  return canApprove(actor);
}

/** Reserving, re-windowing, releasing, allocating stock to a show. Planning. */
export function canReserveAssets(actor: Actor): boolean {
  return canApprove(actor);
}

/** Signing it out, checking it in, recording its condition. Anybody — see the header. */
export function canHandleAssets(): boolean {
  return true;
}

/** Counting a shelf, or counting a box back from a show. A fact, not a privilege. */
export function canCountStock(): boolean {
  return true;
}
