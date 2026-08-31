import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, type Actor } from '@/lib/auth/actor';
import { RecordedFlightProvider } from '@/lib/integrations/flights/recorded/provider';
import { runAgent, submitTravelRequest, type AgentDeps } from '@/lib/travel/agent';
import {
  approvalsQueue,
  listRequests,
  loadRequest,
  travelersFor,
  NotFoundError,
} from '@/lib/travel/queue';
import { selectProvider, selectProviderOrNull } from '@/lib/travel/provider';

/**
 * Step 9 — the travel screens' read layer against the real database.
 *
 * The pure half (`review.ts`: what approving authorizes, and who may do what)
 * has its own tests. What is only checkable here is the part that touches rows,
 * and specifically the part that matters if it is wrong: **a Member's queries
 * must not return a colleague's fare at all.** Hiding it in JSX would pass a
 * visual check and still ship the number to the browser, so the assertion is
 * against the data the query returns, not against what a page renders.
 *
 * The fixtures are built by running the real agent against the `recorded`
 * provider, the same way `scripts/seed.ts` builds its own — never by inserting
 * offer snapshots by hand, which would put fares no airline ever quoted into
 * the table the audit story rests on. They are built here rather than read from
 * the seed because the other spine tests wipe `travel_requests` between files,
 * so a test that depended on the seeded rows would pass alone and fail in the
 * suite.
 */

const db = getDb();

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let shelley: Actor;
let marcus: Actor;
let priya: Actor;

const DAY = 86_400_000;
const deps = (at: Date): AgentDeps => ({
  db,
  provider: new RecordedFlightProvider({ now: () => at }),
  now: () => at,
  live: false,
});

beforeAll(async () => {
  shelley = await actorFor('shelley@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');

  await db.delete(s.travelRequests);

  const ingrid = await db.query.users.findFirst({
    where: eq(s.users.email, 'ingrid@northwindrobotics.test'),
  });
  const automate = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });

  // Within policy, auto-booked: Priya's own, and the row a member should see.
  const now = new Date();
  const domestic = await submitTravelRequest(
    {
      showId: automate!.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(automate!.moveInAt!.getTime() - DAY),
      latestArrival: automate!.moveInAt!,
      idempotencyKey: 'queue-test:domestic',
    },
    priya,
    deps(now),
  );
  await runAgent(domestic.id, deps(now), priya);

  // Over the band and left waiting — run two hours in the past, against a
  // thirty-minute offer life, so its fare is already dead. That is the case the
  // approvals queue exists for, and a fixture with a live offer never shows it.
  const past = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  // Aligned to the top of an hour. The `recorded` provider rebases a captured
  // payload onto the requested departure, and an unaligned window leaves the
  // replayed flight a few minutes before it — which the policy engine correctly
  // rejects as outside the constraints, giving `no_options` instead of the
  // escalation this fixture is for.
  const depart = new Date(past.getTime() + 45 * DAY);
  depart.setMinutes(0, 0, 0);
  const intl = await submitTravelRequest(
    {
      travelerId: ingrid!.id,
      originAirport: 'SFO',
      destinationAirport: 'LHR',
      earliestDeparture: depart,
      latestArrival: new Date(depart.getTime() + 2 * DAY),
      idempotencyKey: 'queue-test:intl',
    },
    marcus,
    deps(past),
  );
  await runAgent(intl.id, deps(past), marcus);
});

describe('listRequests — visibility', () => {
  it('gives an approver the whole org', async () => {
    const all = await listRequests(marcus, { scope: 'all' }, db);
    const travelers = new Set(all.map((r) => r.traveler.id));
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(travelers.size).toBeGreaterThan(1);
  });

  /**
   * The one that matters. A member asking for everything gets themselves —
   * `scope: 'all'` is a request, not an authorization.
   */
  it('narrows a member to their own travel even when they ask for all of it', async () => {
    const asked = await listRequests(priya, { scope: 'all' }, db);
    for (const r of asked) expect(r.traveler.id).toBe(priya.userId);
  });

  it('never puts a colleague’s fare in a member’s result at all', async () => {
    const orgWide = await listRequests(marcus, { scope: 'all' }, db);
    const someoneElse = orgWide.find(
      (r) => r.traveler.id !== priya.userId && r.quotedCents !== null,
    );
    expect(someoneElse, 'the fixtures include a priced request for another traveler').toBeDefined();

    const asMember = await listRequests(priya, { scope: 'all' }, db);
    expect(asMember.find((r) => r.id === someoneElse!.id)).toBeUndefined();
  });

  it('a travel manager asking for their own list is not shown the whole org', async () => {
    const mine = await listRequests(marcus, { scope: 'mine' }, db);
    for (const r of mine) expect(r.traveler.id).toBe(marcus.userId);
  });

  it('filters by status when asked', async () => {
    const waiting = await listRequests(shelley, { scope: 'all', statuses: ['pending_approval'] }, db);
    for (const r of waiting) expect(r.status).toBe('pending_approval');
  });
});

describe('the standing of each offer travels with the row', () => {
  it('marks the seeded escalated request as expired and therefore a ceiling', async () => {
    const queue = await approvalsQueue(shelley, db);
    const lhr = queue.find((r) => r.destinationAirport === 'LHR');
    expect(lhr, 'the fixtures leave one request awaiting approval').toBeDefined();

    // Seeded two hours in the past against a 30-minute offer life, so this is
    // the case SCOPE.md §6b is about: the number is a ceiling, not a fare.
    expect(lhr!.standing?.kind).toBe('expired');
    expect(lhr!.standing?.bookableAtShownPrice).toBe(false);
    expect(lhr!.quotedCents).toBeGreaterThan(0);
  });

  it('reports an age measured from one instant, not from the clock at render', async () => {
    const rows = await listRequests(shelley, { scope: 'all' }, db);
    for (const r of rows) expect(r.ageMs).toBeGreaterThanOrEqual(0);
  });
});

describe('loadRequest — org scoping', () => {
  it('loads a request the actor may see', async () => {
    const [first] = await listRequests(shelley, { scope: 'all' }, db);
    const loaded = await loadRequest(shelley, first.id, db);
    expect(loaded.request.id).toBe(first.id);
  });

  /**
   * Not-found rather than forbidden, deliberately: a "you may not see this"
   * would confirm that a colleague is flying somewhere.
   */
  it('is indistinguishable from missing when a member asks for someone else’s', async () => {
    const orgWide = await listRequests(marcus, { scope: 'all' }, db);
    const notPriyas = orgWide.find((r) => r.traveler.id !== priya.userId)!;
    await expect(loadRequest(priya, notPriyas.id, db)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an id that is not in this workspace', async () => {
    await expect(
      loadRequest(shelley, '00000000-0000-0000-0000-000000000000', db),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('travelersFor', () => {
  it('offers a member only themselves — booking for others is a manager capability', async () => {
    const options = await travelersFor(priya, db);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe(priya.userId);
  });

  it('offers a travel manager the whole org', async () => {
    expect((await travelersFor(marcus, db)).length).toBeGreaterThan(1);
  });
});

/* ------------------------------ provider choice ----------------------------- */

describe('selectProvider', () => {
  it('replays only when explicitly asked to, and says so', () => {
    const choice = selectProvider({ FLIGHT_PROVIDER: 'recorded' });
    expect(choice.source).toBe('recorded');
    expect(choice.replayed).toBe(true);
  });

  /**
   * The rule the whole file exists for. With nothing configured there is no
   * silent downgrade to replayed offers — a screen showing a fare nobody is
   * selling is indistinguishable, on that screen, from real availability.
   */
  it('refuses to substitute recorded offers for a missing key', () => {
    expect(() => selectProvider({})).toThrow(/DUFFEL_ACCESS_TOKEN/);
  });

  it('rejects a provider name it does not have rather than guessing', () => {
    expect(() => selectProvider({ FLIGHT_PROVIDER: 'sabre' })).toThrow(
      /not a provider/,
    );
  });

  it('uses Duffel when a token is present, and does not call it replayed', () => {
    const choice = selectProvider({ DUFFEL_ACCESS_TOKEN: 'duffel_test_xxx' });
    expect(choice.source).toBe('duffel');
    expect(choice.replayed).toBe(false);
  });

  it('hands back a message instead of throwing, for screens that load before searching', () => {
    const result = selectProviderOrNull({});
    expect('unavailable' in result && result.unavailable).toMatch(/DUFFEL_ACCESS_TOKEN/);
  });
});
