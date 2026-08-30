import type { EvaluationContext, PolicyVerdict, RuleResult, Decision, TravelPolicy } from './types';
import { ALL_RULES, type Rule } from './rules';

/**
 * The decision function.
 *
 * Deterministic, pure, and the only thing permitted to authorize spend. An LLM
 * parses the request that produces `constraints` and narrates the verdict
 * afterward; it never runs this. SCOPE.md §6a.
 */

/** Worst outcome wins: any deny denies, any approval-severity failure escalates. */
function decide(results: RuleResult[]): Decision {
  const failures = results.filter((r) => r.status === 'fail');
  if (failures.some((r) => r.severity === 'deny')) return 'deny';
  if (failures.some((r) => r.severity === 'approval')) return 'needs_approval';
  return 'auto_approve';
}

export function evaluate(ctx: EvaluationContext, rules: Rule[] = ALL_RULES): PolicyVerdict {
  const results = rules.map((rule) => rule.evaluate(ctx));
  const failures = results.filter((r) => r.status === 'fail');

  return {
    decision: decide(results),
    offerId: ctx.offer.id,
    policyId: ctx.policy.id,
    policyVersion: ctx.policy.version,
    evaluatedAt: ctx.now,
    results,
    failures,
    // Advisory failures are recorded but never block, so they are not blockers.
    blockers: failures.filter((r) => r.severity !== 'advisory'),
    reasons: failures.filter((r) => r.severity !== 'advisory').map((r) => r.message),
  };
}

/**
 * A single layer of a rule set. Layers are partial by nature: a cost-center
 * override that only raises a fare cap says nothing about connection times, and
 * must inherit them rather than blank them out.
 */
export type PolicyLayer = Partial<TravelPolicy> & Pick<TravelPolicy, 'scope'>;

/** Every field a rule set must carry before it is allowed to authorize anything. */
const REQUIRED_FIELDS: (keyof TravelPolicy)[] = [
  'id',
  'version',
  'maxAirfareDomesticCents',
  'maxAirfareInternationalCents',
  'bands',
  'maxCabinDomestic',
  'maxCabinInternational',
  'premiumCabinAllowedOverHours',
  'minAdvanceBookingDays',
  'maxStops',
  'minConnectionMinutes',
  'arrivalBufferHoursBeforeMoveIn',
  'nonRefundableAllowedUnderCents',
  'maxAcceptableRefundPenaltyCents',
  'preferredAirlines',
  'blockedAirlines',
  'maxHotelNightlyRateCents',
  'perShowTravelBudgetCents',
  'requireCreditFirst',
];

/**
 * Resolve a rule set most-specific-first: org → cost center → show → role.
 *
 * The *resolved* policy is what gets recorded on the evaluation, so an audit six
 * months later reads the rules actually applied rather than today's org defaults.
 * SCOPE.md §7.
 *
 * Two details that look like nitpicks and are not:
 *
 * - `bands` is a nested object, so a shallow spread would let an override that
 *   only lowers `autoApproveUnderCents` silently drop the org's `denyOverCents`
 *   — removing the ceiling above which nobody may approve. It is merged field by
 *   field instead.
 * - A missing field is refused, loudly, rather than defaulted. There is no safe
 *   default for a spend limit: absent must never quietly read as unlimited.
 */
export function resolvePolicy(layers: PolicyLayer[]): TravelPolicy {
  if (layers.length === 0) throw new Error('resolvePolicy requires at least one layer');

  const precedence: Record<TravelPolicy['scope'], number> = {
    org: 0,
    cost_center: 1,
    show: 2,
    role: 3,
  };
  const ordered = [...layers].sort((a, b) => precedence[a.scope] - precedence[b.scope]);

  // Later (more specific) layers win field by field, so a cost-center override
  // that only sets a fare cap inherits everything else from the org.
  const merged = ordered.reduce<Partial<TravelPolicy>>((acc, layer) => {
    const defined = Object.fromEntries(
      Object.entries(layer).filter(([, v]) => v !== undefined),
    ) as Partial<TravelPolicy>;
    return {
      ...acc,
      ...defined,
      ...(acc.bands || defined.bands
        ? { bands: { ...acc.bands, ...defined.bands } as TravelPolicy['bands'] }
        : {}),
    };
  }, {});

  const missing = REQUIRED_FIELDS.filter((f) => !(f in merged));
  // A half-merged `bands` is the same hole one level down.
  if (merged.bands && typeof merged.bands.autoApproveUnderCents !== 'number') {
    missing.push('bands.autoApproveUnderCents' as keyof TravelPolicy);
  }
  if (merged.bands && typeof merged.bands.denyOverCents !== 'number') {
    missing.push('bands.denyOverCents' as keyof TravelPolicy);
  }
  if (missing.length > 0) {
    throw new Error(
      `Resolved travel policy is incomplete — no layer supplied: ${missing.join(', ')}. ` +
        'A rule set with holes cannot authorize spend.',
    );
  }

  return merged as TravelPolicy;
}

/** Whether a verdict may proceed to purchase with no human involved. */
export function isAutoBookable(verdict: PolicyVerdict): boolean {
  return verdict.decision === 'auto_approve';
}

/**
 * A verdict is only good for the offer it was computed against, and offers expire.
 * Re-approval after an offer dies must re-run policy against the new fare — the
 * approved *price* may no longer exist. SCOPE.md §6b.
 */
export function verdictIsStale(verdict: PolicyVerdict, now: Date, maxAgeMinutes = 15): boolean {
  return (now.getTime() - verdict.evaluatedAt.getTime()) / 60_000 > maxAgeMinutes;
}
