import {
  effectiveStatus,
  expectedArrival,
  freshnessOf,
  stallOf,
  windowVerdict,
  type Freshness,
  type ShipmentPhase,
  type Stall,
  type TrackedShipment,
  type WindowVerdict,
} from './status';
import { planShipmentAlert, type AlertableShipment, type PlannedShipmentAlert } from './alerts';

/**
 * The shipping board's ordering and its summary. Pure.
 *
 * Same argument as `flights/board.ts`, with one figure that does not exist
 * there. A shipping board sorted by delivery date puts the crate arriving
 * tomorrow above the crate that has not moved in five days, which is precisely
 * backwards: the second one is the emergency and the first is a lorry doing its
 * job. So rows sort by **what is wrong**, and dates only break ties.
 *
 * `unreceived` is the figure with no counterpart on the flight board. A flight
 * that landed is over; a crate that was delivered is halfway. Folding delivered
 * crates into a "done" count is how a booth ends up empty on the first morning
 * with every screen in the product showing green.
 */

export type ShipmentCosts = {
  costCents: number | null;
  declaredValueCents: number | null;
  pieces: number;
  weightLb: string | null;
};

export type ShipmentRow = {
  shipment: TrackedShipment;
  costs: ShipmentCosts;
  showId: string;
  showName: string;
  showTimezone: string | null;
  moveInAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
  status: ShipmentPhase;
  freshness: Freshness;
  window: WindowVerdict;
  stall: Stall;
  expectedArrival: Date | null;
  /** What the engine would say about this row right now, or nothing. */
  alert: PlannedShipmentAlert | null;
};

export type ShipmentBoardSummary = {
  tracked: number;
  /** Expected to miss the receiving deadline, or already has. */
  missingWindow: number;
  /** Silent for longer than freight normally goes silent. */
  stalled: number;
  /** Delivered to a dock and not yet confirmed at the booth. */
  unreceived: number;
  /** Nobody is watching these, which is why they are counted separately. */
  unowned: number;
  unknown: number;
  neverChecked: number;
  /** Landed inside the window, confirmed by a person. The quiet good figure. */
  settled: number;
};

const SEVERITY_RANK: Record<ShipmentPhase, number> = {
  exception: 0,
  returned: 1,
  unknown: 2,
  in_transit: 3,
  out_for_delivery: 4,
  label_created: 5,
  draft: 6,
  delivered: 7,
  cancelled: 8,
};

/** Window trouble and silence both outrank the status enum: they have consequences. */
function rank(row: ShipmentRow): number {
  if (row.window.standing === 'late') return -4;
  if (row.stall.kind !== 'moving') return -3;
  if (row.window.standing === 'too_early') return -2;
  if (row.shipment.deliveredAt && !row.shipment.receivedAt) return -1;
  if (row.window.standing === 'tight') return -0.5;
  return SEVERITY_RANK[row.status];
}

export function buildShipmentRow(
  item: AlertableShipment & {
    showTimezone: string | null;
    costs: ShipmentCosts;
  },
  asOf: Date,
): ShipmentRow {
  return {
    shipment: item.shipment,
    costs: item.costs,
    showId: item.showId,
    showName: item.showName,
    showTimezone: item.showTimezone,
    moveInAt: item.moveInAt,
    ownerId: item.ownerId,
    ownerName: item.ownerName,
    status: effectiveStatus(item.shipment, asOf),
    freshness: freshnessOf(item.shipment, asOf),
    window: windowVerdict(item.shipment, item.context),
    stall: stallOf(item.shipment, asOf),
    expectedArrival: expectedArrival(item.shipment),
    alert: planShipmentAlert(item, asOf),
  };
}

/**
 * Soonest deadline first, and severity is the tie-break rather than the key.
 *
 * The flight board's change, arrived at the same way and landing somewhere
 * slightly different. It was worst-first, on the argument that a shipping screen
 * sorted by delivery date puts the crate arriving tomorrow above the crate that
 * has not moved in five days. Once the board stops carrying settled freight,
 * every row on it is a crate somebody still has to get to a dock, and among
 * those the deadline is the order the work happens in.
 *
 * Two things fall out that the flight board did not have to think about, and
 * both are why this ordering is *more* right here than there.
 *
 * **Ascending puts the most overdue first, not last.** A crate whose cutoff was
 * last Tuesday and which nobody has confirmed is the emergency on this page, and
 * the earliest deadline is exactly where it sorts. The old ranking reached the
 * same row by a different route; the clock gets there on its own.
 *
 * **A crate with no deadline sorts last, and that is a judgement.** No date
 * recorded means a plan rather than freight — an advance-warehouse cutoff nobody
 * has read off the manual yet. Treating a missing date as the earliest one would
 * put every unread row above every real deadline, which is the `Number(null)`
 * mistake in a comparator.
 */
export function orderShipments(rows: ShipmentRow[]): ShipmentRow[] {
  return [...rows].sort((a, b) => {
    const at = a.shipment.mustArriveBy?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = b.shipment.mustArriveBy?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return rank(a) - rank(b);
  });
}

export function summarizeShipments(rows: ShipmentRow[]): ShipmentBoardSummary {
  const s: ShipmentBoardSummary = {
    tracked: rows.length,
    missingWindow: 0,
    stalled: 0,
    unreceived: 0,
    unowned: 0,
    unknown: 0,
    neverChecked: 0,
    settled: 0,
  };
  for (const r of rows) {
    const w = r.window.standing;
    if (w === 'late' || w === 'too_early' || w === 'arrived_late' || w === 'arrived_early') {
      s.missingWindow += 1;
    }
    if (r.stall.kind !== 'moving') s.stalled += 1;
    if (r.shipment.deliveredAt && !r.shipment.receivedAt) s.unreceived += 1;
    if (!r.ownerId) s.unowned += 1;
    if (r.status === 'unknown') s.unknown += 1;
    if (r.freshness.kind === 'never_checked') s.neverChecked += 1;
    if (r.shipment.receivedAt && (w === 'arrived' || w === 'not_applicable')) s.settled += 1;
  }
  return s;
}
