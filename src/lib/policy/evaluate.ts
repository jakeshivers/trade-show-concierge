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
 * Resolve a rule set most-specific-first: role → show → cost center → org.
 *
 * The *resolved* policy is what gets recorded on the evaluation, so an audit six
 * months later reads the rules actually applied rather than today's org defaults.
 * SCOPE.md §7.
 */
export function resolvePolicy(layers: TravelPolicy[]): TravelPolicy {
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
  return ordered.reduce((merged, layer) => ({
    ...merged,
    ...Object.fromEntries(Object.entries(layer).filter(([, v]) => v !== undefined)),
  })) as TravelPolicy;
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
