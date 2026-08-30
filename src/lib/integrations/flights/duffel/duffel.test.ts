import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeOffer, normalizeOffers, holdCapability, NormalizationError } from './normalize';
import { DuffelProvider } from './client';
import {
  ProviderNotConfiguredError,
  DryRunError,
  PriceMovedError,
  ProviderCeilingError,
} from '../types';
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
  const provider = new DuffelProvider({ accessToken: undefined, liveBooking: false, hardCeilingCents: null });

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
    const provider = new DuffelProvider({ accessToken: 'test_key', liveBooking: false, hardCeilingCents: null });
    await expect(
      provider.purchase({ amountCents: 43_055, currency: 'USD', idempotencyKey: 'req_1' }),
    ).rejects.toThrow(DryRunError);
  });

  it('still requires configuration before the dry-run check', async () => {
    const provider = new DuffelProvider({ accessToken: undefined, liveBooking: true, hardCeilingCents: null });
    await expect(
      provider.purchase({ amountCents: 1, currency: 'USD', idempotencyKey: 'req_2' }),
    ).rejects.toThrow(ProviderNotConfiguredError);
  });
});

/* --------------------------- live purchase, on the wire -------------------- */

/**
 * Step 5. Duffel is mocked at `fetch`, so these assert the exact shape of what
 * would go over the wire — the part a live test key would confirm and nothing
 * else can.
 */
describe('DuffelProvider.purchase', () => {
  const LIVE = { accessToken: 'test_key', liveBooking: true, hardCeilingCents: 200_000 };

  type Call = { url: string; init: RequestInit };

  /** Queue of JSON bodies, returned in order, with every request recorded. */
  function mockFetch(...bodies: unknown[]): Call[] {
    const calls: Call[] = [];
    let i = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    });
    return calls;
  }

  const offerBody = (amount = '430.55') => ({
    data: {
      ...fx.nonstopOffer,
      total_amount: amount,
      total_currency: 'USD',
      passengers: [{ id: 'pas_duffel_1' }],
    },
  });

  const orderBody = (over: Record<string, unknown> = {}) => ({
    data: {
      id: 'ord_0001',
      live_mode: true,
      booking_reference: 'RJ8KL2',
      total_amount: '430.55',
      total_currency: 'USD',
      created_at: '2026-03-01T10:00:00Z',
      documents: [{ type: 'electronic_ticket', unique_identifier: '0012345678901' }],
      ...over,
    },
  });

  const passenger = {
    id: '',
    givenName: 'Priya',
    familyName: 'Raghunathan',
    email: 'priya@northwindrobotics.test',
    phone: '+14155550103',
    bornOn: '1990-06-25',
    title: 'ms',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('creates an instant order carrying the offer’s own passenger ids', async () => {
    const calls = mockFetch(offerBody(), orderBody());
    const provider = new DuffelProvider(LIVE);

    const result = await provider.purchase({
      offerId: 'off_0000A',
      passengers: [passenger],
      amountCents: 43_055,
      currency: 'USD',
      idempotencyKey: 'req_live_1',
    });

    // The offer is re-read first: an offer is a quote, not a price.
    expect(calls[0].url).toContain('/air/offers/off_0000A');

    const body = JSON.parse(calls[1].init.body as string);
    expect(calls[1].url).toContain('/air/orders');
    expect(body.data.type).toBe('instant');
    expect(body.data.payments).toEqual([
      { type: 'balance', amount: '430.55', currency: 'USD' },
    ]);
    // Duffel mints passenger ids on the offer; an order must echo them back.
    expect(body.data.passengers[0].id).toBe('pas_duffel_1');
    expect(body.data.passengers[0].born_on).toBe('1990-06-25');
    // A retry has to hit Duffel's own dedupe, not just ours.
    expect((calls[1].init.headers as Record<string, string>)['Idempotency-Key']).toBe('req_live_1');

    expect(result).toMatchObject({
      orderId: 'ord_0001',
      bookingReference: 'RJ8KL2',
      ticketNumbers: ['0012345678901'],
      chargedCents: 43_055,
      liveMode: true,
    });
  });

  it('pays off a held order rather than ordering the seat twice', async () => {
    const calls = mockFetch(orderBody(), {}, orderBody());
    const provider = new DuffelProvider(LIVE);

    await provider.purchase({
      orderId: 'ord_0001',
      amountCents: 43_055,
      currency: 'USD',
      idempotencyKey: 'req_live_2',
    });

    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'POST', 'GET']);
    expect(calls[1].url).toContain('/air/payments');
    expect(JSON.parse(calls[1].init.body as string).data.order_id).toBe('ord_0001');
    // Ticket numbers appear on the order, so it is re-read after payment.
    expect(calls[2].url).toContain('/air/orders/ord_0001');
  });

  it('refuses when the fare moved between the verdict and the purchase', async () => {
    mockFetch(offerBody('455.00'));
    const provider = new DuffelProvider(LIVE);

    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        idempotencyKey: 'req_live_3',
      }),
    ).rejects.toThrow(PriceMovedError);
  });

  it('reports the provider’s own live_mode, not our intent', async () => {
    // A test key issues real-looking orders that are not spend.
    mockFetch(offerBody(), orderBody({ live_mode: false }));
    const provider = new DuffelProvider(LIVE);
    const result = await provider.purchase({
      offerId: 'off_0000A',
      passengers: [passenger],
      amountCents: 43_055,
      currency: 'USD',
      idempotencyKey: 'req_live_4',
    });
    expect(result.liveMode).toBe(false);
  });

  it('enforces a ceiling the application cannot raise', async () => {
    mockFetch(offerBody());
    const provider = new DuffelProvider({ ...LIVE, hardCeilingCents: 40_000 });
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        idempotencyKey: 'req_live_5',
      }),
    ).rejects.toThrow(ProviderCeilingError);
  });

  it('will not purchase live at all without a configured ceiling', async () => {
    mockFetch(offerBody());
    const provider = new DuffelProvider({ ...LIVE, hardCeilingCents: null });
    await expect(
      provider.purchase({ offerId: 'off_0000A', amountCents: 1, currency: 'USD', idempotencyKey: 'req_live_6' }),
    ).rejects.toThrow(/FLIGHT_BOOKING_MAX_CENTS/);
  });

  /* ---------------------------- airline credits ---------------------------- */

  const creditedOffer = (over: Record<string, unknown> = {}) => ({
    data: {
      ...offerBody().data,
      available_airline_credit_ids: ['acr_1'],
      available_airline_credits: [
        { id: 'acr_1', credit_amount: '184.00', credit_currency: 'USD' },
      ],
      ...over,
    },
  });

  it('pays the fare minus the credit, and reports what the credit covered', async () => {
    const calls = mockFetch(creditedOffer(), orderBody());
    const provider = new DuffelProvider(LIVE);

    const result = await provider.purchase({
      offerId: 'off_0000A',
      passengers: [passenger],
      amountCents: 43_055,
      currency: 'USD',
      creditIds: ['acr_1'],
      idempotencyKey: 'req_credit_1',
    });

    const body = JSON.parse(calls[1].init.body as string);
    expect(body.data.airline_credits).toEqual([{ id: 'acr_1' }]);
    // $430.55 fare less the $184 credit: the payment is what is left.
    expect(body.data.payments[0].amount).toBe('246.55');

    // The split is reported, not inferred — only the new money is spend.
    expect(result.creditAppliedCents).toBe(18_400);
    expect(result.chargedCents).toBe(24_655);
  });

  it('refuses when the offer names a credit but not its value', async () => {
    // Without the amount there is no correct payment figure to send, and a
    // guessed one fails at settlement. Refusing sends it to a human instead.
    mockFetch(creditedOffer({ available_airline_credits: [] }));
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        creditIds: ['acr_1'],
        idempotencyKey: 'req_credit_2',
      }),
    ).rejects.toThrow(/carries no credit values/);
  });

  it('refuses a credit the offer no longer carries', async () => {
    mockFetch(creditedOffer());
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        creditIds: ['acr_stale'],
        idempotencyKey: 'req_credit_3',
      }),
    ).rejects.toThrow(/not available on offer/);
  });

  it('refuses a credit held in another currency', async () => {
    mockFetch(
      creditedOffer({
        available_airline_credits: [
          { id: 'acr_1', credit_amount: '184.00', credit_currency: 'EUR' },
        ],
      }),
    );
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        creditIds: ['acr_1'],
        idempotencyKey: 'req_credit_4',
      }),
    ).rejects.toThrow(/Airlines do not convert credits/);
  });

  it('will not attach a credit to an order that already exists', async () => {
    // A credit is applied when an order is created. A held order was created
    // before anyone approved it, so the credit has nowhere to go — and silently
    // dropping it is the exact loss the ledger exists to prevent.
    mockFetch(orderBody());
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        orderId: 'ord_0001',
        amountCents: 43_055,
        currency: 'USD',
        creditIds: ['acr_1'],
        idempotencyKey: 'req_credit_5',
      }),
    ).rejects.toThrow(/applied when the order is created/);
  });

  it('will not send a negative payment when credits exceed the fare', async () => {
    mockFetch(
      creditedOffer({
        available_airline_credits: [
          { id: 'acr_1', credit_amount: '900.00', credit_currency: 'USD' },
        ],
      }),
    );
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [passenger],
        amountCents: 43_055,
        currency: 'USD',
        creditIds: ['acr_1'],
        idempotencyKey: 'req_credit_6',
      }),
    ).rejects.toThrow(/does not give change/);
  });

  it('refuses to guess who is flying', async () => {
    mockFetch(offerBody());
    const provider = new DuffelProvider(LIVE);
    await expect(
      provider.purchase({
        offerId: 'off_0000A',
        passengers: [],
        amountCents: 43_055,
        currency: 'USD',
        idempotencyKey: 'req_live_8',
      }),
    ).rejects.toThrow(/Refusing to guess who is flying/);
  });
});
