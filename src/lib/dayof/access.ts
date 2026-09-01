import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may open the day-of screen, and who may decide what it says.
 *
 * The split is the one this product keeps arriving at from new directions, and
 * this is the fifth time: **doing the work is anybody's, changing the plan is
 * not.** Confirming a crate reached the booth, signing an asset out, answering
 * your own invitation, capturing a lead — all of them ended up here, and every
 * time the argument was the same. The person standing in the booth at 7am is
 * whoever is standing in the booth at 7am.
 *
 * Day-of is that argument at its strongest, because the screen exists for the
 * two days when everybody is a booth staffer regardless of their role. A
 * day-of screen gated on anything would be a day-of screen that a Member cannot
 * open on the one morning it matters, and §8c's bad lead count would follow by
 * construction — which is the failure step 18 spent a whole step describing.
 *
 * **The target list is the exception, and it is the usual exception.** Who we
 * came to this show to meet is a decision about the show, made before it, by
 * somebody who set the budget. Adding a must-meet account at hour six of day two
 * moves the denominator of every "targets met" figure the show will report, so
 * it sits with skipping a task, waiving a deadline and marking a duplicate.
 * *Reading* the list is everybody's, and has to be — a target nobody at the
 * booth can see is a target nobody meets.
 */

/** Opening the day-of screen for a show. Anybody, on any show in the org. */
export function canOpenDayOf(): boolean {
  return true;
}

/** Reading the target accounts. Everybody, or the alert reaches nobody. */
export function canSeeTargets(): boolean {
  return true;
}

/** Adding, editing or removing a target account. Changing the plan. */
export function canManageTargets(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Syncing a device's outbox.
 *
 * Not a separate permission, deliberately. Every item in an outbox is a capture
 * or a meeting, and both are already anybody's; a gate here would be a second,
 * dumber copy of `canCaptureLead` that could disagree with it. What the sync
 * route does enforce is that the actor syncing is the actor the snapshot was
 * built for — which is identity, not authority, and lives in `store.ts`.
 */
export function canSyncOutbox(): boolean {
  return true;
}
