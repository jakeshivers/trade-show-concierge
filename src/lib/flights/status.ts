import type { StatusLookup, StatusPhase, StatusReport } from '@/lib/integrations/flightstatus/types';
import { isNoRecord } from '@/lib/integrations/flightstatus/types';

/**
 * What a status reading *means*. Pure, and the clock is a parameter.
 *
 * The whole of step 13 turns on one distinction that a flight-tracking screen
 * makes it very easy to miss: **a delay is not news; a delay that costs you
 * something is.** Forty minutes on a flight landing three days before move-in is
 * weather. The same forty minutes on a flight landing four hours and twenty
 * minutes before move-in has just spent the arrival buffer that §7's policy rule
 * required before the ticket could be bought at all — and nobody would find that
 * out, because the buffer was checked once, against an offer, at purchase, and
 * never again. That is the gap this file closes, and it closes it by reading the
 * *same* rule the policy engine reads rather than writing a second copy of "four
 * hours" that can drift from the org's policy without anybody noticing.
 *
 * Three further distinctions live here, each one a way a naive board lies:
 *
 * - **A re-timed flight is not a delayed flight.** Airlines move flights weeks
 *   out. Written into `estimated_*` that reads as a three-hour delay on a flight
 *   that is running perfectly; written into `scheduled_*` it erases the
 *   itinerary the policy verdict was computed against. It is a third thing, it
 *   gets its own columns and its own alert, and it invalidates the buffer
 *   verdict in a way a delay does not — because there is still time to rebook.
 *
 * - **Not knowing is not the same as on time**, and it is the default. A row
 *   nobody has checked reads `scheduled`, which renders on a board as the calm
 *   green one. A board that has not refreshed in eight hours therefore shows a
 *   full slate of on-time flights, which is the single most dangerous thing this
 *   screen could do. Staleness is computed against the flight's own timeline —
 *   an unchecked flight three weeks out is fine; an unchecked flight that should
 *   already have taken off is `unknown`, and says when it was last checked.
 *
 * - **A flight with no show has no buffer to blow**, and that is a verdict, not
 *   a gap. `policy/rules.ts` already returns `not_applicable` for the arrival
 *   buffer when a trip has no move-in time attached; this returns the same
 *   answer for the same reason instead of inventing a second convention.
 */

export type TrackedFlight = {
  id: string;
  airlineCode: string;
  flightNumber: string;
  originAirport: string;
  destinationAirport: string;
  /** For rendering only: a departure happens at the origin airport's clock. */
  originTimeZone: string | null;
  destinationTimeZone: string | null;
  scheduledDeparture: Date;
  scheduledArrival: Date;
  estimatedDeparture: Date | null;
  estimatedArrival: Date | null;
  providerScheduledDeparture: Date | null;
  providerScheduledArrival: Date | null;
  scheduleChangedAt: Date | null;
  status: StatusPhase | 'delayed';
  delayMinutes: number;
  departureGate: string | null;
  divertedToAirport: string | null;
  lastCheckedAt: Date | null;
  statusProvider: string | null;
};

/* ------------------------------- freshness --------------------------------- */

export type Freshness =
  | { kind: 'never_checked' }
  | { kind: 'fresh'; ageMinutes: number }
  | { kind: 'stale'; ageMinutes: number; expectedEveryMinutes: number };

/**
 * How often a flight is worth re-checking, by how close it is.
 *
 * Not a constant, because the cost of a stale reading is not a constant: a
 * flight three weeks out cannot meaningfully change between checks, and a flight
 * that boards in ninety minutes can change everything. These are the windows the
 * sweep uses to decide what to ask about and the board uses to decide what to
 * call stale — one definition, so the board can never call fresh something the
 * sweep is not refreshing.
 */
export function expectedCheckIntervalMinutes(flight: TrackedFlight, asOf: Date): number {
  const minutesOut = (flight.scheduledDeparture.getTime() - asOf.getTime()) / 60_000;
  if (minutesOut > 7 * 24 * 60) return 24 * 60;
  if (minutesOut > 24 * 60) return 6 * 60;
  if (minutesOut > 4 * 60) return 60;
  return 15;
}

export function freshnessOf(flight: TrackedFlight, asOf: Date): Freshness {
  if (!flight.lastCheckedAt) return { kind: 'never_checked' };
  const ageMinutes = Math.max(0, Math.round((asOf.getTime() - flight.lastCheckedAt.getTime()) / 60_000));
  const expectedEveryMinutes = expectedCheckIntervalMinutes(flight, asOf);
  // Doubled: one missed refresh is a slow job, two is a broken one.
  return ageMinutes > expectedEveryMinutes * 2
    ? { kind: 'stale', ageMinutes, expectedEveryMinutes }
    : { kind: 'fresh', ageMinutes };
}

export type EffectiveStatus = StatusPhase | 'delayed';

/**
 * What the board should say, which is not always what the column holds.
 *
 * `cancelled`, `diverted` and `landed` are facts and survive any amount of
 * staleness — a cancelled flight does not become uncertain because nobody
 * refreshed the page. Everything else is a *prediction*, and a stale prediction
 * about a flight that has already left the gate is not a prediction any more.
 */
export function effectiveStatus(flight: TrackedFlight, asOf: Date): EffectiveStatus {
  if (flight.status === 'cancelled' || flight.status === 'diverted' || flight.status === 'landed') {
    return flight.status;
  }
  const fresh = freshnessOf(flight, asOf);
  const departed = asOf.getTime() > flight.scheduledDeparture.getTime();
  if (fresh.kind === 'never_checked') return departed ? 'unknown' : flight.status;
  if (fresh.kind === 'stale' && departed) return 'unknown';
  return flight.status;
}

/* ----------------------------- arrival buffer ------------------------------ */

export type BufferStanding =
  /** No move-in to miss — an unattached trip, or a return leg. */
  | 'not_applicable'
  /** Lands with the required buffer intact. */
  | 'clear'
  /** Lands before move-in, but inside the buffer the policy required. */
  | 'inside_buffer'
  /** Lands after move-in has already begun. */
  | 'after_move_in'
  /** There is no arrival to judge: the flight is not going. */
  | 'no_arrival';

export type BufferVerdict = {
  standing: BufferStanding;
  /** Hours between the arrival we now expect and move-in. Null when N/A. */
  hoursBefore: number | null;
  requiredHours: number;
  /** Hours of buffer lost since the ticket was bought. Positive means eaten. */
  hoursLost: number;
  /** True when the plan cleared the buffer and the current expectation does not. */
  brokenSincePurchase: boolean;
};

export type BufferContext = {
  /** The show's move-in instant, or null for a trip with no show. */
  moveInAt: Date | null;
  /** From the resolved travel policy — never a literal in this file. */
  requiredHours: number;
  /**
   * Which direction this leg flies. Only an *inbound* leg can miss move-in, and
   * a return flight delayed by three hours is somebody's evening, not the show's
   * problem. Without this the board raises a critical alert every time a Friday
   * flight home slips, and a feed that cries wolf on the way home is one nobody
   * reads on the way there.
   */
  isInbound: boolean;
  /**
   * False when the direction was inferred from the show's dates rather than
   * recorded at purchase. `conflicts.ts` learned this the hard way on travel
   * windows: a finding that had to guess says so, because the alternative is a
   * confident sentence built on a coin flip.
   */
  directionKnown: boolean;
};

const HOUR_MS = 3_600_000;

/** The arrival we currently expect: the estimate if there is one, else the plan. */
export function expectedArrival(flight: TrackedFlight): Date | null {
  if (flight.status === 'cancelled') return null;
  return flight.estimatedArrival ?? flight.providerScheduledArrival ?? flight.scheduledArrival;
}

export function bufferVerdict(
  flight: TrackedFlight,
  ctx: BufferContext,
  ): BufferVerdict {
  const requiredHours = ctx.requiredHours;
  if (!ctx.moveInAt || !ctx.isInbound) {
    return {
      standing: 'not_applicable',
      hoursBefore: null,
      requiredHours,
      hoursLost: 0,
      brokenSincePurchase: false,
    };
  }

  const arrival = expectedArrival(flight);
  if (!arrival) {
    return {
      standing: 'no_arrival',
      hoursBefore: null,
      requiredHours,
      hoursLost: 0,
      // A cancelled flight has not merely eaten the buffer, it has removed the
      // arrival. Saying "broken" would put it in the same sentence as a delay.
      brokenSincePurchase: false,
    };
  }

  const hoursBefore = (ctx.moveInAt.getTime() - arrival.getTime()) / HOUR_MS;
  const plannedHoursBefore =
    (ctx.moveInAt.getTime() - flight.scheduledArrival.getTime()) / HOUR_MS;

  const standing: BufferStanding =
    hoursBefore < 0 ? 'after_move_in' : hoursBefore < requiredHours ? 'inside_buffer' : 'clear';

  return {
    standing,
    hoursBefore,
    requiredHours,
    hoursLost: plannedHoursBefore - hoursBefore,
    brokenSincePurchase: plannedHoursBefore >= requiredHours && hoursBefore < requiredHours,
  };
}

/* ------------------------------ reconciliation ----------------------------- */

/**
 * What changed, named. The store writes these fields; it decides nothing.
 */
export type ChangeKind =
  | 'none'
  | 'delay'
  | 'recovered'
  | 'schedule_change'
  | 'cancelled'
  | 'diverted'
  | 'landed'
  | 'gate_change'
  | 'no_record';

export type Reconciliation = {
  changes: ChangeKind[];
  /** Exactly the columns to write. Absent keys are deliberately left alone. */
  patch: {
    status: TrackedFlight['status'];
    delayMinutes: number;
    estimatedDeparture: Date | null;
    estimatedArrival: Date | null;
    providerScheduledDeparture: Date | null;
    providerScheduledArrival: Date | null;
    scheduleChangedAt: Date | null;
    departureTerminal: string | null;
    departureGate: string | null;
    arrivalTerminal: string | null;
    arrivalGate: string | null;
    divertedToAirport: string | null;
    originTimeZone: string | null;
    destinationTimeZone: string | null;
    statusProvider: string;
    lastCheckedAt: Date;
  } | null;
};

/**
 * A schedule change under this many minutes is the provider and us rounding
 * differently, not the airline moving a flight. Fifteen because published
 * schedules are quoted to five minutes and re-timings are never subtle.
 */
export const SCHEDULE_CHANGE_TOLERANCE_MINUTES = 15;

/** Below this, "delayed" is noise the crew has not even announced yet. */
export const DELAY_FLOOR_MINUTES = 15;

const minutesBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60_000);

export function reconcile(
  flight: TrackedFlight,
  lookup: StatusLookup,
): Reconciliation {
  if (isNoRecord(lookup)) {
    // A provider that has never heard of this flight tells us nothing about the
    // flight and something important about the row, so the row is *not* patched
    // — writing `unknown` over a good reading because one poll missed would lose
    // a real delay. The check time is not stamped either: pretending we checked
    // successfully is how a board goes quietly stale.
    return { changes: ['no_record'], patch: null };
  }

  const r: StatusReport = lookup;
  const changes: ChangeKind[] = [];

  // The carrier's schedule against ours. Ours never moves — the ticket was
  // bought against it and the policy verdict was computed from it.
  const providerScheduledDeparture = r.scheduledDeparture;
  const providerScheduledArrival = r.scheduledArrival;
  const drift =
    providerScheduledDeparture !== null
      ? minutesBetween(providerScheduledDeparture, flight.scheduledDeparture)
      : 0;
  const rescheduled = Math.abs(drift) >= SCHEDULE_CHANGE_TOLERANCE_MINUTES;
  if (rescheduled && flight.scheduleChangedAt === null) changes.push('schedule_change');

  // Delay is measured against *our* scheduled time when the airline has not
  // re-timed the flight, and against the airline's when it has — otherwise every
  // re-timed flight reads as permanently delayed by the amount it was moved,
  // which is the one number nobody can act on.
  const delayBaseline =
    rescheduled && providerScheduledArrival ? providerScheduledArrival : flight.scheduledArrival;
  const expected = r.estimatedArrival ?? providerScheduledArrival ?? flight.scheduledArrival;
  const delayMinutes = Math.max(0, minutesBetween(expected, delayBaseline));

  let status: TrackedFlight['status'];
  switch (r.phase) {
    case 'cancelled':
      status = 'cancelled';
      break;
    case 'diverted':
      status = 'diverted';
      break;
    case 'landed':
      status = 'landed';
      break;
    case 'unknown':
      status = 'unknown';
      break;
    case 'active':
      status = delayMinutes >= DELAY_FLOOR_MINUTES ? 'delayed' : 'active';
      break;
    default:
      status = delayMinutes >= DELAY_FLOOR_MINUTES ? 'delayed' : 'scheduled';
  }

  if (status !== flight.status) {
    if (status === 'cancelled') changes.push('cancelled');
    else if (status === 'diverted') changes.push('diverted');
    else if (status === 'landed') changes.push('landed');
    else if (status === 'delayed') changes.push('delay');
    else if (flight.status === 'delayed') changes.push('recovered');
  } else if (status === 'delayed' && delayMinutes > flight.delayMinutes + DELAY_FLOOR_MINUTES) {
    changes.push('delay');
  }

  // A gate appearing for the first time is an assignment, not a change. Only a
  // gate we already published and that has since moved is worth telling anybody.
  const gateChanged =
    flight.departureGate !== null &&
    r.departureGate !== null &&
    r.departureGate !== flight.departureGate;
  if (gateChanged) changes.push('gate_change');
  if (changes.length === 0) changes.push('none');

  return {
    changes,
    patch: {
      status,
      delayMinutes,
      estimatedDeparture: r.estimatedDeparture,
      estimatedArrival: r.estimatedArrival,
      providerScheduledDeparture,
      providerScheduledArrival,
      scheduleChangedAt: rescheduled
        ? (flight.scheduleChangedAt ?? r.observedAt)
        : null,
      departureTerminal: r.departureTerminal,
      departureGate: r.departureGate,
      arrivalTerminal: r.arrivalTerminal,
      arrivalGate: r.arrivalGate,
      divertedToAirport: r.divertedToAirport,
      originTimeZone: r.originTimeZone,
      destinationTimeZone: r.destinationTimeZone,
      statusProvider: r.provider,
      lastCheckedAt: r.observedAt,
    },
  };
}
