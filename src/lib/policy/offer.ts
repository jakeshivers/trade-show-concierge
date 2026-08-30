import type { Offer, Segment, TripScope, Cabin } from './types';
import { CABIN_RANK } from './types';

/** Derived facts about an offer. Pure, so rules stay one-liners. */

export function allSegments(offer: Offer): Segment[] {
  return offer.slices.flatMap((s) => s.segments);
}

export function firstSegment(offer: Offer): Segment {
  const segments = allSegments(offer);
  if (segments.length === 0) throw new Error(`Offer ${offer.id} has no segments`);
  return segments[0];
}

export function outboundArrival(offer: Offer): Date {
  const outbound = offer.slices[0];
  if (!outbound || outbound.segments.length === 0) {
    throw new Error(`Offer ${offer.id} has no outbound slice`);
  }
  return outbound.segments[outbound.segments.length - 1].arrivesAt;
}

export function outboundDeparture(offer: Offer): Date {
  return firstSegment(offer).departsAt;
}

/**
 * Any segment crossing a border makes the whole trip international, which is the
 * conservative reading — it applies the higher fare ceiling and the stricter
 * cabin rule rather than the looser one.
 */
export function tripScope(offer: Offer): TripScope {
  const segments = allSegments(offer);
  const countries = new Set(
    segments.flatMap((s) => [s.originCountry, s.destinationCountry]),
  );
  return countries.size > 1 ? 'international' : 'domestic';
}

/** Stops within a slice; a round trip of two nonstops has zero stops, not one. */
export function maxStopsInAnySlice(offer: Offer): number {
  return Math.max(...offer.slices.map((s) => s.segments.length - 1), 0);
}

/** Connection durations in minutes, across every slice. */
export function connectionMinutes(offer: Offer): number[] {
  const gaps: number[] = [];
  for (const slice of offer.slices) {
    for (let i = 1; i < slice.segments.length; i++) {
      const prev = slice.segments[i - 1];
      const next = slice.segments[i];
      gaps.push((next.departsAt.getTime() - prev.arrivesAt.getTime()) / 60_000);
    }
  }
  return gaps;
}

/** Total time in the air, excluding connections. */
export function flightHours(offer: Offer): number {
  const ms = allSegments(offer).reduce(
    (total, s) => total + (s.arrivesAt.getTime() - s.departsAt.getTime()),
    0,
  );
  return ms / 3_600_000;
}

/** The longest single slice, gate to gate — what "long-haul" actually means. */
export function longestSliceHours(offer: Offer): number {
  const durations = offer.slices.map((slice) => {
    if (slice.segments.length === 0) return 0;
    const start = slice.segments[0].departsAt.getTime();
    const end = slice.segments[slice.segments.length - 1].arrivesAt.getTime();
    return (end - start) / 3_600_000;
  });
  return Math.max(...durations, 0);
}

/** The richest cabin anywhere in the itinerary — a ceiling must catch the worst case. */
export function highestCabin(offer: Offer): Cabin {
  return allSegments(offer).reduce<Cabin>(
    (best, s) => (CABIN_RANK[s.cabin] > CABIN_RANK[best] ? s.cabin : best),
    'economy',
  );
}

export function marketingAirlines(offer: Offer): string[] {
  return [...new Set(allSegments(offer).map((s) => s.airlineCode))];
}

export function isExpired(offer: Offer, now: Date): boolean {
  return offer.expiresAt !== null && offer.expiresAt.getTime() <= now.getTime();
}
