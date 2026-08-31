import type { EasyPostTracker, EasyPostTrackingDetail } from '../easypost/wire';

/**
 * Recorded EasyPost-shaped payloads, one per thing that can happen to a crate.
 *
 * Times are **fractions of the transit window on the query** rather than fixed
 * instants, for the reason `flightstatus/recorded/fixtures.ts` uses offsets: a
 * canned instant is in the past by the time anybody runs this, and a screen full
 * of last spring's shipments demonstrates nothing. The *shape* is what was
 * recorded — how many scans, where they stop, what the carrier was still
 * promising when it stopped — and the clock is the caller's.
 *
 * Every scenario here exists because `src/lib/shipping/status.ts` has a branch
 * nothing else would exercise. Two of them are worth naming, because they are
 * the ones a plausible tracking screen gets wrong:
 *
 * - **`stalled`** looks completely healthy. The carrier is still promising
 *   delivery a day early; there simply has not been a scan since Tuesday. No
 *   status field anywhere in the payload says anything is wrong, which is
 *   exactly why the silence has to be what raises it.
 * - **`delivered_early`** is a *success* by every status column in this file and
 *   a failure on a show floor: the dock was not open, so the crate was refused,
 *   held, or is sitting somewhere nobody has been told about.
 */

export type Scenario =
  | 'on_time'
  | 'slow_but_fine'
  | 'late'
  | 'stalled'
  | 'exception'
  | 'delivered'
  | 'delivered_early'
  | 'returned'
  | 'no_record';

/**
 * A scan, placed at a fraction of the window between pickup and the deadline.
 *
 * `where` is a **role**, not a place, and that is deliberate. A replay knows the
 * shape of a journey and nothing whatever about the route: it is asked about a
 * crate going to Anaheim as readily as one going to Detroit. Naming real cities
 * here would put "Departed Memphis, TN" on the timeline of a shipment that never
 * went near Tennessee — a detail specific enough to be believed and invented
 * outright, which is the failure mode the no-fake-data rule exists to prevent.
 * So the timeline says what kind of waypoint it was and does not pretend to know
 * which one.
 */
type RecordedScan = {
  /** 0 = collected, 1 = due. May exceed 1 for a scan past the deadline. */
  at: number;
  status: string;
  message: string;
  where: string;
};

export type RecordedTracking = {
  scenario: Scenario;
  status: string;
  scans: RecordedScan[];
  /**
   * Where the carrier currently says it will land, as a fraction of the window.
   * < 1 is "before the deadline". Null is a carrier that will not commit.
   */
  estimateAt: number | null;
  signedBy?: string;
};

const ORIGIN = { where: 'Origin facility' };

const COLLECTED: RecordedScan = {
  at: 0,
  status: 'pre_transit',
  message: 'Shipping label created',
  ...ORIGIN,
};

const PICKED_UP: RecordedScan = {
  at: 0.08,
  status: 'in_transit',
  message: 'Picked up',
  ...ORIGIN,
};

export const TRACKING: Record<Exclude<Scenario, 'no_record'>, RecordedTracking> = {
  on_time: {
    scenario: 'on_time',
    status: 'in_transit',
    estimateAt: 0.72,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.3, status: 'in_transit', message: 'Departed facility', where: 'Origin hub' },
      { at: 0.55, status: 'in_transit', message: 'Arrived at facility', where: 'Regional hub' },
    ],
  },

  // Comfortably inside the window and moving slowly. This scenario is here to
  // prove the engine stays quiet: a crate that will make it with six hours to
  // spare has made it, and a feed that says otherwise is one nobody reads.
  slow_but_fine: {
    scenario: 'slow_but_fine',
    status: 'in_transit',
    estimateAt: 0.96,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.45, status: 'in_transit', message: 'Departed facility', where: 'Regional hub' },
      { at: 0.8, status: 'in_transit', message: 'In transit to destination', where: 'Destination hub' },
    ],
  },

  // The carrier has moved its own promise past the deadline and said so. This is
  // the case the whole feature exists for, and the one a person can still act on.
  late: {
    scenario: 'late',
    status: 'in_transit',
    estimateAt: 1.18,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.4, status: 'in_transit', message: 'Departed facility', where: 'Regional hub' },
      { at: 0.7, status: 'in_transit', message: 'Delay: weather condition in transit network', where: 'Regional hub' },
    ],
  },

  // Nothing in this payload says anything is wrong. That is the point.
  stalled: {
    scenario: 'stalled',
    status: 'in_transit',
    estimateAt: 0.85,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.22, status: 'in_transit', message: 'Arrived at facility', where: 'Regional hub' },
    ],
  },

  exception: {
    scenario: 'exception',
    status: 'failure',
    estimateAt: null,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.5, status: 'in_transit', message: 'Arrived at facility', where: 'Regional hub' },
      { at: 0.62, status: 'failure', message: 'Delivery attempted — business closed', where: 'Destination facility' },
    ],
  },

  delivered: {
    scenario: 'delivered',
    status: 'delivered',
    estimateAt: 0.9,
    signedBy: 'DOCK 4',
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.6, status: 'in_transit', message: 'Arrived at facility', where: 'Regional hub' },
      { at: 0.88, status: 'out_for_delivery', message: 'Out for delivery', where: 'Destination facility' },
      { at: 0.92, status: 'delivered', message: 'Delivered to receiving dock', where: 'Destination facility' },
    ],
  },

  // Every status column here says success. On a show-site consignment it is not.
  delivered_early: {
    scenario: 'delivered_early',
    status: 'delivered',
    estimateAt: 0.2,
    signedBy: 'RECEIVING',
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.15, status: 'out_for_delivery', message: 'Out for delivery', where: 'Destination facility' },
      { at: 0.2, status: 'delivered', message: 'Delivered', where: 'Destination facility' },
    ],
  },

  returned: {
    scenario: 'returned',
    status: 'return_to_sender',
    estimateAt: null,
    scans: [
      COLLECTED,
      PICKED_UP,
      { at: 0.55, status: 'failure', message: 'Delivery refused by recipient', where: 'Destination facility' },
      { at: 0.6, status: 'return_to_sender', message: 'Return to sender initiated', where: 'Destination facility' },
    ],
  },
};

/**
 * Project a recorded shape onto one real shipment's window.
 *
 * `now` is a parameter and it matters: a scan that has not happened yet must not
 * appear in a history. A replay that hands back the whole timeline the moment a
 * label is created would show a crate delivered on the day it shipped, which is
 * a payload no carrier could have produced — and `stalled`, whose entire content
 * is *the absence of recent scans*, would be indistinguishable from `on_time`.
 */
export function buildTracker(
  recorded: RecordedTracking,
  window: { from: Date; to: Date },
  now: Date,
  trackingNumber: string,
): EasyPostTracker {
  const span = window.to.getTime() - window.from.getTime();
  const at = (fraction: number) => new Date(window.from.getTime() + span * fraction);

  const details: EasyPostTrackingDetail[] = recorded.scans
    .map((scan) => ({ scan, when: at(scan.at) }))
    .filter(({ when }) => when.getTime() <= now.getTime())
    .map(({ scan, when }) => ({
      datetime: when.toISOString(),
      message: scan.message,
      status: scan.status,
      source: 'recorded',
      // The normalizer joins city/state/country; a replay has only the role,
      // so that is the only field it fills.
      tracking_location: { city: scan.where, state: null, country: null, zip: null },
    }));

  // The tracker's summary status is the last scan that actually happened, not
  // the scenario's eventual one — for the same reason. A crate cannot be
  // `delivered` in a payload whose latest scan is a departure from Memphis.
  const last = details[details.length - 1];
  const status = last ? last.status : 'pre_transit';

  return {
    id: `trk_recorded_${trackingNumber}`,
    object: 'Tracker',
    mode: 'test',
    tracking_code: trackingNumber,
    carrier: 'Recorded',
    status: status === recorded.scans[recorded.scans.length - 1]?.status ? recorded.status : status,
    signed_by: status === 'delivered' ? (recorded.signedBy ?? null) : null,
    est_delivery_date: recorded.estimateAt === null ? null : at(recorded.estimateAt).toISOString(),
    created_at: window.from.toISOString(),
    updated_at: (last?.datetime ?? window.from.toISOString()) as string,
    tracking_details: details,
  };
}
