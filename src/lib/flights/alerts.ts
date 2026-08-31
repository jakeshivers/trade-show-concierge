import {
  bufferVerdict,
  effectiveStatus,
  freshnessOf,
  type BufferContext,
  type BufferVerdict,
  type TrackedFlight,
} from './status';

/**
 * What a flight is owed tonight — or, far more often, that it is owed nothing.
 *
 * The deadline engine's four corrections apply here almost unchanged, which is
 * the argument for having written them down: an alert is addressed to somebody,
 * written in a tense, and keyed to the claim it makes rather than to the row it
 * came from. What is new is the fifth, and it is the one a flight board gets
 * wrong by default:
 *
 * **Key on the fact that changed, not on the number.** A deadline's date moves
 * rarely and deliberately. An arrival estimate moves every time anybody asks —
 * by four minutes, then back by two — so keying a delay alert on the estimated
 * arrival instant would send a fresh "your flight is late" every fifteen
 * minutes, all night, each one technically a new claim. The key therefore
 * carries the **standing** the alert is about (`inside_buffer`, `after_move_in`,
 * `cancelled`) and the scheduled instant that identifies the leg. So it fires
 * once when a flight crosses into the buffer, once more if it crosses past
 * move-in, and never again for jitter in between.
 *
 * And the thing this engine mostly does is *not* fire. A delay that costs
 * nothing is weather. `minor_delay` is in the recorded fixtures specifically to
 * prove that path stays silent, because a feed that reports every delay is one
 * that gets muted before the delay that mattered.
 */

export type AlertableFlight = {
  flight: TrackedFlight;
  travelerId: string;
  travelerName: string;
  showId: string | null;
  showName: string | null;
  context: BufferContext;
};

export type FlightAlertReason =
  | 'cancelled'
  | 'diverted'
  | 'buffer_broken'
  | 'after_move_in'
  | 'schedule_change'
  | 'unknown_near_departure';

export type PlannedFlightAlert = {
  flightId: string;
  showId: string | null;
  travelerId: string;
  reason: FlightAlertReason;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  dedupeKey: string;
};

const HOURS = (h: number) => `${h.toFixed(1)}h`;

function leg(f: TrackedFlight): string {
  return `${f.airlineCode} ${f.flightNumber} ${f.originAirport}→${f.destinationAirport}`;
}

/** Identifies the leg without identifying the moving estimate. See the header. */
function keyBase(f: TrackedFlight): string {
  return `flight:${f.id}:${f.scheduledDeparture.toISOString()}`;
}

function bufferClause(
  v: BufferVerdict,
  showName: string | null,
  directionKnown: boolean,
): string {
  if (v.standing === 'not_applicable' || v.hoursBefore === null) return '';
  const show = showName ? ` for ${showName}` : '';
  const guessed = directionKnown
    ? ''
    : ' (This leg was not recorded as an outbound one; the direction is inferred from the show’s dates.)';
  if (v.standing === 'after_move_in') {
    return ` It now lands ${HOURS(Math.abs(v.hoursBefore))} AFTER move-in begins${show}.${guessed}`;
  }
  if (v.standing === 'inside_buffer') {
    return (
      ` It now lands ${HOURS(v.hoursBefore)} before move-in${show}, inside the ` +
      `${v.requiredHours}h buffer this trip was approved against — ${HOURS(v.hoursLost)} of it gone.${guessed}`
    );
  }
  return ` It still lands ${HOURS(v.hoursBefore)} before move-in${show}, so the buffer holds.${guessed}`;
}

export function planFlightAlert(
  item: AlertableFlight,
  asOf: Date,
): PlannedFlightAlert | null {
  const { flight: f, showId, travelerId, travelerName, showName, context } = item;
  const status = effectiveStatus(f, asOf);
  const verdict = bufferVerdict(f, context);
  const base = keyBase(f);

  // Nothing to say about a flight that is already down.
  if (status === 'landed') return null;

  if (status === 'cancelled') {
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'cancelled',
      severity: 'critical',
      title: `Cancelled: ${leg(f)} — ${travelerName}`,
      body:
        'The carrier cancelled this flight. Nothing in this app has rebooked it and nothing ' +
        'will: the agent buys against a travel request, and this ticket is already bought. ' +
        'Rebooking is a call to the airline, and then a corrected flight record here.' +
        (context.moveInAt && context.isInbound
          ? ` ${travelerName} was due in ${HOURS(
              (context.moveInAt.getTime() - f.scheduledArrival.getTime()) / 3_600_000,
            )} before move-in${showName ? ` for ${showName}` : ''}; booth coverage counts people who are in town.`
          : ''),
      dedupeKey: `${base}:cancelled`,
    };
  }

  if (status === 'diverted') {
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'diverted',
      severity: 'critical',
      title: `Diverted: ${leg(f)} — ${travelerName}`,
      body:
        `The flight is on the ground at ${f.divertedToAirport ?? 'another airport'} rather than ` +
        `${f.destinationAirport}. Where it goes next is the carrier's call and is not something ` +
        'this app can see; treat the arrival time on this row as unknown until somebody says ' +
        'otherwise.',
      dedupeKey: `${base}:diverted`,
    };
  }

  // The buffer, which is the only reason a delay is worth anybody's attention.
  if (verdict.standing === 'after_move_in') {
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'after_move_in',
      severity: 'critical',
      title: `${travelerName} now lands after move-in — ${leg(f)}`,
      body:
        `The flight is now expected ${HOURS(verdict.hoursLost)} later than the itinerary this ` +
        'ticket was bought against.' +
        bufferClause(verdict, showName, context.directionKnown) +
        ' The policy rule that authorized this ticket required the opposite, and it was checked ' +
        'once, at purchase. This is that verdict going stale.',
      dedupeKey: `${base}:after_move_in`,
    };
  }

  if (verdict.brokenSincePurchase) {
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'buffer_broken',
      severity: 'warning',
      title: `Arrival buffer gone: ${leg(f)} — ${travelerName}`,
      body:
        'This flight was inside policy when it was bought and is not now.' +
        bufferClause(verdict, showName, context.directionKnown) +
        ' Nothing has been missed yet, which is exactly why this is worth reading: there is ' +
        'still time to move somebody, or the shift they were meant to cover.',
      dedupeKey: `${base}:inside_buffer`,
    };
  }

  // A re-timing is not a delay and does not wait for the day. It is the plan
  // changing under an approved ticket, with weeks of room to do something.
  if (f.scheduleChangedAt && f.providerScheduledDeparture) {
    const movedMinutes = Math.round(
      (f.providerScheduledDeparture.getTime() - f.scheduledDeparture.getTime()) / 60_000,
    );
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'schedule_change',
      severity: 'warning',
      title: `The airline moved ${leg(f)} by ${movedMinutes > 0 ? '+' : ''}${movedMinutes} min`,
      body:
        'This is a schedule change, not a delay: the carrier has re-timed the flight itself. ' +
        'The times this ticket was bought and approved against are unchanged on the record, ' +
        'because they are what the policy verdict was computed from — the carrier’s new times ' +
        'sit beside them.' +
        bufferClause(verdict, showName, context.directionKnown) +
        ' Re-check the arrival buffer and, if it no longer holds, rebook while there is time.',
      dedupeKey: `${base}:schedule_change:${f.providerScheduledDeparture.toISOString()}`,
    };
  }

  // Correction: silence is not the same as on time. A flight that should be in
  // the air, on a row nobody has been able to refresh, is the one case where
  // "we do not know" is itself the alert.
  const fresh = freshnessOf(f, asOf);
  const hoursOut = (f.scheduledDeparture.getTime() - asOf.getTime()) / 3_600_000;
  if (status === 'unknown' || (hoursOut <= 12 && fresh.kind !== 'fresh')) {
    return {
      flightId: f.id,
      showId,
      travelerId,
      reason: 'unknown_near_departure',
      severity: 'info',
      title: `No live status for ${leg(f)} — ${travelerName}`,
      body:
        (fresh.kind === 'never_checked'
          ? 'This flight has never been checked against a status provider.'
          : `The last reading is ${fresh.kind === 'stale' ? fresh.ageMinutes : 0} minutes old.`) +
        ' It departs within twelve hours, so this row is not saying the flight is on time — ' +
        'it is saying nobody knows. Check the carrier directly, and check whether the status ' +
        'provider is configured at all.',
      dedupeKey: `${base}:unknown`,
    };
  }

  return null;
}

export function planFlightAlerts(items: AlertableFlight[], asOf: Date): PlannedFlightAlert[] {
  const order: Record<PlannedFlightAlert['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  return items
    .map((i) => planFlightAlert(i, asOf))
    .filter((a): a is PlannedFlightAlert => a !== null)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}
