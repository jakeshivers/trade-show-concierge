/**
 * Flight status provider interface.
 *
 * The same posture as `integrations/flights/types.ts`, for the same reason: with
 * no API key the app still runs, says "flight status is not configured", and
 * never invents a delay. SCOPE.md non-negotiable #2.
 *
 * What this interface deliberately does **not** do is decide anything. It
 * reports what a carrier says about one flight at one moment. Whether that is a
 * delay, a schedule change, or a disruption worth waking somebody up for is
 * `src/lib/flights/status.ts`'s job, and it is pure — the provider is the least
 * trustworthy thing in the loop and the least testable, so nothing that has to
 * be right may live inside it.
 */

/** Enough to identify one flight leg to a carrier's data. */
export type StatusQuery = {
  airlineCode: string;
  flightNumber: string;
  originAirport: string;
  destinationAirport: string;
  /**
   * The scheduled departure *we* hold. A flight number repeats daily and
   * providers return a window of them, so this is how the right one is picked —
   * and, when the provider's own scheduled time no longer matches it, how a
   * schedule change is detected at all.
   */
  scheduledDeparture: Date;
  /**
   * The scheduled arrival we hold. No live provider needs it to find a flight —
   * it is here because a *replay* does: a recorded payload describes a shape
   * (departed on time, landed forty minutes late) and has to be projected onto
   * the leg being asked about, and a canned block time would report a
   * transcontinental delay on a shuttle. Optional, because a provider that has
   * no use for it should not have to be given one.
   */
  scheduledArrival?: Date;
};

export type StatusPhase =
  | 'scheduled'
  | 'active'
  | 'landed'
  | 'cancelled'
  | 'diverted'
  /** The provider has a record and cannot say. Not the same as no record. */
  | 'unknown';

/**
 * One observation. Every time field is an instant; the provider's *scheduled*
 * times are reported separately from ours and never merged here — merging is a
 * decision, and decisions happen upstream in `status.ts`.
 */
export type StatusReport = {
  provider: string;
  observedAt: Date;
  phase: StatusPhase;

  /** What the carrier currently calls the schedule. */
  scheduledDeparture: Date | null;
  scheduledArrival: Date | null;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  actualDeparture: Date | null;
  actualArrival: Date | null;

  departureTerminal: string | null;
  departureGate: string | null;
  arrivalTerminal: string | null;
  arrivalGate: string | null;

  /** IATA code, when the carrier says the flight went somewhere else. */
  divertedToAirport: string | null;

  /** IANA zones, when the provider carries them. Null is "we do not know". */
  originTimeZone: string | null;
  destinationTimeZone: string | null;
};

/**
 * The provider has no record of this flight.
 *
 * Distinct from `phase: 'unknown'`, which means the provider knows the flight
 * and cannot currently say where it is. "No record" is usually our data being
 * wrong — a mistyped flight number, a code-share the tracker files under the
 * operating carrier — and that is a different thing to tell somebody than "we
 * are not sure whether your flight is late".
 */
export type NoRecord = { noRecord: true; provider: string; observedAt: Date; reason: string };

export type StatusLookup = StatusReport | NoRecord;

export function isNoRecord(r: StatusLookup): r is NoRecord {
  return 'noRecord' in r;
}

export class StatusProviderNotConfiguredError extends Error {
  constructor(readonly provider: string, readonly missingEnv: string[]) {
    super(
      `${provider} is not configured. Set ${missingEnv.join(', ')}. ` +
        'Until then flights are tracked from what was booked, and no row will ever ' +
        'claim to be on time on the strength of nobody having checked.',
    );
    this.name = 'StatusProviderNotConfiguredError';
  }
}

export class StatusProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'StatusProviderError';
  }
}

export interface FlightStatusProvider {
  readonly name: string;
  isConfigured(): boolean;
  lookup(query: StatusQuery): Promise<StatusLookup>;
}
