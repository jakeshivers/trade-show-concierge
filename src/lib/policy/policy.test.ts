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
