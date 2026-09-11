import type { TrackingLookup, TrackingPhase, TrackingReport, TrackingScan } from '@/lib/integrations/shipping/types';
import { isNoRecord } from '@/lib/integrations/shipping/types';

/**
 * What a tracking reading *means*. Pure, and the clock is a parameter.
 *
 * Step 13 established that a delay is only news when it costs something, and
 * that rule ports here almost unchanged. What does **not** port is the shape of
 * "on time", and that is the whole argument of this file:
 *
 * **A crate has a window, not a deadline, and early is a failure too.** A flight
 * cannot land too soon. A crate can, and routinely does. Show-site receiving
 * opens when move-in opens; freight that turns up before the dock is staffed is
 * refused, held by the carrier at its own rate, or returned — and every status
 * column in every payload calls that outcome `delivered`. So the verdict here is
 * a window with two edges, and `too_early` is a real standing rather than an
 * impossible one. An advance warehouse is the other rule: it accepts freight for
 * weeks and stops on a published date, so it has a far edge only. Which rule
 * applies is `shipments.consignment`, and getting it wrong flips the meaning of
 * the same delivery date.
 *
 * Three further distinctions live here, each a way a plausible tracking screen
 * lies:
 *
 * - **Delivered is not received.** The carrier's claim is that a dock signed for
 *   it. Between that dock and the booth sits drayage: a different contractor, on
 *   its own schedule, invisible to this app. The most expensive thing this model
 *   could do is render `delivered` as done while the crate sits in a marshalling
 *   yard and the booth stands empty on the first morning. Only a person sets
 *   `receivedAt`, the way only the subject sets `responded_at` on an attendee —
 *   the step 12 hearsay rule arriving from a fourth direction.
 *
 * - **Silence is the failure mode, and no status field reports it.** A stalled
 *   crate has a healthy payload: the carrier is still promising Thursday, there
 *   simply has not been a scan since Tuesday. Nothing anywhere says anything is
 *   wrong, so the absence of scans has to be what raises it. This is also the
 *   one place §5f's rule **inverts**: a delayed flight home says nothing,
 *   because it is somebody's evening — but a *return* crate is the leg that
 *   actually gets lost, and you find out next quarter when the booth is not
 *   there for the next show. Going quiet about the way home is right for people
 *   and wrong for freight.
 *
 * - **Not knowing is not the same as fine**, and it is the default. Step 13's
 *   correction, unchanged, because a `draft` row reads as calm on a board just
 *   as `scheduled` did.
 */

export type ShipmentPhase =
  | 'draft'
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned'
  | 'cancelled'
  | 'unknown';

export type Consignment = 'advance_warehouse' | 'show_site' | 'office' | 'direct';

export type TrackedShipment = {
  id: string;
  description: string;
  direction: 'outbound' | 'return';
  consignment: Consignment;
  carrier: string;
  trackingNumber: string | null;
  status: ShipmentPhase;
  pieces: number;

  mustArriveBy: Date | null;
  receivingOpensAt: Date | null;
  shippedAt: Date | null;
  estimatedDelivery: Date | null;
  promisedDelivery: Date | null;
  estimateChangedAt: Date | null;
  deliveredAt: Date | null;
  receivedAt: Date | null;

  lastCheckedAt: Date | null;
  trackingProvider: string | null;
  /** The most recent scan's instant, from the event timeline. Null if none. */
  lastScanAt: Date | null;
};

const HOUR_MS = 3_600_000;

/* ------------------------------- freshness --------------------------------- */

export type Freshness =
  | { kind: 'never_checked' }
  | { kind: 'fresh'; ageMinutes: number }
  | { kind: 'stale'; ageMinutes: number; expectedEveryMinutes: number };

/**
 * How often a shipment is worth re-checking, by how close its deadline is.
 *
 * Slower than a flight's schedule on purpose. Freight scans a handful of times a
 * day, not continuously, so polling every fifteen minutes buys nothing but API
 * calls — and a *stale* threshold derived from that would paint a board amber
 * for rows that are behaving exactly as freight behaves. One definition, read by
 * both the sweep and the board, so the board can never call fresh something the
 * sweep is not refreshing.
 */
export function expectedCheckIntervalMinutes(s: TrackedShipment, asOf: Date): number {
  if (!s.mustArriveBy) return 24 * 60;
  const hoursOut = (s.mustArriveBy.getTime() - asOf.getTime()) / HOUR_MS;
  if (hoursOut > 14 * 24) return 24 * 60;
  if (hoursOut > 3 * 24) return 8 * 60;
  if (hoursOut > 24) return 3 * 60;
  return 60;
}

export function freshnessOf(s: TrackedShipment, asOf: Date): Freshness {
  if (!s.lastCheckedAt) return { kind: 'never_checked' };
  const ageMinutes = Math.max(0, Math.round((asOf.getTime() - s.lastCheckedAt.getTime()) / 60_000));
  const expectedEveryMinutes = expectedCheckIntervalMinutes(s, asOf);
  // Doubled: one missed refresh is a slow job, two is a broken one.
  return ageMinutes > expectedEveryMinutes * 2
    ? { kind: 'stale', ageMinutes, expectedEveryMinutes }
    : { kind: 'fresh', ageMinutes };
}

/**
 * What the board should say, which is not always what the column holds.
 *
 * `delivered`, `returned` and `cancelled` are facts and survive any amount of
 * staleness — a crate does not become uncertain because nobody refreshed the
 * page. `in_transit` is a *prediction* about where something is right now, and a
 * stale prediction about a crate that should already have arrived is not a
 * prediction any more.
 */
export function effectiveStatus(s: TrackedShipment, asOf: Date): ShipmentPhase {
  if (s.status === 'delivered' || s.status === 'returned' || s.status === 'cancelled') {
    return s.status;
  }
  // A row nobody has ever tracked is not in transit; it is a plan.
  if (!s.trackingNumber) return s.status === 'draft' ? 'draft' : 'label_created';
  const overdue = s.mustArriveBy !== null && asOf.getTime() > s.mustArriveBy.getTime();
  const fresh = freshnessOf(s, asOf);
  if (fresh.kind === 'never_checked') return overdue ? 'unknown' : s.status;
  if (fresh.kind === 'stale' && overdue) return 'unknown';
  return s.status;
}

/* ------------------------------ arrival window ----------------------------- */

export type WindowStanding =
  /** No deadline to miss — a return leg with nowhere it has to be by. */
  | 'not_applicable'
  /** There is a window and the carrier will not say when it will land. */
  | 'no_estimate'
  /** Expected inside the window with room. */
  | 'clear'
  /** Expected inside the window, but inside the buffer as well. */
  | 'tight'
  /** Expected after the crate had to be there. */
  | 'late'
  /** Expected before the dock opens, which is a refusal, not an early win. */
  | 'too_early'
  /** It is there, inside the window. Past tense. */
  | 'arrived'
  /** It got there, and it got there late. The penalty is incurred, not at risk. */
  | 'arrived_late'
  /** It got there before the dock opened. */
  | 'arrived_early'
  /** It is not coming: returned or cancelled. */
  | 'no_arrival';

export type WindowVerdict = {
  standing: WindowStanding;
  /** Hours between the expected arrival and the deadline. Positive is spare. */
  hoursSpare: number | null;
  /** Hours of spare time the buffer treats as "no longer comfortable". */
  bufferHours: number;
  /**
   * True when the carrier's *original* promise cleared the deadline and what it
   * says now does not. §5f's `brokenSincePurchase`, on freight: the claim is not
   * "this is late", it is "this stopped being on time after we committed", which
   * is the only version of the sentence anybody can act on.
   */
  brokenSincePromise: boolean;
};

export type WindowContext = {
  /**
   * How much spare time counts as comfortable. Not a policy value like the
   * arrival buffer — nothing in `travel_policy` speaks to freight — so it is a
   * parameter with a stated default rather than a literal buried in a branch.
   */
  bufferHours?: number;
};

/**
 * A day. Long enough that a crate landing the morning of a deadline is not
 * flagged, short enough to catch one landing an hour before a dock closes.
 */
export const DEFAULT_ARRIVAL_BUFFER_HOURS = 24;

/**
 * The arrival we currently expect: what the carrier says, else nothing.
 *
 * A shipment with no tracking number has no carrier estimate, whatever is
 * sitting in the column — a stale one from a voided label, or a date somebody
 * typed. Returning it anyway produced the sharpest small bug in this step: a
 * crate that had never been handed to anybody was reported as *"will miss the
 * receiving deadline"*, which is a confident claim about a truck, sourced from
 * nothing, and it hid the real problem — that there is no truck.
 */
export function expectedArrival(s: TrackedShipment): Date | null {
  if (s.status === 'cancelled' || s.status === 'returned') return null;
  if (s.deliveredAt) return s.deliveredAt;
  return s.trackingNumber ? s.estimatedDelivery : null;
}

export function windowVerdict(s: TrackedShipment, ctx: WindowContext = {}): WindowVerdict {
  const bufferHours = ctx.bufferHours ?? DEFAULT_ARRIVAL_BUFFER_HOURS;
  const none = (standing: WindowStanding): WindowVerdict => ({
    standing,
    hoursSpare: null,
    bufferHours,
    brokenSincePromise: false,
  });

  if (s.status === 'cancelled' || s.status === 'returned') return none('no_arrival');
  if (!s.mustArriveBy) return none('not_applicable');

  const opensAt = s.consignment === 'show_site' ? s.receivingOpensAt : null;

  // Delivered is past tense, and the tense is the product. §5a: "at risk" says
  // hurry, and once the crate is on the dock there is nothing left to hurry
  // about — what there is, is a drayage bill somebody has already incurred.
  if (s.deliveredAt) {
    const hoursSpare = (s.mustArriveBy.getTime() - s.deliveredAt.getTime()) / HOUR_MS;
    if (opensAt && s.deliveredAt.getTime() < opensAt.getTime()) {
      return { standing: 'arrived_early', hoursSpare, bufferHours, brokenSincePromise: false };
    }
    return {
      standing: hoursSpare < 0 ? 'arrived_late' : 'arrived',
      hoursSpare,
      bufferHours,
      brokenSincePromise: false,
    };
  }

  const arrival = expectedArrival(s);
  if (!arrival) return none('no_estimate');

  const hoursSpare = (s.mustArriveBy.getTime() - arrival.getTime()) / HOUR_MS;

  // The early edge is checked before the late one: a crate expected two days
  // before a dock opens is not "clear with 50 hours spare", which is what a
  // deadline-only model would call it, and what the plausible version of this
  // screen would have said right up until the carrier turned the truck around.
  const standing: WindowStanding =
    opensAt && arrival.getTime() < opensAt.getTime()
      ? 'too_early'
      : hoursSpare < 0
        ? 'late'
        : hoursSpare < bufferHours
          ? 'tight'
          : 'clear';

  const promisedSpare =
    s.promisedDelivery !== null
      ? (s.mustArriveBy.getTime() - s.promisedDelivery.getTime()) / HOUR_MS
      : null;

  return {
    standing,
    hoursSpare,
    bufferHours,
    brokenSincePromise: promisedSpare !== null && promisedSpare >= 0 && hoursSpare < 0,
  };
}

/* --------------------------------- stalls ---------------------------------- */

export type Stall =
  | { kind: 'moving' }
  | { kind: 'never_scanned'; sinceHours: number }
  | { kind: 'stalled'; sinceHours: number; expectedWithinHours: number };

/**
 * How long freight may plausibly go unscanned before the silence is itself news.
 *
 * Wider than it feels like it should be. Long-haul LTL genuinely scans once a
 * day and can sit a weekend in a terminal with nothing wrong; a threshold tuned
 * to parcel delivery would flag every pallet in the country. It tightens as the
 * deadline approaches, because that is when the same silence stops being
 * ordinary and starts being the thing you cannot recover from.
 */
export function stallThresholdHours(s: TrackedShipment, asOf: Date): number {
  if (!s.mustArriveBy) return 96;
  const hoursOut = (s.mustArriveBy.getTime() - asOf.getTime()) / HOUR_MS;
  if (hoursOut > 7 * 24) return 96;
  if (hoursOut > 3 * 24) return 48;
  return 24;
}

export function stallOf(s: TrackedShipment, asOf: Date): Stall {
  const settled =
    s.status === 'delivered' || s.status === 'returned' || s.status === 'cancelled' || s.deliveredAt !== null;
  if (settled) return { kind: 'moving' };
  // Nothing has been handed to a carrier yet, so there is nothing to be silent.
  if (!s.trackingNumber || s.status === 'draft') return { kind: 'moving' };

  const expectedWithinHours = stallThresholdHours(s, asOf);

  if (!s.lastScanAt) {
    const since = s.shippedAt ?? s.lastCheckedAt;
    if (!since) return { kind: 'moving' };
    const sinceHours = (asOf.getTime() - since.getTime()) / HOUR_MS;
    // A tracking number with no scan at all is a label that was printed and
    // never handed over — the commonest way an outbound crate misses a show, and
    // the one nobody notices because the row looks filled in.
    return sinceHours > expectedWithinHours
      ? { kind: 'never_scanned', sinceHours }
      : { kind: 'moving' };
  }

  const sinceHours = (asOf.getTime() - s.lastScanAt.getTime()) / HOUR_MS;
  return sinceHours > expectedWithinHours
    ? { kind: 'stalled', sinceHours, expectedWithinHours }
    : { kind: 'moving' };
}

/* ------------------------------ reconciliation ----------------------------- */

export type ChangeKind =
  | 'none'
  | 'moved'
  | 'estimate_slipped'
  | 'estimate_improved'
  | 'delivered'
  | 'exception'
  | 'returned'
  | 'no_record';

export type Reconciliation = {
  changes: ChangeKind[];
  /** New scans only — the ones this shipment does not already have. */
  newScans: TrackingScan[];
  /** Exactly the columns to write. Null means write nothing at all. */
  patch: {
    status: ShipmentPhase;
    estimatedDelivery: Date | null;
    promisedDelivery: Date | null;
    estimateChangedAt: Date | null;
    deliveredAt: Date | null;
    trackingProvider: string;
    lastCheckedAt: Date;
  } | null;
};

/** Below this an estimate has not moved; the carrier has re-rounded it. */
export const ESTIMATE_CHANGE_TOLERANCE_HOURS = 2;

const PHASE_TO_STATUS: Record<TrackingPhase, ShipmentPhase> = {
  pre_transit: 'label_created',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  exception: 'exception',
  returned: 'returned',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

export function reconcile(
  s: TrackedShipment,
  lookup: TrackingLookup,
  knownFingerprints: ReadonlySet<string>,
): Reconciliation {
  if (isNoRecord(lookup)) {
    // Step 13's rule, and it is if anything sharper here: a tracker that has
    // never heard of this number tells us nothing about the crate and something
    // important about the row. Nothing is patched — and `last_checked_at` least
    // of all, because stamping a successful check on a failed lookup is how a
    // board goes stale while claiming to be fresh.
    return { changes: ['no_record'], newScans: [], patch: null };
  }

  const r: TrackingReport = lookup;
  const changes: ChangeKind[] = [];
  const newScans = r.scans.filter((scan) => !knownFingerprints.has(scan.fingerprint));
  if (newScans.length > 0) changes.push('moved');

  const status = PHASE_TO_STATUS[r.phase];

  // The promise is captured once and never re-captured. EasyPost has no field
  // for it, so this is honestly *our* first-seen estimate rather than the
  // carrier's word — and a "promise" that silently followed the estimate would
  // make `brokenSincePromise` unable to ever be true, which is the same as
  // deleting the feature while leaving its name on the screen.
  const promisedDelivery = s.promisedDelivery ?? r.promisedDelivery ?? r.estimatedDelivery;

  const previous = s.estimatedDelivery;
  const drift =
    previous && r.estimatedDelivery
      ? (r.estimatedDelivery.getTime() - previous.getTime()) / HOUR_MS
      : 0;
  const estimateMoved = Math.abs(drift) >= ESTIMATE_CHANGE_TOLERANCE_HOURS;
  if (estimateMoved) changes.push(drift > 0 ? 'estimate_slipped' : 'estimate_improved');

  if (status !== s.status) {
    if (status === 'delivered') changes.push('delivered');
    else if (status === 'exception') changes.push('exception');
    else if (status === 'returned') changes.push('returned');
  }
  if (changes.length === 0) changes.push('none');

  return {
    changes,
    newScans,
    patch: {
      status,
      estimatedDelivery: r.estimatedDelivery,
      promisedDelivery,
      estimateChangedAt: estimateMoved ? r.observedAt : s.estimateChangedAt,
      // Never un-deliver a crate on a poll that lost the scan: delivery is a
      // fact and the timeline is the record of it.
      deliveredAt: r.deliveredAt ?? s.deliveredAt,
      trackingProvider: r.provider,
      lastCheckedAt: r.observedAt,
    },
  };
}
