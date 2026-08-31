import type { AeroFlight } from '../aeroapi/wire';

/**
 * Recorded AeroAPI-shaped payloads, one per thing that can happen to a flight.
 *
 * Times are **offsets in minutes from the scheduled departure on the query**
 * rather than fixed instants, for the reason `duffel/recorded` shifts its dates:
 * a canned instant is in the past by the time anybody runs this, and a board
 * full of last spring's flights demonstrates nothing. The offsets are the part
 * that was recorded; the clock is the caller's.
 *
 * Every scenario here exists because `src/lib/flights/status.ts` has a branch
 * that nothing else would exercise. In particular `schedule_change` and
 * `delayed_into_buffer` look identical on a naive board — both land later than
 * planned — and are completely different events.
 */

export type Scenario =
  | 'on_time'
  | 'minor_delay'
  | 'delayed_into_buffer'
  | 'schedule_change'
  | 'cancelled'
  | 'diverted'
  | 'landed'
  | 'no_record';

/** Minutes, from the scheduled departure this leg was ticketed against. */
export type RecordedLeg = {
  scenario: Scenario;
  /** What the carrier calls the schedule. Non-zero means a re-timing. */
  scheduledOutOffset: number;
  blockMinutes: number;
  estimatedOutOffset: number | null;
  estimatedInOffset: number | null;
  actualOutOffset: number | null;
  actualInOffset: number | null;
  cancelled: boolean;
  diverted: boolean;
  divertTo?: string;
  positionOnly?: boolean;
  gateOrigin: string | null;
  terminalOrigin: string | null;
};

const BLOCK = 260;

export const LEGS: Record<Exclude<Scenario, 'no_record'>, RecordedLeg> = {
  on_time: {
    scenario: 'on_time',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: 0,
    estimatedInOffset: 0,
    actualOutOffset: null,
    actualInOffset: null,
    cancelled: false,
    diverted: false,
    gateOrigin: 'B12',
    terminalOrigin: '1',
  },
  // Twenty-five minutes late and nobody needs to know. This scenario is here to
  // prove the engine stays quiet, which is the harder half of an alert feature.
  minor_delay: {
    scenario: 'minor_delay',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: 25,
    estimatedInOffset: 25,
    actualOutOffset: null,
    actualInOffset: null,
    cancelled: false,
    diverted: false,
    gateOrigin: 'A4',
    terminalOrigin: '2',
  },
  // Three and a half hours, which is not a bigger version of the last one: it is
  // the arrival buffer the policy engine required at purchase, spent.
  delayed_into_buffer: {
    scenario: 'delayed_into_buffer',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: 215,
    estimatedInOffset: 215,
    actualOutOffset: null,
    actualInOffset: null,
    cancelled: false,
    diverted: false,
    gateOrigin: 'C31',
    terminalOrigin: '3',
  },
  // The airline moved the flight itself. Same arrival time as a two-hour delay
  // and a different thing entirely — this one is the plan changing under a
  // ticket somebody approved, weeks out, with nothing wrong on the day.
  schedule_change: {
    scenario: 'schedule_change',
    scheduledOutOffset: 125,
    blockMinutes: BLOCK,
    estimatedOutOffset: 125,
    estimatedInOffset: 125,
    actualOutOffset: null,
    actualInOffset: null,
    cancelled: false,
    diverted: false,
    gateOrigin: null,
    terminalOrigin: null,
  },
  cancelled: {
    scenario: 'cancelled',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: null,
    estimatedInOffset: null,
    actualOutOffset: null,
    actualInOffset: null,
    cancelled: true,
    diverted: false,
    gateOrigin: null,
    terminalOrigin: null,
  },
  diverted: {
    scenario: 'diverted',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: 5,
    estimatedInOffset: 70,
    actualOutOffset: 5,
    actualInOffset: null,
    cancelled: false,
    diverted: true,
    divertTo: 'ORD',
    gateOrigin: 'B12',
    terminalOrigin: '1',
  },
  landed: {
    scenario: 'landed',
    scheduledOutOffset: 0,
    blockMinutes: BLOCK,
    estimatedOutOffset: 8,
    estimatedInOffset: -6,
    actualOutOffset: 8,
    actualInOffset: -6,
    cancelled: false,
    diverted: false,
    gateOrigin: 'B12',
    terminalOrigin: '1',
  },
};

/** Zones for the airports the seed uses. Unknown stays unknown. */
export const AIRPORT_ZONES: Record<string, string> = {
  SFO: 'America/Los_Angeles',
  LAX: 'America/Los_Angeles',
  SEA: 'America/Los_Angeles',
  DTW: 'America/Detroit',
  ORD: 'America/Chicago',
  DFW: 'America/Chicago',
  JFK: 'America/New_York',
  EWR: 'America/New_York',
  BOS: 'America/New_York',
  LAS: 'America/Los_Angeles',
  SAN: 'America/Los_Angeles',
  MCO: 'America/New_York',
  ATL: 'America/New_York',
};

const iso = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000).toISOString();

/** Build the AeroAPI payload this scenario would have produced for this leg. */
export function buildAeroFlight(
  leg: RecordedLeg,
  q: {
    airlineCode: string;
    flightNumber: string;
    originAirport: string;
    destinationAirport: string;
    scheduledDeparture: Date;
    scheduledArrival?: Date;
  },
): AeroFlight {
  const base = q.scheduledDeparture;
  // The leg's own block time when we know it. `blockMinutes` on the fixture is
  // the fallback for a caller that did not say, and a fixed one would turn every
  // delay into a wrong arrival time by however much the routes differ.
  const block = q.scheduledArrival
    ? Math.round((q.scheduledArrival.getTime() - base.getTime()) / 60_000)
    : leg.blockMinutes;
  const arrivalOf = (outOffset: number) => outOffset + block;
  const destination = leg.diverted && leg.divertTo ? leg.divertTo : q.destinationAirport;

  return {
    ident: `${q.airlineCode}${q.flightNumber}`,
    ident_iata: `${q.airlineCode}${q.flightNumber}`,
    operator_iata: q.airlineCode,
    flight_number: q.flightNumber,
    origin: {
      code_iata: q.originAirport,
      timezone: AIRPORT_ZONES[q.originAirport],
    },
    destination: {
      code_iata: destination,
      timezone: AIRPORT_ZONES[destination],
    },
    scheduled_out: iso(base, leg.scheduledOutOffset),
    scheduled_in: iso(base, arrivalOf(leg.scheduledOutOffset)),
    estimated_out: leg.estimatedOutOffset == null ? null : iso(base, leg.estimatedOutOffset),
    estimated_in:
      leg.estimatedInOffset == null ? null : iso(base, arrivalOf(leg.estimatedInOffset)),
    actual_out: leg.actualOutOffset == null ? null : iso(base, leg.actualOutOffset),
    actual_in: leg.actualInOffset == null ? null : iso(base, arrivalOf(leg.actualInOffset)),
    cancelled: leg.cancelled,
    diverted: leg.diverted,
    position_only: leg.positionOnly ?? false,
    gate_origin: leg.gateOrigin,
    terminal_origin: leg.terminalOrigin,
    gate_destination: null,
    terminal_destination: null,
  };
}
