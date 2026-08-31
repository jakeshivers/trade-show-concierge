import type { StatusPhase, StatusQuery, StatusReport } from '../types';
import { StatusProviderError } from '../types';
import type { AeroAirport, AeroFlight } from './wire';

/**
 * AeroAPI payload → `StatusReport`. Pure, so the part that has to be right is
 * testable without a key, which is the split `duffel/normalize.ts` established.
 */

const PROVIDER = 'aeroapi';

function instant(iso: string | null | undefined, field: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new StatusProviderError(`AeroAPI sent an unparseable ${field}: "${iso}"`, PROVIDER);
  }
  return d;
}

function iata(a: AeroAirport | null | undefined): string | null {
  return a?.code_iata ?? null;
}

/**
 * The phase, from the flags and the timestamps rather than from `status`.
 *
 * `status` is a display string ("En Route / On Time") that AeroAPI is free to
 * reword; branching on it means a copy edit at the vendor changes what our board
 * says. The booleans and the actual-time fields are the machine-readable half,
 * so they are what this reads, in the order that resolves the ambiguities:
 * cancelled beats everything, a diversion is still a diversion after it lands,
 * and an `actual_in` is the only thing that means landed.
 */
export function phaseOf(f: AeroFlight): StatusPhase {
  if (f.cancelled) return 'cancelled';
  if (f.diverted) return 'diverted';
  if (f.actual_in) return 'landed';
  if (f.actual_out) return 'active';
  if (f.position_only) return 'unknown';
  if (f.scheduled_out) return 'scheduled';
  return 'unknown';
}

/**
 * Pick the leg that is ours out of the window the provider returned.
 *
 * A flight number repeats daily, so `GET /flights/AA318` is several flights.
 * Matching on the exact scheduled instant would be wrong in precisely the case
 * this feature exists for — a re-timed flight no longer departs when our row
 * says — so the match is the *nearest* scheduled departure within a day, and
 * anything further out is a different day's flight rather than a schedule
 * change. The route is checked too: a code-share filed under another carrier
 * that happens to fly the same number is not our leg.
 */
export function selectLeg(flights: AeroFlight[], query: StatusQuery): AeroFlight | null {
  const windowMs = 24 * 3_600_000;
  let best: { f: AeroFlight; distance: number } | null = null;

  for (const f of flights) {
    if (f.position_only) continue;
    // Origin filters; destination only breaks ties. A diverted flight's
    // destination is *not* the one on our ticket — that is what a diversion is —
    // so filtering on it would discard exactly the leg somebody needs to hear
    // about, and the board would show the last on-time reading forever.
    const origin = iata(f.origin);
    if (origin && origin !== query.originAirport) continue;

    const scheduled = instant(f.scheduled_out, 'scheduled_out');
    if (!scheduled) continue;
    const distance = Math.abs(scheduled.getTime() - query.scheduledDeparture.getTime());
    if (distance > windowMs) continue;

    const destination = iata(f.destination);
    const penalty = destination && destination !== query.destinationAirport ? windowMs : 0;
    const score = distance + penalty;
    if (!best || score < best.distance) best = { f, distance: score };
  }

  return best?.f ?? null;
}

export function normalizeFlight(f: AeroFlight, observedAt: Date): StatusReport {
  return {
    provider: PROVIDER,
    observedAt,
    phase: phaseOf(f),

    scheduledDeparture: instant(f.scheduled_out, 'scheduled_out'),
    scheduledArrival: instant(f.scheduled_in, 'scheduled_in'),
    // An actual time supersedes an estimate: once a flight is off the ground the
    // estimate is a stale prediction of something that already happened, and a
    // board showing "estimated 09:40" beside a plane that left at 10:12 is worse
    // than showing nothing.
    estimatedDeparture: instant(f.actual_out ?? f.estimated_out, 'estimated_out'),
    estimatedArrival: instant(f.actual_in ?? f.estimated_in, 'estimated_in'),
    actualDeparture: instant(f.actual_out, 'actual_out'),
    actualArrival: instant(f.actual_in, 'actual_in'),

    departureTerminal: f.terminal_origin ?? null,
    departureGate: f.gate_origin ?? null,
    arrivalTerminal: f.terminal_destination ?? null,
    arrivalGate: f.gate_destination ?? null,

    // AeroAPI reports a diversion as a flag; where it went arrives as a changed
    // destination on the record. Null rather than a guess when it did not.
    divertedToAirport: f.diverted ? iata(f.destination) : null,

    originTimeZone: f.origin?.timezone ?? null,
    destinationTimeZone: f.destination?.timezone ?? null,
  };
}
