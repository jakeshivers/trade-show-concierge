import type {
  FlightProvider,
  SearchRequest,
  SearchResult,
  HoldRequest,
  HoldResult,
  PurchaseRequest,
  PurchaseResult,
} from '../types';
import { DryRunError } from '../types';
import type { DuffelOffer, DuffelSegment, DuffelSlice } from '../duffel/wire';
import { normalizeOffers } from '../duffel/normalize';
import { allOffers } from '../duffel/fixtures';

/**
 * A provider that replays recorded provider payloads instead of calling anyone.
 *
 * **This is not a fake Duffel.** SCOPE.md non-negotiable #2 forbids serving
 * invented data from behind a real integration, and this does not: it announces
 * itself as the provider `recorded`, every booking it produces is stamped
 * `live: false`, and `purchase()` throws unconditionally — there is no
 * configuration of this class that can spend money. What it replays are the
 * recorded payloads in `duffel/fixtures.ts`, pushed through the *real*
 * normalizer, so the pipeline under test is the production one from the wire
 * format inward.
 *
 * It exists because non-negotiable #1 says the whole spine must run on a clean
 * clone with zero API keys. Without it, "dry-run booking end-to-end" would be
 * untestable until someone had a Duffel account, which is the wrong dependency
 * order for the riskiest component in the project.
 *
 * The one liberty it takes is dates: a recorded payload has fixed departure
 * dates, so the itinerary is shifted by whole days onto the requested travel
 * window. Whole days, so local clock times, durations, and overnight arrivals
 * all survive intact. Nothing about the fare, carrier, or conditions is touched.
 */

const DAY_MS = 86_400_000;

/** `2026-03-29T08:15:00` + n days, staying a naive local-time string. */
function shiftNaive(naive: string, days: number): string {
  const [datePart, timePart] = naive.split('T');
  if (!timePart) throw new Error(`Not a naive local datetime: "${naive}"`);
  const shifted = new Date(`${datePart}T00:00:00Z`).getTime() + days * DAY_MS;
  return `${new Date(shifted).toISOString().slice(0, 10)}T${timePart}`;
}

function shiftSegment(seg: DuffelSegment, days: number): DuffelSegment {
  return {
    ...seg,
    departing_at: shiftNaive(seg.departing_at, days),
    arriving_at: shiftNaive(seg.arriving_at, days),
  };
}

function shiftSlice(slice: DuffelSlice, days: number): DuffelSlice {
  return { ...slice, segments: slice.segments.map((s) => shiftSegment(s, days)) };
}

function utcDay(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
}

function rebase(raw: DuffelOffer, departOn: Date, expiresAt: Date): DuffelOffer {
  const first = raw.slices[0]?.segments[0];
  if (!first) return raw;
  const days = utcDay(departOn) - utcDay(new Date(`${first.departing_at.slice(0, 10)}T00:00:00Z`));

  return {
    ...raw,
    slices: raw.slices.map((s) => shiftSlice(s, days)),
    expires_at: expiresAt.toISOString(),
    payment_requirements: raw.payment_requirements
      ? {
          ...raw.payment_requirements,
          // A hold deadline in the past would defeat the very thing holds exist
          // for, so these move with the itinerary too.
          payment_required_by: raw.payment_requirements.payment_required_by
            ? new Date(expiresAt.getTime() + 2 * DAY_MS).toISOString()
            : null,
          price_guarantee_expires_at: raw.payment_requirements.price_guarantee_expires_at
            ? new Date(expiresAt.getTime() + DAY_MS).toISOString()
            : null,
        }
      : undefined,
  };
}

export type RecordedProviderOptions = {
  /** Recorded wire payloads to replay. Defaults to the Duffel v2 fixtures. */
  payloads?: DuffelOffer[];
  /** Injected so tests are deterministic; never read the clock directly. */
  now?: () => Date;
  /** Offers really do die in about half an hour. Mirror that, don't soften it. */
  offerTtlMinutes?: number;
};

export class RecordedFlightProvider implements FlightProvider {
  readonly name = 'recorded';

  private readonly payloads: DuffelOffer[];
  private readonly now: () => Date;
  private readonly ttlMinutes: number;

  constructor(opts: RecordedProviderOptions = {}) {
    this.payloads = opts.payloads ?? allOffers;
    this.now = opts.now ?? (() => new Date());
    this.ttlMinutes = opts.offerTtlMinutes ?? 30;
  }

  /** Nothing to configure — it calls nobody. */
  isConfigured(): boolean {
    return true;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const { constraints } = request;
    const searchedAt = this.now();
    const expiresAt = new Date(searchedAt.getTime() + this.ttlMinutes * 60_000);

    const matching = this.payloads.filter((raw) => {
      const slice = raw.slices[0];
      const segments = slice?.segments ?? [];
      const origin = segments[0]?.origin.iata_code;
      const destination = segments[segments.length - 1]?.destination.iata_code;
      return (
        origin === constraints.originAirport && destination === constraints.destinationAirport
      );
    });

    return {
      offers: normalizeOffers(
        matching.map((raw) => rebase(raw, constraints.earliestDeparture, expiresAt)),
      ).map((offer) => ({ ...offer, provider: this.name })),
      searchId: `rec_srh_${searchedAt.getTime()}`,
      searchedAt,
    };
  }

  /**
   * A hold costs nothing, so replaying one is honest: no money moves either way.
   * The order id is derived from the idempotency key, which makes a retried hold
   * return the same reference exactly as a real provider's dedupe would.
   */
  async hold(request: HoldRequest): Promise<HoldResult> {
    const now = this.now();
    const raw = this.payloads.find((p) => p.id === request.offerId);
    const holdable = raw?.payment_requirements?.requires_instant_payment === false;
    if (!holdable) {
      throw new Error(`Recorded offer ${request.offerId} does not support a hold`);
    }
    const [offer] = normalizeOffers([raw!]);

    return {
      orderId: `rec_ord_${request.idempotencyKey}`,
      bookingReference: `REC${request.idempotencyKey.slice(0, 6).toUpperCase()}`,
      payBy: new Date(now.getTime() + 2 * DAY_MS),
      priceGuaranteedUntil: offer.priceGuaranteeExpiresAt
        ? new Date(now.getTime() + DAY_MS)
        : null,
      totalCents: offer.totalCents,
      currency: offer.currency,
    };
  }

  /** Unconditional. There is no flag, env var, or argument that changes this. */
  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    throw new DryRunError(
      `purchase of ${request.amountCents} ${request.currency} against the recorded provider — ` +
        'it can never buy a ticket. Configure a real provider to book',
    );
  }

  async cancel(): Promise<void> {
    // Nothing was ever reserved with anyone.
  }
}
