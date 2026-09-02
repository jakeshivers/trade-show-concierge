import {
  bufferVerdict,
  effectiveStatus,
  expectedArrival,
  freshnessOf,
  type BufferVerdict,
  type EffectiveStatus,
  type Freshness,
  type TrackedFlight,
} from './status';
import { planFlightAlert, type AlertableFlight, type PlannedFlightAlert } from './alerts';

/**
 * The board's ordering and its summary. Pure.
 *
 * A departure board sorts by departure time, because at an airport every flight
 * on it leaves from where you are standing. This one must not: it is read by
 * somebody responsible for twenty people across five shows, and the flight that
 * needs them is rarely the next one to leave. So rows sort by **what is wrong**,
 * and time only breaks ties within a severity.
 *
 * The summary deliberately counts `unknown` as its own figure rather than
 * folding it into "on time". A board that says "14 tracked, 14 on time" when it
 * has checked none of them is worse than an empty screen, because an empty
 * screen does not get believed.
 */

/**
 * The booked facts, which are not tracking facts.
 *
 * Kept off `TrackedFlight` deliberately: `status.ts` and `alerts.ts` must not be
 * able to see a fare. Whether a flight will make move-in is not a question about
 * money, and a judgment layer holding a price is a judgment layer that can
 * eventually be written to weigh one.
 */
export type BookedFacts = {
  priceCents: number | null;
  seat: string | null;
  cabin: string | null;
  bookingProvider: string | null;
  bookingReference: string | null;
};

export type BoardRow = {
  flight: TrackedFlight;
  booked: BookedFacts;
  travelerId: string;
  travelerName: string;
  showId: string | null;
  showName: string | null;
  showTimezone: string | null;
  status: EffectiveStatus;
  freshness: Freshness;
  buffer: BufferVerdict;
  expectedArrival: Date | null;
  /** What the engine would say about this row right now, or nothing. */
  alert: PlannedFlightAlert | null;
};

export type BoardSummary = {
  tracked: number;
  disrupted: number;
  /** Delayed, but with the buffer still holding — noise, counted separately. */
  delayedButClear: number;
  bufferAtRisk: number;
  unknown: number;
  neverChecked: number;
};

const SEVERITY_RANK: Record<EffectiveStatus, number> = {
  cancelled: 0,
  diverted: 1,
  delayed: 2,
  unknown: 3,
  active: 4,
  scheduled: 5,
  landed: 6,
};

/** Buffer trouble outranks the status enum: it is the thing with consequences. */
function rank(row: BoardRow): number {
  if (row.buffer.standing === 'after_move_in') return -2;
  if (row.buffer.brokenSincePurchase) return -1;
  return SEVERITY_RANK[row.status];
}

export function buildBoardRow(
  item: AlertableFlight & { showTimezone: string | null; booked: BookedFacts },
  asOf: Date,
): BoardRow {
  return {
    flight: item.flight,
    booked: item.booked,
    travelerId: item.travelerId,
    travelerName: item.travelerName,
    showId: item.showId,
    showName: item.showName,
    showTimezone: item.showTimezone,
    status: effectiveStatus(item.flight, asOf),
    freshness: freshnessOf(item.flight, asOf),
    buffer: bufferVerdict(item.flight, item.context),
    expectedArrival: expectedArrival(item.flight),
    alert: planFlightAlert(item, asOf),
  };
}

/**
 * Soonest first, and severity is the tie-break rather than the key.
 *
 * This was severity-first for twelve steps, on the argument that a board sorted
 * by departure puts the flight that needs somebody underneath the one that is
 * merely next. That argument was answered by the horizon rather than refuted:
 * once the board stopped carrying legs that had already landed, everything on it
 * is a flight somebody still has to catch, and among those the clock is what
 * orders the work. A screen where Oct 27 sits above Oct 21 is one a person has
 * to re-sort in their head every time they read it, and they will stop reading
 * it — which costs more than the ranking ever bought.
 *
 * What was actually load-bearing in the old order is kept and moved to where it
 * belongs. Trouble is not discoverable by scanning rows either way: it is in the
 * summary at the top of the page, in the tone on each row, and in the alerts
 * card, which is written by the engine and is the thing that speaks without
 * being looked for. Severity still breaks ties, so two legs leaving in the same
 * minute put the cancelled one first.
 */
export function orderBoard(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    const byTime =
      a.flight.scheduledDeparture.getTime() - b.flight.scheduledDeparture.getTime();
    if (byTime !== 0) return byTime;
    return rank(a) - rank(b);
  });
}

export function summarizeBoard(rows: BoardRow[]): BoardSummary {
  const s: BoardSummary = {
    tracked: rows.length,
    disrupted: 0,
    delayedButClear: 0,
    bufferAtRisk: 0,
    unknown: 0,
    neverChecked: 0,
  };
  for (const r of rows) {
    if (r.status === 'cancelled' || r.status === 'diverted') s.disrupted += 1;
    if (r.status === 'unknown') s.unknown += 1;
    if (r.freshness.kind === 'never_checked') s.neverChecked += 1;
    if (r.buffer.standing === 'after_move_in' || r.buffer.brokenSincePurchase) s.bufferAtRisk += 1;
    else if (r.status === 'delayed') s.delayedButClear += 1;
  }
  return s;
}
