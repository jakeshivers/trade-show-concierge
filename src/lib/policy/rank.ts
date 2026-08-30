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
export function scoreOffer(ranked: Omit<RankedOffer, 'score'>, ctx: EvaluationContext): number {
  const { offer, verdict } = ranked;
  let score = DECISION_WEIGHT[verdict.decision] + offer.totalCents;

  score += o.maxStopsInAnySlice(offer) * 7_500;

  if (ctx.moveInAt) {
    const hoursBefore = (ctx.moveInAt.getTime() - o.outboundArrival(offer).getTime()) / 3_600_000;
    // Cutting it fine is a risk, not a preference; price it as one.
    if (hoursBefore < 12) score += (12 - hoursBefore) * 2_500;
  }

  return score;
}

export function rankOffers(offers: Offer[], ctx: Omit<EvaluationContext, 'offer'>): RankedOffer[] {
  return offers
    .map((offer) => {
      const full: EvaluationContext = { ...ctx, offer };
      const verdict = evaluate(full);
      return { offer, verdict, score: scoreOffer({ offer, verdict }, full) };
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
