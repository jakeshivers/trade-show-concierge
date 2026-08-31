import type { ShipmentTrackingProvider, TrackingLookup, TrackingQuery } from '../types';
import { TrackingProviderError, TrackingProviderNotConfiguredError } from '../types';
import type { EasyPostTracker, EasyPostTrackerList } from './wire';
import { normalizeTracker } from './normalize';

/**
 * EasyPost Tracker API v2 — the real shipment tracking provider.
 *
 * **Verified against nothing yet**, and recorded here in the same words the
 * AeroAPI client uses so nobody reads the absence of a warning as evidence: the
 * wire types are written from the published v2 schema, the tests run against
 * fixtures we wrote ourselves, and a closed loop like that proves internal
 * consistency and cannot catch a wrong field name. `EASYPOST_API_KEY` is the
 * arbiter when somebody has one, and `pnpm duffel:capture` is the shape of the
 * script that should exist here before this is trusted with a real crate.
 *
 * What the adapter does guarantee is the shape of its failures. A missing key is
 * an error naming the variable; an unparseable timestamp is an error naming the
 * field; a tracking number the carrier has never seen is `NoRecord` rather than
 * a blank report. Nothing here can produce a row that says "in transit".
 */

const BASE_URL = 'https://api.easypost.com/v2';

export type EasyPostConfig = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export function easyPostConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EasyPostConfig {
  return { apiKey: env.EASYPOST_API_KEY, baseUrl: env.EASYPOST_BASE_URL };
}

/**
 * Our carrier enum → EasyPost's carrier account names.
 *
 * `other` is deliberately absent rather than mapped to something plausible. A
 * shipment on a carrier we cannot name is one EasyPost cannot look up, and
 * guessing "UPS" for it would produce either nothing or, far worse, somebody
 * else's parcel that happens to share the number format.
 */
const CARRIERS: Record<string, string> = {
  ups: 'UPS',
  usps: 'USPS',
  fedex: 'FedEx',
  dhl: 'DHLExpress',
};

export function carrierFor(carrier: string): string | null {
  return CARRIERS[carrier.toLowerCase()] ?? null;
}

export class EasyPostTrackingProvider implements ShipmentTrackingProvider {
  readonly name = 'easypost';

  constructor(private readonly config: EasyPostConfig = easyPostConfigFromEnv()) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async lookup(query: TrackingQuery): Promise<TrackingLookup> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new TrackingProviderNotConfiguredError('EasyPost', ['EASYPOST_API_KEY']);

    const observedAt = new Date();
    const carrier = carrierFor(query.carrier);
    if (!carrier) {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason:
          `This shipment's carrier is "${query.carrier}", which EasyPost cannot be asked about. ` +
          'Set the carrier to UPS, USPS, FedEx or DHL, or track it by hand — a guessed carrier ' +
          'returns either nothing or somebody else’s parcel with the same number format.',
      };
    }

    const doFetch = this.config.fetch ?? fetch;
    const url =
      `${this.config.baseUrl ?? BASE_URL}/trackers` +
      `?tracking_code=${encodeURIComponent(query.trackingNumber)}&carrier=${encodeURIComponent(carrier)}`;

    const res = await doFetch(url, {
      headers: {
        // EasyPost authenticates with the key as HTTP Basic username, empty password.
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });

    // A 404 is an answer — no such tracker. Every other non-2xx is a fault on
    // our side or theirs, and swallowing it would freeze the timeline at its
    // last scan with nothing on the screen saying so.
    if (res.status === 404) {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason: `EasyPost has no tracker for ${carrier} ${query.trackingNumber}.`,
      };
    }
    if (!res.ok) {
      throw new TrackingProviderError(
        `EasyPost returned ${res.status} for ${carrier} ${query.trackingNumber}.`,
        this.name,
        res.status,
        res.headers.get('x-ep-request-uuid') ?? undefined,
      );
    }

    const body = (await res.json()) as EasyPostTrackerList;
    const tracker = selectTracker(body.trackers ?? [], query.trackingNumber);
    if (!tracker) {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason:
          `EasyPost returned no tracker matching ${query.trackingNumber}. The number on this ` +
          'shipment is probably wrong, or the label was voided and re-cut.',
      };
    }
    return normalizeTracker(tracker, observedAt);
  }
}

/**
 * Pick the tracker that is ours.
 *
 * The filter endpoint is a collection, and a code re-cut on a new label leaves
 * more than one tracker behind for the same number. The exact code match comes
 * first; the newest of several is the live one, because the old tracker keeps
 * reporting the state it was frozen in and would show a crate as still in
 * transit forever.
 */
export function selectTracker(
  trackers: EasyPostTracker[],
  trackingNumber: string,
): EasyPostTracker | null {
  const exact = trackers.filter((t) => t.tracking_code === trackingNumber);
  const pool = exact.length > 0 ? exact : trackers;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => {
    const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    return bt - at;
  })[0];
}
