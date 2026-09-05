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
   * How much the traveler's own carrier preference moved this offer, in cents.
   *
   * Recorded rather than folded silently into the score, because the pick has to
   * be legible: "we bought the $412 United over the $408 Delta" reads as a bug
   * unless something says why. It goes into the `search` step's audit detail.
   */
  preferenceCreditCents: number;
};

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
 * What the traveler's own carrier preference is worth on this offer.
 *
 * Three refusals, and they are the whole design of the feature.
 *
 * **It ranks; it never rules.** There is no rule in `rules.ts` that reads a
 * personal preference, so it can never deny an offer, never escalate one, and
 * never remove one from the list. `rank.ts`'s own docblock is the reason: policy
 * says what is allowed and ranking says what is best among the allowed, and
 * conflating them is how a booking agent ends up justifying an expensive choice.
 * A per-person *constraint* is exactly that failure — the agent stops finding
 * fares and the person who typed a preference cannot tell why.
 *
 * **All-or-nothing on the carriers actually flown.** A credit only lands when
 * every marketing carrier on the offer is one the traveler asked for, which
 * mirrors how `airlineRules` reads the org's list. A two-leg itinerary that is
 * half preferred is not half a preference: the traveler is on the other carrier
 * for the other leg.
 *
 * **It cannot cross a decision tier**, and that is enforced here rather than
 * assumed from the size of the number. The caller clamps the discounted score to
 * the tier's own floor, so no allowance an admin can type — including one typed
 * with an extra zero — can promote a `needs_approval` fare above an
 * `auto_approve` one, or rescue anything the policy denied.
 */
function preferenceCreditFor(offer: Offer, ctx: EvaluationContext): number {
  const allowance = ctx.policy.personalCarrierAllowanceCents;
  // Null is "nobody has priced this", which is a tie-break and not a discount.
  if (!allowance || allowance <= 0) return 0;

  const wanted = ctx.travelerPreferredAirlines ?? [];
  if (wanted.length === 0) return 0;

  const carriers = o.marketingAirlines(offer);
  if (carriers.length === 0) return 0;
  return carriers.every((c) => wanted.includes(c)) ? allowance : 0;
}

export function scoreOffer(
  ranked: Omit<RankedOffer, 'score' | 'preferenceCreditCents'>,
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
  score = Math.max(floor, score - preferenceCreditFor(offer, ctx));

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
        preferenceCreditCents: preferenceCreditFor(offer, full),
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
