import { and, eq, isNull, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { resolvePolicy, type PolicyLayer, type TravelPolicy, type Cabin } from '@/lib/policy';

/**
 * Loads policy layers out of the database and hands the policy engine a single
 * resolved rule set.
 *
 * This module exists so `src/lib/policy` can stay pure: it takes a `TravelPolicy`
 * and knows nothing about Drizzle, orgs, or rows. Everything database-shaped —
 * null-vs-undefined, version selection, layer precedence — is dealt with here.
 */

type PolicyRow = typeof s.travelPolicies.$inferSelect;

/**
 * Row → layer.
 *
 * `null` and `undefined` mean different things and the difference is the whole
 * point. On the org base layer a null is a real answer ("there is no hotel cap").
 * On an override it means "I don't speak to this rule" and must be dropped so the
 * broader layer survives the merge — an override that blanked a spend limit by
 * omission is precisely the accident this guards against.
 */
function toLayer(row: PolicyRow): PolicyLayer {
  const isBase = row.scope === 'org';
  const keep = <T>(v: T | null): T | null | undefined => (v === null && !isBase ? undefined : v);

  const bands =
    row.autoApproveUnderCents !== null || row.denyOverCents !== null
      ? {
          autoApproveUnderCents: row.autoApproveUnderCents,
          denyOverCents: row.denyOverCents,
        }
      : undefined;

  const layer: Record<string, unknown> = {
    id: row.id,
    version: row.version,
    scope: row.scope,
    scopeRef: row.scopeRef ?? undefined,

    maxAirfareDomesticCents: keep(row.maxAirfareDomesticCents),
    maxAirfareInternationalCents: keep(row.maxAirfareInternationalCents),
    bands,

    maxCabinDomestic: keep(row.maxCabinDomestic) as Cabin | null | undefined,
    maxCabinInternational: keep(row.maxCabinInternational) as Cabin | null | undefined,
    premiumCabinAllowedOverHours: keep(row.premiumCabinAllowedOverHours),

    minAdvanceBookingDays: keep(row.minAdvanceBookingDays),
    maxStops: keep(row.maxStops),
    minConnectionMinutes: keep(row.minConnectionMinutes),
    arrivalBufferHoursBeforeMoveIn: keep(row.arrivalBufferHoursBeforeMoveIn),

    nonRefundableAllowedUnderCents: keep(row.nonRefundableAllowedUnderCents),
    maxAcceptableRefundPenaltyCents: keep(row.maxAcceptableRefundPenaltyCents),
    preferredAirlines: keep(row.preferredAirlines),
    blockedAirlines: keep(row.blockedAirlines),

    maxHotelNightlyRateCents: keep(row.maxHotelNightlyRateCents),
    perShowTravelBudgetCents: keep(row.perShowTravelBudgetCents),
    requireCreditFirst: keep(row.requireCreditFirst),
  };

  // Undefined keys must be absent, not present-and-undefined: `'x' in layer` is
  // how the resolver detects a hole.
  for (const [k, v] of Object.entries(layer)) if (v === undefined) delete layer[k];

  return layer as PolicyLayer;
}

export type PolicyResolution = {
  policy: TravelPolicy;
  /** The layers that produced it, broad → specific. Recorded for the audit trail. */
  layers: { id: string; scope: PolicyRow['scope']; scopeRef: string | null; version: number }[];
};

export class NoPolicyError extends Error {
  constructor(orgId: string) {
    super(
      `Organization ${orgId} has no live org-level travel policy. ` +
        'Nothing can be evaluated, and therefore nothing can be booked.',
    );
    this.name = 'NoPolicyError';
  }
}

/**
 * Resolve the rule set for one request.
 *
 * Only live versions are considered — superseded rows stay in the table so an
 * old `policy_evaluations` row can still be read against the rules that ran, but
 * they never authorize anything new.
 */
export async function resolveTravelPolicy(
  orgId: string,
  opts: { costCenterId?: string | null; showId?: string | null; role?: string | null } = {},
  db = getDb(),
): Promise<PolicyResolution> {
  const rows = await db
    .select()
    .from(s.travelPolicies)
    .where(and(eq(s.travelPolicies.orgId, orgId), isNull(s.travelPolicies.supersededAt)))
    .orderBy(desc(s.travelPolicies.version));

  const refs = new Map<PolicyRow['scope'], string | null>([
    ['org', null],
    ['cost_center', opts.costCenterId ?? null],
    ['show', opts.showId ?? null],
    ['role', opts.role ?? null],
  ]);

  const applicable = rows.filter((r) => {
    const wanted = refs.get(r.scope);
    if (r.scope === 'org') return true;
    return wanted !== null && wanted !== undefined && r.scopeRef === wanted;
  });

  // Highest live version wins within a layer; the descending sort put it first.
  const newestPerLayer = new Map<string, PolicyRow>();
  for (const row of applicable) {
    const key = `${row.scope}:${row.scopeRef ?? ''}`;
    if (!newestPerLayer.has(key)) newestPerLayer.set(key, row);
  }

  const chosen = [...newestPerLayer.values()];
  if (!chosen.some((r) => r.scope === 'org')) throw new NoPolicyError(orgId);

  return {
    policy: resolvePolicy(chosen.map(toLayer)),
    layers: chosen
      .map((r) => ({ id: r.id, scope: r.scope, scopeRef: r.scopeRef, version: r.version }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
  };
}
