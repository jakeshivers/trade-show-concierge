import { and, eq, isNull, desc } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { resolvePolicy, type PolicyLayer, type TravelPolicy, type Cabin } from '@/lib/policy';
import { validatePolicy, type PolicyIssue } from '@/lib/policy/validate';
import { ForbiddenError, isAdmin, type Actor } from '@/lib/auth/actor';
import { PolicyEditError, type PolicyRowValues } from './policy-edit';

type Db = ReturnType<typeof getDb>;

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
    // The two list fields resolve to `[]` rather than `null` on the base layer,
    // and that is a correctness fix rather than a tidy-up.
    //
    // `TravelPolicy` declares both as `string[]`, and the engine relies on it:
    // `rules.ts` asks `policy.preferredAirlines.length === 0` to mean "no
    // preference". But `resolvePolicy` only checks that a required *key is
    // present* (`f in merged`), never that it is non-null — so a policy row that
    // simply leaves preferred airlines blank resolves to `null` under a type
    // that promises an array, and the first thing to touch it throws.
    //
    // Nothing had ever hit it because `scripts/seed.ts` sets `['DL', 'AA']` and
    // `[]`, and because the only other reader, `validatePolicy`, was called by
    // nothing. Adding the policy editor made "no preferred airlines" reachable
    // from a screen for the first time, and the crash surfaced immediately.
    //
    // For a *list*, "no rule" and "the empty list" are the same statement, so
    // this loses nothing — on an override `keep` still returns `undefined`,
    // which correctly means "this layer does not speak to carriers" and lets the
    // broader layer survive the merge.
    preferredAirlines: isBase ? (row.preferredAirlines ?? []) : keep(row.preferredAirlines),
    blockedAirlines: isBase ? (row.blockedAirlines ?? []) : keep(row.blockedAirlines),
    // A scalar, so `keep`'s ordinary rule applies and the base layer may leave
    // it null: null is a real answer here — "a personal carrier preference is
    // worth nothing but a tie-break" — rather than a hole.
    personalCarrierAllowanceCents: keep(row.personalCarrierAllowanceCents),

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

/* ------------------------------ editing a policy ---------------------------- */

/**
 * Every layer this org has, live and superseded, newest first.
 *
 * The superseded ones are kept and shown rather than hidden: a policy is a
 * decision about money and "what were the rules when this was bought" has to
 * stay answerable, which is the same argument `show_decisions` and
 * `org_login_policies` already make.
 */
export async function listPolicyLayers(actor: Actor, db: Db = getDb()) {
  if (!isAdmin(actor)) throw new ForbiddenError('read the travel policy');
  return db
    .select()
    .from(s.travelPolicies)
    .where(eq(s.travelPolicies.orgId, actor.orgId))
    .orderBy(desc(s.travelPolicies.version), desc(s.travelPolicies.createdAt));
}

/**
 * Save a new version of the **org base layer**.
 *
 * Versioned rather than updated in place, like `org_login_policies`, and for a
 * sharper reason than tidiness: every booking this agent has ever made was
 * authorized against a particular set of numbers, and `bookings` point at a
 * policy row. Editing that row in place rewrites the rules a past purchase was
 * judged under — it would make an audit trail that says "within policy" true of
 * a policy that no longer exists.
 *
 * The coherence check runs on the **resolved** policy rather than on the form,
 * because layering is where incoherence actually appears: a base layer that is
 * fine on its own can produce an unbookable rule set once a cost-center override
 * merges over it. `validatePolicy` has been in the codebase since step 3 with a
 * comment saying it is for this editor, and this is the call it was waiting for.
 * Errors refuse the save; warnings are returned and shown.
 */
export async function saveOrgPolicy(
  actor: Actor,
  values: PolicyRowValues,
  db: Db = getDb(),
): Promise<{ version: number; warnings: PolicyIssue[] }> {
  if (!isAdmin(actor)) throw new ForbiddenError('change the travel policy');

  const current = await db
    .select()
    .from(s.travelPolicies)
    .where(
      and(
        eq(s.travelPolicies.orgId, actor.orgId),
        eq(s.travelPolicies.scope, 'org'),
        isNull(s.travelPolicies.supersededAt),
      ),
    )
    .orderBy(desc(s.travelPolicies.version))
    .limit(1);

  const version = (current[0]?.version ?? 0) + 1;
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    if (current[0]) {
      await tx
        .update(s.travelPolicies)
        .set({ supersededAt: now })
        .where(eq(s.travelPolicies.id, current[0].id));
    }
    const [row] = await tx
      .insert(s.travelPolicies)
      .values({
        orgId: actor.orgId,
        scope: 'org',
        scopeRef: null,
        version,
        ...values,
      })
      .returning({ id: s.travelPolicies.id });
    return row;
  });

  // Resolved, not per-field: this is the only place an override-induced
  // incoherence can be seen at all.
  const resolution = await resolveTravelPolicy(actor.orgId, {}, db);
  const issues = validatePolicy(resolution.policy);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    // Roll the version back rather than leaving a policy live that the agent
    // will refuse every offer against — the failure looks like "no flights
    // found", which is the diagnosis `validate.ts` exists to prevent.
    await db.transaction(async (tx) => {
      await tx.delete(s.travelPolicies).where(eq(s.travelPolicies.id, inserted.id));
      if (current[0]) {
        await tx
          .update(s.travelPolicies)
          .set({ supersededAt: null })
          .where(eq(s.travelPolicies.id, current[0].id));
      }
    });
    throw new PolicyEditError(
      `That policy would not work: ${errors.map((e) => e.message).join(' ')} Nothing was saved.`,
    );
  }

  return { version, warnings: issues.filter((i) => i.severity === 'warning') };
}
