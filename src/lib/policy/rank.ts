import type { Offer, EvaluationContext, PolicyVerdict } from './types';
import { evaluate } from './evaluate';
import * as o from './offer';

/**
 * Offer ranking.
 *
 * Deliberately separate from `evaluate`: policy says what is *allowed*, ranking
 * says what is *best* among the allowed. Conflating them is how a booking agent
 * ends up justifying an expensive choice.
 */

export type RankedOffer = {
  offer: Offer;
  verdict: PolicyVerdict;
  score: number;
  /**
   * How much carrier preference moved this offer, and **which** preference.
   *
   * Broken out rather than folded silently into the score, because the pick has
   * to be legible: "we bought the $412 United over the $408 Delta" reads as a
   * bug unless something says why — and "because the company has a deal with
   * United" and "because Priya asked for United" are different answers to that
   * question, with different people to argue with. It goes into the `search`
   * step's audit detail. `totalCents` is what the score actually used.
   */
  preference: PreferenceCredit;
};

export type PreferenceCredit = {
  /** From the org's negotiated carrier list. */
  orgCents: number;
  /** From the traveler's own profile. */
  travelerCents: number;
  totalCents: number;
};

const NO_PREFERENCE: PreferenceCredit = { orgCents: 0, travelerCents: 0, totalCents: 0 };

const DECISION_WEIGHT = {
  auto_approve: 0,
  needs_approval: 1_000_000,
  deny: 100_000_000,
} as const;

/**
 * Lower score wins. Price dominates within a decision tier, with modest penalties
 * for stops and for landing uncomfortably close to move-in. Every term is in
 * cents so the tradeoffs are legible: a stop "costs" $75 of convenience.
 */
/**
 * What carrier preference is worth on this offer — the org's and the traveler's.
 *
 * Four refusals, and they are the whole design of the feature.
 *
 * **Both lists rank; neither rules.** No rule in `rules.ts` reads a preference
 * to decide anything. The org's list does produce an `airlineRules` advisory —
 * which is a sentence an auditor reads and has never moved a verdict — and the
 * traveler's list is not a rule input at all. Neither can deny an offer,
 * escalate one, or remove one from the list. This file's own docblock is the
 * reason: policy says what is allowed and ranking says what is best among the
 * allowed, and conflating them is how a booking agent ends up justifying an
 * expensive choice. A carrier *constraint* is exactly that failure — the agent
 * stops finding fares and nobody can tell why.
 *
 * **They stack, and the breakdown is kept.** An offer on a carrier the company
 * has a deal with *and* the traveler has status on has two independent reasons
 * behind it, both priced by an admin who typed two separate numbers. Taking the
 * larger of the two would make the second number inert whenever the first is
 * bigger, which is a worse surprise than the sum. What the sum costs is
 * visibility, so it is paid for: `PreferenceCredit` keeps the halves apart all
 * the way into the audit, because "the company has a deal with United" and
 * "Priya asked for United" are different answers with different people to argue
 * with. The worst case is the two caps added — see `policy-edit.ts`, which
 * bounds each at the point somebody types it.
 *
 * **All-or-nothing on the carriers actually flown**, for each list separately.
 * A credit only lands when *every* marketing carrier on the offer is on that
 * list, which mirrors how `airlineRules` already reads the org's. A two-leg
 * itinerary that is half preferred is not half a preference: the traveler is on
 * somebody else's aircraft for the other leg, and the company's agreement does
 * not cover it.
 *
 * **Neither can cross a decision tier**, and that is enforced here rather than
 * assumed from the size of the numbers. The caller clamps the discounted score
 * to the tier's own floor, so no allowance an admin can type — including one
 * typed with an extra zero, and including both of them together — can promote a
 * `needs_approval` fare above an `auto_approve` one, or rescue anything the
 * policy denied. That last case matters twice over here: `validatePolicy`
 * already refuses a carrier that is both preferred and blocked, and the clamp is
 * what holds if it ever gets through.
 */
function preferenceCreditFor(offer: Offer, ctx: EvaluationContext): PreferenceCredit {
  const carriers = o.marketingAirlines(offer);
  if (carriers.length === 0) return NO_PREFERENCE;

  /** Null is "nobody has priced this" — a tie-break, not a discount. */
  const worth = (allowance: number | null, wanted: string[]): number => {
    if (!allowance || allowance <= 0) return 0;
    if (wanted.length === 0) return 0;
    return carriers.every((c) => wanted.includes(c)) ? allowance : 0;
  };

  const orgCents = worth(ctx.policy.preferredCarrierAllowanceCents, ctx.policy.preferredAirlines);
  const travelerCents = worth(
    ctx.policy.personalCarrierAllowanceCents,
    ctx.travelerPreferredAirlines ?? [],
  );
  return { orgCents, travelerCents, totalCents: orgCents + travelerCents };
}

export function scoreOffer(
  ranked: Omit<RankedOffer, 'score' | 'preference'>,
  ctx: EvaluationContext,
): number {
  const { offer, verdict } = ranked;
  let score = DECISION_WEIGHT[verdict.decision] + offer.totalCents;

  score += o.maxStopsInAnySlice(offer) * 7_500;

  if (ctx.moveInAt) {
    const hoursBefore = (ctx.moveInAt.getTime() - o.outboundArrival(offer).getTime()) / 3_600_000;
    // Cutting it fine is a risk, not a preference; price it as one.
    if (hoursBefore < 12) score += (12 - hoursBefore) * 2_500;
  }

  /**
   * Whole cents, and this is not cosmetic.
   *
   * Every other term here is already an integer number of cents; `hoursBefore`
   * is milliseconds divided by 3,600,000, so the arrival-buffer penalty is the
   * one term that can produce a fraction. And `score` is an `integer` column in
   * **both** `offer_snapshots` and `policy_evaluations` — so a fractional score
   * does not rank slightly oddly, it fails the insert with `invalid input
   * syntax for type integer` and takes the whole agent run down with it.
   *
   * Which makes this the worst possible shape of bug for this module: it fires
   * only when `moveInAt` is set *and* the offer arrives inside twelve hours of
   * move-in — the tight-connection case the arrival buffer exists to reason
   * about. The agent crashed hardest on precisely the offers it was built to be
   * careful with, and did it while writing the audit row rather than while
   * deciding, so there was nothing left to read afterwards.
   *
   * It stayed hidden because the recorded fixtures happened to land outside the
   * twelve hours; a one-day shift in `recorded/provider.ts` moved them inside
   * and twenty of these appeared at once.
   */
  /**
   * The traveler's preference, last, and clamped to the decision tier's floor.
   *
   * Last because it is the only term here that is about a person rather than
   * about the trip, and clamped because the clamp is the safety property: the
   * tier weight is what keeps an offer needing approval below one that does not,
   * and an allowance typed with an extra zero would otherwise walk straight
   * through it. `Math.max` makes that impossible rather than unlikely.
   */
  const floor = DECISION_WEIGHT[verdict.decision];
  score = Math.max(floor, score - preferenceCreditFor(offer, ctx).totalCents);

  return Math.round(score);
}

export function rankOffers(offers: Offer[], ctx: Omit<EvaluationContext, 'offer'>): RankedOffer[] {
  return offers
    .map((offer) => {
      const full: EvaluationContext = { ...ctx, offer };
      const verdict = evaluate(full);
      return {
        offer,
        verdict,
        score: scoreOffer({ offer, verdict }, full),
        preference: preferenceCreditFor(offer, full),
      };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * The agent's choice. Returns null rather than falling back to a denied offer —
 * "no viable option" is a real outcome the user must see, not something to paper
 * over with a bad booking. SCOPE.md §6b, state `no_options`.
 */
export function selectBest(ranked: RankedOffer[]): RankedOffer | null {
  return ranked.find((r) => r.verdict.decision !== 'deny') ?? null;
}
