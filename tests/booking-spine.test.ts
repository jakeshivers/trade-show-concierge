import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { RecordedFlightProvider } from '@/lib/integrations/flights/recorded/provider';
import type { FlightProvider, SearchRequest, SearchResult } from '@/lib/integrations/flights/types';
import { DryRunError } from '@/lib/integrations/flights/types';
import {
  submitTravelRequest,
  runAgent,
  approveRequest,
  rejectRequest,
  expireStaleRequests,
  confirmConstraints,
  ConcurrentUpdateError,
  HardCeilingError,
  type AgentDeps,
} from '@/lib/travel/agent';
import { resolveTravelPolicy } from '@/lib/travel/policy-store';

/**
 * Step 4: the booking spine, end to end, against the real database and the real
 * policy engine. Offers come from replayed payloads, so this runs with no API
 * keys and no network — which is the only reason the riskiest component in the
 * project can be tested this early.
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

function depsFor(clock: Clock, provider?: FlightProvider): AgentDeps {
  return {
    db,
    provider: provider ?? new RecordedFlightProvider({ now: clock.now }),
    now: clock.now,
    live: false,
  };
}

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let priya: Actor;
let marcus: Actor;
let dana: Actor;
let ingridId: string;
let automate: typeof s.shows.$inferSelect;

beforeAll(async () => {
  priya = await actorFor('priya@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  dana = await actorFor('dana@northwindrobotics.test');

  const ingrid = await db.query.users.findFirst({
    where: eq(s.users.email, 'ingrid@northwindrobotics.test'),
  });
  ingridId = ingrid!.id;

  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  automate = show!;
});

beforeEach(async () => {
  // Every test starts from an empty spine; the seeded planning data stays.
  await db.delete(s.travelRequests);
});

/** A domestic request that the seeded policy will wave through. */
async function submitDomestic(clock: Clock, deps: AgentDeps, key: string) {
  return submitTravelRequest(
    {
      showId: automate.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
      latestArrival: automate.moveInAt!,
      idempotencyKey: key,
    },
    priya,
    deps,
  );
}

/** An international request that lands above the executive auto-approve band. */
async function submitInternational(clock: Clock, deps: AgentDeps, key: string) {
  const depart = new Date(clock.now().getTime() + 45 * DAY);
  return submitTravelRequest(
    {
      travelerId: ingridId,
      originAirport: 'SFO',
      destinationAirport: 'LHR',
      earliestDeparture: depart,
      latestArrival: new Date(depart.getTime() + 2 * DAY),
      idempotencyKey: key,
    },
    marcus,
    deps,
  );
}

/* ------------------------------ policy loading ------------------------------ */

describe('policy resolution from the database', () => {
  it('layers a cost-center override onto the org baseline', async () => {
    const se = await db.query.costCenters.findFirst({ where: eq(s.costCenters.code, 'SE-200') });
    const resolved = await resolveTravelPolicy(priya.orgId, { costCenterId: se!.id }, db);

    // Tightened by Sales Engineering...
    expect(resolved.policy.maxAirfareDomesticCents).toBe(55_000);
    // ...while everything the override is silent about comes from the org row.
    expect(resolved.policy.minConnectionMinutes).toBe(60);
    expect(resolved.policy.bands.denyOverCents).toBe(120_000);
    expect(resolved.layers).toHaveLength(2);
  });

  it('does not let an override blank out a limit by omission', async () => {
    const exec = await db.query.costCenters.findFirst({ where: eq(s.costCenters.code, 'EXEC-001') });
    const resolved = await resolveTravelPolicy(priya.orgId, { costCenterId: exec!.id }, db);

    // The executive layer raises the fare caps and says nothing about hotels,
    // stops, or connections. Null on an override means inherit, never "unlimited".
    expect(resolved.policy.maxAirfareInternationalCents).toBe(450_000);
    expect(resolved.policy.maxStops).toBe(1);
    expect(resolved.policy.maxHotelNightlyRateCents).toBe(30_000);
  });

  it('merges approval bands field by field, not wholesale', async () => {
    const exec = await db.query.costCenters.findFirst({ where: eq(s.costCenters.code, 'EXEC-001') });
    const resolved = await resolveTravelPolicy(priya.orgId, { costCenterId: exec!.id }, db);
    expect(resolved.policy.bands.autoApproveUnderCents).toBe(120_000);
    expect(resolved.policy.bands.denyOverCents).toBe(500_000);
  });
});

/* ------------------------------- the auto path ------------------------------ */

describe('within policy: the agent books without asking anyone', () => {
  it('ends ticketed, with a dry-run booking that spent nothing', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'auto-1');
    const outcome = await runAgent(request.id, deps, priya);

    expect(outcome.status).toBe('ticketed');
    expect(outcome.selected?.verdict.decision).toBe('auto_approve');
    expect(outcome.booking?.live).toBe(false);
    expect(outcome.booking?.chargedCents).toBe(43_055);
    // Unmistakable at a glance, in a report, and in a query.
    expect(outcome.booking?.providerOrderId).toMatch(/^dryrun:/);
    expect(outcome.booking?.ticketNumbers).toEqual([]);
  });

  it('books to a cost center, never to nothing', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'auto-2');
    const outcome = await runAgent(request.id, deps, priya);
    expect(outcome.booking?.costCenterId).toBe(request.costCenterId);
    expect(outcome.booking?.costCenterId).not.toBeNull();
  });

  it('records a verdict for every offer it saw, not just the one it took', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'auto-3');
    await runAgent(request.id, deps, priya);

    const snapshots = await db
      .select()
      .from(s.offerSnapshots)
      .where(eq(s.offerSnapshots.travelRequestId, request.id));
    const evaluations = await db
      .select()
      .from(s.policyEvaluations)
      .where(eq(s.policyEvaluations.travelRequestId, request.id));

    expect(snapshots.length).toBeGreaterThan(1);
    expect(evaluations).toHaveLength(snapshots.length);
    expect(snapshots.filter((o) => o.selected)).toHaveLength(1);
  });

  it('writes the resolved rule set onto the evaluation, not a pointer to today', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'auto-4');
    await runAgent(request.id, deps, priya);

    const [evaluation] = await db
      .select()
      .from(s.policyEvaluations)
      .where(eq(s.policyEvaluations.travelRequestId, request.id));
    const stored = evaluation.resolvedPolicy as { policy: { maxAirfareDomesticCents: number }; layers: unknown[] };

    // Priya is Sales Engineering, so the $550 override is what actually ran.
    expect(stored.policy.maxAirfareDomesticCents).toBe(55_000);
    expect(stored.layers).toHaveLength(2);
  });

  it('leaves an audit trail that reads as a sequence of statuses', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'auto-5');
    await runAgent(request.id, deps, priya);

    const runs = await db
      .select()
      .from(s.agentRuns)
      .where(eq(s.agentRuns.travelRequestId, request.id))
      .orderBy(s.agentRuns.sequence);

    expect(runs.map((r) => r.step)).toEqual([
      'submit',
      'search_start',
      'search',
      'offers_found',
      'booking_start',
      'ticketed',
    ]);
  });
});

/* ------------------------------- idempotency -------------------------------- */

describe('one ticket per request, ever', () => {
  it('returns the original request when the same key is submitted twice', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const first = await submitDomestic(clock, deps, 'idem-1');
    const second = await submitDomestic(clock, deps, 'idem-1');

    expect(second.id).toBe(first.id);
    const all = await db.select().from(s.travelRequests);
    expect(all).toHaveLength(1);
  });

  it('refuses a second run against an already-ticketed request', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'idem-2');
    await runAgent(request.id, deps, priya);

    // A retried job, a double-clicked button, a second worker: all land here.
    await expect(runAgent(request.id, deps, priya)).rejects.toThrow();
    const bookings = await db
      .select()
      .from(s.bookings)
      .where(eq(s.bookings.travelRequestId, request.id));
    expect(bookings).toHaveLength(1);
  });

  it('makes the status column itself the lock', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitDomestic(clock, deps, 'idem-3');

    const [a, b] = await Promise.allSettled([
      runAgent(request.id, deps, priya),
      runAgent(request.id, deps, priya),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConcurrentUpdateError);
  });
});

/* -------------------------------- escalation -------------------------------- */

describe('over the band: escalation and approval', () => {
  it('parks the request in pending_approval with the reasons attached', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitInternational(clock, deps, 'esc-1');
    const outcome = await runAgent(request.id, deps, marcus);

    expect(outcome.status).toBe('pending_approval');
    expect(outcome.selected?.verdict.decision).toBe('needs_approval');
    expect(outcome.selected?.verdict.reasons.join(' ')).toMatch(/auto-approve threshold/);

    const bookings = await db.select().from(s.bookings);
    expect(bookings).toHaveLength(0);
  });

  it('enforces separation of duties — you cannot approve what you asked for', async () => {
    const clock = new Clock(new Date());
    // Only the premium-economy fare is on offer, so Dana's own request has to
    // go to somebody for a decision.
    const { holdableOffer } = await import('@/lib/integrations/flights/duffel/fixtures');
    const deps = depsFor(clock, new RecordedFlightProvider({ now: clock.now, payloads: [holdableOffer] }));

    const request = await submitTravelRequest(
      {
        showId: automate.id,
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
        latestArrival: automate.moveInAt!,
        idempotencyKey: 'esc-2',
      },
      dana,
      deps,
    );
    const escalated = await runAgent(request.id, deps, dana);
    expect(escalated.status).toBe('pending_approval');

    await expect(approveRequest(request.id, dana, deps)).rejects.toThrow(ForbiddenError);
  });

  it('books on approval while the offer is still alive', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitInternational(clock, deps, 'esc-3');
    await runAgent(request.id, deps, marcus);

    clock.advanceMinutes(5);
    const approved = await approveRequest(request.id, dana, depsFor(clock));

    expect(approved.status).toBe('ticketed');
    const [approval] = await db
      .select()
      .from(s.approvals)
      .where(eq(s.approvals.travelRequestId, request.id));
    expect(approval.outcome).toBe('approved');
    expect(approval.reSearchedOnApproval).toBe(false);
    expect(approval.priceAtApprovalCents).toBe(128_490);
  });

  it('records a rejection against the evaluation that was refused', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitInternational(clock, deps, 'esc-4');
    await runAgent(request.id, deps, marcus);

    const rejected = await rejectRequest(request.id, dana, 'Take the Q3 trip instead', deps);
    expect(rejected.status).toBe('rejected');

    const [approval] = await db
      .select()
      .from(s.approvals)
      .where(eq(s.approvals.travelRequestId, request.id));
    expect(approval.outcome).toBe('rejected');
    expect(approval.policyEvaluationId).not.toBeNull();
  });
});

/* ------------------------ expiry and re-search-on-approval ------------------ */

/** Replays one price on the first search and a different one afterwards. */
class RepricingProvider implements FlightProvider {
  readonly name = 'recorded';
  private calls = 0;
  constructor(
    private readonly first: FlightProvider,
    private readonly then: FlightProvider,
  ) {}
  isConfigured() {
    return true;
  }
  async search(request: SearchRequest): Promise<SearchResult> {
    this.calls += 1;
    return this.calls === 1 ? this.first.search(request) : this.then.search(request);
  }
  hold(...args: Parameters<FlightProvider['hold']>) {
    return this.first.hold(...args);
  }
  purchase(...args: Parameters<FlightProvider['purchase']>) {
    return this.first.purchase(...args);
  }
  cancel(...args: Parameters<FlightProvider['cancel']>) {
    return this.first.cancel(...args);
  }
}

describe('the offer dies while the approver sleeps', () => {
  it('re-searches on approval and flags the approval as re-searched', async () => {
    const clock = new Clock(new Date());
    const request = await submitInternational(clock, depsFor(clock), 'exp-1');
    await runAgent(request.id, depsFor(clock), marcus);

    // Duffel offers live about thirty minutes. Approval queues live overnight.
    clock.advanceMinutes(120);
    const approved = await approveRequest(request.id, dana, depsFor(clock));

    expect(approved.status).toBe('ticketed');
    const [approval] = await db
      .select()
      .from(s.approvals)
      .where(eq(s.approvals.travelRequestId, request.id));
    expect(approval.reSearchedOnApproval).toBe(true);

    // Both captures survive: the audit must show what was approved *and* what
    // was actually bought.
    const snapshots = await db
      .select()
      .from(s.offerSnapshots)
      .where(eq(s.offerSnapshots.travelRequestId, request.id));
    expect(new Set(snapshots.map((o) => o.providerSearchId)).size).toBe(2);
    expect(snapshots.filter((o) => o.selected)).toHaveLength(1);
  });

  it('sends the request back to the queue when the new fare is higher', async () => {
    const clock = new Clock(new Date());
    const cheap = new RecordedFlightProvider({ now: clock.now });
    const dearer = new RecordedFlightProvider({
      now: clock.now,
      payloads: [
        {
          ...(await import('@/lib/integrations/flights/duffel/fixtures')).internationalOffer,
          total_amount: '1499.00',
        },
      ],
    });
    const provider = new RepricingProvider(cheap, dearer);

    const request = await submitInternational(clock, depsFor(clock, provider), 'exp-2');
    await runAgent(request.id, depsFor(clock, provider), marcus);

    clock.advanceMinutes(120);
    const outcome = await approveRequest(request.id, dana, depsFor(clock, provider));

    // The approval was for an amount, not for an offer id — and $1,499 is not
    // the $1,284.90 anyone signed off on.
    expect(outcome.status).toBe('pending_approval');
    expect(await db.select().from(s.bookings)).toHaveLength(0);
  });

  it('takes the cheaper re-priced fare without a second approval', async () => {
    const clock = new Clock(new Date());
    const cheap = new RecordedFlightProvider({ now: clock.now });
    const cheaper = new RecordedFlightProvider({
      now: clock.now,
      payloads: [
        {
          ...(await import('@/lib/integrations/flights/duffel/fixtures')).internationalOffer,
          total_amount: '1100.00',
        },
      ],
    });
    const provider = new RepricingProvider(cheap, cheaper);

    const request = await submitInternational(clock, depsFor(clock, provider), 'exp-3');
    await runAgent(request.id, depsFor(clock, provider), marcus);

    clock.advanceMinutes(120);
    const outcome = await approveRequest(request.id, dana, depsFor(clock, provider));

    expect(outcome.status).toBe('ticketed');
    expect(outcome.booking?.chargedCents).toBe(110_000);
  });

  it('sweeps requests whose offer expired with nobody watching', async () => {
    const clock = new Clock(new Date());
    const request = await submitInternational(clock, depsFor(clock), 'exp-4');
    await runAgent(request.id, depsFor(clock), marcus);

    clock.advanceMinutes(90);
    const expired = await expireStaleRequests(marcus.orgId, depsFor(clock));

    expect(expired.map((r) => r.id)).toContain(request.id);
    expect(expired[0].status).toBe('expired');
  });

  it('leaves a request alone while its offer is still good', async () => {
    const clock = new Clock(new Date());
    const request = await submitInternational(clock, depsFor(clock), 'exp-5');
    await runAgent(request.id, depsFor(clock), marcus);

    clock.advanceMinutes(10);
    expect(await expireStaleRequests(marcus.orgId, depsFor(clock))).toHaveLength(0);
  });
});

/* --------------------------------- the rails -------------------------------- */

describe('safety rails', () => {
  it('refuses to spend above the hard ceiling even after an approval', async () => {
    const clock = new Clock(new Date());
    const request = await submitInternational(clock, depsFor(clock), 'rail-1');
    await runAgent(request.id, depsFor(clock), marcus);

    // An admin tightens the executive ceiling while the request sits in the
    // queue. The check at purchase is independent of the verdict that got the
    // request this far, which is exactly what makes it worth having.
    const exec = await db.query.costCenters.findFirst({ where: eq(s.costCenters.code, 'EXEC-001') });
    await db
      .update(s.travelPolicies)
      .set({ denyOverCents: 100_000 })
      .where(
        and(eq(s.travelPolicies.scope, 'cost_center'), eq(s.travelPolicies.scopeRef, exec!.id)),
      );

    try {
      clock.advanceMinutes(5);
      await expect(approveRequest(request.id, dana, depsFor(clock))).rejects.toThrow(
        HardCeilingError,
      );
      expect(await db.select().from(s.bookings)).toHaveLength(0);
    } finally {
      await db
        .update(s.travelPolicies)
        .set({ denyOverCents: 500_000 })
        .where(
          and(eq(s.travelPolicies.scope, 'cost_center'), eq(s.travelPolicies.scopeRef, exec!.id)),
        );
    }
  });

  it('will not search free-text constraints a human has not confirmed', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const request = await submitTravelRequest(
      {
        showId: automate.id,
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
        latestArrival: automate.moveInAt!,
        rawRequestText: 'I need to be in Detroit the night before move-in, back Friday',
        idempotencyKey: 'rail-2',
      },
      priya,
      deps,
    );

    // An LLM's reading of a sentence is a proposal, not an authorization.
    await expect(runAgent(request.id, deps, priya)).rejects.toThrow(/unconfirmed/);

    await confirmConstraints(request.id, priya, deps);
    const outcome = await runAgent(request.id, deps, priya);
    expect(outcome.status).toBe('ticketed');
  });

  it('cannot be made to buy anything through the recorded provider', async () => {
    const provider = new RecordedFlightProvider();
    await expect(
      provider.purchase({ amountCents: 1, currency: 'USD', idempotencyKey: 'x' }),
    ).rejects.toThrow(DryRunError);
  });

  it('will not open a request for a traveler with no cost center', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const [orphan] = await db
      .insert(s.users)
      .values({
        orgId: priya.orgId,
        email: 'orphan@northwindrobotics.test',
        fullName: 'No Cost Center',
        role: 'member',
      })
      .returning();

    try {
      await expect(
        submitTravelRequest(
          {
            travelerId: orphan.id,
            originAirport: 'SFO',
            destinationAirport: 'DTW',
            earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
            latestArrival: automate.moveInAt!,
            idempotencyKey: 'rail-3',
          },
          marcus,
          deps,
        ),
      ).rejects.toThrow(/cost center/);
    } finally {
      await db.delete(s.users).where(eq(s.users.id, orphan.id));
    }
  });

  it('stops a member from booking travel for somebody else', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    await expect(
      submitTravelRequest(
        {
          travelerId: ingridId,
          originAirport: 'SFO',
          destinationAirport: 'DTW',
          earliestDeparture: new Date(automate.moveInAt!.getTime() - DAY),
          latestArrival: automate.moveInAt!,
          idempotencyKey: 'rail-4',
        },
        priya,
        deps,
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

/* -------------------------------- no options -------------------------------- */

describe('nothing bookable', () => {
  it('says why, so the user knows what to relax', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const depart = new Date(clock.now().getTime() + 40 * DAY);
    const request = await submitTravelRequest(
      {
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        earliestDeparture: depart,
        latestArrival: new Date(depart.getTime() + 4 * 3_600_000),
        idempotencyKey: 'none-1',
      },
      priya,
      deps,
    );
    const outcome = await runAgent(request.id, deps, priya);

    expect(outcome.status).toBe('no_options');
    expect(outcome.noOptionsReasons?.length).toBeGreaterThan(0);
    // Still recorded: an empty-handed search is exactly the thing a user will
    // ask about later.
    const snapshots = await db
      .select()
      .from(s.offerSnapshots)
      .where(eq(s.offerSnapshots.travelRequestId, request.id));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(await db.select().from(s.bookings)).toHaveLength(0);
  });

  it('returns no_options rather than a bad booking when the route is unserved', async () => {
    const clock = new Clock(new Date());
    const deps = depsFor(clock);
    const depart = new Date(clock.now().getTime() + 40 * DAY);
    const request = await submitTravelRequest(
      {
        originAirport: 'SFO',
        destinationAirport: 'MSP',
        earliestDeparture: depart,
        latestArrival: new Date(depart.getTime() + DAY),
        idempotencyKey: 'none-2',
      },
      priya,
      deps,
    );
    const outcome = await runAgent(request.id, deps, priya);
    expect(outcome.status).toBe('no_options');
    expect(outcome.ranked).toHaveLength(0);
  });
});
