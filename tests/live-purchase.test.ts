import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { RecordedFlightProvider } from '@/lib/integrations/flights/recorded/provider';
import type {
  FlightProvider,
  PurchaseRequest,
  PurchaseResult,
} from '@/lib/integrations/flights/types';
import { submitTravelRequest, runAgent, approveRequest, type AgentDeps } from '@/lib/travel/agent';
import {
  haltPurchasing,
  resumePurchasing,
  purchasingStatus,
  PurchasingHaltedError,
} from '@/lib/travel/kill-switch';
import { passengerForUser, MissingTravelerDetailsError } from '@/lib/travel/passengers';
import { getAuditTrail, renderAuditTrail } from '@/lib/travel/audit';

/**
 * Step 5: the parts that only matter once real money is reachable — the live
 * purchase path, the kill switch, and the audit trail as something a person can
 * actually read.
 *
 * The provider here is a spy, not a fake Duffel: it records what it was asked to
 * buy and returns what a provider would return. The wire-level Duffel purchase
 * is tested against mocked HTTP in `src/lib/integrations/flights/duffel`.
 */

const db = getDb();
const DAY = 86_400_000;

class Clock {
  constructor(private t: Date) {}
  now = () => new Date(this.t);
  advanceMinutes(n: number) {
    this.t = new Date(this.t.getTime() + n * 60_000);
    return this;
  }
}

/** A provider that can buy — and remembers exactly what it was told to buy. */
class SpyProvider implements FlightProvider {
  readonly name = 'spy';
  readonly purchases: PurchaseRequest[] = [];

  constructor(
    private readonly inner: FlightProvider,
    private readonly outcome: Partial<PurchaseResult> | Error = {},
  ) {}

  isConfigured() {
    return true;
  }
  search(...a: Parameters<FlightProvider['search']>) {
    return this.inner.search(...a);
  }
  hold(...a: Parameters<FlightProvider['hold']>) {
    return this.inner.hold(...a);
  }
  cancel(...a: Parameters<FlightProvider['cancel']>) {
    return this.inner.cancel(...a);
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    this.purchases.push(request);
    if (this.outcome instanceof Error) throw this.outcome;
    return {
      orderId: `ord_${request.idempotencyKey}`,
      bookingReference: 'ABC123',
      ticketNumbers: ['0012345678901'],
      chargedCents: request.amountCents,
      creditAppliedCents: 0,
      currency: request.currency,
      liveMode: true,
      ...this.outcome,
    };
  }
}

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let priya: Actor;
let shelley: Actor;
let reeseId: string;
let automate: typeof s.shows.$inferSelect;

beforeAll(async () => {
  priya = await actorFor('priya@northwindrobotics.test');
  shelley = await actorFor('shelley@northwindrobotics.test');
  const reese = await db.query.users.findFirst({
    where: eq(s.users.email, 'reese@northwindrobotics.test'),
  });
  reeseId = reese!.id;
  automate = (await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') }))!;
});

beforeEach(async () => {
  await db.delete(s.travelRequests);
  await db.delete(s.bookingControls);
  await db.delete(s.alerts);
});

function depsFor(clock: Clock, opts: { live?: boolean; provider?: FlightProvider } = {}): AgentDeps {
  return {
    db,
    provider: opts.provider ?? new RecordedFlightProvider({ now: clock.now }),
    now: clock.now,
    live: opts.live ?? false,
  };
}

async function submitDomestic(deps: AgentDeps, key: string, travelerId?: string) {
  return submitTravelRequest(
    {
      showId: automate.id,
      travelerId,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
      latestArrival: automate.moveInAt!,
      idempotencyKey: key,
    },
    travelerId ? shelley : priya,
    deps,
  );
}

/* ------------------------------ live purchase ------------------------------ */

describe('live purchase behind the flag', () => {
  it('buys the offer and records the provider order, ticket, and charge', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }));
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitDomestic(deps, 'live-happy');
    const outcome = await runAgent(request.id, deps, priya);

    expect(outcome.status).toBe('ticketed');
    expect(spy.purchases).toHaveLength(1);

    const [call] = spy.purchases;
    // The idempotency key is the request's own: a retry cannot buy twice.
    expect(call.idempotencyKey).toBe(request.idempotencyKey);
    expect(call.amountCents).toBe(outcome.selected!.offer.totalCents);
    // A real carrier needs to know who is flying, by name and date of birth.
    expect(call.passengers?.[0]).toMatchObject({
      givenName: 'Priya',
      familyName: 'Raghunathan',
      bornOn: '1990-06-25',
    });

    const booking = outcome.booking!;
    expect(booking.live).toBe(true);
    expect(booking.providerOrderId).toBe(`ord_${request.idempotencyKey}`);
    expect(booking.ticketNumbers).toEqual(['0012345678901']);
    expect(booking.chargedCents).toBe(outcome.selected!.offer.totalCents);
    // Non-negotiable #6: the cost center travels with the money.
    expect(booking.costCenterId).not.toBeNull();
  });

  it('trusts the provider, not our intent, about whether the booking is real', async () => {
    // A Duffel *test* key issues orders with `live_mode: false`. Recording those
    // as spend would quietly inflate every show's true cost.
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), {
      liveMode: false,
    });
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitDomestic(deps, 'live-testkey');
    const outcome = await runAgent(request.id, deps, priya);

    expect(outcome.status).toBe('ticketed');
    expect(outcome.booking!.live).toBe(false);

    const ticketed = await db.query.agentRuns.findFirst({
      where: and(eq(s.agentRuns.travelRequestId, request.id), eq(s.agentRuns.step, 'ticketed')),
    });
    expect(ticketed!.summary).toMatch(/not a live-mode booking/);
  });

  it('lands a failed purchase in `failed`, not stuck in `booking`', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(
      new RecordedFlightProvider({ now: clock.now }),
      new Error('card declined'),
    );
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitDomestic(deps, 'live-declined');
    await expect(runAgent(request.id, deps, priya)).rejects.toThrow('card declined');

    const after = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, request.id),
    });
    expect(after!.status).toBe('failed');
    // `failed → searching` is legal, so the request is recoverable.

    const failure = await db.query.agentRuns.findFirst({
      where: and(
        eq(s.agentRuns.travelRequestId, request.id),
        eq(s.agentRuns.step, 'purchase_failed'),
      ),
    });
    expect(failure!.summary).toContain('card declined');
    // The key a retry must reuse so a lost response cannot become a second charge.
    expect((failure!.detail as { idempotencyKey: string }).idempotencyKey).toBe(
      request.idempotencyKey,
    );

    const booking = await db.query.bookings.findFirst({
      where: eq(s.bookings.travelRequestId, request.id),
    });
    expect(booking).toBeUndefined();
  });

  it('refuses to ticket a traveler whose profile is incomplete', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }));
    const deps = depsFor(clock, { live: true, provider: spy });

    // Reese has no date of birth. An airline needs one; we do not invent it.
    const request = await submitDomestic(deps, 'live-no-dob', reeseId);
    await expect(runAgent(request.id, deps, shelley)).rejects.toThrow(MissingTravelerDetailsError);

    expect(spy.purchases).toHaveLength(0);
    const after = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, request.id),
    });
    expect(after!.status).toBe('failed');
  });

  it('notifies the traveler and a travel manager at the moment of ticketing', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock, { live: false });
    const request = await submitDomestic(deps, 'notify-me');
    await runAgent(request.id, deps, priya);

    const alerts = await db.select().from(s.alerts).where(eq(s.alerts.orgId, priya.orgId));
    const recipients = alerts.map((a) => a.userId);
    expect(recipients).toContain(priya.userId);
    expect(recipients).toContain(shelley.userId);
    // Rail 6 runs in dry run too, so its first exercise is not a real purchase.
    expect(alerts.every((a) => a.title.startsWith('[dry run]'))).toBe(true);
  });

  it('never lets the recorded provider buy, whatever the flag says', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock, { live: true });
    const request = await submitDomestic(deps, 'recorded-cannot-buy');
    await expect(runAgent(request.id, deps, priya)).rejects.toThrow(/never buy a ticket/);
  });
});

/* ------------------------------- kill switch ------------------------------- */

describe('the kill switch', () => {
  it('is off for an org that has never touched it', async () => {
    const status = await purchasingStatus(priya.orgId, db);
    expect(status.halted).toBe(false);
    expect(status.since).toBeNull();
  });

  it('queues an otherwise auto-approved request instead of booking it', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    await haltPurchasing(priya.orgId, shelley, 'Fare feed looked wrong at 09:12', db, clock.now);

    const request = await submitDomestic(deps, 'halted-run');
    const outcome = await runAgent(request.id, deps, priya);

    // Judged, not discarded: the verdict is still auto_approve.
    expect(outcome.selected!.verdict.decision).toBe('auto_approve');
    expect(outcome.status).toBe('pending_approval');
    expect(
      await db.query.bookings.findFirst({ where: eq(s.bookings.travelRequestId, request.id) }),
    ).toBeUndefined();

    const halted = await db.query.agentRuns.findFirst({
      where: and(
        eq(s.agentRuns.travelRequestId, request.id),
        eq(s.agentRuns.step, 'purchasing_halted'),
      ),
    });
    expect(halted!.summary).toContain('Fare feed looked wrong');
  });

  it('halts dry runs too, so the switch is exercised on the path we run daily', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock, { live: false });
    await haltPurchasing(priya.orgId, shelley, 'Testing the rail', db, clock.now);
    const request = await submitDomestic(deps, 'halted-dry-run');
    expect((await runAgent(request.id, deps, priya)).status).toBe('pending_approval');
  });

  it('refuses an approval while halted, before writing an approval row', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(deps, 'halt-mid-approval');
    await runAgent(request.id, deps, priya);
    // Nothing to approve — it auto-booked. Use a halted run instead.
    await haltPurchasing(priya.orgId, shelley, 'Incident 4471', db, clock.now);

    const second = await submitDomestic(deps, 'halt-then-approve');
    await runAgent(second.id, deps, priya);

    await expect(approveRequest(second.id, shelley, deps)).rejects.toThrow(PurchasingHaltedError);
    expect(await db.select().from(s.approvals)).toHaveLength(0);
    const after = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, second.id),
    });
    expect(after!.status).toBe('pending_approval');
  });

  it('books again once an admin resumes, and keeps both toggles on the record', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    await haltPurchasing(priya.orgId, shelley, 'Incident 4471', db, clock.now);
    clock.advanceMinutes(30);
    await resumePurchasing(priya.orgId, shelley, 'Incident 4471 closed, feed verified', db, clock.now);

    expect((await purchasingStatus(priya.orgId, db)).halted).toBe(false);

    const request = await submitDomestic(deps, 'after-resume');
    expect((await runAgent(request.id, deps, priya)).status).toBe('ticketed');

    const history = await db.select().from(s.bookingControls);
    expect(history.map((h) => h.purchasingHalted)).toEqual([true, false]);
    // Who turned it back on is the question that gets asked afterwards.
    expect(history[1].actorId).toBe(shelley.userId);
  });

  it('is an admin control, and demands a reason in both directions', async () => {
    await expect(haltPurchasing(priya.orgId, priya, 'because', db)).rejects.toThrow(ForbiddenError);
    await expect(haltPurchasing(priya.orgId, shelley, '   ', db)).rejects.toThrow(/reason is required/);
  });
});

/* ------------------------------- audit trail ------------------------------- */

describe('the audit trail, surfaced', () => {
  it('assembles the whole story of an auto-booked request', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(deps, 'audit-auto');
    await runAgent(request.id, deps, priya);

    const trail = await getAuditTrail(request.id, db);

    expect(trail.request.status).toBe('ticketed');
    expect(trail.traveler!.email).toBe('priya@northwindrobotics.test');
    expect(trail.searches).toHaveLength(1);
    expect(trail.searches[0].offers.length).toBeGreaterThan(1);
    // Every offer considered carries its own verdict, not just the winner.
    expect(trail.searches[0].offers.every((o) => o.decision !== null)).toBe(true);
    expect(trail.searches[0].offers.filter((o) => o.selected)).toHaveLength(1);
    expect(trail.booking!.live).toBe(false);
    expect(trail.timeline.map((r) => r.sequence)).toEqual(
      trail.timeline.map((_, i) => i + 1),
    );
    expect(trail.notifications.length).toBeGreaterThan(0);

    const text = renderAuditTrail(trail);
    expect(text).toContain('SFO → DTW');
    expect(text).toContain('dry run');
    expect(text).toContain('Timeline');
  });

  it('keeps a re-priced request’s two searches apart', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitTravelRequest(
      {
        travelerId: (await db.query.users.findFirst({
          where: eq(s.users.email, 'ingrid@northwindrobotics.test'),
        }))!.id,
        originAirport: 'SFO',
        destinationAirport: 'LHR',
        earliestDeparture: new Date(clock.now().getTime() + 45 * DAY),
        latestArrival: new Date(clock.now().getTime() + 47 * DAY),
        idempotencyKey: 'audit-reprice',
      },
      shelley,
      deps,
    );
    await runAgent(request.id, deps, shelley);
    // Long enough that the offer is a corpse by the time the approver looks.
    clock.advanceMinutes(120);
    // Marcus approves: Shelley raised it, and nobody approves their own request.
    await approveRequest(request.id, await actorFor('marcus@northwindrobotics.test'), deps);

    const trail = await getAuditTrail(request.id, db);
    expect(trail.searches.length).toBe(2);
    expect(trail.approvals).toHaveLength(1);
    expect(trail.approvals[0].reSearchedOnApproval).toBe(true);
    expect(renderAuditTrail(trail)).toContain('offer had expired');
  });
});

/* ---------------------------- passenger identity ---------------------------- */

describe('passenger identity', () => {
  it('names every missing field rather than defaulting one', async () => {
    const reese = (await db.query.users.findFirst({ where: eq(s.users.id, reeseId) }))!;
    try {
      passengerForUser(reese);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTravelerDetailsError);
      const missing = (err as MissingTravelerDetailsError).missing;
      expect(missing).toContain('a date of birth');
      expect(missing).toContain('a phone number');
    }
  });

  it('keeps a birth date a calendar date, never an instant', async () => {
    const priyaRow = (await db.query.users.findFirst({
      where: eq(s.users.id, priya.userId),
    }))!;
    // A Date round-trip here would move the date across time zones and put the
    // wrong birthday on a ticket.
    expect(passengerForUser(priyaRow).bornOn).toBe('1990-06-25');
  });
});
