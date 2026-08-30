import type { Offer, Segment, Slice, Cabin } from '@/lib/policy/types';
import { CABIN_RANK } from '@/lib/policy/types';
import { decimalStringToCents, optionalDecimalToCents } from '@/lib/money/decimal';
import { zonedToInstant, ZonedTimeError } from '@/lib/datetime/zoned';
import type { DuffelOffer, DuffelSegment, DuffelSlice, DuffelCondition } from './wire';

/**
 * Duffel wire -> provider-agnostic `Offer`.
 *
 * This is the only place in the app that knows Duffel exists. Policy, ranking,
 * and every UI see the normalized shape, so adding Amadeus later is a second
 * normalizer and nothing else.
 */

export class NormalizationError extends Error {
  constructor(message: string, readonly offerId?: string) {
    super(offerId ? `${message} (offer ${offerId})` : message);
    this.name = 'NormalizationError';
  }
}

const KNOWN_CABINS: Cabin[] = ['economy', 'premium_economy', 'business', 'first'];

/**
 * Duffel sends cabin per segment *per passenger*. For policy we need one value
 * per segment, and the ceiling must catch the worst case — so take the richest
 * cabin any passenger holds on that segment.
 */
function segmentCabin(segment: DuffelSegment): Cabin {
  if (segment.passengers.length === 0) {
    throw new NormalizationError(`Segment ${segment.id} has no passenger cabin data`);
  }
  return segment.passengers.reduce<Cabin>((best, p) => {
    const cabin = KNOWN_CABINS.includes(p.cabin_class as Cabin)
      ? (p.cabin_class as Cabin)
      : 'economy';
    return CABIN_RANK[cabin] > CABIN_RANK[best] ? cabin : best;
  }, 'economy');
}

function toDate(iso: string, field: string, offerId?: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new NormalizationError(`Invalid date in ${field}: "${iso}"`, offerId);
  }
  return d;
}

/**
 * Segment times are local to the airport and carry no offset, so they are
 * meaningless without the airport's zone. Getting this wrong makes a 4h50m
 * transcontinental flight measure 7h50m, which quietly trips every
 * duration-based policy rule.
 */
function toAirportInstant(
  naive: string,
  timeZone: string | undefined,
  field: string,
  offerId: string,
): Date {
  if (!timeZone) {
    throw new NormalizationError(
      `Cannot interpret ${field} "${naive}": airport has no time_zone`,
      offerId,
    );
  }
  try {
    return zonedToInstant(naive, timeZone);
  } catch (err) {
    if (err instanceof ZonedTimeError) {
      throw new NormalizationError(`${err.message} in ${field}`, offerId);
    }
    throw err;
  }
}

function normalizeSegment(segment: DuffelSegment, offerId: string): Segment {
  const marketing = segment.marketing_carrier.iata_code;
  if (!marketing) {
    throw new NormalizationError(`Segment ${segment.id} has no marketing carrier IATA code`, offerId);
  }
  return {
    airlineCode: marketing,
    airlineName: segment.marketing_carrier.name,
    operatingAirlineCode: segment.operating_carrier.iata_code ?? undefined,
    operatingAirlineName: segment.operating_carrier.name,
    flightNumber: segment.marketing_carrier_flight_number,
    originAirport: segment.origin.iata_code,
    originCountry: segment.origin.iata_country_code,
    destinationAirport: segment.destination.iata_code,
    destinationCountry: segment.destination.iata_country_code,
    departsAt: toAirportInstant(
      segment.departing_at,
      segment.origin.time_zone,
      'departing_at',
      offerId,
    ),
    arrivesAt: toAirportInstant(
      segment.arriving_at,
      segment.destination.time_zone,
      'arriving_at',
      offerId,
    ),
    cabin: segmentCabin(segment),
  };
}

function normalizeSlice(slice: DuffelSlice, offerId: string): Slice {
  if (slice.segments.length === 0) {
    throw new NormalizationError(`Slice ${slice.id} has no segments`, offerId);
  }
  return { segments: slice.segments.map((s) => normalizeSegment(s, offerId)) };
}

/** `allowed` absent is not the same as `allowed: false` — unknown stays unknown. */
function condition(c: DuffelCondition | undefined): {
  allowed: boolean;
  penaltyCents: number | null;
} {
  if (!c) return { allowed: false, penaltyCents: null };
  return { allowed: c.allowed, penaltyCents: optionalDecimalToCents(c.penalty_amount) };
}

export function normalizeOffer(raw: DuffelOffer): Offer {
  if (raw.slices.length === 0) {
    throw new NormalizationError('Offer has no slices', raw.id);
  }

  const refund = condition(raw.conditions?.refund_before_departure);
  const change = condition(raw.conditions?.change_before_departure);
  const payment = raw.payment_requirements;

  return {
    id: raw.id,
    provider: 'duffel',
    // Decimal string, never a float. See lib/money/decimal.ts.
    totalCents: decimalStringToCents(raw.total_amount),
    currency: raw.total_currency,
    slices: raw.slices.map((s) => normalizeSlice(s, raw.id)),

    refundable: refund.allowed,
    refundPenaltyCents: refund.penaltyCents,
    changeable: change.allowed,
    changePenaltyCents: change.penaltyCents,

    expiresAt: toDate(raw.expires_at, 'expires_at', raw.id),

    // Absent payment_requirements is treated as instant payment required: the
    // conservative reading, since assuming a hold is available and being wrong
    // means losing the space.
    requiresInstantPayment: payment?.requires_instant_payment ?? true,
    paymentRequiredBy: payment?.payment_required_by
      ? toDate(payment.payment_required_by, 'payment_required_by', raw.id)
      : null,
    priceGuaranteeExpiresAt: payment?.price_guarantee_expires_at
      ? toDate(payment.price_guarantee_expires_at, 'price_guarantee_expires_at', raw.id)
      : null,

    availableCreditIds: raw.available_airline_credit_ids ?? [],
    corporateFareCodes:
      raw.private_fares
        ?.map((f) => f.corporate_code)
        .filter((c): c is string => typeof c === 'string' && c.length > 0) ?? [],
  };
}

export function normalizeOffers(raws: DuffelOffer[]): Offer[] {
  return raws.map(normalizeOffer);
}

/**
 * Can this offer be held while an approver decides?
 *
 * Only some carriers support it, and a hold without a price guarantee reserves
 * the space but not the fare — so the caller must know which it got.
 */
export function holdCapability(offer: Offer): {
  canHold: boolean;
  priceGuaranteed: boolean;
  payBy: Date | null;
} {
  return {
    canHold: !offer.requiresInstantPayment,
    priceGuaranteed: offer.priceGuaranteeExpiresAt !== null,
    payBy: offer.paymentRequiredBy,
  };
}
