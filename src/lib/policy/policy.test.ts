import { describe, it, expect } from 'vitest';
import { evaluate, resolvePolicy, verdictIsStale } from './evaluate';
import { validatePolicy, isPolicyBookable } from './validate';
import { rankOffers, selectBest } from './rank';
import * as R from './rules';
import type { EvaluationContext, RuleResult } from './types';
import { NOW, MOVE_IN, offer, connectingOffer, policy, constraints, segment } from './fixtures';

const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  offer: offer(),
  constraints: constraints(),
  policy: policy(),
  now: NOW,
  moveInAt: MOVE_IN,
  ...over,
});

const find = (results: RuleResult[], id: string) => {
  const r = results.find((x) => x.ruleId === id);
  if (!r) throw new Error(`rule ${id} did not report`);
  return r;
};

const h = (hours: number) => hours * 3_600_000;
const d = (days: number) => days * 86_400_000;

/* -------------------------------- the basics ------------------------------- */

describe('evaluate', () => {
  it('auto-approves a compliant, in-budget, in-window offer', () => {
    const v = evaluate(ctx());
    expect(v.decision).toBe('auto_approve');
    expect(v.blockers).toHaveLength(0);
  });

  it('records the policy version on the verdict', () => {
    // An audit must reconstruct which rules ran, not today's rules. SCOPE.md §4.
    const v = evaluate(ctx({ policy: policy({ version: 11 }) }));
    expect(v.policyVersion).toBe(11);
    expect(v.policyId).toBe('pol_test');
  });

  it('reports every rule, not just failures', () => {
    const v = evaluate(ctx());
    expect(v.results.length).toBe(R.ALL_RULES.length);
  });

  it('distinguishes not_applicable from pass', () => {
    // No move-in time means the buffer rule has nothing to say — which is a
    // different fact from it passing.
    const v = evaluate(ctx({ moveInAt: undefined }));
    expect(find(v.results, 'arrival_buffer').status).toBe('not_applicable');
    expect(v.decision).toBe('auto_approve');
  });
});

/* ------------------------------ spend authority ---------------------------- */

describe('approval bands', () => {
  it('escalates above the auto-approve threshold', () => {
    const v = evaluate(ctx({ offer: offer({ totalCents: 58_000 }) }));
    expect(v.decision).toBe('needs_approval');
    expect(find(v.results, 'approval_band').margin).toBe(8_000);
  });

  it('denies above the absolute ceiling, and no approver can override', () => {
    const v = evaluate(ctx({ offer: offer({ totalCents: 260_000 }) }));
    expect(v.decision).toBe('deny');
    expect(find(v.results, 'approval_band').severity).toBe('deny');
  });

  it('reports the fare-ceiling margin in dollars an approver can read', () => {
    const v = evaluate(ctx({ offer: offer({ totalCents: 69_000 }) }));
    const r = find(v.results, 'fare_ceiling');
    expect(r.margin).toBe(4_000);
    expect(r.message).toContain('$40');
  });

  it('applies the international ceiling when any segment crosses a border', () => {
    const intl = offer({
      totalCents: 110_000,
      slices: [{ segments: [segment({ destinationAirport: 'LHR', destinationCountry: 'GB' })] }],
    });
    const v = evaluate(ctx({ offer: intl }));
    // Under the $1,800 international cap, so the ceiling rule passes...
    expect(find(v.results, 'fare_ceiling').status).toBe('pass');
    // ...but still above the $500 auto-approve band.
    expect(v.decision).toBe('needs_approval');
  });
});

/* ---------------------------- offer expiry (the classic) -------------------- */

describe('offer expiry', () => {
  it('hard-denies an expired offer regardless of price', () => {
    const stale = offer({ totalCents: 10_000, expiresAt: new Date(NOW.getTime() - h(1)) });
    const v = evaluate(ctx({ offer: stale }));
    expect(v.decision).toBe('deny');
    expect(find(v.results, 'offer_not_expired').message).toContain('fresh search');
  });

  it('passes an offer with no stated expiry', () => {
    const v = evaluate(ctx({ offer: offer({ expiresAt: null }) }));
    expect(find(v.results, 'offer_not_expired').status).toBe('pass');
  });

  it('marks a verdict stale once it outlives the offer window', () => {
    const v = evaluate(ctx());
    expect(verdictIsStale(v, new Date(NOW.getTime() + h(0.1)))).toBe(false);
    // An approval that sat overnight cannot authorize the price it saw.
    expect(verdictIsStale(v, new Date(NOW.getTime() + h(14)))).toBe(true);
  });
});

/* -------------------------------- trade show rules -------------------------- */

describe('arrival buffer', () => {
  it('denies an itinerary landing after move-in has started', () => {
    const late = offer({
      slices: [
        {
          segments: [
            segment({
              departsAt: new Date(MOVE_IN.getTime() + h(1)),
              arrivesAt: new Date(MOVE_IN.getTime() + h(5)),
            }),
          ],
        },
      ],
    });
    const v = evaluate(ctx({ offer: late, constraints: constraints({ latestArrival: new Date(MOVE_IN.getTime() + h(6)) }) }));
    expect(find(v.results, 'arrival_buffer').severity).toBe('deny');
    expect(v.decision).toBe('deny');
  });

  it('escalates an itinerary landing inside the buffer but before move-in', () => {
    const tight = offer({
      slices: [
        {
          segments: [
            segment({
              departsAt: new Date(MOVE_IN.getTime() - h(5)),
              arrivesAt: new Date(MOVE_IN.getTime() - h(2)),
            }),
          ],
        },
      ],
    });
    const v = evaluate(ctx({ offer: tight, constraints: constraints({ latestArrival: MOVE_IN }) }));
    const r = find(v.results, 'arrival_buffer');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('approval');
    expect(r.margin).toBeCloseTo(2, 5);
  });
});

describe('the score is a whole number of cents', () => {
  /*
   * `offer_snapshots.score` and `policy_evaluations.score` are both `integer`,
   * so a fractional score is not a ranking nuance — it fails the insert with
   * `invalid input syntax for type integer` and takes the agent run down while
   * it is writing the audit row.
   *
   * Every term in `scoreOffer` is already whole cents except the arrival-buffer
   * penalty, which multiplies a float count of hours. So the crash fires only
   * when a show has a move-in time *and* the offer lands inside twelve hours of
   * it — the tight-arrival case the buffer exists to reason about, and the last
   * one you would want the agent to fall over on.
   */
  const arrivingHoursBefore = (hours: number) =>
    offer({
      slices: [
        {
          segments: [
            segment({
              departsAt: new Date(MOVE_IN.getTime() - h(hours + 4)),
              arrivesAt: new Date(MOVE_IN.getTime() - h(hours)),
            }),
          ],
        },
      ],
    });

  it('stays an integer for an arrival inside the buffer, at any fraction of an hour', () => {
    for (const hours of [11.5, 7.25, 3.1, 1.0 / 3.0, 0.7]) {
      const [ranked] = rankOffers([arrivingHoursBefore(hours)], ctx({}));
      expect(Number.isInteger(ranked.score), `score ${ranked.score} for ${hours}h before move-in`).toBe(
        true,
      );
    }
  });

  it('is an integer with no move-in time and with a roomy arrival too', () => {
    const [roomy] = rankOffers([arrivingHoursBefore(48)], ctx({}));
    expect(Number.isInteger(roomy.score)).toBe(true);
    const [noMoveIn] = rankOffers([arrivingHoursBefore(2)], ctx({ moveInAt: undefined }));
    expect(Number.isInteger(noMoveIn.score)).toBe(true);
  });

  it('still prefers the roomier arrival after rounding', () => {
    // Rounding must not flatten the penalty into a tie, or the buffer stops
    // being priced at all.
    const [tight] = rankOffers([arrivingHoursBefore(1)], ctx({}));
    const [roomy] = rankOffers([arrivingHoursBefore(11)], ctx({}));
    expect(tight.score).toBeGreaterThan(roomy.score);
  });
});

describe('traveler time constraints', () => {
  it('denies an offer arriving after the traveler must be on the ground', () => {
    const v = evaluate(
      ctx({ constraints: constraints({ latestArrival: new Date(NOW.getTime() + d(27)) }) }),
    );
    expect(find(v.results, 'departure_window').severity).toBe('deny');
  });

  it('denies an offer departing before the traveler can leave', () => {
    const v = evaluate(
      ctx({ constraints: constraints({ earliestDeparture: new Date(NOW.getTime() + d(28) + h(6)) }) }),
    );
    expect(find(v.results, 'departure_window').severity).toBe('deny');
  });
});

/* ----------------------------- itinerary quality ---------------------------- */

describe('stops and connections', () => {
  it('counts stops per slice, not across the whole trip', () => {
    // Two nonstop slices is zero stops, not one.
    const roundTrip = offer({ slices: [{ segments: [segment()] }, { segments: [segment()] }] });
    const v = evaluate(ctx({ offer: roundTrip }));
    expect(find(v.results, 'stop_limit').margin).toBe(-1);
  });

  it('escalates a connection tighter than the minimum', () => {
    const v = evaluate(ctx({ offer: connectingOffer(35) }));
    const r = find(v.results, 'connection_time');
    expect(r.status).toBe('fail');
    expect(r.margin).toBe(25);
  });

  it('reports not_applicable for a nonstop', () => {
    const v = evaluate(ctx());
    expect(find(v.results, 'connection_time').status).toBe('not_applicable');
  });

  it('escalates when stops exceed the limit', () => {
    const threeLeg = offer({
      slices: [{ segments: [segment(), segment(), segment()] }],
    });
    const v = evaluate(ctx({ offer: threeLeg }));
    expect(find(v.results, 'stop_limit').status).toBe('fail');
  });
});

describe('cabin ceiling', () => {
  it('escalates a business-class domestic fare', () => {
    const biz = offer({ slices: [{ segments: [segment({ cabin: 'business' })] }] });
    const v = evaluate(ctx({ offer: biz }));
    expect(find(v.results, 'cabin_ceiling').status).toBe('fail');
  });

  it('permits premium economy on a long-haul leg', () => {
    const longHaul = offer({
      slices: [
        {
          segments: [
            segment({
              cabin: 'premium_economy',
              destinationAirport: 'NRT',
              destinationCountry: 'JP',
              arrivesAt: new Date(NOW.getTime() + d(28) + h(11)),
            }),
          ],
        },
      ],
    });
    const v = evaluate(ctx({ offer: longHaul, constraints: constraints({ latestArrival: new Date(NOW.getTime() + d(29)) }) }));
    expect(find(v.results, 'cabin_ceiling').status).toBe('pass');
  });

  it('catches the richest cabin anywhere in the itinerary', () => {
    // An economy leg followed by a business leg is a business itinerary.
    const mixed = offer({
      slices: [{ segments: [segment({ cabin: 'economy' }), segment({ cabin: 'business' })] }],
    });
    const v = evaluate(ctx({ offer: mixed }));
    expect(find(v.results, 'cabin_ceiling').status).toBe('fail');
  });
});

/* --------------------------------- money rules ------------------------------ */

describe('advance booking, refundability, carriers, budget', () => {
  it('escalates a booking inside the advance window', () => {
    const soon = offer({
      slices: [
        {
          segments: [
            segment({
              departsAt: new Date(NOW.getTime() + d(5)),
              arrivesAt: new Date(NOW.getTime() + d(5) + h(4.5)),
            }),
          ],
        },
      ],
    });
    const v = evaluate(
      ctx({
        offer: soon,
        constraints: constraints({
          earliestDeparture: NOW,
          latestArrival: new Date(NOW.getTime() + d(6)),
        }),
        moveInAt: new Date(NOW.getTime() + d(7)),
      }),
    );
    const r = find(v.results, 'advance_booking');
    expect(r.status).toBe('fail');
    expect(r.margin).toBeCloseTo(9, 1);
  });

  it('escalates an expensive non-refundable fare', () => {
    const v = evaluate(ctx({ offer: offer({ totalCents: 48_000, refundable: false }) }));
    expect(find(v.results, 'refundability').status).toBe('fail');
  });

  it('passes a cheap non-refundable fare', () => {
    const v = evaluate(ctx({ offer: offer({ totalCents: 30_000, refundable: false }) }));
    expect(find(v.results, 'refundability').status).toBe('pass');
  });

  it('hard-denies a blocked carrier', () => {
    const v = evaluate(ctx({ policy: policy({ blockedAirlines: ['DL'] }) }));
    expect(v.decision).toBe('deny');
  });

  it('treats an off-preferred carrier as advisory, not a blocker', () => {
    const v = evaluate(ctx({ policy: policy({ preferredAirlines: ['UA'] }) }));
    const r = find(v.results, 'airline_rules');
    expect(r.status).toBe('fail');
    expect(r.severity).toBe('advisory');
    expect(v.decision).toBe('auto_approve');
    expect(v.blockers).toHaveLength(0);
  });

  it('escalates when a purchase would breach the show travel budget', () => {
    const v = evaluate(
      ctx({
        policy: policy({ perShowTravelBudgetCents: 200_000 }),
        showTravelSpentCents: 180_000,
      }),
    );
    const r = find(v.results, 'show_travel_budget');
    expect(r.status).toBe('fail');
    expect(r.margin).toBe(18_000);
  });
});

describe('credit-first', () => {
  it('escalates when an unused credit could have been applied', () => {
    const v = evaluate(
      ctx({ policy: policy({ requireCreditFirst: true }), applicableCreditCents: 31_500 }),
    );
    expect(find(v.results, 'credit_first').status).toBe('fail');
    expect(v.decision).toBe('needs_approval');
  });

  it('passes when no credit is available', () => {
    const v = evaluate(
      ctx({ policy: policy({ requireCreditFirst: true }), applicableCreditCents: 0 }),
    );
    expect(find(v.results, 'credit_first').status).toBe('pass');
  });

  it('is not applicable when the rule is off', () => {
    const v = evaluate(ctx({ applicableCreditCents: 90_000 }));
    expect(find(v.results, 'credit_first').status).toBe('not_applicable');
  });
});

/* ------------------------------ policy resolution --------------------------- */

describe('resolvePolicy', () => {
  it('lets a cost-center override beat the org default', () => {
    const resolved = resolvePolicy([
      policy({ scope: 'org', maxAirfareDomesticCents: 65_000 }),
      policy({ scope: 'cost_center', maxAirfareDomesticCents: 180_000, scopeRef: 'SE-200' }),
    ]);
    expect(resolved.maxAirfareDomesticCents).toBe(180_000);
  });

  it('applies most-specific-first regardless of input order', () => {
    const resolved = resolvePolicy([
      policy({ scope: 'role', maxStops: 0 }),
      policy({ scope: 'org', maxStops: 2 }),
      policy({ scope: 'cost_center', maxStops: 1 }),
    ]);
    expect(resolved.maxStops).toBe(0);
  });

  it('inherits unset fields from the broader layer', () => {
    const resolved = resolvePolicy([
      policy({ scope: 'org', minConnectionMinutes: 90, maxAirfareDomesticCents: 65_000 }),
      policy({ scope: 'show', maxAirfareDomesticCents: 95_000, minConnectionMinutes: 90 }),
    ]);
    expect(resolved.maxAirfareDomesticCents).toBe(95_000);
    expect(resolved.minConnectionMinutes).toBe(90);
  });

  it('throws rather than guessing when given no layers', () => {
    expect(() => resolvePolicy([])).toThrow();
  });
});

/* --------------------------------- ranking ---------------------------------- */

describe('ranking', () => {
  it('prefers a compliant offer over a cheaper one needing approval', () => {
    const cheapButOverCabin = offer({
      id: 'off_cheap',
      totalCents: 20_000,
      slices: [{ segments: [segment({ cabin: 'business' })] }],
    });
    const compliant = offer({ id: 'off_ok', totalCents: 35_000 });

    const ranked = rankOffers([cheapButOverCabin, compliant], {
      constraints: constraints(),
      policy: policy(),
      now: NOW,
      moveInAt: MOVE_IN,
    });
    expect(ranked[0].offer.id).toBe('off_ok');
  });

  it('prefers the cheaper option within the same decision tier', () => {
    const ranked = rankOffers(
      [
        offer({ id: 'pricey', totalCents: 47_000, refundable: true }),
        offer({ id: 'cheap', totalCents: 31_000, refundable: true }),
      ],
      { constraints: constraints(), policy: policy(), now: NOW, moveInAt: MOVE_IN },
    );
    expect(ranked[0].offer.id).toBe('cheap');
  });

  it('penalizes stops enough to lose to a modestly pricier nonstop', () => {
    const ranked = rankOffers(
      [connectingOffer(90, { id: 'onestop', totalCents: 30_000 }), offer({ id: 'nonstop', totalCents: 34_000 })],
      { constraints: constraints(), policy: policy(), now: NOW, moveInAt: MOVE_IN },
    );
    expect(ranked[0].offer.id).toBe('nonstop');
  });

  it('returns null rather than selecting a denied offer', () => {
    const ranked = rankOffers([offer({ totalCents: 600_000 })], {
      constraints: constraints(),
      policy: policy(),
      now: NOW,
      moveInAt: MOVE_IN,
    });
    // "No viable option" is a real outcome the user must see. SCOPE.md §6b.
    expect(selectBest(ranked)).toBeNull();
  });

  it('selects a needs-approval offer when nothing auto-approves', () => {
    const ranked = rankOffers([offer({ totalCents: 58_000 })], {
      constraints: constraints(),
      policy: policy(),
      now: NOW,
      moveInAt: MOVE_IN,
    });
    const best = selectBest(ranked);
    expect(best?.verdict.decision).toBe('needs_approval');
  });
});

/* ------------------------------- determinism -------------------------------- */

describe('determinism', () => {
  it('produces identical verdicts for identical inputs', () => {
    const a = evaluate(ctx());
    const b = evaluate(ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never reads the wall clock', () => {
    // `now` is an input. If it were read internally, this would drift.
    const later = evaluate(ctx({ now: NOW }));
    expect(later.evaluatedAt).toEqual(NOW);
  });
});

/* ------------------------------ policy validation --------------------------- */

describe('validatePolicy', () => {
  it('accepts a coherent policy', () => {
    expect(validatePolicy(policy())).toHaveLength(0);
    expect(isPolicyBookable(policy())).toBe(true);
  });

  it('catches a fare cap above the deny ceiling', () => {
    // The trap: international fares up to $1,800 are "allowed" but everything
    // over $1,200 is denied, so no international fare is ever bookable. This
    // presents as "the agent can't find flights", not as a policy error.
    const broken = policy({ bands: { autoApproveUnderCents: 50_000, denyOverCents: 120_000 } });
    const issues = validatePolicy(broken);
    expect(issues.some((i) => i.field === 'maxAirfareInternationalCents' && i.severity === 'error')).toBe(true);
    expect(isPolicyBookable(broken)).toBe(false);
  });

  it('catches an auto-approve threshold above the deny ceiling', () => {
    const broken = policy({ bands: { autoApproveUnderCents: 300_000, denyOverCents: 250_000 } });
    expect(validatePolicy(broken).some((i) => i.field === 'bands')).toBe(true);
  });

  it('catches a carrier that is both preferred and blocked', () => {
    const broken = policy({ preferredAirlines: ['DL', 'UA'], blockedAirlines: ['UA'] });
    const issue = validatePolicy(broken).find((i) => i.field === 'preferredAirlines');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('UA');
  });

  it('warns on an unmakeable connection minimum without blocking', () => {
    const issues = validatePolicy(policy({ minConnectionMinutes: 15 }));
    expect(issues[0].severity).toBe('warning');
    expect(isPolicyBookable(policy({ minConnectionMinutes: 15 }))).toBe(true);
  });
});

/* ------------------- a traveler's own carrier preference ------------------- */

/**
 * The rule this section exists to hold: **a personal preference ranks and never
 * rules.**
 *
 * The org's `preferredAirlines` is a policy input and produces an advisory that
 * `types.ts` says is "recorded and ignored". A *person's* preference is a
 * different thing and it deliberately never becomes a rule at all — no entry in
 * `ALL_RULES` reads it, so it cannot deny a fare, escalate one, or remove one
 * from the list. What it does is move an offer among the ones already allowed,
 * by an amount an admin priced, clamped so it can never cross a decision tier.
 *
 * The bad version of this feature is easy to write and hard to see: a rule that
 * fails an off-preference fare turns "I prefer United" into an agent that
 * quietly stops finding flights, and the person who typed the preference is the
 * last one able to diagnose it.
 */
describe("a traveler's own carrier preference", () => {
  const ua = (totalCents: number) =>
    offer({
      id: 'off_ua',
      totalCents,
      slices: [{ segments: [segment({ airlineCode: 'UA' })] }],
    });
  const dl = (totalCents: number) => offer({ id: 'off_dl', totalCents });

  const priced = (cents: number | null) => policy({ personalCarrierAllowanceCents: cents });

  it('never appears as a rule, so it cannot deny or escalate anything', () => {
    const v = evaluate(
      ctx({
        offer: ua(38_000),
        policy: priced(50_000),
        travelerPreferredAirlines: ['DL'],
      }),
    );
    // Flying the carrier they did *not* ask for changes nothing about the verdict.
    expect(v.decision).toBe('auto_approve');
    expect(v.blockers).toHaveLength(0);
    expect(v.results.some((r) => JSON.stringify(r).includes('travelerPreferred'))).toBe(false);
  });

  it('wins a near-tie inside the allowance', () => {
    // Both fares sit under the fixture's $400 non-refundable limit on purpose:
    // a preference must be compared between offers in the *same* decision tier,
    // and the first draft of this test picked two that were not.
    const ranked = rankOffers([dl(30_000), ua(30_400)], {
      ...ctx(),
      policy: priced(6_000),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_ua');
    expect(ranked[0].preference).toEqual({ orgCents: 0, travelerCents: 6_000, totalCents: 6_000 });
  });

  it('loses to a fare cheaper than the allowance is worth', () => {
    // $100 apart, $60 allowance. The company keeps the difference; this is the
    // case that makes the feature safe to hand somebody.
    const ranked = rankOffers([dl(30_000), ua(40_000)], {
      ...ctx(),
      policy: priced(6_000),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
  });

  it('is a tie-break and nothing more when nobody has priced it', () => {
    // Null is the app declining to spend money nobody authorized, not a guess.
    const ranked = rankOffers([dl(30_000), ua(30_400)], {
      ...ctx(),
      policy: priced(null),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(ranked[0].preference.totalCents).toBe(0);
  });

  it('is all-or-nothing across the carriers actually flown', () => {
    // A two-leg itinerary that is half preferred is not half a preference: the
    // traveler is on somebody else's aircraft for the other leg.
    const mixed = connectingOffer(75, { id: 'off_mixed', totalCents: 30_400 });
    mixed.slices[0].segments[0].airlineCode = 'UA';
    mixed.slices[0].segments[1].airlineCode = 'AS';
    const ranked = rankOffers([dl(30_000), mixed], {
      ...ctx(),
      policy: priced(6_000),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked.find((r) => r.offer.id === 'off_mixed')!.preference.totalCents).toBe(0);
  });

  it('cannot promote an offer across a decision tier, whatever the allowance', () => {
    // The safety property, and asserted against an absurd allowance on purpose:
    // the clamp is what makes this true, not the size of the number. Without it
    // a mistyped $10,000 would walk a needs-approval fare past an auto-approved
    // one and buy it without asking anybody.
    const cheapCompliant = dl(30_000);
    const dearPreferred = ua(90_000); // over the $600 auto-approve band
    const ranked = rankOffers([cheapCompliant, dearPreferred], {
      ...ctx(),
      policy: priced(10_000_000),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(selectBest(ranked)!.verdict.decision).toBe('auto_approve');
  });

  it('cannot rescue a carrier the org blocks', () => {
    // Two independent reasons, and both must hold: blocked is a `deny`, which
    // `selectBest` skips, and the tier clamp keeps the score inside the deny
    // band regardless.
    const ranked = rankOffers([ua(30_000)], {
      ...ctx(),
      policy: policy({ blockedAirlines: ['UA'], personalCarrierAllowanceCents: 50_000 }),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].verdict.decision).toBe('deny');
    expect(selectBest(ranked)).toBeNull();
  });
});

/* -------------------- the org's own carrier preference -------------------- */

/**
 * The org's list, which for twenty-four steps produced an advisory and moved
 * nothing.
 *
 * `types.ts` said advisory was "recorded and ignored", and that was accurate:
 * `evaluate` filters advisories out of `blockers` and `scoreOffer` never read
 * the rule results at all, so an org could name its negotiated carriers and the
 * agent would still buy whatever was cheapest. The advisory still cannot move a
 * verdict — that half is unchanged and asserted below — but the list now has a
 * price, and the price is what makes it a preference rather than a note.
 */
describe("the org's own carrier preference", () => {
  const ua = (totalCents: number) =>
    offer({ id: 'off_ua', totalCents, slices: [{ segments: [segment({ airlineCode: 'UA' })] }] });
  const dl = (totalCents: number) => offer({ id: 'off_dl', totalCents });

  it('still cannot deny or escalate, however much it is worth', () => {
    const v = evaluate(
      ctx({
        offer: ua(30_000),
        policy: policy({
          preferredAirlines: ['DL'],
          preferredCarrierAllowanceCents: 100_000,
        }),
      }),
    );
    const r = find(v.results, 'airline_rules');
    expect(r.severity).toBe('advisory');
    expect(v.decision).toBe('auto_approve');
    expect(v.blockers).toHaveLength(0);
  });

  it('pays to stay on a preferred carrier', () => {
    const ranked = rankOffers([ua(30_000), dl(30_400)], {
      ...ctx(),
      policy: policy({ preferredAirlines: ['DL'], preferredCarrierAllowanceCents: 15_000 }),
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(ranked[0].preference).toEqual({
      orgCents: 15_000,
      travelerCents: 0,
      totalCents: 15_000,
    });
  });

  it('does nothing until it is priced, which is what it did for twenty-four steps', () => {
    const ranked = rankOffers([ua(30_000), dl(30_400)], {
      ...ctx(),
      policy: policy({ preferredAirlines: ['DL'], preferredCarrierAllowanceCents: null }),
    });
    expect(ranked[0].offer.id).toBe('off_ua');
    expect(ranked[0].preference.totalCents).toBe(0);
  });

  it('stacks with the traveler’s, and keeps the halves apart', () => {
    // Two independent reasons, priced separately by an admin who typed two
    // numbers. Taking the larger would make the smaller inert whenever the
    // other is bigger, which is a worse surprise than the sum — so they add,
    // and the breakdown survives into the audit so the right person can argue.
    const ranked = rankOffers([ua(30_000), dl(31_500)], {
      ...ctx(),
      policy: policy({
        preferredAirlines: ['DL'],
        preferredCarrierAllowanceCents: 15_000,
        personalCarrierAllowanceCents: 6_000,
      }),
      travelerPreferredAirlines: ['DL'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(ranked[0].preference).toEqual({
      orgCents: 15_000,
      travelerCents: 6_000,
      totalCents: 21_000,
    });
  });

  it('the two lists disagreeing is a contest, not an error', () => {
    // The org prefers DL and the traveler prefers UA. Nothing is wrong here and
    // nothing is refused: each fare earns its own side's allowance and the
    // cheaper-after-preference one wins. $150 beats $60, so DL takes it — which
    // is the right answer, and is also why the audit has to name which one paid.
    const ranked = rankOffers([ua(30_000), dl(30_400)], {
      ...ctx(),
      policy: policy({
        preferredAirlines: ['DL'],
        preferredCarrierAllowanceCents: 15_000,
        personalCarrierAllowanceCents: 6_000,
      }),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(ranked[0].preference.orgCents).toBe(15_000);
    expect(ranked[0].preference.travelerCents).toBe(0);
    expect(ranked[1].preference.travelerCents).toBe(6_000);
  });

  it('cannot cross a decision tier even stacked at both caps', () => {
    // The safety property again, against the worst configuration the editor
    // permits ($1,000 + $500) plus an absurdity on top. The clamp is what holds.
    const ranked = rankOffers([dl(30_000), ua(90_000)], {
      ...ctx(),
      policy: policy({
        preferredAirlines: ['UA'],
        preferredCarrierAllowanceCents: 10_000_000,
        personalCarrierAllowanceCents: 10_000_000,
      }),
      travelerPreferredAirlines: ['UA'],
    });
    expect(ranked[0].offer.id).toBe('off_dl');
    expect(selectBest(ranked)!.verdict.decision).toBe('auto_approve');
  });
});

describe('a carrier list and its price have to agree', () => {
  it('warns when a list is priced but empty, and when a list has no price', () => {
    // Neither can hurt anybody, which is why both are warnings — but both look
    // configured on the screen while the agent behaves as though nothing were
    // set, and that is the gap this validator exists to say out loud. The
    // second is the exact state this workspace shipped in for twenty-four steps.
    const unspendable = validatePolicy(
      policy({ preferredAirlines: [], preferredCarrierAllowanceCents: 15_000 }),
    ).find((i) => i.field === 'preferredCarrierAllowanceCents');
    expect(unspendable?.severity).toBe('warning');
    expect(unspendable?.message).toContain('nothing can ever earn it');

    const unpriced = validatePolicy(
      policy({ preferredAirlines: ['DL'], preferredCarrierAllowanceCents: null }),
    ).find((i) => i.field === 'preferredCarrierAllowanceCents');
    expect(unpriced?.severity).toBe('warning');
    expect(unpriced?.message).toContain('never changes which fare wins');
  });

  it('does not shadow the blocked-and-preferred error', () => {
    // The unpriced warning was first written onto `preferredAirlines`, where it
    // took that field's slot for any caller looking an issue up by name — and
    // the existing test for the blocked-and-preferred error caught it at once.
    const both = validatePolicy(
      policy({
        preferredAirlines: ['DL', 'UA'],
        blockedAirlines: ['UA'],
        preferredCarrierAllowanceCents: null,
      }),
    );
    expect(both.find((i) => i.field === 'preferredAirlines')?.severity).toBe('error');
  });
});
