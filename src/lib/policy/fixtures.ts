import type { Offer, TravelPolicy, TravelConstraints, Segment, Cabin } from './types';

/** Test fixtures. Builders, not constants, so each test states only what it cares about. */

export const NOW = new Date('2026-03-01T12:00:00Z');
const h = (hours: number) => hours * 3_600_000;
const d = (days: number) => days * 86_400_000;

export const MOVE_IN = new Date(NOW.getTime() + d(30));

export function segment(over: Partial<Segment> = {}): Segment {
  return {
    airlineCode: 'DL',
    flightNumber: '1422',
    originAirport: 'SFO',
    originCountry: 'US',
    destinationAirport: 'DTW',
    destinationCountry: 'US',
    departsAt: new Date(NOW.getTime() + d(28)),
    arrivesAt: new Date(NOW.getTime() + d(28) + h(4.5)),
    cabin: 'economy' as Cabin,
    ...over,
  };
}

export function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 'off_test',
    provider: 'duffel',
    // Under the $400 non-refundable limit, so the baseline is genuinely compliant.
    totalCents: 38_000,
    currency: 'USD',
    slices: [{ segments: [segment()] }],
    refundable: false,
    refundPenaltyCents: null,
    changeable: true,
    changePenaltyCents: 20_000,
    expiresAt: new Date(NOW.getTime() + h(0.25)),
    requiresInstantPayment: true,
    paymentRequiredBy: null,
    priceGuaranteeExpiresAt: null,
    availableCreditIds: [],
    corporateFareCodes: [],
    ...over,
  };
}

/** A two-leg connecting itinerary, for stop and connection-time rules. */
export function connectingOffer(connectionMinutes = 75, over: Partial<Offer> = {}): Offer {
  const leg1Departs = new Date(NOW.getTime() + d(28));
  const leg1Arrives = new Date(leg1Departs.getTime() + h(2));
  const leg2Departs = new Date(leg1Arrives.getTime() + connectionMinutes * 60_000);
  return offer({
    slices: [
      {
        segments: [
          segment({ destinationAirport: 'SLC', departsAt: leg1Departs, arrivesAt: leg1Arrives }),
          segment({
            originAirport: 'SLC',
            departsAt: leg2Departs,
            arrivesAt: new Date(leg2Departs.getTime() + h(3)),
          }),
        ],
      },
    ],
    ...over,
  });
}

export function policy(over: Partial<TravelPolicy> = {}): TravelPolicy {
  return {
    id: 'pol_test',
    version: 3,
    scope: 'org',
    maxAirfareDomesticCents: 65_000,
    maxAirfareInternationalCents: 180_000,
    // The deny ceiling must sit above both fare caps or those fares are
    // unbookable — see validatePolicy().
    bands: { autoApproveUnderCents: 50_000, denyOverCents: 250_000 },
    maxCabinDomestic: 'economy',
    maxCabinInternational: 'premium_economy',
    premiumCabinAllowedOverHours: 6,
    minAdvanceBookingDays: 14,
    maxStops: 1,
    minConnectionMinutes: 60,
    arrivalBufferHoursBeforeMoveIn: 4,
    nonRefundableAllowedUnderCents: 40_000,
    maxAcceptableRefundPenaltyCents: null,
    preferredAirlines: [],
    blockedAirlines: [],
    // Null, like a real org that has never priced it: the personal carrier
    // preference is a tie-break until somebody says what it is worth.
    personalCarrierAllowanceCents: null,
    maxHotelNightlyRateCents: 30_000,
    perShowTravelBudgetCents: null,
    requireCreditFirst: false,
    ...over,
  };
}

export function constraints(over: Partial<TravelConstraints> = {}): TravelConstraints {
  return {
    originAirport: 'SFO',
    destinationAirport: 'DTW',
    earliestDeparture: new Date(NOW.getTime() + d(27)),
    latestArrival: new Date(NOW.getTime() + d(29)),
    ...over,
  };
}
