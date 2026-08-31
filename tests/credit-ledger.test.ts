import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, type Actor } from '@/lib/auth/actor';
import { RecordedFlightProvider } from '@/lib/integrations/flights/recorded/provider';
import type {
  FlightProvider,
  PurchaseRequest,
  PurchaseResult,
} from '@/lib/integrations/flights/types';
import {
  submitTravelRequest,
  runAgent,
  approveRequest,
  cancelRequest,
  type AgentDeps,
} from '@/lib/travel/agent';
import {
  CreditLedgerError,
  creditExposure,
  creditPool,
  creditsExpiringSoon,
  issueCreditFromCancellation,
  reconcileCredit,
  runCreditMaintenance,
  sweepExpiredCredits,
} from '@/lib/travel/credits';

/**
 * Step 6: the ticket credit ledger against the real database and the real agent.
 *
 * The point of §5b is not that credits are stored — it is that the agent looks
 * at them *before* spending new money, and that a credit's balance can always be
 * explained. Both are behaviours, so both are tested here rather than in the
 * pure-function suite.
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

/** Buys whatever it is told to, and remembers exactly what it was told. */
class SpyProvider implements FlightProvider {
  readonly name = 'spy';
  readonly purchases: PurchaseRequest[] = [];

  constructor(
    private readonly inner: FlightProvider,
    private readonly creditCents = 0,
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
    const credit = request.creditIds?.length ? this.creditCents : 0;
    return {
      orderId: `ord_${request.idempotencyKey}`,
      bookingReference: 'CRD123',
      ticketNumbers: ['0019876543210'],
      chargedCents: request.amountCents - credit,
      creditAppliedCents: credit,
      currency: request.currency,
      liveMode: true,
    };
  }
}

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let shelley: Actor;
let marcus: Actor;
let priya: Actor;
let tomasId: string;
let orgId: string;
let automate: typeof s.shows.$inferSelect;

beforeAll(async () => {
  shelley = await actorFor('shelley@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');
  orgId = shelley.orgId;
  const tomas = await db.query.users.findFirst({
    where: eq(s.users.email, 'tomas@northwindrobotics.test'),
  });
  tomasId = tomas!.id;
  automate = (await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') }))!;
});

/**
 * The seeded credits are the fixture, so each test restores them rather than
 * inventing its own. The ledger is append-only; "reset" means reseeding the
 * entries, not editing them.
 */
async function resetCredits() {
  await db.delete(s.ticketCreditEntries);
  await db.delete(s.ticketCredits);

  const rows = await db
    .insert(s.ticketCredits)
    .values([
      {
        orgId,
        userId: tomasId,
        providerCreditId: 'acr_00009htYpSCXrwaB9DnCr1',
        airlineCode: 'AA',
        originalValueCents: 18_400,
        remainingValueCents: 18_400,
        issuedOn: new Date(Date.now() - 120 * DAY),
        expiresOn: new Date(Date.now() + 240 * DAY),
        status: 'available',
      },
      {
        orgId,
        userId: tomasId,
        airlineCode: 'DL',
        originalValueCents: 61_200,
        remainingValueCents: 61_200,
        issuedOn: new Date(Date.now() - 200 * DAY),
        expiresOn: new Date(Date.now() + 21 * DAY),
        status: 'available',
      },
      {
        orgId,
        userId: tomasId,
        airlineCode: 'AS',
        originalValueCents: 27_300,
        remainingValueCents: 27_300,
        issuedOn: new Date(Date.now() - 420 * DAY),
        expiresOn: new Date(Date.now() - 3 * DAY),
        status: 'available',
      },
    ])
    .returning();

  await db.insert(s.ticketCreditEntries).values(
    rows.map((c) => ({
      creditId: c.id,
      orgId,
      kind: 'issued' as const,
      deltaCents: c.originalValueCents,
      balanceAfterCents: c.originalValueCents,
      reason: 'Seeded for test',
      occurredAt: c.issuedOn,
    })),
  );
  return { aa: rows[0], dl: rows[1], expired: rows[2] };
}

beforeEach(async () => {
  await db.delete(s.travelRequests);
  await db.delete(s.alerts);
  await resetCredits();
});

function depsFor(clock: Clock, opts: { live?: boolean; provider?: FlightProvider } = {}): AgentDeps {
  return {
    db,
    provider: opts.provider ?? new RecordedFlightProvider({ now: clock.now }),
    now: clock.now,
    live: opts.live ?? false,
  };
}

/** SFO → DTW for Tomas, who is the one holding credits. */
async function submitForTomas(deps: AgentDeps, key: string) {
  return submitTravelRequest(
    {
      showId: automate.id,
      travelerId: tomasId,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
      latestArrival: automate.moveInAt!,
      idempotencyKey: key,
    },
    // Marcus books it, Shelley approves it: an approver may not sign off on a
    // request they raised themselves.
    marcus,
    deps,
  );
}

const stepsOf = async (requestId: string) =>
  (
    await db
      .select()
      .from(s.agentRuns)
      .where(eq(s.agentRuns.travelRequestId, requestId))
      .orderBy(s.agentRuns.sequence)
  ).map((r) => r.step);

/* ------------------------------- the pool ---------------------------------- */

describe('what the agent can see', () => {
  it('includes a partially used credit — the old query silently forfeited these', async () => {
    const [c] = await db
      .insert(s.ticketCredits)
      .values({
        orgId,
        userId: tomasId,
        airlineCode: 'UA',
        originalValueCents: 44_000,
        remainingValueCents: 12_750,
        issuedOn: new Date(Date.now() - 300 * DAY),
        expiresOn: new Date(Date.now() + 30 * DAY),
        status: 'partially_used',
      })
      .returning();

    const pool = await creditPool(db, { orgId, travelerId: tomasId, now: new Date() });
    expect(pool.map((p) => p.id)).toContain(c.id);
  });

  it('leaves another traveler out unless the credit is transferable', async () => {
    const mine = await creditPool(db, { orgId, travelerId: priya.userId, now: new Date() });
    expect(mine).toHaveLength(0);

    await db
      .update(s.ticketCredits)
      .set({ transferable: true })
      .where(eq(s.ticketCredits.airlineCode, 'DL'));

    const shared = await creditPool(db, { orgId, travelerId: priya.userId, now: new Date() });
    expect(shared.map((c) => c.airlineCode)).toEqual(['DL']);
  });

  it('leaves out a credit whose clock has run out', async () => {
    const pool = await creditPool(db, { orgId, travelerId: tomasId, now: new Date() });
    expect(pool.map((c) => c.airlineCode)).not.toContain('AS');
  });
});

/* -------------------------- the agent's credit check ------------------------ */

describe('the agent checks the pool before spending', () => {
  it('escalates rather than paying cash over an unused credit', async () => {
    const clock = new Clock(new Date());
    const outcome = await runAgent((await submitForTomas(depsFor(clock), 'cr-escalate')).id, depsFor(clock), marcus);

    expect(outcome.status).toBe('pending_approval');
    expect(outcome.selected!.verdict.blockers.map((b) => b.ruleId)).toContain('credit_first');
  });

  it('writes the credit position into the audit trail, refusals included', async () => {
    const clock = new Clock(new Date());
    const request = await submitForTomas(depsFor(clock), 'cr-audit');
    await runAgent(request.id, depsFor(clock), marcus);
    await approveRequest(request.id, shelley, depsFor(clock));

    const check = await db.query.agentRuns.findFirst({
      where: and(eq(s.agentRuns.travelRequestId, request.id), eq(s.agentRuns.step, 'credit_check')),
    });
    expect(check).toBeTruthy();

    const detail = check!.detail as { redeemableElsewhereCents: number; rejected: unknown[] };
    // The Delta credit is real money we hold and cannot spend through the
    // provider, and the trail has to say so at the moment cash was spent.
    expect(detail.redeemableElsewhereCents).toBe(61_200);
    expect(detail.rejected.length).toBeGreaterThan(0);
  });

  it('alerts the traveler and a manager about credit it could not reach', async () => {
    const clock = new Clock(new Date());
    const request = await submitForTomas(depsFor(clock), 'cr-alert');
    await runAgent(request.id, depsFor(clock), marcus);
    await approveRequest(request.id, shelley, depsFor(clock));

    const alerts = await db.select().from(s.alerts);
    const unreachable = alerts.filter((a) => a.dedupeKey.includes(':unreachable:'));
    expect(unreachable.length).toBeGreaterThan(0);
    expect(unreachable[0].severity).toBe('warning');
    expect(unreachable[0].title).toContain('DL credit went unused');
  });

  it('does not burn a credit on a dry run — the ticket does not exist', async () => {
    const clock = new Clock(new Date());
    const request = await submitForTomas(depsFor(clock), 'cr-dryrun');
    await runAgent(request.id, depsFor(clock), marcus);
    await approveRequest(request.id, shelley, depsFor(clock));

    const entries = await db
      .select()
      .from(s.ticketCreditEntries)
      .where(eq(s.ticketCreditEntries.kind, 'applied'));
    expect(entries).toHaveLength(0);

    const pool = await creditPool(db, { orgId, travelerId: tomasId, now: clock.now() });
    expect(pool.reduce((n, c) => n + c.remainingValueCents, 0)).toBe(18_400 + 61_200);
  });
});

/* ------------------------------ live settlement ----------------------------- */

describe('settling the ledger against a real purchase', () => {
  /**
   * The winning fare on this route is Delta's, so the redeemable credit has to
   * be a Delta one — a credit only applies to a ticket its own carrier flew.
   * The AA credit stays in the pool as the thing that correctly does *not* apply.
   */
  beforeEach(async () => {
    await db
      .update(s.ticketCredits)
      .set({ providerCreditId: 'acr_dl_redeemable', originalValueCents: 18_400, remainingValueCents: 18_400 })
      .where(eq(s.ticketCredits.airlineCode, 'DL'));
    await db
      .update(s.ticketCreditEntries)
      .set({ deltaCents: 18_400, balanceAfterCents: 18_400 })
      .where(
        eq(
          s.ticketCreditEntries.creditId,
          (await db.query.ticketCredits.findFirst({
            where: eq(s.ticketCredits.airlineCode, 'DL'),
          }))!.id,
        ),
      );
  });

  it('sends only the credits the provider can redeem, and draws down what it took', async () => {
    const clock = new Clock(new Date());
    // The AA credit is worth $184 and carries a provider id; the DL one does not.
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), 18_400);
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitForTomas(deps, 'cr-live');
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);

    expect(spy.purchases[0].creditIds).toEqual(['acr_dl_redeemable']);

    const booking = await db.query.bookings.findFirst({
      where: eq(s.bookings.travelRequestId, request.id),
    });
    expect(booking!.creditAppliedCents).toBe(18_400);

    const dl = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'DL'),
    });
    expect(dl!.remainingValueCents).toBe(0);
    expect(dl!.status).toBe('used');

    // The American credit is untouched: this itinerary never flew American, and
    // a credit only pays for a ticket on the carrier that issued it.
    const aa = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'AA'),
    });
    expect(aa!.remainingValueCents).toBe(18_400);
  });

  it('records what the provider took, not what we hoped it would', async () => {
    const clock = new Clock(new Date());
    // The provider only honours $100 of the $184 credit.
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), 10_000);
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitForTomas(deps, 'cr-partial');
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);

    const dl = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'DL'),
    });
    expect(dl!.remainingValueCents).toBe(8_400);
    expect(dl!.status).toBe('partially_used');
  });

  it('flags a discount larger than the ledger can support instead of inventing it', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), 30_000);
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitForTomas(deps, 'cr-discrepancy');
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);

    expect(await stepsOf(request.id)).toContain('credit_discrepancy');
    const dl = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'DL'),
    });
    // Drawn down by what it actually held, never below zero.
    expect(dl!.remainingValueCents).toBe(0);
  });

  it('puts the credit movement on the audit trail a person actually reads', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), 18_400);
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitForTomas(deps, 'cr-audit-trail');
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);

    const { getAuditTrail, renderAuditTrail } = await import('@/lib/travel/audit');
    const trail = await getAuditTrail(request.id, db);
    expect(trail.creditEntries).toHaveLength(1);
    expect(trail.creditEntries[0].kind).toBe('applied');
    expect(renderAuditTrail(trail)).toContain('$184.00 applied against the fare');
  });

  it('returns the credit when the trip is cancelled', async () => {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }), 18_400);
    const deps = depsFor(clock, { live: true, provider: spy });

    const request = await submitForTomas(deps, 'cr-cancel');
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);
    await cancelRequest(request.id, shelley, 'show pulled', deps);

    const dl = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'DL'),
    });
    expect(dl!.remainingValueCents).toBe(18_400);
    expect(dl!.status).toBe('available');
    expect(await stepsOf(request.id)).toContain('credit_released');
  });
});

/* --------------------------- the ledger's integrity ------------------------- */

describe('a balance you can always explain', () => {
  it('reconciles the cached balance against the entries that produced it', async () => {
    const { aa } = await resetCredits();
    const check = await reconcileCredit(db, aa.id);
    expect(check.ok).toBe(true);
    expect(check.ledgerCents).toBe(18_400);
  });

  it('refuses an entry that would take a credit below zero', async () => {
    const { aa } = await resetCredits();
    const { recordEntry } = await import('@/lib/travel/credits');
    await expect(
      recordEntry(db, {
        credit: aa,
        kind: 'applied',
        deltaCents: -99_999,
        reason: 'nope',
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(CreditLedgerError);
  });

  it('refuses to grow a credit past the ticket that created it', async () => {
    const { aa } = await resetCredits();
    const { recordEntry } = await import('@/lib/travel/credits');
    await expect(
      recordEntry(db, {
        credit: aa,
        kind: 'released',
        deltaCents: 1,
        reason: 'nope',
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(CreditLedgerError);
  });
});

/* ------------------------------- issuance ---------------------------------- */

describe('issuing a credit from a cancelled ticket', () => {
  async function aBooking() {
    const clock = new Clock(new Date());
    const spy = new SpyProvider(new RecordedFlightProvider({ now: clock.now }));
    const deps = depsFor(clock, { live: true, provider: spy });
    const request = await submitForTomas(deps, `issue-${Math.random()}`);
    await runAgent(request.id, deps, marcus);
    await approveRequest(request.id, shelley, deps);
    return (await db.query.bookings.findFirst({
      where: eq(s.bookings.travelRequestId, request.id),
    }))!;
  }

  it('opens the credit at zero and moves it with an entry, so its origin is on the record', async () => {
    const booking = await aBooking();
    const now = new Date();
    const { credit, entry } = await issueCreditFromCancellation(db, {
      booking,
      orgId,
      travelerId: tomasId,
      airlineCode: 'DL',
      valueCents: 43_055,
      expiresOn: new Date(now.getTime() + 365 * DAY),
      reason: 'Automate 2026 cancelled',
      now,
    });

    expect(entry.kind).toBe('issued');
    expect(entry.balanceAfterCents).toBe(43_055);
    expect((await reconcileCredit(db, credit.id)).ok).toBe(true);
  });

  it('refuses a guessed expiry date that is already past', async () => {
    const booking = await aBooking();
    await expect(
      issueCreditFromCancellation(db, {
        booking,
        orgId,
        travelerId: tomasId,
        airlineCode: 'DL',
        valueCents: 1_000,
        expiresOn: new Date(Date.now() - DAY),
        reason: 'nope',
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(CreditLedgerError);
  });

  it('refuses to issue two credits from one cancelled ticket', async () => {
    const booking = await aBooking();
    const args = {
      booking,
      orgId,
      travelerId: tomasId,
      airlineCode: 'DL',
      valueCents: 1_000,
      expiresOn: new Date(Date.now() + 100 * DAY),
      reason: 'once',
      now: new Date(),
    };
    await issueCreditFromCancellation(db, args);
    await expect(issueCreditFromCancellation(db, args)).rejects.toBeInstanceOf(CreditLedgerError);
  });
});

/* -------------------------- expiry: the whole point ------------------------- */

describe('expiry', () => {
  it('writes off an expired credit as an entry, so the loss is a number', async () => {
    const now = new Date();
    const swept = await sweepExpiredCredits(db, orgId, now);

    expect(swept.map((x) => x.credit.airlineCode)).toEqual(['AS']);
    expect(swept[0].forfeitedCents).toBe(27_300);

    const written = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.airlineCode, 'AS'),
    });
    expect(written!.status).toBe('expired');
    expect(written!.remainingValueCents).toBe(0);

    const exposure = await creditExposure(db, orgId, now);
    expect(exposure.forfeitedCents).toBe(27_300);
  });

  it('sweeps once — a second run finds nothing left to write off', async () => {
    await sweepExpiredCredits(db, orgId, new Date());
    expect(await sweepExpiredCredits(db, orgId, new Date())).toHaveLength(0);
  });

  it('warns at the tightest threshold a credit has crossed', async () => {
    const soon = await creditsExpiringSoon(db, orgId, new Date());
    const dl = soon.find((x) => x.credit.airlineCode === 'DL')!;
    expect(dl.bucketDays).toBe(30);
  });

  it('says each threshold once, however often the job runs', async () => {
    const now = new Date();
    const first = await runCreditMaintenance(db, orgId, now);
    expect(first.alertsSent).toBeGreaterThan(0);

    // The count is of alerts actually written, not attempted: an alert that
    // repeats nightly teaches everyone to ignore it.
    const second = await runCreditMaintenance(db, orgId, now);
    expect(second.alertsSent).toBe(0);
    expect(second.warned).toBe(first.warned);
  });

  it('writes off before it warns, so nobody is sent to an airline that will refuse them', async () => {
    const now = new Date();
    const result = await runCreditMaintenance(db, orgId, now);
    expect(result.forfeitedCents).toBe(27_300);

    const alerts = await db.select().from(s.alerts);
    expect(alerts.some((a) => a.title.includes('AS credit'))).toBe(false);
  });

  it('reports the exposure the way a travel manager needs it', async () => {
    const exposure = await creditExposure(db, orgId, new Date());
    expect(exposure.liveCents).toBe(18_400 + 61_200);
    expect(exposure.expiringWithin30Cents).toBe(61_200);
    // Money we hold that this provider cannot spend for us.
    expect(exposure.redeemableElsewhereCents).toBe(61_200);
  });
});
