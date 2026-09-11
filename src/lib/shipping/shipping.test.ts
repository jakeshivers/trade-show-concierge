import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ARRIVAL_BUFFER_HOURS,
  ESTIMATE_CHANGE_TOLERANCE_HOURS,
  effectiveStatus,
  expectedCheckIntervalMinutes,
  freshnessOf,
  reconcile,
  stallOf,
  windowVerdict,
  type TrackedShipment,
} from './status';
import { planReturnGapAlert, planShipmentAlert, type AlertableShipment } from './alerts';
import { buildShipmentRow, orderShipments, summarizeShipments } from './board';
import { selectTrackingProvider } from './provider';
import { validateShipment, describeDeletion, type ShipmentDraft } from './edit';
import { RecordedTrackingProvider, scenarioFor, transitWindow } from '@/lib/integrations/shipping/recorded/provider';
import {
  fingerprintOf,
  locationOf,
  normalizeTracker,
  phaseOf,
} from '@/lib/integrations/shipping/easypost/normalize';
import { carrierFor, selectTracker } from '@/lib/integrations/shipping/easypost/client';
import type { TrackingReport } from '@/lib/integrations/shipping/types';
import { isNoRecord } from '@/lib/integrations/shipping/types';

/**
 * The pure half of shipping — no database, no network, fixed clock.
 *
 * As with flights, the assertions worth reading are the ones about *silence* —
 * and one whole class here is the reverse: proving the engine speaks when
 * nothing at all has happened, because a stalled crate produces no event to
 * trigger on and a missing return leg produces no row.
 */

const NOW = new Date('2026-03-10T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const days = (n: number) => hours(n * 24);

const crate = (over: Partial<TrackedShipment> = {}): TrackedShipment => ({
  id: 's1',
  description: 'Booth crate 1 of 2',
  direction: 'outbound',
  consignment: 'advance_warehouse',
  carrier: 'fedex',
  trackingNumber: '7712345678',
  status: 'in_transit',
  pieces: 2,
  mustArriveBy: days(6),
  receivingOpensAt: null,
  shippedAt: days(-2),
  estimatedDelivery: days(4),
  promisedDelivery: days(4),
  estimateChangedAt: null,
  deliveredAt: null,
  receivedAt: null,
  lastCheckedAt: hours(-1),
  trackingProvider: 'recorded',
  lastScanAt: hours(-6),
  ...over,
});

const alertable = (over: Partial<AlertableShipment> = {}): AlertableShipment => ({
  shipment: crate(),
  showId: 'show1',
  showName: 'Automate 2026',
  moveInAt: days(7),
  ownerId: 'u-owner',
  ownerName: 'Marcus Webb',
  ...over,
});

/* ------------------------------ the window --------------------------------- */

describe('windowVerdict — a crate has two edges, not a deadline', () => {
  it('is clear when it lands with room', () => {
    const v = windowVerdict(crate());
    expect(v.standing).toBe('clear');
    expect(v.hoursSpare).toBeCloseTo(48, 5);
  });

  it('is tight inside the buffer, which is not the same as late', () => {
    const v = windowVerdict(crate({ estimatedDelivery: hours(6 * 24 - 6) }));
    expect(v.standing).toBe('tight');
    expect(v.bufferHours).toBe(DEFAULT_ARRIVAL_BUFFER_HOURS);
  });

  it('is late when the carrier expects it after the deadline', () => {
    const v = windowVerdict(crate({ estimatedDelivery: days(7) }));
    expect(v.standing).toBe('late');
    expect(v.hoursSpare).toBeLessThan(0);
  });

  /**
   * The correction this whole step turns on. A deadline-only model calls this
   * "clear with five days spare" — which is the answer right up until the dock
   * refuses the delivery.
   */
  it('calls a show-site delivery before the dock opens too_early, not clear', () => {
    const s = crate({
      consignment: 'show_site',
      receivingOpensAt: days(5),
      mustArriveBy: days(6),
      estimatedDelivery: days(1),
    });
    const v = windowVerdict(s);
    expect(v.standing).toBe('too_early');
    // And the deadline-only reading it replaces would have been comfortable.
    expect(v.hoursSpare).toBeGreaterThan(0);
  });

  it('does not apply the early edge to an advance warehouse, which holds freight', () => {
    const v = windowVerdict(crate({ receivingOpensAt: days(5), estimatedDelivery: days(1) }));
    expect(v.standing).toBe('clear');
  });

  it('reports brokenSincePromise only when it was promised inside the deadline', () => {
    const slipped = windowVerdict(crate({ promisedDelivery: days(4), estimatedDelivery: days(7) }));
    expect(slipped.brokenSincePromise).toBe(true);

    // Booked too tight to begin with is a planning decision, not a disruption —
    // the same distinction §5f draws for a flight bought inside its buffer.
    const alwaysLate = windowVerdict(
      crate({ promisedDelivery: days(7), estimatedDelivery: days(7) }),
    );
    expect(alwaysLate.brokenSincePromise).toBe(false);
  });

  it('is past tense once delivered, and separates late from early arrival', () => {
    expect(windowVerdict(crate({ deliveredAt: days(3) })).standing).toBe('arrived');
    expect(windowVerdict(crate({ deliveredAt: days(8) })).standing).toBe('arrived_late');
    expect(
      windowVerdict(
        crate({ consignment: 'show_site', receivingOpensAt: days(5), deliveredAt: days(1) }),
      ).standing,
    ).toBe('arrived_early');
  });

  it('has nothing to say without a deadline', () => {
    expect(windowVerdict(crate({ mustArriveBy: null })).standing).toBe('not_applicable');
  });

  it('reports no_estimate rather than guessing when the carrier will not say', () => {
    expect(windowVerdict(crate({ estimatedDelivery: null })).standing).toBe('no_estimate');
  });
});

/* -------------------------------- silence ---------------------------------- */

describe('stallOf — the failure with no event behind it', () => {
  it('is quiet while scans keep arriving', () => {
    expect(stallOf(crate(), NOW).kind).toBe('moving');
  });

  it('raises a stall when nothing has scanned for longer than freight goes quiet', () => {
    const stall = stallOf(crate({ lastScanAt: hours(-60), mustArriveBy: days(2) }), NOW);
    expect(stall.kind).toBe('stalled');
  });

  it('tolerates more silence when the deadline is weeks out', () => {
    // Same 60-hour gap, a month of runway: ordinary LTL behaviour, not news.
    const stall = stallOf(crate({ lastScanAt: hours(-60), mustArriveBy: days(30) }), NOW);
    expect(stall.kind).toBe('moving');
  });

  it('catches a label that was printed and never handed over', () => {
    const stall = stallOf(
      crate({ status: 'label_created', lastScanAt: null, shippedAt: days(-6), mustArriveBy: days(2) }),
      NOW,
    );
    expect(stall.kind).toBe('never_scanned');
  });

  it('says nothing about a crate with no tracking number to be silent under', () => {
    expect(stallOf(crate({ trackingNumber: null, status: 'draft' }), NOW).kind).toBe('moving');
  });

  it('says nothing about a delivered crate', () => {
    expect(stallOf(crate({ status: 'delivered', deliveredAt: hours(-70) }), NOW).kind).toBe('moving');
  });
});

/* ------------------------------- freshness --------------------------------- */

describe('freshness — not knowing is not the same as fine', () => {
  it('polls harder as the deadline closes', () => {
    expect(expectedCheckIntervalMinutes(crate({ mustArriveBy: days(30) }), NOW)).toBe(24 * 60);
    expect(expectedCheckIntervalMinutes(crate({ mustArriveBy: days(5) }), NOW)).toBe(8 * 60);
    expect(expectedCheckIntervalMinutes(crate({ mustArriveBy: hours(12) }), NOW)).toBe(60);
  });

  it('calls an overdue, unchecked crate unknown rather than in transit', () => {
    const s = crate({ mustArriveBy: hours(-2), lastCheckedAt: null });
    expect(effectiveStatus(s, NOW)).toBe('unknown');
  });

  it('lets facts survive any amount of staleness', () => {
    const s = crate({ status: 'delivered', lastCheckedAt: days(-20), mustArriveBy: days(-10) });
    expect(effectiveStatus(s, NOW)).toBe('delivered');
  });

  it('does not call a row with no tracking number in transit', () => {
    expect(effectiveStatus(crate({ trackingNumber: null, status: 'draft' }), NOW)).toBe('draft');
  });

  it('reports never_checked distinctly from stale', () => {
    expect(freshnessOf(crate({ lastCheckedAt: null }), NOW).kind).toBe('never_checked');
    expect(freshnessOf(crate({ lastCheckedAt: days(-4), mustArriveBy: days(1) }), NOW).kind).toBe('stale');
  });
});

/* ------------------------------- the alerts -------------------------------- */

describe('planShipmentAlert — mostly, it says nothing', () => {
  it('is silent on a crate that will make it', () => {
    expect(planShipmentAlert(alertable(), NOW)).toBeNull();
  });

  it('is silent on a crate that is merely close, which is still on time', () => {
    const item = alertable({ shipment: crate({ estimatedDelivery: hours(6 * 24 - 6) }) });
    expect(planShipmentAlert(item, NOW)).toBeNull();
  });

  it('speaks when the carrier moves its promise past the deadline', () => {
    const item = alertable({ shipment: crate({ estimatedDelivery: days(7) }) });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.reason).toBe('late');
    expect(alert.severity).toBe('critical');
    expect(alert.body).toContain('slipped after we committed');
  });

  it('speaks about a crate arriving before the dock opens', () => {
    const item = alertable({
      shipment: crate({
        consignment: 'show_site',
        receivingOpensAt: days(5),
        estimatedDelivery: days(1),
      }),
    });
    expect(planShipmentAlert(item, NOW)!.reason).toBe('too_early');
  });

  it('names the missing owner first when nobody owns the crate', () => {
    const item = alertable({
      ownerId: null,
      ownerName: null,
      shipment: crate({ estimatedDelivery: days(7) }),
    });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.ownerId).toBeNull();
    expect(alert.body.startsWith('Nobody owns this shipment')).toBe(true);
  });

  /**
   * The distinction the carrier's own data cannot express: every status field
   * on this crate says success.
   */
  it('reports a delivered crate nobody has confirmed at the booth', () => {
    const item = alertable({
      moveInAt: hours(-6),
      shipment: crate({ status: 'delivered', deliveredAt: hours(-30), receivedAt: null }),
    });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.reason).toBe('delivered_not_received');
    expect(alert.body).toContain('drayage');
  });

  it('does not chase a delivered crate before move-in has started', () => {
    const item = alertable({
      moveInAt: days(4),
      shipment: crate({ status: 'delivered', deliveredAt: hours(-30) }),
    });
    expect(planShipmentAlert(item, NOW)).toBeNull();
  });

  it('says nothing more once a person has confirmed receipt', () => {
    const item = alertable({
      moveInAt: hours(-6),
      shipment: crate({ status: 'delivered', deliveredAt: hours(-30), receivedAt: hours(-2) }),
    });
    expect(planShipmentAlert(item, NOW)).toBeNull();
  });

  it('writes an arrived-late crate in the past tense, as incurred', () => {
    const item = alertable({
      moveInAt: days(10),
      shipment: crate({
        status: 'delivered',
        deliveredAt: hours(-2),
        mustArriveBy: hours(-30),
        receivedAt: null,
      }),
    });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.reason).toBe('arrived_late');
    expect(alert.severity).toBe('info');
    expect(alert.body).toContain('incurred, not risked');
  });

  /** §5f inverted: the leg home is the one that goes missing. */
  it('says the return leg out loud when a return crate stalls', () => {
    const item = alertable({
      shipment: crate({
        direction: 'return',
        consignment: 'office',
        lastScanAt: hours(-60),
        mustArriveBy: days(2),
        // Inside the deadline on the carrier's own account, so the *only* thing
        // wrong with this crate is that nobody has heard from it.
        estimatedDelivery: hours(24),
      }),
    });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.reason).toBe('stalled');
    expect(alert.body).toContain('leg home');
  });

  it('escalates a shipment with a deadline and nothing to track it by', () => {
    const item = alertable({
      shipment: crate({ trackingNumber: null, status: 'draft', mustArriveBy: hours(30) }),
    });
    const alert = planShipmentAlert(item, NOW)!;
    expect(alert.reason).toBe('no_tracking');
  });

  /**
   * The bug this test was written for: the base fixture carries an estimated
   * delivery, and with no tracking number that estimate came from nowhere. The
   * engine reported "will miss the receiving deadline" — a confident claim about
   * a truck, on a row where the actual problem is that there is no truck.
   */
  it('does not call an untracked crate late on the strength of a stale estimate', () => {
    const s = crate({ trackingNumber: null, status: 'draft', mustArriveBy: days(2), estimatedDelivery: days(9) });
    expect(windowVerdict(s).standing).toBe('no_estimate');
    expect(planShipmentAlert(alertable({ shipment: s }), NOW)!.reason).toBe('no_tracking');
  });
});

describe('the alert with no row behind it', () => {
  const show = { id: 'show1', name: 'Automate 2026', moveOutAt: days(-4) };

  it('fires when freight went out and nothing came back', () => {
    const alert = planReturnGapAlert(show, true, false, NOW)!;
    expect(alert.reason).toBe('return_leg_missing');
    expect(alert.shipmentId).toBeNull();
  });

  it('does not fire for a show we shipped nothing to', () => {
    expect(planReturnGapAlert(show, false, false, NOW)).toBeNull();
  });

  it('does not fire once a return shipment exists', () => {
    expect(planReturnGapAlert(show, true, true, NOW)).toBeNull();
  });

  it('gives move-out a day before complaining', () => {
    expect(planReturnGapAlert({ ...show, moveOutAt: hours(-3) }, true, false, NOW)).toBeNull();
  });
});

/* --------------------------------- keying ---------------------------------- */

describe('dedupe keys carry the deadline and the standing, never the estimate', () => {
  it('does not change when the carrier jitters its estimate', () => {
    const a = planShipmentAlert(alertable({ shipment: crate({ estimatedDelivery: days(7) }) }), NOW)!;
    const b = planShipmentAlert(
      alertable({ shipment: crate({ estimatedDelivery: hours(7 * 24 + 3) }) }),
      NOW,
    )!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('does change when the receiving deadline moves', () => {
    const a = planShipmentAlert(alertable({ shipment: crate({ estimatedDelivery: days(7) }) }), NOW)!;
    const b = planShipmentAlert(
      alertable({ shipment: crate({ mustArriveBy: days(5), estimatedDelivery: days(7) }) }),
      NOW,
    )!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('distinguishes one standing from another on the same crate', () => {
    const late = planShipmentAlert(alertable({ shipment: crate({ estimatedDelivery: days(7) }) }), NOW)!;
    const early = planShipmentAlert(
      alertable({
        shipment: crate({
          consignment: 'show_site',
          receivingOpensAt: days(5),
          estimatedDelivery: days(1),
        }),
      }),
      NOW,
    )!;
    expect(late.dedupeKey).not.toBe(early.dedupeKey);
  });
});

/* ----------------------------- reconciliation ------------------------------ */

const report = (over: Partial<TrackingReport> = {}): TrackingReport => ({
  provider: 'recorded',
  observedAt: NOW,
  phase: 'in_transit',
  estimatedDelivery: days(4),
  promisedDelivery: null,
  deliveredAt: null,
  signedBy: null,
  scans: [],
  ...over,
});

describe('reconcile', () => {
  it('patches nothing at all when the provider has no record', () => {
    const r = reconcile(crate(), { noRecord: true, provider: 'recorded', observedAt: NOW, reason: 'x' }, new Set());
    expect(r.patch).toBeNull();
    expect(r.changes).toEqual(['no_record']);
  });

  it('appends only scans it has not seen', () => {
    const scan = (iso: string) => ({
      occurredAt: new Date(iso),
      phase: 'in_transit' as const,
      message: 'Departed facility',
      location: 'Reno, NV, US',
      fingerprint: `${iso}|in_transit|Reno, NV, US`,
    });
    const known = new Set([scan('2026-03-08T00:00:00.000Z').fingerprint]);
    const r = reconcile(
      crate(),
      report({ scans: [scan('2026-03-08T00:00:00.000Z'), scan('2026-03-09T00:00:00.000Z')] }),
      known,
    );
    expect(r.newScans).toHaveLength(1);
    expect(r.changes).toContain('moved');
  });

  it('captures the promise once and never re-captures it', () => {
    const fresh = reconcile(crate({ promisedDelivery: null }), report(), new Set());
    expect(fresh.patch!.promisedDelivery?.toISOString()).toBe(days(4).toISOString());

    // A promise that followed the estimate could never be broken, which would
    // delete the feature while leaving its name on the screen.
    const later = reconcile(crate({ promisedDelivery: days(4) }), report({ estimatedDelivery: days(9) }), new Set());
    expect(later.patch!.promisedDelivery?.toISOString()).toBe(days(4).toISOString());
  });

  it('ignores a re-rounded estimate and notices a real slip', () => {
    const noise = reconcile(
      crate(),
      report({ estimatedDelivery: hours(4 * 24 + ESTIMATE_CHANGE_TOLERANCE_HOURS - 1) }),
      new Set(),
    );
    expect(noise.changes).not.toContain('estimate_slipped');

    const real = reconcile(crate(), report({ estimatedDelivery: days(6) }), new Set());
    expect(real.changes).toContain('estimate_slipped');
  });

  it('never un-delivers a crate on a poll that lost the scan', () => {
    const r = reconcile(crate({ deliveredAt: days(-1) }), report({ deliveredAt: null }), new Set());
    expect(r.patch!.deliveredAt?.toISOString()).toBe(days(-1).toISOString());
  });
});

/* --------------------------------- the board -------------------------------- */

describe('the board', () => {
  const row = (over: Partial<TrackedShipment>, id: string) =>
    buildShipmentRow(
      {
        ...alertable({ shipment: crate({ ...over, id }) }),
        showTimezone: 'America/Detroit',
        costs: { costCents: 120_000, declaredValueCents: null, pieces: 2, weightLb: '480.00' },
      },
      NOW,
    );

  /**
   * Soonest deadline first, and this reverses the assertion it replaces.
   *
   * Trouble used to sort above the clock. It stopped once the board grew a
   * horizon: every row on it is now a crate somebody still has to get to a dock,
   * and among those the deadline is the order the work happens in. Trouble did
   * not become invisible — the summary, the row's tone and the alerts card all
   * carry it without being scanned for.
   */
  it('puts the nearest deadline first, whatever is wrong further down', () => {
    const rows = orderShipments([
      row({ mustArriveBy: days(20), estimatedDelivery: days(25) }, 'far-and-late'),
      row({ mustArriveBy: days(3), estimatedDelivery: days(1) }, 'soon-and-fine'),
      row({ mustArriveBy: days(10), lastScanAt: hours(-100) }, 'silent'),
    ]);
    expect(rows.map((r) => r.shipment.id)).toEqual(['soon-and-fine', 'silent', 'far-and-late']);
  });

  /**
   * The one the flight board did not have to think about. An overdue crate has
   * the earliest deadline on the page, so ascending order puts the emergency at
   * the top on its own — no ranking required.
   */
  it('sorts an overdue crate above everything, because its deadline is earliest', () => {
    const rows = orderShipments([
      row({ mustArriveBy: days(3) }, 'next-week'),
      row({ mustArriveBy: days(-6) }, 'overdue-since-last-week'),
    ]);
    expect(rows[0].shipment.id).toBe('overdue-since-last-week');
  });

  /**
   * A crate with no deadline is a plan, not freight — an advance-warehouse
   * cutoff nobody has read off the manual yet. Treating a missing date as the
   * earliest would put every unread row above every real deadline, which is
   * `Number(null)` in a comparator.
   */
  it('sorts a crate with no deadline last rather than first', () => {
    const rows = orderShipments([
      row({ mustArriveBy: null }, 'no-date'),
      row({ mustArriveBy: days(30) }, 'next-month'),
    ]);
    expect(rows.map((r) => r.shipment.id)).toEqual(['next-month', 'no-date']);
  });

  // Severity is still what breaks a tie between two crates due at once.
  it('breaks a tie on what is wrong', () => {
    const due = days(4);
    const rows = orderShipments([
      row({ mustArriveBy: due }, 'fine'),
      row({ mustArriveBy: due, estimatedDelivery: days(6) }, 'late'),
    ]);
    expect(rows[0].shipment.id).toBe('late');
  });

  it('counts a delivered-but-unreceived crate as live rather than done', () => {
    const summary = summarizeShipments([
      row({ status: 'delivered', deliveredAt: hours(-4), receivedAt: null }, 'on-dock'),
      row({ status: 'delivered', deliveredAt: hours(-4), receivedAt: hours(-1) }, 'at-booth'),
    ]);
    expect(summary.unreceived).toBe(1);
    expect(summary.settled).toBe(1);
  });

  it('counts unowned crates in their own figure', () => {
    const unowned = buildShipmentRow(
      {
        ...alertable({ ownerId: null, ownerName: null }),
        showTimezone: 'America/Detroit',
        costs: { costCents: null, declaredValueCents: null, pieces: 1, weightLb: null },
      },
      NOW,
    );
    expect(summarizeShipments([unowned]).unowned).toBe(1);
  });
});

/* ------------------------------- validation -------------------------------- */

const draft = (over: Partial<ShipmentDraft> = {}): ShipmentDraft => ({
  description: 'Booth crate 1 of 2',
  direction: 'outbound',
  consignment: 'advance_warehouse',
  carrier: 'fedex',
  costCenterId: 'cc1',
  mustArriveOn: '2026-04-01',
  ...over,
});

describe('validateShipment', () => {
  it('refuses a show-site consignment with no dock-opening time', () => {
    expect(() => validateShipment(draft({ consignment: 'show_site' }))).toThrow(/dock opens/);
  });

  it('accepts an advance warehouse with no deadline, and says nothing about move-in', () => {
    const v = validateShipment(draft({ mustArriveOn: null }));
    expect(v.mustArriveByLocal).toBeNull();
  });

  it('refuses a window whose edges are the wrong way round', () => {
    expect(() =>
      validateShipment(
        draft({ consignment: 'show_site', receivingOpensOn: '2026-04-02', mustArriveOn: '2026-04-01' }),
      ),
    ).toThrow(/no window at all/);
  });

  it('keeps direction and consignment consistent', () => {
    expect(() => validateShipment(draft({ direction: 'return' }))).toThrow(/consigned to the office/);
    expect(() => validateShipment(draft({ consignment: 'office' }))).toThrow(
      /advance warehouse, to show-site/,
    );
  });

  // A parcel to a hotel is the one consignment that is not a rule about a dock,
  // which is why it is legal in both directions and never asks for a window.
  it('takes a direct parcel either way, and never asks it for a dock time', () => {
    expect(validateShipment(draft({ consignment: 'direct' })).consignment).toBe('direct');
    expect(
      validateShipment(draft({ consignment: 'direct', direction: 'return' })).direction,
    ).toBe('return');
    expect(
      validateShipment(draft({ consignment: 'direct' })).receivingOpensLocal,
    ).toBeNull();
  });

  it('requires a cost center, as every financial row does', () => {
    expect(() => validateShipment(draft({ costCenterId: '' }))).toThrow(/cost center/);
  });

  it('parses money as cents, never as a float', () => {
    const v = validateShipment(draft({ cost: '1450.55' }));
    expect(v.costCents).toBe(145_055);
  });

  it('names what deleting does not do, only when there is freight to name', () => {
    expect(describeDeletion({ trackingNumber: null, carrier: 'fedex', status: 'draft' })).toBeNull();
    expect(describeDeletion({ trackingNumber: '77123', carrier: 'fedex', status: 'in_transit' })).toContain(
      'does not cancel the shipment',
    );
  });
});

/* ------------------------------- the adapter ------------------------------- */

describe('the EasyPost normalizer', () => {
  it('does not call available_for_pickup delivered', () => {
    expect(phaseOf('available_for_pickup')).toBe('exception');
  });

  it('maps a tracker error to unknown rather than to a fact about the freight', () => {
    expect(phaseOf('error')).toBe('unknown');
    expect(phaseOf(undefined)).toBe('unknown');
  });

  it('builds a fingerprint that survives the carrier rewording a scan', () => {
    const at = new Date('2026-03-08T14:00:00Z');
    const a = fingerprintOf({ occurredAt: at, phase: 'in_transit', location: 'Reno, NV' });
    const b = fingerprintOf({ occurredAt: at, phase: 'in_transit', location: 'Reno, NV' });
    expect(a).toBe(b);
  });

  it('takes the delivery instant from the scan, not the summary', () => {
    const r = normalizeTracker(
      {
        status: 'delivered',
        est_delivery_date: '2026-03-14T00:00:00Z',
        tracking_details: [
          { datetime: '2026-03-13T18:02:00Z', status: 'delivered', message: 'Delivered', tracking_location: { city: 'Detroit', state: 'MI' } },
        ],
      },
      NOW,
    );
    expect(r.deliveredAt?.toISOString()).toBe('2026-03-13T18:02:00.000Z');
  });

  it('drops a scan with no time rather than guessing where it goes', () => {
    const r = normalizeTracker(
      { status: 'in_transit', tracking_details: [{ status: 'in_transit', message: 'Somewhere' }] },
      NOW,
    );
    expect(r.scans).toHaveLength(0);
  });

  it('throws naming the field on an unparseable timestamp', () => {
    expect(() => normalizeTracker({ status: 'in_transit', est_delivery_date: 'soon' }, NOW)).toThrow(
      /est_delivery_date/,
    );
  });

  it('joins a location out of the parts the carrier sent', () => {
    expect(locationOf({ city: 'Reno', state: 'NV', country: 'US' })).toBe('Reno, NV, US');
    expect(locationOf({})).toBeNull();
  });

  it('picks the newest tracker when a label was re-cut', () => {
    const chosen = selectTracker(
      [
        { tracking_code: 'X1', updated_at: '2026-01-01T00:00:00Z', id: 'old' },
        { tracking_code: 'X1', updated_at: '2026-03-01T00:00:00Z', id: 'new' },
      ],
      'X1',
    );
    expect(chosen?.id).toBe('new');
  });

  it('has no EasyPost carrier for a freight forwarder', () => {
    expect(carrierFor('other')).toBeNull();
    expect(carrierFor('fedex')).toBe('FedEx');
  });
});

describe('the recorded provider', () => {
  it('replays a stable scenario per tracking number', () => {
    expect(scenarioFor('7712345678')).toBe(scenarioFor('7712345678'));
  });

  it('never hands back a scan that has not happened yet', async () => {
    const provider = new RecordedTrackingProvider({ ABC: 'delivered' });
    const lookup = await provider.lookup({
      carrier: 'fedex',
      trackingNumber: 'ABC',
      shippedAt: new Date(Date.now() - 3_600_000),
      mustArriveBy: new Date(Date.now() + 10 * 86_400_000),
    });
    expect(isNoRecord(lookup)).toBe(false);
    if (!isNoRecord(lookup)) {
      expect(lookup.phase).not.toBe('delivered');
      for (const scan of lookup.scans) {
        expect(scan.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
      }
    }
  });

  it('stretches a recorded shape over the real window rather than a canned one', () => {
    const w = transitWindow({ carrier: 'ups', trackingNumber: 'x', shippedAt: days(-3), mustArriveBy: days(3) });
    expect(w.from.toISOString()).toBe(days(-3).toISOString());
    expect(w.to.toISOString()).toBe(days(3).toISOString());
  });

  it('falls back rather than anchoring an unscheduled crate to a fixed date', () => {
    const w = transitWindow({ carrier: 'ups', trackingNumber: 'x', shippedAt: days(-3) });
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
  });
});

describe('selectTrackingProvider — no fallback, ever', () => {
  it('throws naming the variable when nothing is configured', () => {
    expect(() => selectTrackingProvider({})).toThrow(/EASYPOST_API_KEY/);
  });

  it('replays only when asked out loud', () => {
    const choice = selectTrackingProvider({ SHIPMENT_TRACKING_PROVIDER: 'recorded' });
    expect(choice.source).toBe('recorded');
    expect(choice.replayed).toBe(true);
  });

  it('refuses a provider it does not have rather than picking one', () => {
    expect(() => selectTrackingProvider({ SHIPMENT_TRACKING_PROVIDER: 'shippo' })).toThrow(/not a tracking provider/);
  });

  it('uses EasyPost when there is a key', () => {
    const choice = selectTrackingProvider({ EASYPOST_API_KEY: 'k' });
    expect(choice.source).toBe('easypost');
    expect(choice.replayed).toBe(false);
  });
});
