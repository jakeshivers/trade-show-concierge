import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import {
  cloneShow,
  createProspect,
  decideShow,
  getItinerary,
  getShowDetail,
  listShows,
  listDecisions,
  NotFoundError,
} from '@/lib/shows/store';
import { IntakeError } from '@/lib/shows/intake';
import { seesTraveler, travelerScope } from '@/lib/shows/visibility';

/**
 * Step 8 — the planning core against the real database.
 *
 * The pure halves (clone planning, intake validation, the zoned shift) have their
 * own tests. What is only checkable here is the part that touches rows: that a
 * clone writes what the plan said and nothing else, that a decline keeps the show
 * and records why, and that a Member's show detail does not contain a colleague's
 * fare in the first place.
 */

const db = getDb();
const created: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let dana: Actor;
let marcus: Actor;
let priya: Actor;
let automateId: string;

beforeAll(async () => {
  dana = await actorFor('dana@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');

  const shows = await listShows(dana);
  automateId = shows.find((sh) => sh.name === 'Automate 2026')!.id;
});

afterAll(async () => {
  // Tests share the dev database with `pnpm booking:dry-run`; leaving half a
  // dozen phantom shows behind would quietly corrupt the next person's read of it.
  if (created.length) await db.delete(s.shows).where(inArray(s.shows.id, created));
});

describe('listShows', () => {
  it('returns the whole org calendar to a member, flagging which are theirs', async () => {
    const mine = await listShows(priya);
    expect(mine.length).toBeGreaterThanOrEqual(4);
    // Not a permission: the calendar is the org's plan. See visibility.ts.
    expect(mine.some((sh) => sh.name === 'PACK EXPO International 2027')).toBe(true);
    expect(mine.find((sh) => sh.name === 'Automate 2026')!.mine).toBe(true);
    expect(mine.find((sh) => sh.name === 'PACK EXPO International 2027')!.mine).toBe(false);
  });

  it('scores readiness from the tasks, not from the status column', async () => {
    const shows = await listShows(dana);
    const automate = shows.find((sh) => sh.id === automateId)!;
    expect(automate.taskCount).toBeGreaterThan(0);
    // A breakdown, not a bare number, as of step 10 — see lib/readiness/score.ts.
    expect(automate.readiness.score).toBeGreaterThan(0);
    expect(automate.readiness.score).toBeLessThan(100);
  });
});

describe('show detail visibility', () => {
  it('gives a travel manager every traveler on the show', async () => {
    expect(travelerScope(marcus)).toEqual({ kind: 'all' });
    const detail = await getShowDetail(marcus, automateId);
    const travelers = new Set(detail.flights.map((f) => f.traveler.email));
    expect(travelers.size).toBeGreaterThan(1);
    expect(detail.travelNarrowed).toBe(false);
  });

  it('narrows a member to their own flights in the query, not in the markup', async () => {
    const detail = await getShowDetail(priya, automateId);
    expect(detail.travelNarrowed).toBe(true);
    expect(detail.flights.length).toBeGreaterThan(0);
    expect(detail.flights.every((f) => f.traveler.id === priya.userId)).toBe(true);
    expect(seesTraveler(priya, dana.userId)).toBe(false);
  });

  it('still shows a member the show-wide planning facts', async () => {
    const detail = await getShowDetail(priya, automateId);
    expect(detail.tasks.length).toBeGreaterThan(0);
    expect(detail.deadlines.length).toBeGreaterThan(0);
    expect(detail.attendees.length).toBeGreaterThan(1);
  });

  it('refuses a show id from outside the workspace', async () => {
    const [other] = await db
      .insert(s.organizations)
      .values({ name: 'Someone Else Inc' })
      .returning();
    const [foreign] = await db
      .insert(s.shows)
      .values({
        orgId: other.id,
        name: 'Not Yours 2026',
        startsOn: new Date(),
        endsOn: new Date(),
      })
      .returning();

    await expect(getShowDetail(dana, foreign.id)).rejects.toThrow(NotFoundError);
    await db.delete(s.organizations).where(eq(s.organizations.id, other.id));
  });
});

describe('intake', () => {
  it('records a proposal as a prospect with its written argument', async () => {
    const { id } = await createProspect(priya, {
      name: 'Hannover Messe 2027',
      startsOn: '2027-04-19',
      endsOn: '2027-04-23',
      city: 'Hannover',
      country: 'DE',
      airportCode: 'haj',
      timezone: 'Europe/Berlin',
      budgetCents: 9_000_000,
      rationale: 'European manufacturing buyers we have no other route to reach.',
    });
    created.push(id);

    const show = await db.query.shows.findFirst({ where: eq(s.shows.id, id) });
    expect(show!.status).toBe('prospect');
    expect(show!.airportCode).toBe('HAJ');
    // 09:00 in Berlin on the nominated day, not 09:00 wherever the server is.
    expect(show!.startsOn.toISOString()).toBe('2027-04-19T07:00:00.000Z');

    const decisions = await listDecisions(priya, id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision.decision).toBe('proposed');
    expect(decisions[0].by!.email).toBe(priya.email);
  });

  it('refuses a proposal with no real argument behind it', async () => {
    await expect(
      createProspect(priya, {
        name: 'Some Show',
        startsOn: '2027-04-19',
        endsOn: '2027-04-23',
        timezone: 'UTC',
        rationale: 'looks good',
      }),
    ).rejects.toThrow(IntakeError);
  });

  it('lets an admin commit a prospect and keeps the reasoning', async () => {
    const { id } = await createProspect(dana, {
      name: 'Commitable Show 2027',
      startsOn: '2027-09-01',
      endsOn: '2027-09-03',
      timezone: 'America/Chicago',
      rationale: 'Test fixture with a rationale long enough to be a real one.',
    });
    created.push(id);

    await decideShow(dana, id, 'committed', 'Budget approved out of the field marketing line.');
    const show = await db.query.shows.findFirst({ where: eq(s.shows.id, id) });
    expect(show!.status).toBe('committed');

    const decisions = await listDecisions(dana, id);
    expect(decisions.map((d) => d.decision.decision)).toEqual(['committed', 'proposed']);
  });

  it('keeps a declined show rather than deleting it', async () => {
    const { id } = await createProspect(dana, {
      name: 'Declinable Show 2027',
      startsOn: '2027-10-01',
      endsOn: '2027-10-03',
      timezone: 'America/Chicago',
      rationale: 'Test fixture with a rationale long enough to be a real one.',
    });
    created.push(id);

    await decideShow(
      dana,
      id,
      'declined',
      'Booth space doubled and last year sourced almost nothing. Revisit in 2029.',
    );

    const show = await db.query.shows.findFirst({ where: eq(s.shows.id, id) });
    expect(show).toBeDefined();
    expect(show!.status).toBe('cancelled');
    const [latest] = await listDecisions(dana, id);
    expect(latest.decision.decision).toBe('declined');
    expect(latest.decision.rationale).toContain('sourced almost nothing');
  });

  it('will not let a travel manager decide, or an admin decide without a reason', async () => {
    const { id } = await createProspect(dana, {
      name: 'Guarded Show 2027',
      startsOn: '2027-11-01',
      endsOn: '2027-11-03',
      timezone: 'America/Chicago',
      rationale: 'Test fixture with a rationale long enough to be a real one.',
    });
    created.push(id);

    await expect(decideShow(marcus, id, 'committed', 'A perfectly good reason string.')).rejects.toThrow(
      ForbiddenError,
    );
    await expect(decideShow(dana, id, 'committed', 'ok')).rejects.toThrow(ForbiddenError);
  });

  it('refuses to re-decide a show that is already underway', async () => {
    await expect(
      decideShow(dana, automateId, 'declined', 'Changed our minds about the whole thing.'),
    ).rejects.toThrow(IntakeError);
  });
});

describe('cloneShow', () => {
  it('writes the plan and nothing else', async () => {
    const { id, plan } = await cloneShow(marcus, automateId, {
      name: 'Automate 2027',
      startsOn: '2027-06-07',
      include: { tasks: true, deadlines: true, team: true, assets: true },
    });
    created.push(id);

    const [tasks, deadlines, attendees, reservations, flights, lodgings, expenses] =
      await Promise.all([
        db.select().from(s.showTasks).where(eq(s.showTasks.showId, id)),
        db.select().from(s.showDeadlines).where(eq(s.showDeadlines.showId, id)),
        db.select().from(s.showAttendees).where(eq(s.showAttendees.showId, id)),
        db.select().from(s.assetReservations).where(eq(s.assetReservations.showId, id)),
        db.select().from(s.flights).where(eq(s.flights.showId, id)),
        db.select().from(s.lodgings).where(eq(s.lodgings.showId, id)),
        db.select().from(s.expenses).where(eq(s.expenses.showId, id)),
      ]);

    expect(tasks).toHaveLength(plan.tasks.length);
    expect(deadlines).toHaveLength(plan.deadlines.length);
    expect(attendees).toHaveLength(plan.attendees.length);
    expect(reservations).toHaveLength(plan.reservations.length);

    // The three that would be fabrications if they came along.
    expect(flights).toHaveLength(0);
    expect(lodgings).toHaveLength(0);
    expect(expenses).toHaveLength(0);

    // And every carried deadline comes back needing a human to re-read the manual.
    expect(deadlines.every((d) => d.confirmedAt === null)).toBe(true);
    expect(tasks.every((t) => t.status === 'not_started' && t.completedAt === null)).toBe(true);
    expect(attendees.every((a) => a.status === 'invited')).toBe(true);
  });

  it('lands as a prospect, with the source recorded', async () => {
    const { id } = await cloneShow(marcus, automateId, {
      name: 'Automate 2028',
      startsOn: '2028-06-05',
      include: { tasks: true, deadlines: false, team: false, assets: false },
    });
    created.push(id);

    const show = await db.query.shows.findFirst({ where: eq(s.shows.id, id) });
    expect(show!.status).toBe('prospect');
    expect(show!.boothNumber).toBeNull();

    const [decision] = await listDecisions(marcus, id);
    expect(decision.decision.decision).toBe('cloned');
    expect(decision.decision.clonedFromId).toBe(automateId);
    expect(decision.decision.rationale).toContain('Automate 2026');
  });

  it('refuses a member', async () => {
    await expect(
      cloneShow(priya, automateId, {
        name: 'Automate 2029',
        startsOn: '2029-06-05',
        include: { tasks: true, deadlines: true, team: true, assets: true },
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('getItinerary', () => {
  it("assembles one person's shows, flights, lodging, and shifts", async () => {
    const trips = await getItinerary(priya);
    const automate = trips.find((t) => t.show.id === automateId)!;

    expect(automate).toBeDefined();
    expect(automate.attendee.role).toBe('Technical demos');
    expect(automate.flights).toHaveLength(2);
    expect(automate.flights.every((f) => f.userId === priya.userId)).toBe(true);
    expect(automate.lodging.length).toBeGreaterThan(0);
    expect(automate.shifts.length).toBeGreaterThan(0);
  });

  it('never contains another person’s rows', async () => {
    const trips = await getItinerary(priya);
    const foreign = trips.flatMap((t) => t.flights).filter((f) => f.userId !== priya.userId);
    expect(foreign).toEqual([]);
  });
});
