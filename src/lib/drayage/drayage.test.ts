import { describe, it, expect } from 'vitest';
import { rollUpShowCost, type CostInputs } from '@/lib/cost/rollup';
import {
  billableWeight,
  estimateDrayage,
  rateCardIsConfirmed,
  type EstimableShipment,
  type RateCard,
} from './estimate';
import { validateRateCard, RateCardError } from './edit';
import { isDrayable } from './store';

/**
 * Arithmetic is not what these test. Every assertion here is about a figure that
 * would read perfectly well and be wrong — a total that is 25% light because
 * somebody summed before rounding, a return crate billed twice against a card
 * that already covered it, a crate with no weight quietly deleted from a figure
 * that still reads complete.
 */

const CARD: RateCard = {
  advanceCwtCents: 14_200, // $142.00 / CWT
  showSiteCwtCents: 17_500,
  minimumLb: 200,
  basis: 'round_trip',
  specialHandlingPct: 30,
  overtimePct: 25,
  confirmedAt: new Date('2027-01-05T00:00:00Z'),
};

const crate = (over: Partial<EstimableShipment> = {}): EstimableShipment => ({
  id: 'sh-1',
  description: 'Booth crate',
  direction: 'outbound',
  consignment: 'advance_warehouse',
  weightLb: 800,
  handling: 'crated',
  ...over,
});

describe('billable weight', () => {
  it('takes the minimum before rounding, then rounds up to a whole hundredweight', () => {
    expect(billableWeight(150, 200)).toBe(200);
    expect(billableWeight(250, 200)).toBe(300);
    expect(billableWeight(800, 200)).toBe(800);
    expect(billableWeight(801, 200)).toBe(900);
  });
});

describe('the estimate', () => {
  it('rounds per shipment and never in aggregate', () => {
    // The one a reasonable implementation gets wrong silently and forever. Two
    // 150 lb crates are two shipments: each takes the 200 lb minimum, so 400 lb
    // is billable. Summing first gives 300 lb and bills three hundredweight —
    // 25% light, in the flattering direction nobody audits.
    const e = estimateDrayage(CARD, [
      crate({ id: 'a', weightLb: 150 }),
      crate({ id: 'b', weightLb: 150 }),
    ]);
    expect(e.perShipment.map((p) => p.billableLb)).toEqual([200, 200]);
    expect(e.total).toEqual({ ok: true, cents: 2 * 2 * 14_200 });
    // What the naive version would have produced, spelled out so the gap is
    // visible in the test rather than only in the header.
    expect(e.total.ok && e.total.cents).toBeGreaterThan(3 * 14_200);
  });

  it('does not charge a return crate against a round-trip card', () => {
    const e = estimateDrayage(CARD, [
      crate({ id: 'out', direction: 'outbound' }),
      crate({ id: 'back', direction: 'return', consignment: 'office' }),
    ]);
    expect(e.perShipment).toHaveLength(1);
    expect(e.coveredByRoundTrip).toBe(1);
    expect(e.total).toEqual({ ok: true, cents: 8 * 14_200 });
  });

  it('charges both legs when the card says each way', () => {
    const e = estimateDrayage({ ...CARD, basis: 'each_way' }, [
      crate({ id: 'out', direction: 'outbound' }),
      crate({ id: 'back', direction: 'return', consignment: 'advance_warehouse' }),
    ]);
    expect(e.perShipment).toHaveLength(2);
    expect(e.coveredByRoundTrip).toBe(0);
  });

  it('treats a crate with no weight as unmeasured, not weightless', () => {
    const e = estimateDrayage(CARD, [crate({ id: 'a' }), crate({ id: 'b', weightLb: null })]);
    expect(e.perShipment).toHaveLength(1);
    expect(e.gaps.map((g) => g.kind)).toContain('unweighed');
    // The figure is real and is a floor. Both halves matter: dropping it would
    // be silent, and refusing the whole figure over one crate would throw away
    // the answer for the other five.
    expect(e.total.ok).toBe(true);
    expect(e.isFloor).toBe(true);
  });

  it('never applies the surcharge to freight nobody has described', () => {
    const e = estimateDrayage(CARD, [crate({ handling: 'unknown' })]);
    expect(e.perShipment[0].specialHandlingCents).toBe(0);
    expect(e.gaps.map((g) => g.kind)).toContain('unknown_handling');
    expect(e.isFloor).toBe(true);
  });

  it('applies it to freight somebody has said is uncrated', () => {
    const e = estimateDrayage(CARD, [crate({ handling: 'uncrated' })]);
    expect(e.perShipment[0].specialHandlingCents).toBe(Math.round(8 * 14_200 * 0.3));
    expect(e.isFloor).toBe(false);
  });

  it('names an uncrated crate the card does not price rather than billing it at par', () => {
    const e = estimateDrayage({ ...CARD, specialHandlingPct: null }, [
      crate({ handling: 'uncrated' }),
    ]);
    expect(e.perShipment[0].specialHandlingCents).toBe(0);
    expect(e.gaps.map((g) => g.kind)).toContain('unpriced_surcharge');
  });

  it('prices show-site freight off the show-site rate', () => {
    const e = estimateDrayage(CARD, [crate({ consignment: 'show_site' })]);
    expect(e.total).toEqual({ ok: true, cents: 8 * 17_500 });
  });

  it('withholds a figure with no card, and never answers zero', () => {
    const e = estimateDrayage(null, [crate()]);
    expect(e.total.ok).toBe(false);
    if (!e.total.ok) expect(e.total.reason).toContain('It is not zero');
    expect(e.isFloor).toBe(true);
    // A show with freight and no card must not report zero crates. Deriving the
    // count from what was priced made it read exactly like a show with no
    // freight — found by reading `pnpm drayage`, not by a test.
    expect(e.considered).toBe(1);
  });

  it('accounts for every crate it was given', () => {
    const e = estimateDrayage(CARD, [
      crate({ id: 'a' }),
      crate({ id: 'b', weightLb: null }),
      crate({ id: 'c', direction: 'return', consignment: 'office' }),
      crate({ id: 'd', consignment: 'office' }),
    ]);
    const unpriceable = e.gaps
      .filter((g) => g.kind === 'unweighed' || g.kind === 'no_rate')
      .reduce((n, g) => n + g.count, 0);
    expect(e.perShipment.length + e.coveredByRoundTrip + unpriceable).toBe(e.considered);
    expect(e.considered).toBe(4);
  });

  it('says there is nothing to handle when a show has no freight', () => {
    // Distinct from the case above: no crates is a real, complete answer, and it
    // must not read as a missing rate card.
    const e = estimateDrayage(null, []);
    expect(e.total.ok).toBe(false);
    expect(e.gaps).toHaveLength(0);
    expect(e.isFloor).toBe(false);
  });

  it('carries whether the card was checked, so two screens cannot disagree', () => {
    expect(estimateDrayage(CARD, [crate()]).confirmed).toBe(true);
    expect(estimateDrayage({ ...CARD, confirmedAt: null }, [crate()]).confirmed).toBe(false);
    expect(rateCardIsConfirmed(null)).toBe(false);
  });
});

describe('validating a card', () => {
  const draft = {
    advanceCwt: '142.00',
    showSiteCwt: '175.00',
    minimumLb: '200',
    basis: 'round_trip',
  };

  it('parses rates through the decimal parser rather than a float', () => {
    expect(validateRateCard(draft).advanceCwtCents).toBe(14_200);
    expect(validateRateCard({ ...draft, advanceCwt: '$142.35' }).advanceCwtCents).toBe(14_235);
  });

  it('refuses a card that prices nothing', () => {
    expect(() =>
      validateRateCard({ ...draft, advanceCwt: null, showSiteCwt: null }),
    ).toThrow(RateCardError);
  });

  it('refuses to guess the basis, because either guess is a 100% error', () => {
    expect(() => validateRateCard({ ...draft, basis: '' })).toThrow(RateCardError);
    expect(() => validateRateCard({ ...draft, basis: 'sometimes' })).toThrow(RateCardError);
  });

  it('catches a decimal point in the wrong place', () => {
    expect(() => validateRateCard({ ...draft, advanceCwt: '14200.00' })).toThrow(RateCardError);
  });

  it('keeps a blank surcharge blank, because silence is not zero', () => {
    expect(validateRateCard(draft).specialHandlingPct).toBeNull();
    expect(validateRateCard({ ...draft, specialHandlingPct: '30%' }).specialHandlingPct).toBe(30);
  });
});

describe('where it meets the cost rollup', () => {
  const costInputs = (over: Partial<CostInputs> = {}): CostInputs => ({
    show: {
      id: 'show-1',
      name: 'PACK EXPO 2027',
      startsOn: new Date('2027-03-15T00:00:00Z'),
      endsOn: new Date('2027-03-18T00:00:00Z'),
    },
    expenses: [],
    bookings: [],
    drayage: null,
    enteredFlights: [],
    lodgings: [],
    shipments: [],
    collateral: [],
    attendees: [],
    ...over,
  });

  it('never adds the estimate to the total', () => {
    // The whole point. `creditFundedCents` and `consumedCents` are outside the
    // total because they are real money in the wrong period; this is outside
    // because nobody has been billed it at all.
    const cost = rollUpShowCost(
      costInputs({
        expenses: [{ category: 'booth space', amountCents: 500_000, paid: true }],
        shipments: [{ costCents: 120_000, direction: 'outbound' }],
        drayage: estimateDrayage(CARD, [crate()]),
      }),
    );
    expect(cost.totalCents).toBe(620_000);
    expect(cost.drayage.estimate).toEqual({ ok: true, cents: 8 * 14_200 });
  });

  it('puts the gap on the shipping line, where somebody is reading', () => {
    const cost = rollUpShowCost(
      costInputs({
        shipments: [{ costCents: 120_000, direction: 'outbound' }],
        drayage: estimateDrayage(null, [crate()]),
      }),
    );
    const shipping = cost.lines.find((l) => l.category === 'shipping')!;
    expect(shipping.gaps.some((g) => g.what.includes('Drayage is not in this figure'))).toBe(true);
  });

  it('finds the real bill once it is filed, so the two can be compared', () => {
    const cost = rollUpShowCost(
      costInputs({
        expenses: [{ category: 'Drayage / material handling', amountCents: 390_000, paid: true }],
        shipments: [{ costCents: 120_000, direction: 'outbound' }],
        drayage: estimateDrayage(CARD, [crate()]),
      }),
    );
    expect(cost.drayage.billedCents).toBe(390_000);
    // And it is inside the total, because it is an invoice.
    expect(cost.totalCents).toBe(510_000);
  });
});

/**
 * The rule that keeps a parcel out of a freight figure.
 *
 * Getting this wrong is silent in the worst way. A `direct` row reaching
 * `estimateDrayage` has no rate, so it lands in the `no_rate` gap and the show
 * reports "1 crate consigned somewhere this card does not price" — which makes
 * a complete, correct drayage figure read as a floor, over a box that no
 * contractor will ever touch. The exclusion is at the store so the estimator
 * cannot be handed one; these assert the predicate the store filters on.
 */
describe('what the general contractor actually handles', () => {
  it('leaves a direct parcel out, and keeps every dock consignment in', () => {
    expect(isDrayable({ consignment: 'direct' } as never)).toBe(false);
    expect(isDrayable({ consignment: 'advance_warehouse' } as never)).toBe(true);
    expect(isDrayable({ consignment: 'show_site' } as never)).toBe(true);
    expect(isDrayable({ consignment: 'office' } as never)).toBe(true);
  });

  // The exemption is the dock, never the size of the box. Contractors bill small
  // packages delivered to show site, usually per piece, and an exemption keyed on
  // weight would delete that line while looking like a sensible simplification.
  it('does not exempt a small package that goes through a dock', () => {
    const parcelToTheDock: EstimableShipment = {
      id: 'p1',
      description: 'One carton of datasheets, 12 lb',
      direction: 'outbound',
      consignment: 'show_site',
      weightLb: 12,
      handling: 'crated',
    };
    const e = estimateDrayage(CARD, [parcelToTheDock]);
    expect(e.total.ok).toBe(true);
    // It takes the card's minimum, exactly as a 12 lb crate would.
    expect(e.perShipment[0].billableLb).toBe(billableWeight(12, CARD.minimumLb));
  });
});
