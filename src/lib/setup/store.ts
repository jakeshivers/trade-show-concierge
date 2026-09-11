import { and, count, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { getMyProfile } from '@/lib/profile/store';
import { missingForTicket } from '@/lib/travel/passengers';
import { setupSteps, type SetupStep } from './checklist';

type Db = ReturnType<typeof getDb>;

/**
 * The three existence questions, plus the reader's own traveler details.
 *
 * Deliberately **not** routed through `listPolicyLayers` or `listCostCenters`:
 * both refuse a non-admin, and a Member meeting `NoPolicyError` needs to be told
 * why and who to ask rather than shown the same blank the agent saw. Whether an
 * organization has been configured is not a colleague's fare — it is the
 * `access.ts` line every module here already draws, that reporting what is true
 * is not a privilege while changing the plan is. So these are counts, org-scoped
 * at the source, and they return no policy values and no cost-center names.
 *
 * Three `count`s and one row, run together, because this is on the overview and
 * the overview is the screen people leave open.
 */
export async function getSetupSteps(actor: Actor, db: Db = getDb()): Promise<SetupStep[]> {
  const [policies, centers, shows, me] = await Promise.all([
    db
      .select({ n: count() })
      .from(s.travelPolicies)
      // The **org base layer** specifically. An override for one cost center
      // resolves over a base that is not there, and `resolvePolicy` still has
      // nothing to rule with — so counting every layer would report a workspace
      // as configured while the agent goes on refusing to search.
      .where(and(eq(s.travelPolicies.orgId, actor.orgId), eq(s.travelPolicies.scope, 'org'))),
    db
      .select({ n: count() })
      .from(s.costCenters)
      // Active only, because an inactive one is deliberately not offered on any
      // form — a workspace whose only cost center is switched off has, from
      // every financial screen's point of view, none.
      .where(and(eq(s.costCenters.orgId, actor.orgId), eq(s.costCenters.active, true))),
    db.select({ n: count() }).from(s.shows).where(eq(s.shows.orgId, actor.orgId)),
    getMyProfile(actor, db),
  ]);

  return setupSteps({
    role: actor.role,
    hasTravelPolicy: policies[0].n > 0,
    costCenterCount: centers[0].n,
    showCount: shows[0].n,
    // The same list the booking agent throws with, rather than a second opinion
    // about what a ticket needs — see `missingForTicket`.
    missingTravelerDetails: missingForTicket(me),
  });
}
