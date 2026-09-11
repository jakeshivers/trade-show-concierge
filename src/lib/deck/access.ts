import type { Actor } from '@/lib/auth/actor';

/**
 * Who may export a brief.
 *
 * **Anybody**, and that is not a gap. The deck is assembled from the same store
 * functions the screens call, as the acting actor, so it can only ever contain
 * what that person could already read tab by tab — a Member's brief has no cost
 * and no ROI because `getShowCost` and `getShowRoi` were never called for them.
 *
 * Gating the export itself would therefore restrict nothing except the format,
 * while making the one artifact a show lead actually needs to circulate the
 * thing they have to ask permission for. `access.ts` files here all draw the
 * same line: reporting what is true is not a privilege; changing the plan is.
 */
export function canExportDeck(actor: Actor): boolean {
  void actor;
  return true;
}
