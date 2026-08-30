/**
 * Duffel API v2 wire types — the subset we consume.
 *
 * Deliberately a faithful mirror of Duffel's shapes, including the parts that
 * surprised us: amounts are decimal *strings*, cabin class lives per
 * segment-per-passenger rather than on the segment, and refundability is a
 * nullable object with a penalty rather than a boolean.
 *
 * Nothing outside `normalize.ts` should import from this file. The rest of the
 * app sees only the provider-agnostic `Offer`.
 *
 * Source: https://duffel.com/docs/api/v2/offers/schema
 */

export type DuffelAirport = {
  id: string;
  iata_code: string;
  icao_code?: string | null;
  name: string;
  time_zone?: string;
  /** ISO country of the airport — how we determine domestic vs international. */
  iata_country_code: string;
  iata_city_code?: string;
  city_name?: string;
};

export type DuffelAirline = {
  id: string;
  name: string;
  iata_code: string | null;
};

export type DuffelSegmentPassenger = {
  passenger_id: string;
  /** economy | premium_economy | business | first */
  cabin_class: string;
  cabin_class_marketing_name?: string;
  fare_basis_code?: string | null;
  baggages?: { type: string; quantity: number }[];
};

export type DuffelSegment = {
  id: string;
  departing_at: string;
  arriving_at: string;
  duration?: string | null;
  origin: DuffelAirport;
  destination: DuffelAirport;
  origin_terminal?: string | null;
  destination_terminal?: string | null;
  marketing_carrier: DuffelAirline;
  marketing_carrier_flight_number: string;
  /**
   * US regulation requires the operating carrier be shown prominently, so we
   * carry it through rather than collapsing to the marketing carrier.
   */
  operating_carrier: DuffelAirline;
  operating_carrier_flight_number?: string | null;
  aircraft?: { id: string; iata_code: string; name: string } | null;
  passengers: DuffelSegmentPassenger[];
  stops?: unknown[];
};

export type DuffelSlice = {
  id: string;
  origin: DuffelAirport;
  destination: DuffelAirport;
  duration?: string | null;
  fare_brand_name?: string | null;
  segments: DuffelSegment[];
};

export type DuffelCondition = {
  allowed: boolean;
  penalty_amount: string | null;
  penalty_currency: string | null;
} | null;

export type DuffelConditions = {
  change_before_departure?: DuffelCondition;
  refund_before_departure?: DuffelCondition;
};

export type DuffelPaymentRequirements = {
  /**
   * When false, the offer can be held without payment — which is how an
   * approval queue survives offer expiry. See SCOPE.md §6b.
   */
  requires_instant_payment: boolean;
  payment_required_by: string | null;
  price_guarantee_expires_at: string | null;
};

export type DuffelOffer = {
  id: string;
  created_at: string;
  updated_at?: string;
  expires_at: string;
  live_mode: boolean;
  partial?: boolean;

  base_amount: string;
  base_currency: string;
  tax_amount: string | null;
  tax_currency: string | null;
  /** Decimal string, e.g. "8618.36". Never a number. */
  total_amount: string;
  total_currency: string;
  total_emissions_kg?: string | null;

  owner: DuffelAirline;
  slices: DuffelSlice[];
  passengers: { id: string; type?: string; given_name?: string; family_name?: string }[];
  conditions?: DuffelConditions;
  payment_requirements?: DuffelPaymentRequirements;

  /** Airline credits Duffel can apply to this offer. Directly serves SCOPE.md §5b. */
  available_airline_credit_ids?: string[];

  private_fares?: { type: string; corporate_code?: string | null }[];
};

export type DuffelOfferRequestResponse = {
  data: {
    id: string;
    created_at: string;
    live_mode: boolean;
    offers: DuffelOffer[];
  };
};

/** A single offer re-fetched immediately before purchase, to re-check the price. */
export type DuffelOfferResponse = { data: DuffelOffer };

/**
 * An order — what an offer becomes once it is bought or held.
 *
 * `documents` is where ticket numbers live, and it is populated asynchronously
 * after payment, so a purchase re-reads the order rather than trusting the
 * response to the payment call.
 */
export type DuffelOrder = {
  id: string;
  live_mode: boolean;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  created_at: string;
  documents?: { type: string; unique_identifier: string }[] | null;
  payment_status?: {
    awaiting_payment: boolean;
    payment_required_by: string | null;
    price_guarantee_expires_at: string | null;
  };
  passengers?: { id: string; given_name?: string; family_name?: string }[];
};

export type DuffelOrderResponse = { data: DuffelOrder };

export type DuffelListResponse<T> = {
  data: T[];
  meta?: { limit: number; before: string | null; after: string | null };
};

export type DuffelErrorResponse = {
  errors: {
    type: string;
    title: string;
    message: string;
    code: string;
    documentation_url?: string;
  }[];
  meta?: { request_id: string; status: number };
};
