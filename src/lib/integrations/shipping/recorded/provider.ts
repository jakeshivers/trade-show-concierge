import type { ShipmentTrackingProvider, TrackingLookup, TrackingQuery } from '../types';
import { normalizeTracker } from '../easypost/normalize';
import { TRACKING, buildTracker, type Scenario } from './fixtures';

/**
 * A tracking provider that replays recorded payloads instead of asking a carrier.
 *
 * The same object, and the same defence, as `flightstatus/recorded/provider.ts`:
 * it announces itself as the provider `recorded`, every row it touches records
 * that name in `shipments.tracking_provider` and on each scan's `source`, and
 * the screens that render its output say on the page that no carrier was asked.
 * What it replays are EasyPost-shaped payloads pushed through the **real**
 * normalizer, so everything from the wire format inward is production code.
 *
 * It exists because non-negotiable #1 says the whole app runs on a clean clone
 * with zero API keys, and because the interesting half of shipment tracking is
 * what goes wrong — which cannot be demonstrated on demand with a real key
 * either. Nobody can arrange for a crate to stall in Memphis for a demo.
 *
 * **The one liberty it takes** is choosing which scenario a shipment gets: a
 * hash of the tracking number, so the same crate tells the same story on every
 * run and across a `--sync`, which is what makes a dedupe key testable at all.
 * A random draw would be a board that says something different each reload,
 * which is indistinguishable from a bug.
 */

const CYCLE: Scenario[] = [
  'on_time',
  'stalled',
  'slow_but_fine',
  'late',
  'on_time',
  'exception',
];

export function scenarioFor(trackingNumber: string): Scenario {
  let h = 0;
  for (const ch of trackingNumber) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}

/** Five days is the default door-to-door window for palletized LTL freight. */
const DEFAULT_TRANSIT_DAYS = 5;
const DAY_MS = 86_400_000;

export class RecordedTrackingProvider implements ShipmentTrackingProvider {
  readonly name = 'recorded';

  /**
   * `scenarios` pins specific tracking numbers, which is how a test writes "this
   * crate stalled" without reverse-engineering the hash — and how the seed
   * builds a logistics screen that tells one coherent story rather than whatever
   * the hash happened to spell. That is not typing the data: choosing which
   * recorded payload to replay is the same act as choosing which recorded Duffel
   * offer a seeded search returns. What the row ends up saying still comes out
   * of the real normalizer and the real reconciler.
   */
  constructor(private readonly scenarios: Record<string, Scenario> = {}) {}

  isConfigured(): boolean {
    return true;
  }

  async lookup(query: TrackingQuery): Promise<TrackingLookup> {
    const observedAt = new Date();
    const scenario = this.scenarios[query.trackingNumber] ?? scenarioFor(query.trackingNumber);

    if (scenario === 'no_record') {
      return {
        noRecord: true,
        provider: this.name,
        observedAt,
        reason: `No recorded payload for ${query.trackingNumber}.`,
      };
    }

    const window = transitWindow(query);
    const payload = buildTracker(TRACKING[scenario], window, observedAt, query.trackingNumber);
    const report = normalizeTracker(payload, observedAt);
    return {
      ...report,
      provider: this.name,
      scans: report.scans.map((s) => ({ ...s, fingerprint: s.fingerprint })),
    };
  }
}

/**
 * The window a recorded shape is stretched over.
 *
 * Both ends can be missing on a real row — a shipment with no ship date and no
 * deadline is perfectly legal and quite common early on — so each end falls back
 * to the other rather than to a fixed date, and only a row with neither gets an
 * invented window anchored to now. Anchoring to a constant instead would put
 * every unscheduled crate's scans in the same week of last year.
 */
export function transitWindow(query: TrackingQuery): { from: Date; to: Date } {
  const shipped = query.shippedAt ?? null;
  const due = query.mustArriveBy ?? null;
  if (shipped && due && due.getTime() > shipped.getTime()) return { from: shipped, to: due };
  if (shipped) return { from: shipped, to: new Date(shipped.getTime() + DEFAULT_TRANSIT_DAYS * DAY_MS) };
  if (due) return { from: new Date(due.getTime() - DEFAULT_TRANSIT_DAYS * DAY_MS), to: due };
  const now = new Date();
  return { from: new Date(now.getTime() - 2 * DAY_MS), to: new Date(now.getTime() + 3 * DAY_MS) };
}
