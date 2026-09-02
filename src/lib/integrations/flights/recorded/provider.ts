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

/**
 * Shift a recorded itinerary so it really is *inside* the window that was asked
 * for — which `rebase` alone does not guarantee.
 *
 * `rebase` aligns the offer to the **UTC day** of `earliestDeparture` and keeps
 * the fixture's naive local departure time. That is right for everything it was
 * built to protect: clock times, durations and overnight arrivals all survive a
 * whole-day shift. What it never compares is the resulting **instant** against
 * the window, and a requested departure is an instant with a time of day on it.
 *
 * The international fixture leaves SFO at 16:20 local, so it rebases to 23:20Z.
 * Any search whose earliest departure falls later than that on the same UTC day
 * gets an offer departing *before* the window opens — denied on
 * `departure_window`, and the request comes back `no_options`.
 *
 * `pnpm test` and `pnpm booking:dry-run` both build their window from
 * `now + 45 days`, so for the forty minutes between 23:20Z and midnight UTC the
 * escalation scenario could not be reached and eight tests failed — and passed
 * every other hour, which is how it survived twenty-five steps. **A replay that
 * only works at certain times of day is not a replay**, and a suite whose colour
 * depends on when it runs is worse than one that is red.
 *
 * The correction is another whole day, because whole days is the property the
 * shifting exists to preserve. `recorded.test.ts` pins the clock across that
 * hour, since a test that read the wall clock would reproduce this about 3% of
 * the time.
 */
function rebaseIntoWindow(
  raw: DuffelOffer,
  constraints: { earliestDeparture: Date },
  expiresAt: Date,
): DuffelOffer {
  const shifted = rebase(raw, constraints.earliestDeparture, expiresAt);
  const departs = normalizeOffers([shifted])[0]?.slices[0]?.segments[0]?.departsAt;
  if (departs && departs.getTime() < constraints.earliestDeparture.getTime()) {
    return rebase(raw, new Date(constraints.earliestDeparture.getTime() + DAY_MS), expiresAt);
  }
  return shifted;
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
      offers: normalizeOffers(matching.map((raw) => rebaseIntoWindow(raw, constraints, expiresAt)))
        .map((offer) => ({ ...offer, provider: this.name })),
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
