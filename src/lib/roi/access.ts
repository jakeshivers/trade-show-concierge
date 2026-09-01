import type { Actor } from '@/lib/auth/actor';
import { canApprove, isAdmin } from '@/lib/auth/actor';

/**
 * Who reads ROI, and who connects a CRM.
 *
 * **Reading is Travel Manager and Admin, and the reason is inherited rather than
 * chosen.** An ROI figure contains a cost figure, and `cost/access.ts` already
 * settled that a show's true cost is every colleague's fare in one number — a
 * Member who can see it can often read one person's fare straight back out of
 * it. Nothing about adding pipeline to that makes it safer. So the gate is the
 * same gate, and the tab is not rendered for a Member rather than rendered and
 * refused.
 *
 * It is worth naming what is *not* re-decided here. The lead **count** stays
 * everybody's (`leads/access.ts`), because §8c's entire mitigation is that a
 * thin count is visible to the person who could fix it. ROI is narrower than its
 * own inputs, which is the right direction for an aggregate to move.
 *
 * **Connecting a CRM is Admin**, one bar higher, and for `intake_keys`' reason:
 * an access token is a credential rather than data. It also authorises the one
 * write this product makes into somebody else's system, which is the only place
 * in the app where a mistake lands in a database we do not own.
 */
export function canSeeRoi(actor: Actor): boolean {
  return canApprove(actor);
}

/** Running a sync. Reads a CRM and writes attribution back into it. */
export function canSyncCrm(actor: Actor): boolean {
  return canApprove(actor);
}

/** Connecting, disconnecting, and choosing the attribution model. */
export function canManageCrm(actor: Actor): boolean {
  return isAdmin(actor);
}
