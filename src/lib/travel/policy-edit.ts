import { decimalStringToCents } from '@/lib/money/decimal';
import type { Cabin } from '@/lib/policy';

/**
 * Editing the org's travel policy — the rules the booking agent enforces.
 *
 * ## Why this did not exist
 *
 * `SCOPE.md`'s first sentence describes this product as *"a policy-governed
 * agent that purchases flights within admin-defined spend and schedule
 * constraints"*, and until now **an admin could not define them**.
 * `travel_policies` is written in exactly one place, `scripts/seed.ts`. The
 * engine that reads it is pure, deterministic and covered by 47 tests; the
 * layering, the versioning and the null-versus-undefined rule are all built; and
 * `policy/validate.ts` has carried the comment *"Consumed by the admin policy
 * editor (build step 7)"* since step 3, for an editor that never shipped and is
 * called by nothing.
 *
 * So a real organization runs the agent against whatever policy it does not
 * have, which is `NoPolicyError` — the agent refuses to search at all.
 *
 * ## What this module does and does not decide
 *
 * It converts a form into a row and nothing else. **The coherence rules stay in
 * `policy/validate.ts`**, which already knows that a fare cap above the deny
 * ceiling makes a whole class of fare unbookable and that the symptom is "the
 * agent cannot find flights" rather than "the policy is wrong". Re-checking any
 * of that here would be a second opinion about the same question — the
 * `SOURCE_LABEL` trap — so the store resolves the saved layers and runs the real
 * validator over the result, which is also the only way to catch an incoherence
 * that only exists *after* merging.
 *
 * Money is parsed with `money/decimal.ts`. Every cap here is a dollar figure
 * somebody types, and this is the module where a `parseFloat` rounding error
 * would become a fare ceiling that is a cent short.
 */

export class PolicyEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEditError';
  }
}

export const CABINS: Cabin[] = ['economy', 'premium_economy', 'business', 'first'];
export const CABIN_LABEL: Record<Cabin, string> = {
  economy: 'Economy',
  premium_economy: 'Premium economy',
  business: 'Business',
  first: 'First',
};

export type PolicyFormInput = {
  label: string | null;
  maxAirfareDomestic: string | null;
  maxAirfareInternational: string | null;
  autoApproveUnder: string | null;
  denyOver: string | null;
  maxCabinDomestic: string | null;
  maxCabinInternational: string | null;
  premiumCabinAllowedOverHours: string | null;
  minAdvanceBookingDays: string | null;
  maxStops: string | null;
  minConnectionMinutes: string | null;
  arrivalBufferHoursBeforeMoveIn: string | null;
  nonRefundableAllowedUnder: string | null;
  maxAcceptableRefundPenalty: string | null;
  preferredAirlines: string | null;
  blockedAirlines: string | null;
  preferredCarrierAllowance: string | null;
  personalCarrierAllowance: string | null;
  maxHotelNightlyRate: string | null;
  perShowTravelBudget: string | null;
  requireCreditFirst: boolean;
};

export type PolicyRowValues = {
  label: string | null;
  maxAirfareDomesticCents: number | null;
  maxAirfareInternationalCents: number | null;
  autoApproveUnderCents: number | null;
  denyOverCents: number | null;
  maxCabinDomestic: string | null;
  maxCabinInternational: string | null;
  premiumCabinAllowedOverHours: number | null;
  minAdvanceBookingDays: number | null;
  maxStops: number | null;
  minConnectionMinutes: number | null;
  arrivalBufferHoursBeforeMoveIn: number | null;
  nonRefundableAllowedUnderCents: number | null;
  maxAcceptableRefundPenaltyCents: number | null;
  preferredAirlines: string[] | null;
  blockedAirlines: string[] | null;
  preferredCarrierAllowanceCents: number | null;
  personalCarrierAllowanceCents: number | null;
  maxHotelNightlyRateCents: number | null;
  perShowTravelBudgetCents: number | null;
  requireCreditFirst: boolean | null;
};

function money(value: string | null, field: string): number | null {
  const raw = value?.trim().replace(/[$,]/g, '');
  if (!raw) return null;
  const cents = decimalStringToCents(raw);
  if (cents < 0) throw new PolicyEditError(`${field} cannot be negative.`);
  return cents;
}

function whole(value: string | null, field: string, max: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new PolicyEditError(`${field} is a whole number, or blank for "no rule".`);
  }
  const n = Number(raw);
  if (n > max) throw new PolicyEditError(`${field} of ${n} is not a rule, it is a typo.`);
  return n;
}

/**
 * What a carrier preference may cost the company — either kind.
 *
 * Bounded on purpose, and the bound is the argument. Every other money field
 * here is a *limit*, a ceiling the agent must stay under, so a typo makes the
 * policy looser and something downstream catches it. **These two are the only
 * fields in the policy that authorize the agent to pay more than it otherwise
 * would**, so a slipped decimal does not loosen a rule — it quietly buys a
 * $2,500 fare instead of a $500 one because somebody likes United. Ranking
 * clamps a preference to its decision tier either way, so the damage is bounded;
 * a refusal at the point of typing is simply a better place to find it than an
 * audit six months later.
 *
 * The two caps differ because the two things differ. An org's list is a
 * negotiated agreement — volume on a contracted carrier, often paying for itself
 * in discounts this app cannot see — and a person's is a convenience. And they
 * **stack**, so the real worst case is the two caps added, which is the number
 * to have in mind when raising either one.
 */
function allowance(value: string | null, field: string, cap: number): number | null {
  const cents = money(value, field);
  if (cents !== null && cents > cap) {
    throw new PolicyEditError(
      `${field} of ${usd(cents)} is a fare, not a preference. This is how much extra the ` +
        `agent may pay to stay on a preferred carrier; the cap is ${usd(cap)}. Leave it ` +
        'blank to make that preference a tie-break and nothing more.',
    );
  }
  return cents;
}

/** $1,000. A negotiated-carrier premium is a contract term, not a convenience. */
export const MAX_PREFERRED_CARRIER_ALLOWANCE_CENTS = 100_000;
/** $500. High enough for a real long-haul preference, low enough to notice. */
export const MAX_PERSONAL_CARRIER_ALLOWANCE_CENTS = 50_000;

/** Local, like the copies in `agent.ts` and `rules.ts` — for one error message. */
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function cabin(value: string | null, field: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!CABINS.includes(raw as Cabin)) {
    throw new PolicyEditError(`"${raw}" is not a cabin this app knows about (${field}).`);
  }
  return raw;
}

/**
 * IATA codes, uppercased, deduplicated, and **never validated against a list of
 * real airlines**. We do not hold one, and a made-up allowlist would refuse a
 * carrier that exists — which on this screen means quietly making a route
 * unbookable and calling it policy.
 */
function airlines(value: string | null): string[] | null {
  const raw = value?.trim();
  if (!raw) return null;
  const codes = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  for (const c of codes) {
    if (!/^[A-Z0-9]{2}$/.test(c)) {
      throw new PolicyEditError(
        `"${c}" is not a two-character IATA airline code. Use "AA UA DL", not a name.`,
      );
    }
  }
  return codes.length ? codes : null;
}

export function toPolicyRow(input: PolicyFormInput): PolicyRowValues {
  return {
    label: input.label?.trim() || null,
    maxAirfareDomesticCents: money(input.maxAirfareDomestic, 'The domestic fare cap'),
    maxAirfareInternationalCents: money(
      input.maxAirfareInternational,
      'The international fare cap',
    ),
    autoApproveUnderCents: money(input.autoApproveUnder, 'The auto-approve threshold'),
    denyOverCents: money(input.denyOver, 'The deny ceiling'),
    maxCabinDomestic: cabin(input.maxCabinDomestic, 'domestic cabin'),
    maxCabinInternational: cabin(input.maxCabinInternational, 'international cabin'),
    premiumCabinAllowedOverHours: whole(
      input.premiumCabinAllowedOverHours,
      'The premium cabin hour threshold',
      24,
    ),
    minAdvanceBookingDays: whole(input.minAdvanceBookingDays, 'Minimum advance booking', 365),
    maxStops: whole(input.maxStops, 'Maximum stops', 5),
    minConnectionMinutes: whole(input.minConnectionMinutes, 'Minimum connection', 600),
    arrivalBufferHoursBeforeMoveIn: whole(
      input.arrivalBufferHoursBeforeMoveIn,
      'The arrival buffer',
      168,
    ),
    nonRefundableAllowedUnderCents: money(
      input.nonRefundableAllowedUnder,
      'The non-refundable allowance',
    ),
    maxAcceptableRefundPenaltyCents: money(
      input.maxAcceptableRefundPenalty,
      'The acceptable refund penalty',
    ),
    preferredAirlines: airlines(input.preferredAirlines),
    blockedAirlines: airlines(input.blockedAirlines),
    preferredCarrierAllowanceCents: allowance(
      input.preferredCarrierAllowance,
      'The preferred carrier allowance',
      MAX_PREFERRED_CARRIER_ALLOWANCE_CENTS,
    ),
    personalCarrierAllowanceCents: allowance(
      input.personalCarrierAllowance,
      'The personal carrier allowance',
      MAX_PERSONAL_CARRIER_ALLOWANCE_CENTS,
    ),
    maxHotelNightlyRateCents: money(input.maxHotelNightlyRate, 'The hotel nightly cap'),
    perShowTravelBudgetCents: money(input.perShowTravelBudget, 'The per-show travel budget'),
    requireCreditFirst: input.requireCreditFirst,
  };
}
