import {
  effectiveStatus,
  stallOf,
  windowVerdict,
  type TrackedShipment,
  type WindowContext,
  type WindowVerdict,
} from './status';

/**
 * What a crate is owed tonight — or, far more often, that it is owed nothing.
 *
 * §5a's four rules and §5f's fifth all apply here, and the interesting part is
 * that two of them come out **inverted**:
 *
 * - **§5f said a delayed flight home says nothing.** A delayed crate on the way
 *   home says plenty. A return shipment is the one that actually goes missing,
 *   and the loss surfaces a quarter later when the booth is not there for the
 *   next show — by which time there is no tracking number, no claim window, and
 *   nobody who remembers which contractor loaded it. Going quiet about the trip
 *   home is right for people and wrong for freight.
 *
 * - **§5a said an alert is keyed to the deadline and its date; §5f said it is
 *   keyed to the standing, not the number.** Shipping needs both at once,
 *   because it has both kinds of moving part: a receiving deadline that moves
 *   rarely and deliberately, and a carrier estimate that moves every time
 *   anybody asks. So the key carries the deadline *and* the standing, and
 *   carries the estimate nowhere near it.
 *
 * And the audience rule is §5a's third correction verbatim, from a fourth
 * direction: `shipments.owner_id` is nullable, an owner-addressed alert on an
 * unowned crate reaches nobody, and that is exactly the crate most likely to be
 * missed. Unownedness escalates and gets named as the first thing to fix.
 */

export type AlertableShipment = {
  shipment: TrackedShipment;
  showId: string;
  showName: string;
  moveInAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
  context?: WindowContext;
};

export type ShipmentAlertReason =
  | 'late'
  | 'too_early'
  | 'stalled'
  | 'never_scanned'
  | 'no_tracking'
  | 'exception'
  | 'returned'
  | 'arrived_late'
  | 'delivered_not_received'
  | 'return_leg_missing';

export type PlannedShipmentAlert = {
  shipmentId: string | null;
  showId: string;
  /** Null when nobody owns this and the show's runners are the audience. */
  ownerId: string | null;
  reason: ShipmentAlertReason;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  dedupeKey: string;
};

const HOURS = (h: number) => `${h.toFixed(1)}h`;
const DAYS = (h: number) => `${(h / 24).toFixed(1)} days`;

function crate(s: TrackedShipment): string {
  return `${s.description}${s.trackingNumber ? ` (${s.carrier.toUpperCase()} ${s.trackingNumber})` : ''}`;
}

/**
 * Keyed to the deadline and the standing; never to the estimate. See the header.
 * When the deadline moves, every alert already sent about it is void — which is
 * right, because they were claims about a date that no longer exists.
 */
function keyBase(s: TrackedShipment): string {
  return `shipment:${s.id}:${s.mustArriveBy?.toISOString() ?? 'no-deadline'}`;
}

/**
 * The sentence that gets prepended when nobody owns the crate.
 *
 * Deliberately first in the body rather than a footnote: the missing owner is
 * not context for the problem, it is the reason the problem got this far.
 */
function unownedPrefix(item: AlertableShipment): string {
  return item.ownerId
    ? ''
    : 'Nobody owns this shipment, so this is going to whoever runs the show rather than to a ' +
        'person who was watching it. Assigning an owner is the first thing to fix. ';
}

function windowClause(v: WindowVerdict, s: TrackedShipment): string {
  if (v.hoursSpare === null || !s.mustArriveBy) return '';
  if (v.standing === 'late') {
    return (
      ` The carrier now expects it ${HOURS(Math.abs(v.hoursSpare))} AFTER it has to be there` +
      (v.brokenSincePromise
        ? ', and it was promised inside the deadline when the label was made — this slipped after we committed to it.'
        : '.')
    );
  }
  if (v.standing === 'tight') {
    return ` It is expected ${HOURS(v.hoursSpare)} before the deadline, inside the ${v.bufferHours}h margin.`;
  }
  return ` It is expected ${HOURS(v.hoursSpare)} before the deadline.`;
}

export function planShipmentAlert(
  item: AlertableShipment,
  asOf: Date,
): PlannedShipmentAlert | null {
  const { shipment: s, showId, showName, ownerId } = item;
  const status = effectiveStatus(s, asOf);
  const verdict = windowVerdict(s, item.context);
  const stall = stallOf(s, asOf);
  const base = keyBase(s);
  const at = (reason: ShipmentAlertReason, rest: Omit<PlannedShipmentAlert, 'shipmentId' | 'showId' | 'ownerId' | 'reason' | 'dedupeKey'> & { key: string }) => ({
    shipmentId: s.id,
    showId,
    ownerId,
    reason,
    severity: rest.severity,
    title: rest.title,
    body: unownedPrefix(item) + rest.body,
    dedupeKey: `${base}:${rest.key}`,
  });

  if (status === 'cancelled') return null;

  if (status === 'returned') {
    return at('returned', {
      severity: 'critical',
      title: `Coming back, not going: ${crate(s)}`,
      key: 'returned',
      body:
        `The carrier is returning this to sender rather than delivering it to ${showName}. ` +
        'Nothing in this app re-ships it — the crate is physically on a truck going the wrong ' +
        'way, and the next move is a call to the carrier and then a new shipment record here.',
    });
  }

  if (status === 'exception') {
    return at('exception', {
      severity: 'critical',
      title: `Delivery exception: ${crate(s)}`,
      key: 'exception',
      body:
        `The carrier has flagged a problem with this delivery for ${showName}.` +
        windowClause(verdict, s) +
        ' An exception does not resolve itself and the clock does not stop for it.',
    });
  }

  // Delivered is not received, and this is where that distinction earns itself.
  // The alert only fires once move-in is actually under way: a crate sitting at
  // an advance warehouse for three weeks is not a problem, it is the plan.
  if (s.deliveredAt && !s.receivedAt) {
    const moveInStarted = item.moveInAt !== null && asOf.getTime() >= item.moveInAt.getTime();
    if (moveInStarted) {
      return at('delivered_not_received', {
        severity: 'warning',
        title: `Delivered, but nobody has it: ${crate(s)}`,
        key: 'delivered_not_received',
        body:
          `The carrier signed this off at a dock ${DAYS((asOf.getTime() - s.deliveredAt.getTime()) / 3_600_000)} ago and ` +
          `move-in at ${showName} has started, but nobody has confirmed the crate reached the booth. ` +
          'Between the dock and the booth is drayage, which is a different contractor on its own ' +
          'schedule that this app cannot see — and a crate in the marshalling yard looks exactly ' +
          'like a delivered one on every screen except this line.',
      });
    }
    // Delivered and late is a bill, not an emergency. Past tense, once. §5a.
    if (verdict.standing === 'arrived_late') {
      return at('arrived_late', {
        severity: 'info',
        title: `Arrived late: ${crate(s)}`,
        key: 'arrived_late',
        body:
          `It was delivered ${HOURS(Math.abs(verdict.hoursSpare ?? 0))} after the receiving deadline for ` +
          `${showName}. There is nothing left to hurry about; whatever surcharge this carries has ` +
          'been incurred, not risked, and it belongs in the show’s true cost rather than in a warning.',
      });
    }
    if (verdict.standing === 'arrived_early') {
      return at('too_early', {
        severity: 'warning',
        title: `Delivered before the dock opened: ${crate(s)}`,
        key: 'arrived_early',
        body:
          `Show-site receiving for ${showName} had not opened when the carrier delivered this. ` +
          'Every status column calls that a success. On a show floor it means refused, held at the ' +
          'carrier’s rate, or signed for by somebody who was not expecting it — worth confirming ' +
          'where the crate physically is before treating this as done.',
      });
    }
    return null;
  }

  // Still moving, or meant to be.

  // Before any claim about *when* it will arrive: whether there is anything to
  // make the claim about. "There is no crate" precedes "the crate is late", and
  // saying the second when the first is true points at a truck that does not
  // exist while the real problem — nothing has been handed to a carrier — goes
  // unsaid.
  if (!s.trackingNumber && s.mustArriveBy) {
    const hoursOut = (s.mustArriveBy.getTime() - asOf.getTime()) / 3_600_000;
    if (hoursOut < 7 * 24) {
      return at('no_tracking', {
        severity: hoursOut < 48 ? 'critical' : 'warning',
        title: `No tracking number, due in ${DAYS(hoursOut)}: ${crate(s)}`,
        key: 'no_tracking',
        body:
          `This shipment has a receiving deadline at ${showName} and nothing to track it by. ` +
          'Until there is a number this row is a plan, not a crate, and nothing here can tell you ' +
          'whether anything has actually left the building.',
      });
    }
  }

  if (verdict.standing === 'late') {
    return at('late', {
      severity: 'critical',
      title: `Will miss the receiving deadline: ${crate(s)}`,
      key: 'late',
      body:
        `This crate is due at ${showName} before the floor stops taking freight.` +
        windowClause(verdict, s) +
        ' Late freight is the drayage surcharge the deadline register exists to prevent, and — ' +
        'unlike a deadline on a form — this one is a truck that is already somewhere.',
    });
  }

  if (verdict.standing === 'too_early') {
    return at('too_early', {
      severity: 'warning',
      title: `Arriving before the dock opens: ${crate(s)}`,
      key: 'too_early',
      body:
        `Show-site receiving at ${showName} does not open until move-in, and the carrier expects ` +
        'to deliver before then. That is not early, it is a refusal: the dock is not staffed, and ' +
        'the crate is held at the carrier’s rate or sent back. Either hold the shipment or ' +
        'consign it to the advance warehouse, which accepts freight for weeks.',
    });
  }

  if (stall.kind === 'never_scanned') {
    return at('never_scanned', {
      severity: 'warning',
      title: `Label made, never picked up: ${crate(s)}`,
      key: 'never_scanned',
      body:
        `This has had a tracking number for ${DAYS(stall.sinceHours)} and the carrier has never ` +
        'scanned it. A printed label that nobody handed over is the commonest way a crate misses ' +
        'a show, and it is invisible on every screen because the row looks complete.' +
        windowClause(verdict, s),
    });
  }

  if (stall.kind === 'stalled') {
    return at('stalled', {
      severity: 'warning',
      title: `No movement for ${DAYS(stall.sinceHours)}: ${crate(s)}`,
      key: 'stalled',
      body:
        `Nothing in the carrier's own payload says anything is wrong — it is still promising a ` +
        `delivery date, and the status still reads in transit. There has simply been no scan in ` +
        `${DAYS(stall.sinceHours)}, against ${DAYS(stall.expectedWithinHours)} of normal quiet for ` +
        'freight this close to its deadline.' +
        windowClause(verdict, s) +
        (s.direction === 'return'
          ? ' This is the leg home, which is the one that actually goes missing: a return crate ' +
            'nobody chased is discovered next quarter, when the booth is not there for the next show.'
          : ''),
    });
  }

  return null;
}

/**
 * The leg home nobody filed.
 *
 * This is the one alert in the product with no row behind it, and that is the
 * point: it fires on the **absence** of a shipment. A show whose move-out has
 * passed with no return shipment recorded is the single most expensive silence
 * in this domain — the booth is somewhere, on somebody's truck, under a number
 * nobody wrote down. §5f's rule that a delayed flight home says nothing is right
 * for people and exactly backwards for freight.
 */
export function planReturnGapAlert(
  show: { id: string; name: string; moveOutAt: Date | null },
  hasOutbound: boolean,
  hasReturn: boolean,
  asOf: Date,
): PlannedShipmentAlert | null {
  if (!show.moveOutAt || hasReturn) return null;
  // Nothing went out, so nothing is coming back. A show we shipped nothing to
  // does not owe a return leg, and flagging it would flag every show.
  if (!hasOutbound) return null;
  const hoursSince = (asOf.getTime() - show.moveOutAt.getTime()) / 3_600_000;
  if (hoursSince < 24) return null;

  return {
    shipmentId: null,
    showId: show.id,
    ownerId: null,
    reason: 'return_leg_missing',
    severity: 'warning',
    title: `Nothing recorded coming back from ${show.name}`,
    body:
      `Move-out was ${DAYS(hoursSince)} ago and freight went out to this show, but no return ` +
      'shipment has been recorded. Whatever was in the booth is on a truck under a number nobody ' +
      'has written down. This is the failure that surfaces a quarter later, when the crate is not ' +
      'there for the next show and the claim window has closed.',
    dedupeKey: `show:${show.id}:return_leg_missing:${show.moveOutAt.toISOString()}`,
  };
}

export function planShipmentAlerts(
  items: AlertableShipment[],
  asOf: Date,
): PlannedShipmentAlert[] {
  const order: Record<PlannedShipmentAlert['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  return items
    .map((i) => planShipmentAlert(i, asOf))
    .filter((a): a is PlannedShipmentAlert => a !== null)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}
