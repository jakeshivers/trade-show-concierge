import type { EvaluationContext, RuleResult } from './types';
import { CABIN_RANK } from './types';
import * as o from './offer';

/**
 * The rule registry.
 *
 * Every rule is a pure function returning a structured result, never a boolean.
 * The margin is the point: an approver needs "$40 over the domestic cap", not
 * "failed". See SCOPE.md §7.
 *
 * A rule returns `not_applicable` when it has nothing to say — a hotel rule on a
 * flight offer, an arrival-buffer rule with no show attached. Absent rules and
 * passing rules are different facts and the audit trail keeps them apart.
 */

export type Rule = {
  id: string;
  label: string;
  evaluate: (ctx: EvaluationContext) => RuleResult;
};

const pass = (
  ruleId: string,
  label: string,
  message: string,
  extra: Partial<RuleResult> = {},
): RuleResult => ({ ruleId, label, status: 'pass', severity: 'advisory', message, ...extra });

const fail = (
  ruleId: string,
  label: string,
  severity: RuleResult['severity'],
  message: string,
  extra: Partial<RuleResult> = {},
): RuleResult => ({ ruleId, label, status: 'fail', severity, message, ...extra });

const na = (ruleId: string, label: string, message: string): RuleResult => ({
  ruleId,
  label,
  status: 'not_applicable',
  severity: 'advisory',
  message,
});

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/* ---------------------------------- rules ---------------------------------- */

/**
 * An expired offer is not a policy failure, it is a stale fact — but it must
 * hard-stop, because purchasing against it will fail at the provider anyway.
 * This is the single most common real-world failure in booking integrations:
 * an offer sits in an approval queue overnight and dies. SCOPE.md §6b.
 */
export const offerNotExpired: Rule = {
  id: 'offer_not_expired',
  label: 'Offer still valid',
  evaluate: ({ offer, now }) => {
    if (offer.expiresAt === null) {
      return pass('offer_not_expired', 'Offer still valid', 'Offer has no stated expiry.');
    }
    const minutesLeft = (offer.expiresAt.getTime() - now.getTime()) / 60_000;
    if (minutesLeft <= 0) {
      return fail(
        'offer_not_expired',
        'Offer still valid',
        'deny',
        `Offer expired ${Math.abs(Math.round(minutesLeft))} min ago; a fresh search is required.`,
        { margin: -minutesLeft, marginUnit: 'minutes' },
      );
    }
    return pass(
      'offer_not_expired',
      'Offer still valid',
      `Expires in ${Math.round(minutesLeft)} min.`,
      { margin: -minutesLeft, marginUnit: 'minutes' },
    );
  },
};

export const fareCeiling: Rule = {
  id: 'fare_ceiling',
  label: 'Airfare ceiling',
  evaluate: ({ offer, policy }) => {
    const scope = o.tripScope(offer);
    const cap =
      scope === 'domestic'
        ? policy.maxAirfareDomesticCents
        : policy.maxAirfareInternationalCents;
    const margin = offer.totalCents - cap;

    if (margin > 0) {
      return fail(
        'fare_ceiling',
        'Airfare ceiling',
        'approval',
        `${usd(margin)} over the ${scope} cap of ${usd(cap)}.`,
        { margin, marginUnit: 'cents' },
      );
    }
    return pass(
      'fare_ceiling',
      'Airfare ceiling',
      `${usd(Math.abs(margin))} under the ${scope} cap of ${usd(cap)}.`,
      { margin, marginUnit: 'cents' },
    );
  },
};

/**
 * The bands are the spend authority itself, so this rule is the one that can
 * return `deny` on price. The ceiling above only escalates.
 */
export const approvalBand: Rule = {
  id: 'approval_band',
  label: 'Approval band',
  evaluate: ({ offer, policy }) => {
    const { autoApproveUnderCents, denyOverCents } = policy.bands;

    if (offer.totalCents > denyOverCents) {
      return fail(
        'approval_band',
        'Approval band',
        'deny',
        `${usd(offer.totalCents)} exceeds the absolute ceiling of ${usd(denyOverCents)}. No approver can authorize this.`,
        { margin: offer.totalCents - denyOverCents, marginUnit: 'cents' },
      );
    }
    if (offer.totalCents > autoApproveUnderCents) {
      return fail(
        'approval_band',
        'Approval band',
        'approval',
        `${usd(offer.totalCents)} is above the ${usd(autoApproveUnderCents)} auto-approve threshold.`,
        { margin: offer.totalCents - autoApproveUnderCents, marginUnit: 'cents' },
      );
    }
    return pass(
      'approval_band',
      'Approval band',
      `${usd(offer.totalCents)} is within the ${usd(autoApproveUnderCents)} auto-approve threshold.`,
      { margin: offer.totalCents - autoApproveUnderCents, marginUnit: 'cents' },
    );
  },
};

export const cabinCeiling: Rule = {
  id: 'cabin_ceiling',
  label: 'Cabin ceiling',
  evaluate: ({ offer, policy }) => {
    const scope = o.tripScope(offer);
    const cap = scope === 'domestic' ? policy.maxCabinDomestic : policy.maxCabinInternational;
    const actual = o.highestCabin(offer);
    const overage = CABIN_RANK[actual] - CABIN_RANK[cap];

    if (overage <= 0) {
      return pass('cabin_ceiling', 'Cabin ceiling', `${actual} is within the ${scope} ceiling of ${cap}.`);
    }

    // Long-haul exemption: a red-eye in economy is a false economy.
    const hours = o.longestSliceHours(offer);
    const threshold = policy.premiumCabinAllowedOverHours;
    if (threshold !== null && hours > threshold && CABIN_RANK[actual] <= CABIN_RANK.premium_economy) {
      return pass(
        'cabin_ceiling',
        'Cabin ceiling',
        `${actual} permitted: longest leg is ${hours.toFixed(1)}h, over the ${threshold}h long-haul threshold.`,
      );
    }

    return fail(
      'cabin_ceiling',
      'Cabin ceiling',
      'approval',
      `${actual} exceeds the ${scope} ceiling of ${cap}.`,
      { margin: overage, marginUnit: 'stops' },
    );
  },
};

export const advanceBooking: Rule = {
  id: 'advance_booking',
  label: 'Advance booking window',
  evaluate: ({ offer, policy, now }) => {
    const days = (o.outboundDeparture(offer).getTime() - now.getTime()) / 86_400_000;
    const margin = policy.minAdvanceBookingDays - days;

    if (margin > 0) {
      return fail(
        'advance_booking',
        'Advance booking window',
        'approval',
        `Departure is ${days.toFixed(1)} days out, inside the ${policy.minAdvanceBookingDays}-day advance window.`,
        { margin, marginUnit: 'days' },
      );
    }
    return pass(
      'advance_booking',
      'Advance booking window',
      `Departure is ${days.toFixed(1)} days out.`,
      { margin, marginUnit: 'days' },
    );
  },
};

export const stopLimit: Rule = {
  id: 'stop_limit',
  label: 'Connection count',
  evaluate: ({ offer, policy }) => {
    const stops = o.maxStopsInAnySlice(offer);
    const margin = stops - policy.maxStops;
    if (margin > 0) {
      return fail('stop_limit', 'Connection count', 'approval', `${stops} stops exceeds the limit of ${policy.maxStops}.`, {
        margin,
        marginUnit: 'stops',
      });
    }
    return pass('stop_limit', 'Connection count', `${stops} stop(s), within the limit of ${policy.maxStops}.`, {
      margin,
      marginUnit: 'stops',
    });
  },
};

/**
 * A connection too tight to make is worse than a longer trip — a misconnect at a
 * trade show means missing move-in entirely.
 */
export const connectionTime: Rule = {
  id: 'connection_time',
  label: 'Minimum connection time',
  evaluate: ({ offer, policy }) => {
    const gaps = o.connectionMinutes(offer);
    if (gaps.length === 0) {
      return na('connection_time', 'Minimum connection time', 'Nonstop itinerary.');
    }
    const tightest = Math.min(...gaps);
    const margin = policy.minConnectionMinutes - tightest;
    if (margin > 0) {
      return fail(
        'connection_time',
        'Minimum connection time',
        'approval',
        `Tightest connection is ${Math.round(tightest)} min, under the ${policy.minConnectionMinutes} min minimum.`,
        { margin, marginUnit: 'minutes' },
      );
    }
    return pass(
      'connection_time',
      'Minimum connection time',
      `Tightest connection is ${Math.round(tightest)} min.`,
      { margin, marginUnit: 'minutes' },
    );
  },
};

/** The rule that makes this a trade show tool rather than a travel tool. */
export const arrivalBuffer: Rule = {
  id: 'arrival_buffer',
  label: 'Arrival before move-in',
  evaluate: ({ offer, policy, moveInAt }) => {
    if (!moveInAt) {
      return na('arrival_buffer', 'Arrival before move-in', 'Trip is not tied to a show move-in time.');
    }
    const hoursBefore = (moveInAt.getTime() - o.outboundArrival(offer).getTime()) / 3_600_000;
    const required = policy.arrivalBufferHoursBeforeMoveIn;
    const margin = required - hoursBefore;

    if (hoursBefore < 0) {
      return fail(
        'arrival_buffer',
        'Arrival before move-in',
        'deny',
        `Lands ${Math.abs(hoursBefore).toFixed(1)}h AFTER move-in begins.`,
        { margin, marginUnit: 'hours' },
      );
    }
    if (margin > 0) {
      return fail(
        'arrival_buffer',
        'Arrival before move-in',
        'approval',
        `Lands ${hoursBefore.toFixed(1)}h before move-in, under the ${required}h buffer.`,
        { margin, marginUnit: 'hours' },
      );
    }
    return pass(
      'arrival_buffer',
      'Arrival before move-in',
      `Lands ${hoursBefore.toFixed(1)}h before move-in.`,
      { margin, marginUnit: 'hours' },
    );
  },
};

export const departureWindow: Rule = {
  id: 'departure_window',
  label: 'Traveler time constraints',
  evaluate: ({ offer, constraints }) => {
    const departs = o.outboundDeparture(offer);
    const arrives = o.outboundArrival(offer);

    if (departs.getTime() < constraints.earliestDeparture.getTime()) {
      const hours = (constraints.earliestDeparture.getTime() - departs.getTime()) / 3_600_000;
      return fail(
        'departure_window',
        'Traveler time constraints',
        'deny',
        `Departs ${hours.toFixed(1)}h before the traveler's earliest departure.`,
        { margin: hours, marginUnit: 'hours' },
      );
    }
    if (arrives.getTime() > constraints.latestArrival.getTime()) {
      const hours = (arrives.getTime() - constraints.latestArrival.getTime()) / 3_600_000;
      return fail(
        'departure_window',
        'Traveler time constraints',
        'deny',
        `Arrives ${hours.toFixed(1)}h after the traveler's latest acceptable arrival.`,
        { margin: hours, marginUnit: 'hours' },
      );
    }
    return pass('departure_window', 'Traveler time constraints', 'Within the requested travel window.');
  },
};

export const refundability: Rule = {
  id: 'refundability',
  label: 'Refundability',
  evaluate: ({ offer, policy }) => {
    // A refund permitted only with a punitive penalty is not a refundable fare.
    const tolerance = policy.maxAcceptableRefundPenaltyCents;
    const penalty = offer.refundPenaltyCents ?? 0;
    const effectivelyRefundable =
      offer.refundable && (tolerance === null || penalty <= tolerance);

    if (effectivelyRefundable) {
      return pass(
        'refundability',
        'Refundability',
        penalty > 0
          ? `Refundable with a ${usd(penalty)} penalty.`
          : 'Fare is fully refundable.',
      );
    }
    if (offer.refundable && !effectivelyRefundable) {
      return fail(
        'refundability',
        'Refundability',
        'approval',
        `Nominally refundable, but the ${usd(penalty)} penalty exceeds the ${usd(tolerance!)} tolerance.`,
        { margin: penalty - tolerance!, marginUnit: 'cents' },
      );
    }
    const limit = policy.nonRefundableAllowedUnderCents;
    if (limit === null) {
      return na('refundability', 'Refundability', 'No refundability rule configured.');
    }
    const margin = offer.totalCents - limit;
    if (margin > 0) {
      return fail(
        'refundability',
        'Refundability',
        'approval',
        `Non-refundable at ${usd(offer.totalCents)}, over the ${usd(limit)} non-refundable limit.`,
        { margin, marginUnit: 'cents' },
      );
    }
    return pass(
      'refundability',
      'Refundability',
      `Non-refundable but under the ${usd(limit)} limit.`,
      { margin, marginUnit: 'cents' },
    );
  },
};

export const airlineRules: Rule = {
  id: 'airline_rules',
  label: 'Carrier restrictions',
  evaluate: ({ offer, policy }) => {
    const carriers = o.marketingAirlines(offer);
    const blocked = carriers.filter((c) => policy.blockedAirlines.includes(c));
    if (blocked.length > 0) {
      return fail(
        'airline_rules',
        'Carrier restrictions',
        'deny',
        `Blocked carrier(s): ${blocked.join(', ')}.`,
      );
    }
    if (policy.preferredAirlines.length === 0) {
      return na('airline_rules', 'Carrier restrictions', 'No carrier preferences configured.');
    }
    const offPreferred = carriers.filter((c) => !policy.preferredAirlines.includes(c));
    if (offPreferred.length > 0) {
      return fail(
        'airline_rules',
        'Carrier restrictions',
        'advisory',
        `Off-preferred carrier(s): ${offPreferred.join(', ')}.`,
      );
    }
    return pass('airline_rules', 'Carrier restrictions', `All carriers preferred: ${carriers.join(', ')}.`);
  },
};

export const showTravelBudget: Rule = {
  id: 'show_travel_budget',
  label: 'Show travel budget',
  evaluate: ({ offer, policy, showTravelSpentCents }) => {
    const budget = policy.perShowTravelBudgetCents;
    if (budget === null || showTravelSpentCents === undefined) {
      return na('show_travel_budget', 'Show travel budget', 'No per-show travel budget configured.');
    }
    const projected = showTravelSpentCents + offer.totalCents;
    const margin = projected - budget;
    if (margin > 0) {
      return fail(
        'show_travel_budget',
        'Show travel budget',
        'approval',
        `Would put show travel at ${usd(projected)}, ${usd(margin)} over the ${usd(budget)} budget.`,
        { margin, marginUnit: 'cents' },
      );
    }
    return pass(
      'show_travel_budget',
      'Show travel budget',
      `${usd(Math.abs(margin))} of travel budget remaining after this purchase.`,
      { margin, marginUnit: 'cents' },
    );
  },
};

/**
 * Credit-first. 5-11% of corporate air spend is forfeited to expiring credits;
 * this is the rule that stops us adding to the pile. SCOPE.md §5b.
 */
export const creditFirst: Rule = {
  id: 'credit_first',
  label: 'Unused credit applied first',
  evaluate: ({ policy, applicableCreditCents }) => {
    if (!policy.requireCreditFirst) {
      return na('credit_first', 'Unused credit applied first', 'Credit-first rule not enabled.');
    }
    if (!applicableCreditCents || applicableCreditCents <= 0) {
      return pass('credit_first', 'Unused credit applied first', 'No applicable credit available.');
    }
    return fail(
      'credit_first',
      'Unused credit applied first',
      'approval',
      `${usd(applicableCreditCents)} in unused credit is available and must be applied before new spend.`,
      { margin: applicableCreditCents, marginUnit: 'cents' },
    );
  },
};

/** Evaluation order is display order on the approval screen. */
export const ALL_RULES: Rule[] = [
  offerNotExpired,
  departureWindow,
  arrivalBuffer,
  approvalBand,
  fareCeiling,
  cabinCeiling,
  advanceBooking,
  stopLimit,
  connectionTime,
  refundability,
  airlineRules,
  showTravelBudget,
  creditFirst,
];
