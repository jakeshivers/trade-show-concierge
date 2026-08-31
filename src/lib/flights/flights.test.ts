import { describe, it, expect } from 'vitest';
import {
  DELAY_FLOOR_MINUTES,
  SCHEDULE_CHANGE_TOLERANCE_MINUTES,
  bufferVerdict,
  effectiveStatus,
  expectedCheckIntervalMinutes,
  freshnessOf,
  reconcile,
  type BufferContext,
  type TrackedFlight,
} from './status';
import { planFlightAlert, type AlertableFlight } from './alerts';
import { orderBoard, summarizeBoard, buildBoardRow, type BoardRow } from './board';
import { selectStatusProvider } from './provider';
import { RecordedStatusProvider, scenarioFor } from '@/lib/integrations/flightstatus/recorded/provider';
import { selectLeg, normalizeFlight, phaseOf } from '@/lib/integrations/flightstatus/aeroapi/normalize';
import { identFor } from '@/lib/integrations/flightstatus/aeroapi/client';
import type { StatusReport } from '@/lib/integrations/flightstatus/types';
import { isNoRecord } from '@/lib/integrations/flightstatus/types';

/**
 * The pure half of flight tracking — no database, no network, fixed clock.
 *
 * The assertions worth reading are the ones about *silence*. Most of what a
 * flight board gets wrong is over-reporting: a delay that costs nothing, a
 * re-timing filed as a delay, an unchecked row rendered as on time. Several
 * tests below exist only to prove nothing was said.
 */

const NOW = new Date('2026-03-01T12:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
const hours = (n: number) => mins(n * 60);

const flight = (over: Partial<TrackedFlight> = {}): TrackedFlight => ({
  id: 'f1',
  airlineCode: 'AA',
  flightNumber: '318',
  originAirport: 'SFO',
  destinationAirport: 'DTW',
  originTimeZone: 'America/Los_Angeles',
  destinationTimeZone: 'America/Detroit',
  scheduledDeparture: hours(24),
  scheduledArrival: hours(29),
  estimatedDeparture: null,
  estimatedArrival: null,
  providerScheduledDeparture: null,
  providerScheduledArrival: null,
  scheduleChangedAt: null,
  status: 'scheduled',
  delayMinutes: 0,
  departureGate: null,
  divertedToAirport: null,
  lastCheckedAt: mins(-5),
  statusProvider: 'recorded',
  ...over,
});

const ctx = (over: Partial<BufferContext> = {}): BufferContext => ({
  // Move-in eight hours after the planned arrival: three clear hours of slack
  // over the four-hour buffer... no — five hours before move-in, one hour spare.
  moveInAt: hours(34),
  requiredHours: 4,
  isInbound: true,
  directionKnown: true,
  ...over,
});

const report = (over: Partial<StatusReport> = {}): StatusReport => ({
  provider: 'recorded',
  observedAt: NOW,
  phase: 'scheduled',
  scheduledDeparture: hours(24),
  scheduledArrival: hours(29),
  estimatedDeparture: hours(24),
  estimatedArrival: hours(29),
  actualDeparture: null,
  actualArrival: null,
  departureTerminal: '1',
  departureGate: 'B12',
  arrivalTerminal: null,
  arrivalGate: null,
  divertedToAirport: null,
  originTimeZone: 'America/Los_Angeles',
  destinationTimeZone: 'America/Detroit',
  ...over,
});

/* ------------------------------ arrival buffer ----------------------------- */

describe('arrival buffer', () => {
  it('is clear when the planned arrival keeps its distance from move-in', () => {
    const v = bufferVerdict(flight(), ctx());
    expect(v.standing).toBe('clear');
    expect(v.hoursBefore).toBeCloseTo(5);
    expect(v.brokenSincePurchase).toBe(false);
  });

  it('reports the buffer broken only when the plan cleared it and the estimate does not', () => {
    const v = bufferVerdict(flight({ estimatedArrival: hours(31) }), ctx());
    expect(v.standing).toBe('inside_buffer');
    expect(v.hoursBefore).toBeCloseTo(3);
    expect(v.hoursLost).toBeCloseTo(2);
    expect(v.brokenSincePurchase).toBe(true);
  });

  it('does not call a buffer broken that was never intact', () => {
    // Booked inside the buffer to begin with — that was an approval decision,
    // not a disruption, and reporting it as one every night is how a feed dies.
    const tight = flight({ scheduledArrival: hours(32) });
    const v = bufferVerdict(tight, ctx());
    expect(v.standing).toBe('inside_buffer');
    expect(v.brokenSincePurchase).toBe(false);
  });

  it('has nothing to say about a flight home', () => {
    const v = bufferVerdict(flight({ estimatedArrival: hours(40) }), ctx({ isInbound: false }));
    expect(v.standing).toBe('not_applicable');
    expect(v.hoursBefore).toBeNull();
  });

  it('has nothing to say about a trip with no show — the same answer policy gives', () => {
    expect(bufferVerdict(flight(), ctx({ moveInAt: null })).standing).toBe('not_applicable');
  });

  it('reports a cancelled flight as having no arrival rather than an infinite delay', () => {
    const v = bufferVerdict(flight({ status: 'cancelled' }), ctx());
    expect(v.standing).toBe('no_arrival');
    expect(v.brokenSincePurchase).toBe(false);
  });
});

/* -------------------------------- freshness -------------------------------- */

describe('freshness', () => {
  it('checks a distant flight rarely and an imminent one often', () => {
    expect(expectedCheckIntervalMinutes(flight({ scheduledDeparture: hours(24 * 10) }), NOW)).toBe(24 * 60);
    expect(expectedCheckIntervalMinutes(flight({ scheduledDeparture: hours(48) }), NOW)).toBe(6 * 60);
    expect(expectedCheckIntervalMinutes(flight({ scheduledDeparture: hours(6) }), NOW)).toBe(60);
    expect(expectedCheckIntervalMinutes(flight({ scheduledDeparture: hours(1) }), NOW)).toBe(15);
  });

  it('never reports a row nobody has checked as on time once it should have gone', () => {
    const f = flight({ scheduledDeparture: hours(-2), scheduledArrival: hours(3), lastCheckedAt: null });
    expect(freshnessOf(f, NOW).kind).toBe('never_checked');
    expect(effectiveStatus(f, NOW)).toBe('unknown');
  });

  it('leaves a future flight alone: unchecked three weeks out is not unknown, it is early', () => {
    const f = flight({ scheduledDeparture: hours(24 * 21), lastCheckedAt: null });
    expect(effectiveStatus(f, NOW)).toBe('scheduled');
  });

  it('keeps a fact through any amount of staleness', () => {
    const f = flight({ status: 'cancelled', lastCheckedAt: hours(-40), scheduledDeparture: hours(-2) });
    expect(effectiveStatus(f, NOW)).toBe('cancelled');
  });
});

/* ----------------------------- reconciliation ------------------------------ */

describe('reconcile', () => {
  it('says nothing changed when nothing changed', () => {
    const { changes, patch } = reconcile(flight(), report());
    expect(changes).toEqual(['none']);
    expect(patch!.status).toBe('scheduled');
    expect(patch!.delayMinutes).toBe(0);
  });

  it('ignores a delay under the floor', () => {
    const r = reconcile(flight(), report({ estimatedArrival: mins(29 * 60 + DELAY_FLOOR_MINUTES - 1) }));
    expect(r.patch!.status).toBe('scheduled');
    expect(r.changes).toEqual(['none']);
  });

  it('records a real delay against our scheduled time, not the provider’s', () => {
    const r = reconcile(flight(), report({ estimatedArrival: hours(31) }));
    expect(r.changes).toContain('delay');
    expect(r.patch!.status).toBe('delayed');
    expect(r.patch!.delayMinutes).toBe(120);
  });

  it('calls a re-timing a schedule change and leaves our scheduled times alone', () => {
    const moved = SCHEDULE_CHANGE_TOLERANCE_MINUTES + 100;
    const r = reconcile(
      flight(),
      report({
        scheduledDeparture: mins(24 * 60 + moved),
        scheduledArrival: mins(29 * 60 + moved),
        estimatedDeparture: mins(24 * 60 + moved),
        estimatedArrival: mins(29 * 60 + moved),
      }),
    );
    expect(r.changes).toContain('schedule_change');
    expect(r.patch!.scheduleChangedAt).toEqual(NOW);
    expect(r.patch!.providerScheduledDeparture).toEqual(mins(24 * 60 + moved));
    // The whole point: a flight the airline moved by two hours is running on
    // time, and reporting it as 115 minutes late is a number nobody can act on.
    expect(r.patch!.delayMinutes).toBe(0);
    expect(r.patch!.status).toBe('scheduled');
  });

  it('treats a few minutes of drift as rounding, not as the airline moving a flight', () => {
    const r = reconcile(
      flight(),
      report({ scheduledDeparture: mins(24 * 60 + SCHEDULE_CHANGE_TOLERANCE_MINUTES - 1) }),
    );
    expect(r.changes).not.toContain('schedule_change');
    expect(r.patch!.scheduleChangedAt).toBeNull();
  });

  it('writes nothing at all when the provider has no record of the flight', () => {
    const r = reconcile(flight(), {
      noRecord: true,
      provider: 'recorded',
      observedAt: NOW,
      reason: 'no such flight',
    });
    // Not even `lastCheckedAt`: stamping a successful check on a failed lookup
    // is how a board goes stale while claiming to be fresh.
    expect(r.patch).toBeNull();
    expect(r.changes).toEqual(['no_record']);
  });
});

/* --------------------------------- alerts ---------------------------------- */

const alertable = (over: Partial<AlertableFlight> = {}): AlertableFlight => ({
  flight: flight(),
  travelerId: 'u1',
  travelerName: 'Shelley Shivers',
  showId: 'show1',
  showName: 'Automate 2026',
  context: ctx(),
  ...over,
});

describe('flight alerts', () => {
  it('says nothing about a delay the buffer absorbs', () => {
    const item = alertable({ flight: flight({ status: 'delayed', estimatedArrival: mins(29 * 60 + 40) }) });
    expect(planFlightAlert(item, NOW)).toBeNull();
  });

  it('says nothing about a delayed flight home', () => {
    const item = alertable({
      flight: flight({ status: 'delayed', estimatedArrival: hours(40) }),
      context: ctx({ isInbound: false }),
    });
    expect(planFlightAlert(item, NOW)).toBeNull();
  });

  it('speaks when a delay costs the buffer the ticket was approved under', () => {
    const item = alertable({ flight: flight({ status: 'delayed', estimatedArrival: hours(31) }) });
    const a = planFlightAlert(item, NOW)!;
    expect(a.reason).toBe('buffer_broken');
    expect(a.severity).toBe('warning');
    expect(a.body).toContain('4h buffer');
  });

  it('escalates once the arrival passes move-in', () => {
    const item = alertable({ flight: flight({ status: 'delayed', estimatedArrival: hours(36) }) });
    const a = planFlightAlert(item, NOW)!;
    expect(a.reason).toBe('after_move_in');
    expect(a.severity).toBe('critical');
  });

  it('marks an inferred direction as inferred', () => {
    const item = alertable({
      flight: flight({ status: 'delayed', estimatedArrival: hours(31) }),
      context: ctx({ directionKnown: false }),
    });
    expect(planFlightAlert(item, NOW)!.body).toContain('inferred');
  });

  it('keys on the standing, not on the estimate', () => {
    // Two readings four minutes apart, both inside the buffer. One alert.
    const a = planFlightAlert(
      alertable({ flight: flight({ status: 'delayed', estimatedArrival: hours(31) }) }),
      NOW,
    )!;
    const b = planFlightAlert(
      alertable({ flight: flight({ status: 'delayed', estimatedArrival: mins(31 * 60 + 4) }) }),
      NOW,
    )!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('speaks again when the standing itself changes', () => {
    const inside = planFlightAlert(
      alertable({ flight: flight({ status: 'delayed', estimatedArrival: hours(31) }) }),
      NOW,
    )!;
    const past = planFlightAlert(
      alertable({ flight: flight({ status: 'delayed', estimatedArrival: hours(36) }) }),
      NOW,
    )!;
    expect(past.dedupeKey).not.toBe(inside.dedupeKey);
  });

  it('reports a schedule change as a change of plan, in its own words', () => {
    const f = flight({
      scheduleChangedAt: NOW,
      providerScheduledDeparture: mins(24 * 60 + 125),
      providerScheduledArrival: mins(29 * 60 + 125),
    });
    // Deliberately with room to spare: a re-timing that *also* breaks the buffer
    // is reported as a broken buffer, because that is the more urgent of the two
    // true things — see the ordering in `planFlightAlert`.
    const a = planFlightAlert(alertable({ flight: f, context: ctx({ moveInAt: hours(40) }) }), NOW)!;
    expect(a.reason).toBe('schedule_change');
    expect(a.title).toContain('+125 min');
    expect(a.body).toContain('not a delay');
  });

  it('reports not knowing, near departure, as the alert', () => {
    const f = flight({ scheduledDeparture: hours(6), scheduledArrival: hours(11), lastCheckedAt: null });
    const a = planFlightAlert(alertable({ flight: f, context: ctx({ moveInAt: hours(40) }) }), NOW)!;
    expect(a.reason).toBe('unknown_near_departure');
    expect(a.body).toContain('nobody knows');
  });

  it('says nothing about a flight that has landed', () => {
    expect(planFlightAlert(alertable({ flight: flight({ status: 'landed' }) }), NOW)).toBeNull();
  });

  it('tells the show runners about a cancellation only when there is a show', () => {
    const a = planFlightAlert(
      alertable({ flight: flight({ status: 'cancelled' }), showId: null, showName: null, context: ctx({ moveInAt: null }) }),
      NOW,
    )!;
    expect(a.reason).toBe('cancelled');
    expect(a.showId).toBeNull();
  });
});

/* ---------------------------------- board ---------------------------------- */

describe('board', () => {
  const row = (over: Partial<AlertableFlight> = {}, tz = 'America/Detroit'): BoardRow =>
    buildBoardRow(
      {
        ...alertable(over),
        showTimezone: tz,
        booked: {
          priceCents: 48_600,
          seat: '14A',
          cabin: 'economy',
          bookingProvider: null,
          bookingReference: 'JHQ4M2',
        },
      },
      NOW,
    );

  it('puts trouble above the next departure', () => {
    const soonAndFine = row({ flight: flight({ id: 'soon', scheduledDeparture: hours(2), scheduledArrival: hours(7) }) });
    const laterAndBroken = row({
      flight: flight({ id: 'broken', status: 'delayed', estimatedArrival: hours(31) }),
    });
    expect(orderBoard([soonAndFine, laterAndBroken]).map((r) => r.flight.id)).toEqual([
      'broken',
      'soon',
    ]);
  });

  it('counts a costless delay apart from a costly one', () => {
    const weather = row({ flight: flight({ id: 'w', status: 'delayed', estimatedArrival: mins(29 * 60 + 40) }) });
    const costly = row({ flight: flight({ id: 'c', status: 'delayed', estimatedArrival: hours(31) }) });
    const s = summarizeBoard([weather, costly]);
    expect(s.delayedButClear).toBe(1);
    expect(s.bufferAtRisk).toBe(1);
  });
});

/* ------------------------------- providers --------------------------------- */

describe('status provider selection', () => {
  it('never falls back to replay', () => {
    expect(() => selectStatusProvider({})).toThrow(/AEROAPI_KEY/);
  });

  it('replays only when asked out loud', () => {
    const c = selectStatusProvider({ FLIGHT_STATUS_PROVIDER: 'recorded' });
    expect(c.source).toBe('recorded');
    expect(c.replayed).toBe(true);
  });

  it('refuses a provider it does not have rather than guessing', () => {
    expect(() => selectStatusProvider({ FLIGHT_STATUS_PROVIDER: 'flightstats' })).toThrow(
      /not a status provider/,
    );
  });

  it('uses AeroAPI with a key', () => {
    expect(selectStatusProvider({ AEROAPI_KEY: 'k' }).source).toBe('aeroapi');
  });
});

describe('the recorded provider', () => {
  it('never replays a landing for a flight that has not left', async () => {
    const p = new RecordedStatusProvider();
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) {
      const r = await p.lookup({
        airlineCode: 'ZZ',
        flightNumber: n,
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        scheduledDeparture: new Date(Date.now() + 5 * 86_400_000),
      });
      expect(isNoRecord(r) ? 'unknown' : r.phase).not.toBe('landed');
    }
  });

  it('tells the same flight the same story every time', () => {
    expect(scenarioFor('AA', '318')).toBe(scenarioFor('AA', '318'));
  });

  it('projects the recorded shape onto the leg it is asked about', async () => {
    const p = new RecordedStatusProvider({ AA318: 'on_time' });
    const departsAt = new Date(Date.now() + 3 * 86_400_000);
    const arrivesAt = new Date(departsAt.getTime() + 95 * 60_000);
    const r = await p.lookup({
      airlineCode: 'AA',
      flightNumber: '318',
      originAirport: 'SFO',
      destinationAirport: 'LAX',
      scheduledDeparture: departsAt,
      scheduledArrival: arrivesAt,
    });
    // A canned block time would have reported a five-hour transcontinental
    // arrival for a ninety-five minute shuttle.
    expect(isNoRecord(r)).toBe(false);
    if (!isNoRecord(r)) expect(r.scheduledArrival).toEqual(arrivesAt);
  });
});

/* -------------------------------- aeroapi ---------------------------------- */

describe('the AeroAPI adapter', () => {
  const leg = (over: Record<string, unknown> = {}) => ({
    origin: { code_iata: 'SFO', timezone: 'America/Los_Angeles' },
    destination: { code_iata: 'DTW', timezone: 'America/Detroit' },
    scheduled_out: hours(24).toISOString(),
    scheduled_in: hours(29).toISOString(),
    ...over,
  });

  const query = {
    airlineCode: 'AA',
    flightNumber: '318',
    originAirport: 'SFO',
    destinationAirport: 'DTW',
    scheduledDeparture: hours(24),
  };

  it('strips a leading zero from a flight number', () => {
    expect(identFor({ ...query, flightNumber: '0318' })).toBe('AA318');
  });

  it('picks the leg nearest our scheduled time, not the first of the day', () => {
    const yesterday = leg({ scheduled_out: hours(0).toISOString(), gate_origin: 'wrong' });
    const ours = leg({ gate_origin: 'right' });
    expect(selectLeg([yesterday, ours], query)?.gate_origin).toBe('right');
  });

  it('keeps a diverted leg rather than filtering it out by its destination', () => {
    const diverted = leg({ destination: { code_iata: 'ORD' }, diverted: true });
    const picked = selectLeg([diverted], query);
    expect(picked).not.toBeNull();
    const r = normalizeFlight(picked!, NOW);
    expect(r.phase).toBe('diverted');
    expect(r.divertedToAirport).toBe('ORD');
  });

  it('ignores a position-only record, which has no schedule to report', () => {
    expect(selectLeg([leg({ position_only: true })], query)).toBeNull();
  });

  it('reads the phase from the flags, never from the display string', () => {
    expect(phaseOf({ status: 'Scheduled', cancelled: true })).toBe('cancelled');
    expect(phaseOf({ status: 'En Route / On Time', actual_in: hours(29).toISOString() })).toBe('landed');
    expect(phaseOf({ status: 'anything at all', scheduled_out: hours(24).toISOString() })).toBe('scheduled');
  });

  it('prefers an actual time over a stale estimate of it', () => {
    const r = normalizeFlight(
      leg({ estimated_in: hours(29).toISOString(), actual_in: hours(30).toISOString() }),
      NOW,
    );
    expect(r.estimatedArrival).toEqual(hours(30));
  });

  it('carries the airport zones through, which nothing else in the app can source', () => {
    const r = normalizeFlight(leg(), NOW);
    expect(r.originTimeZone).toBe('America/Los_Angeles');
    expect(r.destinationTimeZone).toBe('America/Detroit');
  });

  it('refuses an unparseable timestamp rather than reporting a flight with no schedule', () => {
    expect(() => normalizeFlight(leg({ scheduled_out: 'soon' }), NOW)).toThrow(/scheduled_out/);
  });
});
