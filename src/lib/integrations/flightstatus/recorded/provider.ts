import type { FlightStatusProvider, StatusLookup, StatusQuery } from '../types';
import { normalizeFlight } from '../aeroapi/normalize';
import { LEGS, buildAeroFlight, type Scenario } from './fixtures';

/**
 * A status provider that replays recorded payloads instead of asking a carrier.
 *
 * The same object, and the same defence, as `flights/recorded/provider.ts`: it
 * announces itself as the provider `recorded`, every row it touches records that
 * name in `flights.status_provider`, and the screens that render its output say
 * on the page that nothing here came from an airline. What it replays are the
 * AeroAPI-shaped payloads in `./fixtures.ts`, pushed through the **real**
 * normalizer, so the code under test from the wire format inward is production
 * code.
 *
 * It exists because non-negotiable #1 says the whole app runs on a clean clone
 * with zero API keys, and because the interesting half of flight tracking is
 * disruption — which cannot be demonstrated on demand with a real key either.
 * Nobody can arrange a diversion for a demo.
 *
 * **The one liberty it takes** is choosing which scenario a flight gets. The
 * choice is a hash of the airline code and flight number, so it is stable — the
 * same flight tells the same story on every run and across a `--sync`, which is
 * what makes an alert's dedupe key testable at all — and it spreads the seeded
 * flights across every branch `status.ts` has. A random draw would be a board
 * that says something different each time you reload it, which is indis-
 * tinguishable from a bug.
 */

/**
 * Two cycles, because a replay has to be consistent with the clock it is
 * replayed into.
 *
 * Handing back `landed` for a flight three weeks out is not a demo of anything —
 * it is a payload that no provider could have produced, and it would put a
 * status on the board that contradicts the departure time next to it. So a leg
 * that has not left yet draws from the scenarios a scheduled flight can be in,
 * and one whose departure has passed draws from the rest. This is the same
 * liberty `flights/recorded/provider.ts` takes with dates, and for the same
 * reason: what was recorded is the shape, not the moment.
 */
const UPCOMING: Scenario[] = [
  'on_time',
  'minor_delay',
  'delayed_into_buffer',
  'schedule_change',
  'cancelled',
  'on_time',
];

const DEPARTED: Scenario[] = ['landed', 'diverted', 'landed', 'minor_delay'];

export function scenarioFor(
  airlineCode: string,
  flightNumber: string,
  departed = false,
): Scenario {
  const key = `${airlineCode}${flightNumber}`;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const cycle = departed ? DEPARTED : UPCOMING;
  return cycle[h % cycle.length];
}

export class RecordedStatusProvider implements FlightStatusProvider {
  readonly name = 'recorded';

  /**
   * `scenarios` pins specific flights, which is how a test writes "this leg was
   * cancelled" without reverse-engineering the hash — and how the seed builds a
   * board that tells one coherent story rather than whatever the hash happened
   * to spell. That is not typing the data: choosing which recorded payload to
   * replay is the same act as choosing which recorded Duffel offer a seeded
   * search returns. What the row ends up saying still comes out of the real
   * normalizer and the real reconciler, and nothing here can write a status
   * those two would not have produced.
   */
  constructor(private readonly scenarios: Record<string, Scenario> = {}) {}

  isConfigured(): boolean {
    return true;
  }

  async lookup(query: StatusQuery): Promise<StatusLookup> {
    const observedAt = new Date();
    const key = `${query.airlineCode}${query.flightNumber}`;
    const scenario =
      this.scenarios[key] ??
      scenarioFor(
        query.airlineCode,
        query.flightNumber,
        query.scheduledDeparture.getTime() < observedAt.getTime(),
      );

    if (scenario === 'no_record') {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason: `No recorded payload for ${key}.`,
      };
    }

    const payload = buildAeroFlight(LEGS[scenario], query);
    return { ...normalizeFlight(payload, observedAt), provider: this.name };
  }
}
