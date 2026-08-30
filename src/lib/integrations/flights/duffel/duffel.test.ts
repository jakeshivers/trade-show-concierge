import { describe, it, expect } from 'vitest';
import { normalizeOffer, normalizeOffers, holdCapability, NormalizationError } from './normalize';
import { DuffelProvider } from './client';
import { ProviderNotConfiguredError, DryRunError } from '../types';
import * as fx from './fixtures';
import { evaluate } from '@/lib/policy/evaluate';
import { rankOffers, selectBest } from '@/lib/policy/rank';
import { policy, constraints } from '@/lib/policy/fixtures';
import type { DuffelOffer } from './wire';

describe('normalizeOffer', () => {
  it('parses decimal-string money without float error', () => {
    // "430.55" must not become 43054.999...
    expect(normalizeOffer(fx.nonstopOffer).totalCents).toBe(43_055);
    expect(normalizeOffer(fx.internationalOffer).totalCents).toBe(128_490);
  });

  it('carries country codes through so trip scope can be derived', () => {
    const domestic = normalizeOffer(fx.nonstopOffer);
    expect(domestic.slices[0].segments[0].originCountry).toBe('US');
    expect(domestic.slices[0].segments[0].destinationCountry).toBe('US');

    const intl = normalizeOffer(fx.internationalOffer);
    expect(intl.slices[0].segments[0].destinationCountry).toBe('GB');
  });

  it('lifts cabin class from segment passengers, not the segment', () => {
    // Duffel puts cabin_class on segments[].passengers[], which is easy to miss.
    expect(normalizeOffer(fx.nonstopOffer).slices[0].segments[0].cabin).toBe('economy');
    expect(normalizeOffer(fx.holdableOffer).slices[0].segments[0].cabin).toBe('premium_economy');
  });

  it('keeps the operating carrier distinct from the marketing carrier', () => {
    // Regional operator under a mainline flight number; US display requirement.
    const leg2 = normalizeOffer(fx.connectingOffer).slices[0].segments[1];
    expect(leg2.airlineCode).toBe('DL');
    expect(leg2.operatingAirlineCode).toBe('OO');
    expect(leg2.operatingAirlineName).toBe('SkyWest Airlines');
  });

  it('models refundability as allowed-plus-penalty, not a boolean', () => {
    const nonRefundable = normalizeOffer(fx.nonstopOffer);
    expect(nonRefundable.refundable).toBe(false);
    expect(nonRefundable.changeable).toBe(true);
    expect(nonRefundable.changePenaltyCents).toBe(20_000);

    const refundable = normalizeOffer(fx.holdableOffer);
    expect(refundable.refundable).toBe(true);
    expect(refundable.refundPenaltyCents).toBe(7_500);
  });

  it('captures payment requirements and airline credits', () => {
    const held = normalizeOffer(fx.holdableOffer);
    expect(held.requiresInstantPayment).toBe(false);
    expect(held.priceGuaranteeExpiresAt).toEqual(new Date('2026-03-02T23:59:00Z'));
    expect(held.availableCreditIds).toEqual(['acr_00009htYpSCXrwaB9DnCr1']);
    expect(held.corporateFareCodes).toEqual(['NWR2026']);
  });

  it('assumes instant payment when payment_requirements is absent', () => {
    // Conservative: assuming a hold exists and being wrong loses the space.
    const raw: DuffelOffer = { ...fx.nonstopOffer, payment_requirements: undefined };
    expect(normalizeOffer(raw).requiresInstantPayment).toBe(true);
  });

  it('throws rather than emitting a malformed offer', () => {
    expect(() => normalizeOffer({ ...fx.nonstopOffer, slices: [] })).toThrow(NormalizationError);
    expect(() => normalizeOffer({ ...fx.nonstopOffer, expires_at: 'not-a-date' })).toThrow(
      NormalizationError,
    );
  });

  it('normalizes a batch', () => {
    expect(normalizeOffers(fx.allOffers)).toHaveLength(4);
  });
});

describe('holdCapability', () => {
  it('reports a holdable, price-guaranteed offer', () => {
    const cap = holdCapability(normalizeOffer(fx.holdableOffer));
    expect(cap.canHold).toBe(true);
    expect(cap.priceGuaranteed).toBe(true);
    expect(cap.payBy).toEqual(new Date('2026-03-03T23:59:00Z'));
  });

  it('reports an offer that must be paid immediately', () => {
    const cap = holdCapability(normalizeOffer(fx.nonstopOffer));
    expect(cap.canHold).toBe(false);
  });
});

describe('normalized offers flow into the policy engine', () => {
  // The point of the whole step: real wire shapes reach the decision layer
  // without the decision layer knowing Duffel exists.
  const now = new Date('2026-03-01T12:00:00Z');
  const moveInAt = new Date('2026-03-30T08:00:00Z');
  const ctxBase = {
    constraints: constraints({
      earliestDeparture: new Date('2026-03-29T00:00:00Z'),
      latestArrival: new Date('2026-03-30T00:00:00Z'),
    }),
    // $600 non-refundable allowance: a realistic corporate domestic setting.
    // The fixture default of $400 would flag every one of these fares.
    policy: policy({ nonRefundableAllowedUnderCents: 60_000 }),
    now,
    moveInAt,
  };

  it('auto-approves a cheap compliant nonstop', () => {
    const verdict = evaluate({ ...ctxBase, offer: normalizeOffer(fx.nonstopOffer) });
    expect(verdict.decision).toBe('auto_approve');
  });

  it('escalates the premium-economy domestic fare on cabin and price', () => {
    const verdict = evaluate({ ...ctxBase, offer: normalizeOffer(fx.holdableOffer) });
    expect(verdict.decision).toBe('needs_approval');
    const ids = verdict.blockers.map((b) => b.ruleId);
    expect(ids).toContain('cabin_ceiling');
    expect(ids).toContain('approval_band');
  });

  it('applies the international ceiling to the transatlantic offer', () => {
    const offer = normalizeOffer(fx.internationalOffer);
    const verdict = evaluate({
      ...ctxBase,
      offer,
      constraints: constraints({
        earliestDeparture: new Date('2026-03-29T00:00:00Z'),
        latestArrival: new Date('2026-03-31T00:00:00Z'),
      }),
      // The transatlantic red-eye lands 30 Mar 09:55Z, so a 30 Mar 08:00Z
      // move-in would be a legitimate deny on the arrival buffer.
      moveInAt: new Date('2026-03-31T08:00:00Z'),
    });
    // $1,284.90 is under the $1,800 international cap...
    expect(verdict.results.find((r) => r.ruleId === 'fare_ceiling')?.status).toBe('pass');
    // ...and premium economy is within the international cabin ceiling.
    expect(verdict.results.find((r) => r.ruleId === 'cabin_ceiling')?.status).toBe('pass');
    // But it is still above the auto-approve band.
    expect(verdict.decision).toBe('needs_approval');
  });

  it('ranks the compliant nonstop above the cheaper connection', () => {
    const offers = normalizeOffers([fx.connectingOffer, fx.nonstopOffer, fx.holdableOffer]);
    const ranked = rankOffers(offers, ctxBase);
    const best = selectBest(ranked);
    expect(best?.verdict.decision).toBe('auto_approve');
    // The connection is $112 cheaper but carries a stop penalty and a tight
    // connection; the nonstop wins on total score.
    expect(best?.offer.id).toBe(fx.nonstopOffer.id);
  });
});

describe('DuffelProvider without a key', () => {
  const provider = new DuffelProvider({ accessToken: undefined, liveBooking: false });

  it('reports itself unconfigured', () => {
    expect(provider.isConfigured()).toBe(false);
  });

  it('throws a useful error instead of returning fake offers', async () => {
    // SCOPE.md non-negotiable #2: never invent a fare.
    await expect(
      provider.search({
        constraints: constraints(),
        passengers: [{ givenName: 'Priya', familyName: 'Raghunathan' }],
      }),
    ).rejects.toThrow(ProviderNotConfiguredError);

    await expect(
      provider.search({ constraints: constraints(), passengers: [] }),
    ).rejects.toThrow('DUFFEL_ACCESS_TOKEN');
  });
});

describe('DuffelProvider dry-run guard', () => {
  it('refuses to purchase unless live booking is explicitly enabled', async () => {
    const provider = new DuffelProvider({ accessToken: 'test_key', liveBooking: false });
    await expect(
      provider.purchase({ amountCents: 43_055, currency: 'USD', idempotencyKey: 'req_1' }),
    ).rejects.toThrow(DryRunError);
  });

  it('still requires configuration before the dry-run check', async () => {
    const provider = new DuffelProvider({ accessToken: undefined, liveBooking: true });
    await expect(
      provider.purchase({ amountCents: 1, currency: 'USD', idempotencyKey: 'req_2' }),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });
});
