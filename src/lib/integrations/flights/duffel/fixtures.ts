import type { DuffelOffer, DuffelAirport, DuffelAirline, DuffelSegment } from './wire';

/**
 * Duffel response fixtures, built from the published v2 schema
 * (https://duffel.com/docs/api/v2/offers/schema).
 *
 * These are structural stand-ins for a real API response, used to develop the
 * normalizer before a test key exists. They are NOT a fake integration: nothing
 * in the app serves these to a user. When a Duffel test key lands, these get
 * replaced with recorded real responses and the normalizer tests should pass
 * unchanged — that is the point of writing them to the published shape.
 */

const airports: Record<string, DuffelAirport> = {
  SFO: { id: 'arp_sfo_us', iata_code: 'SFO', name: 'San Francisco International', iata_country_code: 'US', time_zone: 'America/Los_Angeles', city_name: 'San Francisco' },
  DTW: { id: 'arp_dtw_us', iata_code: 'DTW', name: 'Detroit Metropolitan Wayne County', iata_country_code: 'US', time_zone: 'America/Detroit', city_name: 'Detroit' },
  SLC: { id: 'arp_slc_us', iata_code: 'SLC', name: 'Salt Lake City International', iata_country_code: 'US', time_zone: 'America/Denver', city_name: 'Salt Lake City' },
  LHR: { id: 'arp_lhr_gb', iata_code: 'LHR', name: 'Heathrow', iata_country_code: 'GB', time_zone: 'Europe/London', city_name: 'London' },
};

const delta: DuffelAirline = { id: 'arl_00009VME7D6ivUu8dn35WK', name: 'Delta Air Lines', iata_code: 'DL' };
const skywest: DuffelAirline = { id: 'arl_00009VME7D6ivUu8dn35WM', name: 'SkyWest Airlines', iata_code: 'OO' };
const american: DuffelAirline = { id: 'arl_00009VME7D6ivUu8dn35WL', name: 'American Airlines', iata_code: 'AA' };

type SegmentOverrides = Omit<Partial<DuffelSegment>, 'origin' | 'destination'> & {
  origin: keyof typeof airports;
  destination: keyof typeof airports;
};

function segment(over: SegmentOverrides): DuffelSegment {
  const { origin, destination, ...rest } = over;
  return {
    id: 'seg_00009htYpSCXrwaB9Dn123',
    departing_at: '2026-03-29T08:15:00',
    arriving_at: '2026-03-29T16:05:00',
    duration: 'PT4H50M',
    origin: airports[origin],
    destination: airports[destination],
    origin_terminal: '2',
    destination_terminal: 'EM',
    marketing_carrier: delta,
    marketing_carrier_flight_number: '1422',
    operating_carrier: delta,
    operating_carrier_flight_number: '1422',
    aircraft: { id: 'arc_00009UhD4ongolulWd91Ky', iata_code: '321', name: 'Airbus A321' },
    passengers: [
      {
        passenger_id: 'pas_00009hj8USM7Ncg31cBCLL',
        cabin_class: 'economy',
        cabin_class_marketing_name: 'Main Cabin',
        fare_basis_code: 'VA21A0MQ',
        baggages: [{ type: 'carry_on', quantity: 1 }],
      },
    ],
    stops: [],
    ...rest,
  };
}

/** Nonstop, economy, non-refundable, instant payment required. The common case. */
export const nonstopOffer: DuffelOffer = {
  id: 'off_00009htYpSCXrwaB9DnUm0',
  created_at: '2026-03-01T11:58:03.000Z',
  updated_at: '2026-03-01T11:58:03.000Z',
  expires_at: '2026-03-01T12:28:03.000Z',
  live_mode: false,
  base_amount: '389.00',
  base_currency: 'USD',
  tax_amount: '41.55',
  tax_currency: 'USD',
  total_amount: '430.55',
  total_currency: 'USD',
  total_emissions_kg: '312',
  owner: delta,
  passengers: [{ id: 'pas_00009hj8USM7Ncg31cBCLL', type: 'adult' }],
  slices: [
    {
      id: 'sli_00009htYpSCXrwaB9Dn456',
      origin: airports.SFO,
      destination: airports.DTW,
      duration: 'PT4H50M',
      fare_brand_name: 'Main Cabin',
      segments: [segment({ origin: 'SFO', destination: 'DTW' })],
    },
  ],
  conditions: {
    change_before_departure: { allowed: true, penalty_amount: '200.00', penalty_currency: 'USD' },
    refund_before_departure: { allowed: false, penalty_amount: null, penalty_currency: null },
  },
  payment_requirements: {
    requires_instant_payment: true,
    payment_required_by: null,
    price_guarantee_expires_at: null,
  },
  available_airline_credit_ids: [],
};

/**
 * Connecting itinerary where the second leg is operated by a regional carrier
 * under the mainline flight number — the case that makes `operating_carrier`
 * matter, and a US display requirement.
 */
export const connectingOffer: DuffelOffer = {
  ...nonstopOffer,
  id: 'off_00009htYpSCXrwaB9DnCon',
  total_amount: '318.20',
  base_amount: '286.00',
  tax_amount: '32.20',
  slices: [
    {
      id: 'sli_00009htYpSCXrwaB9DnCon',
      origin: airports.SFO,
      destination: airports.DTW,
      duration: 'PT7H35M',
      fare_brand_name: 'Basic Economy',
      segments: [
        segment({
          id: 'seg_leg1',
          origin: 'SFO',
          destination: 'SLC',
          departing_at: '2026-03-29T06:00:00',
          arriving_at: '2026-03-29T09:10:00',
        }),
        segment({
          id: 'seg_leg2',
          origin: 'SLC',
          destination: 'DTW',
          departing_at: '2026-03-29T10:05:00',
          arriving_at: '2026-03-29T15:35:00',
          operating_carrier: skywest,
          operating_carrier_flight_number: '4471',
        }),
      ],
    },
  ],
};

/**
 * American Airlines offer that can be *held* without payment — the mechanism
 * that lets an approval queue outlive offer expiry. Also carries an airline
 * credit and a negotiated corporate fare.
 */
export const holdableOffer: DuffelOffer = {
  ...nonstopOffer,
  id: 'off_00009htYpSCXrwaB9DnHold',
  owner: american,
  total_amount: '612.00',
  base_amount: '558.00',
  tax_amount: '54.00',
  slices: [
    {
      id: 'sli_hold',
      origin: airports.SFO,
      destination: airports.DTW,
      duration: 'PT4H45M',
      segments: [
        segment({
          origin: 'SFO',
          destination: 'DTW',
          marketing_carrier: american,
          operating_carrier: american,
          marketing_carrier_flight_number: '2291',
          passengers: [
            {
              passenger_id: 'pas_00009hj8USM7Ncg31cBCLL',
              cabin_class: 'premium_economy',
              cabin_class_marketing_name: 'Premium Economy',
            },
          ],
        }),
      ],
    },
  ],
  conditions: {
    change_before_departure: { allowed: true, penalty_amount: '0.00', penalty_currency: 'USD' },
    refund_before_departure: { allowed: true, penalty_amount: '75.00', penalty_currency: 'USD' },
  },
  payment_requirements: {
    requires_instant_payment: false,
    payment_required_by: '2026-03-03T23:59:00Z',
    price_guarantee_expires_at: '2026-03-02T23:59:00Z',
  },
  available_airline_credit_ids: ['acr_00009htYpSCXrwaB9DnCr1'],
  private_fares: [{ type: 'corporate', corporate_code: 'NWR2026' }],
};

/** International, for the domestic/international policy split. */
export const internationalOffer: DuffelOffer = {
  ...nonstopOffer,
  id: 'off_00009htYpSCXrwaB9DnIntl',
  total_amount: '1284.90',
  base_amount: '1090.00',
  tax_amount: '194.90',
  slices: [
    {
      id: 'sli_intl',
      origin: airports.SFO,
      destination: airports.LHR,
      duration: 'PT10H40M',
      segments: [
        segment({
          origin: 'SFO',
          destination: 'LHR',
          departing_at: '2026-03-29T16:20:00',
          arriving_at: '2026-03-30T10:55:00',
          passengers: [
            {
              passenger_id: 'pas_00009hj8USM7Ncg31cBCLL',
              cabin_class: 'premium_economy',
              cabin_class_marketing_name: 'Premium Select',
            },
          ],
        }),
      ],
    },
  ],
};

export const allOffers = [nonstopOffer, connectingOffer, holdableOffer, internationalOffer];
