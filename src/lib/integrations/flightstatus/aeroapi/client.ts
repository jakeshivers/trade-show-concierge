import type { FlightStatusProvider, StatusLookup, StatusQuery } from '../types';
import { StatusProviderError, StatusProviderNotConfiguredError } from '../types';
import type { AeroFlightsResponse } from './wire';
import { normalizeFlight, selectLeg } from './normalize';

/**
 * FlightAware AeroAPI v4 — the real status provider.
 *
 * **Verified against nothing yet.** Same position the Duffel adapter was in
 * before step 12.5, and recorded here in the same words so nobody reads the
 * absence of a warning as evidence: the wire types are written from the
 * published v4 schema, the tests run against fixtures we wrote ourselves, and a
 * closed loop like that proves internal consistency and cannot catch a wrong
 * field name. `AEROAPI_KEY` is the arbiter when someone has one.
 *
 * What the adapter does guarantee is the shape of its failures. A missing key is
 * an error naming the variable; an unparseable timestamp is an error naming the
 * field; a flight the provider has never heard of is `NoRecord` rather than a
 * blank report. Nothing here can produce a row that says "on time".
 */

const BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';

export type AeroApiConfig = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export function aeroApiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AeroApiConfig {
  return { apiKey: env.AEROAPI_KEY, baseUrl: env.AEROAPI_BASE_URL };
}

/**
 * AeroAPI identifies flights by ICAO-ish idents but accepts the IATA form.
 * Leading zeros in a flight number are ours to strip: `AA0318` and `AA318` are
 * the same flight, and only one of them returns anything.
 */
export function identFor(query: StatusQuery): string {
  const number = query.flightNumber.replace(/^0+/, '') || query.flightNumber;
  return `${query.airlineCode.toUpperCase()}${number}`;
}

export class AeroApiStatusProvider implements FlightStatusProvider {
  readonly name = 'aeroapi';

  constructor(private readonly config: AeroApiConfig = aeroApiConfigFromEnv()) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async lookup(query: StatusQuery): Promise<StatusLookup> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new StatusProviderNotConfiguredError('AeroAPI', ['AEROAPI_KEY']);

    const observedAt = new Date();
    const doFetch = this.config.fetch ?? fetch;
    const url = `${this.config.baseUrl ?? BASE_URL}/flights/${encodeURIComponent(identFor(query))}`;

    const res = await doFetch(url, {
      headers: { 'x-apikey': apiKey, Accept: 'application/json' },
    });

    // A 404 is an answer, not a failure: this carrier has no such flight. Every
    // other non-2xx is a fault on our side or theirs, and swallowing it would
    // freeze the board at its last reading with nothing saying so.
    if (res.status === 404) {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason: `AeroAPI has no flight ${identFor(query)}.`,
      };
    }
    if (!res.ok) {
      throw new StatusProviderError(
        `AeroAPI returned ${res.status} for ${identFor(query)}.`,
        this.name,
        res.status,
        res.headers.get('x-request-id') ?? undefined,
      );
    }

    const body = (await res.json()) as AeroFlightsResponse;
    const leg = selectLeg(body.flights ?? [], query);
    if (!leg) {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason:
          `AeroAPI knows ${identFor(query)} but returned no leg departing ${query.originAirport} ` +
          'within a day of the scheduled time on this ticket. The flight number or the date ' +
          'on the booking is probably wrong.',
      };
    }
    return normalizeFlight(leg, observedAt);
  }
}
