import type { TravelPolicy } from './types';
import { CABIN_RANK } from './types';

/**
 * Policy coherence checks.
 *
 * A rule set can be individually valid and jointly nonsense — an international
 * fare cap above the absolute deny ceiling means no international fare is ever
 * bookable, and the failure looks like "the agent can't find flights" rather
 * than "the policy is wrong". These are cheap to catch at edit time and
 * miserable to diagnose at purchase time.
 *
 * Consumed by the admin policy editor (build step 7).
 */

export type PolicyIssue = {
  field: string;
  severity: 'error' | 'warning';
  message: string;
};

export function validatePolicy(policy: TravelPolicy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const { bands } = policy;

  if (bands.autoApproveUnderCents > bands.denyOverCents) {
    issues.push({
      field: 'bands',
      severity: 'error',
      message: 'Auto-approve threshold is above the absolute deny ceiling; nothing can be approved.',
    });
  }

  for (const [field, cap] of [
    ['maxAirfareDomesticCents', policy.maxAirfareDomesticCents],
    ['maxAirfareInternationalCents', policy.maxAirfareInternationalCents],
  ] as const) {
    if (cap > bands.denyOverCents) {
      issues.push({
        field,
        severity: 'error',
        message: `Fare cap exceeds the absolute deny ceiling, so no fare in that range can ever be booked. Raise the deny ceiling or lower the cap.`,
      });
    }
  }

  if (policy.maxAirfareDomesticCents > policy.maxAirfareInternationalCents) {
    issues.push({
      field: 'maxAirfareInternationalCents',
      severity: 'warning',
      message: 'Domestic fare cap is higher than the international cap, which is unusual.',
    });
  }

  if (CABIN_RANK[policy.maxCabinDomestic] > CABIN_RANK[policy.maxCabinInternational]) {
    issues.push({
      field: 'maxCabinDomestic',
      severity: 'warning',
      message: 'Domestic cabin ceiling is richer than the international one, which is unusual.',
    });
  }

  if (
    policy.nonRefundableAllowedUnderCents !== null &&
    policy.nonRefundableAllowedUnderCents > bands.denyOverCents
  ) {
    issues.push({
      field: 'nonRefundableAllowedUnderCents',
      severity: 'warning',
      message: 'Non-refundable allowance is above the deny ceiling and can never apply.',
    });
  }

  if (policy.minConnectionMinutes < 30) {
    issues.push({
      field: 'minConnectionMinutes',
      severity: 'warning',
      message: 'Connections under 30 minutes are rarely makeable at large hubs.',
    });
  }

  if (policy.arrivalBufferHoursBeforeMoveIn < 0) {
    issues.push({
      field: 'arrivalBufferHoursBeforeMoveIn',
      severity: 'error',
      message: 'Arrival buffer cannot be negative.',
    });
  }

  /**
   * An allowance with no list to spend it on, and a list with no allowance.
   *
   * Both are warnings rather than errors because both are legitimate mid-edit
   * states and neither can hurt anybody — the first is money authorized that
   * nothing can claim, the second is a carrier list that only ever produces an
   * advisory. What they have in common is that the screen looks configured and
   * the agent behaves as though nothing were set, which is the failure mode this
   * validator exists to name out loud.
   */
  if (
    policy.preferredCarrierAllowanceCents !== null &&
    policy.preferredCarrierAllowanceCents > 0 &&
    policy.preferredAirlines.length === 0
  ) {
    issues.push({
      field: 'preferredCarrierAllowanceCents',
      severity: 'warning',
      message:
        'A preferred carrier allowance is set but no airlines are preferred, so nothing can ' +
        'ever earn it.',
    });
  }
  if (policy.preferredAirlines.length > 0 && !policy.preferredCarrierAllowanceCents) {
    issues.push({
      // The *allowance* is the field that is absent, and naming it that way also
      // keeps this warning from shadowing the blocked-and-preferred **error**
      // below for any caller that looks an issue up by field. Nothing in `src/`
      // does today; a test did, and found this within a minute.
      field: 'preferredCarrierAllowanceCents',
      severity: 'warning',
      message:
        'Preferred airlines are listed but not priced, so the list is recorded on the audit ' +
        'and never changes which fare wins.',
    });
  }

  const blockedAndPreferred = policy.preferredAirlines.filter((a) =>
    policy.blockedAirlines.includes(a),
  );
  if (blockedAndPreferred.length > 0) {
    issues.push({
      field: 'preferredAirlines',
      severity: 'error',
      message: `Carrier(s) both preferred and blocked: ${blockedAndPreferred.join(', ')}.`,
    });
  }

  return issues;
}

export function isPolicyBookable(policy: TravelPolicy): boolean {
  return !validatePolicy(policy).some((i) => i.severity === 'error');
}
