import {
  MISSING_AFTER_HOURS,
  custodyOf,
  freightCoverage,
  serviceabilityOf,
  type FreightBounds,
  type Reservation,
  type TrackedAsset,
} from './custody';
import type { AssetClash } from './conflicts';
import type { CollateralItem, StockStanding } from './inventory';

/**
 * What an asset is owed tonight — which, as everywhere else, is usually nothing.
 *
 * The two dedupe-key shapes this product has argued itself into both appear
 * here, in one feature, for the reason they appeared together in §5g: assets
 * have both kinds of moving part.
 *
 * - A **reservation** alert is keyed to the reservation *and its window* (§5a).
 *   Move the dates and every claim already made about them is void, because they
 *   were claims about a window that no longer exists.
 * - A **stock** alert is keyed to the item and a *bucket* (§5b's shape). A
 *   quantity moves every time somebody picks a box; keying on the number would
 *   send "running low on datasheets" all afternoon.
 *
 * Audience follows §5a's third correction for the fifth time. A reservation's
 * natural addressee is whoever signed the asset out — and on the two alerts that
 * matter most, `never_collected` and `unserviceable`, nobody has signed it out,
 * so an addressed-to-the-holder engine would be silent on precisely the rows
 * that need it. Those escalate to whoever runs the show.
 *
 * One tense rule, taken from §5a and applying with full force to `missing`: past
 * the point where an asset can plausibly still turn up, "return it" is the wrong
 * sentence. The thing to do about an $84,000 booth nobody has seen in five weeks
 * is file an insurance claim, and the alert says so rather than nagging.
 */

export type AssetAlertReason =
  | 'never_returned'
  | 'missing'
  | 'never_collected'
  | 'unserviceable_reservation'
  | 'returned_damaged'
  | 'double_booked'
  | 'tight_turnaround'
  | 'window_short_of_freight'
  | 'low_stock'
  | 'oversubscribed_stock'
  | 'unreconciled_allocation';

export type PlannedAssetAlert = {
  assetId: string | null;
  itemId: string | null;
  reservationId: string | null;
  showId: string | null;
  /** Null when nobody holds this and the show's runners are the audience. */
  userId: string | null;
  reason: AssetAlertReason;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  dedupeKey: string;
};

export type AlertableReservation = {
  asset: TrackedAsset;
  reservation: Reservation;
  showId: string;
  showName: string;
  moveInAt: Date | null;
  holderId: string | null;
  holderName: string | null;
  freight?: FreightBounds;
};

const DAYS = (h: number) => `${(h / 24).toFixed(0)} days`;

function money(cents: number | null): string {
  if (cents === null) return 'unvalued';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function label(a: TrackedAsset): string {
  return a.assetTag ? `${a.name} (${a.assetTag})` : a.name;
}

/** §5a's rule: the window is part of the claim, so it is part of the key. */
function keyBase(r: Reservation): string {
  return `asset:${r.id}:${r.reservedFrom.toISOString()}:${r.reservedTo.toISOString()}`;
}

/**
 * The sentence that goes first when nobody holds the asset — first, not as a
 * footnote, because the missing custodian is not context for the problem, it is
 * how the problem got this far. §5a's third correction, verbatim.
 */
function unheldPrefix(item: AlertableReservation): string {
  return item.holderId
    ? ''
    : 'Nobody signed this out, so this is going to whoever runs the show rather than to a person ' +
        'who has it. Finding out who took it is the first thing to fix. ';
}

/**
 * Money at stake in a lost asset is *capital*, not a surcharge — so severity
 * tracks purchase value, unlike a deadline, where §5a is careful never to quote
 * an unconfirmed figure. A purchase value is not a prediction; it is what we paid.
 */
function lossSeverity(cents: number | null): 'warning' | 'critical' {
  return cents !== null && cents >= 1_000_000 ? 'critical' : 'warning';
}

export function planReservationAlert(
  item: AlertableReservation,
  asOf: Date,
): PlannedAssetAlert | null {
  const { asset, reservation: r, showId, showName } = item;
  const custody = custodyOf(r, asOf);
  const base = {
    assetId: asset.id,
    itemId: null,
    reservationId: r.id,
    showId,
    userId: item.holderId,
  };

  if (custody.standing === 'missing') {
    return {
      ...base,
      reason: 'missing',
      severity: 'critical',
      title: `${label(asset)} has not come back from ${showName}`,
      body:
        `${unheldPrefix(item)}Signed out${item.holderName ? ` by ${item.holderName}` : ''} and due ` +
        `back ${DAYS(custody.hoursPastDue)} ago — past ${DAYS(MISSING_AFTER_HOURS)}, which is the ` +
        `point where chasing it stops being the useful thing to do. ${money(asset.purchaseValueCents)} ` +
        'of capital. This is an insurance and replacement conversation, not a reminder: the next ' +
        'show that reserves it will find out on move-in morning.',
      dedupeKey: `${keyBase(r)}:missing`,
    };
  }

  if (custody.standing === 'overdue') {
    return {
      ...base,
      reason: 'never_returned',
      severity: lossSeverity(asset.purchaseValueCents),
      title: `${label(asset)} is ${DAYS(custody.hoursPastDue)} overdue back from ${showName}`,
      body:
        `${unheldPrefix(item)}Signed out ${item.holderName ? `by ${item.holderName} ` : ''}and not ` +
        `checked in. ${money(asset.purchaseValueCents)} of capital, and every later show that ` +
        'reserves it is being told it is available. Checking it in takes a sentence; the alternative ' +
        'is finding out a quarter from now, which is how capital assets get lost between shows.',
      dedupeKey: `${keyBase(r)}:overdue`,
    };
  }

  if (custody.standing === 'never_collected') {
    return {
      ...base,
      userId: null,
      reason: 'never_collected',
      severity: 'warning',
      title: `${label(asset)} was reserved for ${showName} and never signed out`,
      body:
        `The window closed ${DAYS(custody.hoursPastDue)} ago with nothing checked out against it. ` +
        'Either the show went without it — worth knowing, and worth knowing *why* before the next ' +
        'one reserves it too — or somebody took it and did not say. Both readings are a hole in the ' +
        'chain of custody, and a reservation row on a screen looks identical either way.',
      dedupeKey: `${keyBase(r)}:never-collected`,
    };
  }

  // Written on return rather than on the next reservation, so the damage is
  // reported once by the person who found it, not every night to everybody.
  if (custody.standing === 'returned' && custody.conditionChange === 'worsened') {
    return {
      ...base,
      userId: null,
      reason: 'returned_damaged',
      severity: 'warning',
      title: `${label(asset)} came back from ${showName} worse than it went`,
      body:
        `Signed out ${r.conditionOnCheckout} and checked in ${r.conditionOnReturn}. That delta is ` +
        'only visible because both ends were recorded; it is the reason the reservation carries a ' +
        'condition at checkout rather than reading it off the asset, which by now says the same ' +
        'thing as the return and cannot say when it started. Repair before the next show reserves it.',
      dedupeKey: `${keyBase(r)}:worsened:${r.conditionOnReturn}`,
    };
  }

  // A future claim invalidated by a past fact. Nothing joins these two on a
  // screen, which is exactly why it needs an engine.
  if (custody.standing === 'planned' || custody.standing === 'due_out') {
    const service = serviceabilityOf(asset);
    if (service.kind === 'unserviceable') {
      return {
        ...base,
        userId: null,
        reason: 'unserviceable_reservation',
        severity: 'warning',
        title: `${label(asset)} is reserved for ${showName} and is ${service.why}`,
        body:
          `The reservation renders as a filled slot and the condition renders as a label on a ` +
          `different screen; nothing puts them together. ${label(asset)} is ${service.why}, and it ` +
          `is promised to ${showName}. Repair it, swap it, or drop the reservation — but do it now, ` +
          'while all three are still options, rather than when the crate is opened on the floor.',
        dedupeKey: `${keyBase(r)}:unserviceable:${asset.condition}`,
      };
    }
  }

  // Where assets meet freight. Only worth saying while the outbound crate has
  // not gone: afterwards it is a record-keeping correction, not a decision.
  if (item.freight && (custody.standing === 'planned' || custody.standing === 'due_out')) {
    const coverage = freightCoverage(r, item.freight);
    if (coverage.kind === 'short') {
      const parts: string[] = [];
      if (coverage.opensLateHours !== null) {
        parts.push(
          `the crate has to be at the dock ${DAYS(coverage.opensLateHours)} before the reservation ` +
            'opens, so the asset leaves while it is still recorded as available',
        );
      }
      if (coverage.closesEarlyHours !== null) {
        parts.push(
          `the reservation closes ${DAYS(coverage.closesEarlyHours)} before the freight is expected ` +
            'home, so it reads as back on the shelf while it is still on a truck',
        );
      }
      return {
        ...base,
        userId: null,
        reason: 'window_short_of_freight',
        severity: 'info',
        title: `${label(asset)}'s reservation for ${showName} is shorter than its freight`,
        body:
          `${parts.join('; and ')}. A reservation window is a claim about when the thing cannot be ` +
          'promised elsewhere, and the freight rows are the record of when it is actually gone. ' +
          'The days between the two are the days it is double-promised without anything saying so.',
        dedupeKey: `${keyBase(r)}:short-window`,
      };
    }
  }

  return null;
}

/**
 * A clash is about two reservations, so it is keyed to both — and to both
 * windows, since moving either one is what resolves it.
 */
export function planClashAlert(clash: AssetClash): PlannedAssetAlert {
  const ids = [clash.a.reservationId, clash.b.reservationId].sort();
  const windows = [
    clash.a.from.toISOString(),
    clash.a.to.toISOString(),
    clash.b.from.toISOString(),
    clash.b.to.toISOString(),
  ].join('|');
  return {
    assetId: clash.assetId,
    itemId: null,
    reservationId: null,
    showId: clash.a.showId,
    userId: null,
    reason: clash.kind === 'overlap' ? 'double_booked' : 'tight_turnaround',
    severity: clash.kind === 'overlap' ? 'critical' : 'info',
    title:
      clash.kind === 'overlap'
        ? `${clash.assetName} is promised to ${clash.a.showName} and ${clash.b.showName} at once`
        : `${clash.assetName} has almost no turnaround between ${clash.a.showName} and ${clash.b.showName}`,
    body: clash.detail,
    dedupeKey: `asset-clash:${ids.join(':')}:${windows}`,
  };
}

/* --------------------------------- stock ----------------------------------- */

export type AlertableStock = {
  item: CollateralItem;
  standing: StockStanding;
};

/**
 * Bucketed, not quantified — §5b's key shape rather than §5a's. The body still
 * quotes the number, because a stock figure is a count of things on a shelf and
 * not a prediction about a penalty; what the key refuses to carry is the number,
 * so restocking one box does not fire a fresh alert about the next one.
 */
export function planStockAlert(s: AlertableStock): PlannedAssetAlert | null {
  const { item, standing } = s;
  if (standing.level === 'ok') return null;

  const base = {
    assetId: null,
    itemId: item.id,
    reservationId: null,
    showId: null,
    userId: null,
  };

  if (standing.level === 'short') {
    return {
      ...base,
      reason: 'oversubscribed_stock',
      severity: 'critical',
      title: `${item.name} is promised ${-standing.available} more than we hold`,
      body:
        `${standing.onHand} on the shelf, ${standing.committed} promised to shows that have not ` +
        'packed yet. Somebody is going to open the cupboard and find it short, and the show that ' +
        'finds out is whichever one packs last rather than whichever one was promised last. ' +
        'Reorder, or cut an allocation, while there is still a choice about which.',
      dedupeKey: `collateral:${item.id}:short`,
    };
  }

  // With nothing promised the two figures agree, and saying "0 of those are
  // promised" would spend the sentence explaining a distinction that is not
  // doing any work on this row. The correction is worth stating where it bites.
  const gap =
    standing.committed > 0
      ? `${standing.onHand} on hand, but ${standing.committed} of those are already promised, so ` +
        `${standing.available} is what is actually free — at or under the ${standing.threshold} ` +
        'threshold. The on-hand figure is the one on every screen, and it is the one that reads ' +
        'fine right up to the morning of the pack.'
      : `${standing.available} on hand and none of it promised, against a threshold of ` +
        `${standing.threshold}. Nothing is hiding here — there is simply not much left.`;

  return {
    ...base,
    reason: 'low_stock',
    severity: 'warning',
    title: `${item.name} is down to ${standing.available} available`,
    body: gap,
    dedupeKey: `collateral:${item.id}:low`,
  };
}

export type AlertableAllocation = {
  itemName: string;
  itemId: string;
  allocationId: string;
  showId: string;
  showName: string;
  quantityAllocated: number;
  moveOutAt: Date | null;
};

/**
 * The one that fires on an absence, the way §5g's return-gap alert does: a show
 * that ended with stock in a crate and no count against it. There is a row here,
 * unlike §5g's — but the row is silent, which on a screen is the same thing.
 */
export function planUnreconciledAlert(
  a: AlertableAllocation,
  asOf: Date,
  graceDays = 14,
): PlannedAssetAlert | null {
  if (!a.moveOutAt) return null;
  const days = (asOf.getTime() - a.moveOutAt.getTime()) / 86_400_000;
  if (days < graceDays) return null;
  return {
    assetId: null,
    itemId: a.itemId,
    reservationId: null,
    showId: a.showId,
    userId: null,
    reason: 'unreconciled_allocation',
    severity: 'info',
    title: `Nobody counted the ${a.itemName} back from ${a.showName}`,
    body:
      `${a.quantityAllocated} went out and ${a.showName} moved out ${days.toFixed(0)} days ago with ` +
      'no count against it. That is not the same as "none came back" — which would be an ordinary ' +
      'result for swag — and the app must not guess which: reading it as zero writes off stock we ' +
      'still own, reading it as full ships the next show short. A count of zero is a fine answer ' +
      'and takes one field.',
    dedupeKey: `collateral-alloc:${a.allocationId}:unreconciled`,
  };
}
