import type { TrackingPhase, TrackingReport, TrackingScan } from '../types';
import { TrackingProviderError } from '../types';
import type { EasyPostTracker, EasyPostTrackingDetail, EasyPostTrackingLocation } from './wire';

/**
 * EasyPost payload → `TrackingReport`. Pure, so the part that has to be right is
 * testable without a key — the split `duffel/normalize.ts` established and
 * `aeroapi/normalize.ts` repeated.
 */

const PROVIDER = 'easypost';

function instant(iso: string | null | undefined, field: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new TrackingProviderError(`EasyPost sent an unparseable ${field}: "${iso}"`, PROVIDER);
  }
  return d;
}

/**
 * EasyPost's status vocabulary → ours.
 *
 * Three of these mappings are judgments rather than translations, and each one
 * is a place a naive `as TrackingPhase` cast would have been wrong:
 *
 * - `available_for_pickup` is **not** delivered. It is a crate sitting at a
 *   depot waiting for somebody to drive to it, which on a show week is the
 *   difference between a booth and an empty carpet.
 * - `failure` is an `exception`, not a cancellation. The crate still exists and
 *   is still somewhere; something about the delivery failed.
 * - `error` is the *tracker* failing, not the shipment — it tells us nothing
 *   about the freight, so it maps to `unknown` rather than to a status that
 *   would render as a fact.
 */
const PHASES: Record<string, TrackingPhase> = {
  pre_transit: 'pre_transit',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  available_for_pickup: 'exception',
  return_to_sender: 'returned',
  failure: 'exception',
  cancelled: 'cancelled',
  error: 'unknown',
  unknown: 'unknown',
};

export function phaseOf(status: string | null | undefined): TrackingPhase {
  if (!status) return 'unknown';
  return PHASES[status] ?? 'unknown';
}

export function locationOf(l: EasyPostTrackingLocation | null | undefined): string | null {
  if (!l) return null;
  const parts = [l.city, l.state, l.country].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * A stable identity for one scan.
 *
 * EasyPost does not give tracking details an id, and the whole history comes
 * back on every poll, so without this a nightly sweep appends the entire
 * timeline again each night. The instant plus the status plus the location is
 * what actually identifies a scan: a carrier does not record two different
 * events at the same facility, in the same state, in the same second. The
 * message is deliberately excluded — carriers reword scan text between polls
 * ("Departed facility" → "Departed FedEx location"), and a fingerprint that
 * moved when the prose did would defeat its own purpose.
 */
export function fingerprintOf(d: {
  occurredAt: Date;
  phase: TrackingPhase;
  location: string | null;
}): string {
  return `${d.occurredAt.toISOString()}|${d.phase}|${d.location ?? ''}`;
}

export function normalizeScan(d: EasyPostTrackingDetail): TrackingScan | null {
  const occurredAt = instant(d.datetime, 'tracking_details[].datetime');
  // A scan with no time is not a point on a timeline. Dropping it is right:
  // ordering by a guessed instant is how a delivery lands before its pickup.
  if (!occurredAt) return null;
  const phase = phaseOf(d.status);
  const location = locationOf(d.tracking_location);
  return {
    occurredAt,
    phase,
    message: d.message?.trim() || d.status_detail?.trim() || phase.replace(/_/g, ' '),
    location,
    fingerprint: fingerprintOf({ occurredAt, phase, location }),
  };
}

export function normalizeTracker(t: EasyPostTracker, observedAt: Date): TrackingReport {
  const scans = (t.tracking_details ?? [])
    .map(normalizeScan)
    .filter((s): s is TrackingScan => s !== null)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const phase = phaseOf(t.status);

  // The delivery instant comes from the scan that says delivered, not from the
  // tracker's summary: the summary has no time on it, and "delivered" without a
  // time cannot be compared to a receiving window, which is the only comparison
  // this whole feature makes.
  const deliveredScan = [...scans].reverse().find((s) => s.phase === 'delivered');

  return {
    provider: PROVIDER,
    observedAt,
    phase,
    estimatedDelivery: instant(t.est_delivery_date, 'est_delivery_date'),
    // EasyPost has no "what you were originally promised" field. Rather than
    // invent one from the first estimate we happened to poll, this is null and
    // `shipping/store.ts` captures our own first-seen estimate instead — where
    // it is honestly ours, and cannot be mistaken for the carrier's word.
    promisedDelivery: null,
    deliveredAt: deliveredScan?.occurredAt ?? null,
    signedBy: t.signed_by?.trim() || null,
    scans,
  };
}
