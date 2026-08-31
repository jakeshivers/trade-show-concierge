import type { Actor } from '@/lib/auth/actor';
import { canManageLodging } from '@/lib/lodging/access';
import { TOOLS, type AssistantTool } from './tools';

/**
 * Who may use the assistant, and what it may hold on their behalf.
 *
 * Using it is not a privilege. Step 10 settled the shape of this argument for
 * readiness — reporting is not a privilege, changing the plan is — and it
 * arrives here in its strongest form, because the assistant *is* the Member
 * experience §1 asks for: "for a Member, this app should be almost invisible."
 * A staffer who has to learn six screens to find out when their crate lands has
 * been failed by the product, and gating the one surface that answers that in a
 * sentence would fail them on purpose.
 *
 * It is safe to hold open because none of the tools decide anything. Every one
 * of them is a store call as the asking actor; a Member holding `lodging_board`
 * gets a Member's lodging board, narrowed in the query.
 *
 * **The gate that matters is per tool, and it is subtractive.** A tool the actor
 * may not use is not described to the model at all — it is absent from
 * `request.tools`, so there is no name to call, no refusal to argue with, and
 * nothing for an instruction in a document or a hotel note to aim at. Telling a
 * model about a capability and then declining to run it is a strictly worse
 * design: it advertises the target.
 */

export function canUseAssistant(actor: Actor): boolean {
  // Written as an exhaustive switch rather than `return true` so that "every
  // role" is a decision taken three times and visible as such — and so that the
  // day somebody wants the assistant off for Members, the argument happens here
  // instead of in a feature flag.
  switch (actor.role) {
    case 'member':
    case 'travel_manager':
    case 'admin':
      return true;
  }
}

export function toolsFor(actor: Actor): AssistantTool[] {
  return TOOLS.filter((t) => {
    switch (t.name) {
      // Lodging is a spending record; creating one is planning, not reporting.
      // The same split `lodging/access.ts` already draws for the screen.
      case 'draft_lodging':
        return canManageLodging(actor);
      default:
        return true;
    }
  });
}
