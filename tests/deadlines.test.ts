import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import {
  addDeadline,
  deleteDeadline,
  editDeadline,
  getRegister,
  setDeadlineConfirmed,
  setDeadlineStatus,
  sweepDeadlineAlerts,
} from '@/lib/deadlines/store';
import { DeadlineError } from '@/lib/deadlines/edit';

/**
 * Step 11 against the real database.
 *
 * The pure half — thresholds, tense, audience, dedupe keys, exposure — is tested
 * with no database in `src/lib/deadlines/deadlines.test.ts`. What can only be
 * checked here is what touches rows: that confirmation cannot be laundered
 * through an edit, that the owner of a deadline can report it done without being
 * able to waive it, and that a second sweep writes nothing while a re-dated
 * deadline writes again.
 */

const db = getDb();
const createdShows: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let dana: Actor;
let priya: Actor;
let showId: string;

const NOW = new Date('2026-03-01T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

beforeAll(async () => {
  dana = await actorFor('dana@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');

  const [row] = await db
    .insert(s.shows)
    .values({
      orgId: dana.orgId,
      name: 'Deadline Engine Test Show',
      status: 'committed',
      timezone: 'America/Los_Angeles',
      startsOn: days(60),
      endsOn: days(63),
    })
    .returning({ id: s.shows.id });
  createdShows.push(row.id);
  showId = row.id;
});

afterAll(async () => {
  // Dropping the scratch show takes its alerts with it — `alerts.show_id` cascades.
  // Sweeping `deadline:%` instead would delete the seeded org's alerts too, which
  // is the sort of test cleanup that quietly breaks `pnpm dev` for the next person.
  if (createdShows.length) await db.delete(s.shows).where(inArray(s.shows.id, createdShows));
});

const draft = (over: Partial<Parameters<typeof addDeadline>[2]> = {}) => ({
  title: 'Advance order deadline',
  kind: 'advance_order' as const,
  dueDate: '2026-04-01',
  dueTime: '16:00',
  penaltyEstimate: '3125.00',
  ...over,
});

async function fresh(over = {}) {
  const { id } = await addDeadline(dana, showId, draft(over), NOW);
  return id;
}

describe('addDeadline', () => {
  it('resolves the due time in the show’s zone, not the server’s', async () => {
    const id = await fresh({ dueDate: '2026-04-01', dueTime: '16:00' });
    const row = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    // 4pm Pacific on 1 Apr is 23:00Z — a register that stored 16:00Z would be
    // seven hours early, and one that stored 5pm local an hour late.
    expect(row!.dueAt.toISOString()).toBe('2026-04-01T23:00:00.000Z');
    await deleteDeadline(dana, id);
  });

  it('never treats typing a deadline as confirming it', async () => {
    const id = await fresh();
    const row = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    // The person typing may be reading this year's manual or copying last year's
    // spreadsheet, and the row cannot tell. Confirmation stays a separate act.
    expect(row!.confirmedAt).toBeNull();
    await deleteDeadline(dana, id);
  });

  it('refuses a deadline with no time of day', async () => {
    await expect(addDeadline(dana, showId, draft({ dueTime: '' }), NOW)).rejects.toThrow(
      DeadlineError,
    );
  });

  it('refuses a Member outright', async () => {
    await expect(addDeadline(priya, showId, draft(), NOW)).rejects.toThrow(ForbiddenError);
  });
});

describe('editDeadline', () => {
  it('un-confirms a deadline whose date it moves', async () => {
    const id = await fresh();
    await setDeadlineConfirmed(dana, id, true, NOW);
    await editDeadline(dana, id, draft({ dueDate: '2026-05-01' }), NOW);

    const row = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    // Confirmation is an assertion about one specific date read off the manual.
    // Carrying it onto a different date would let an edit launder a guess into a
    // figure the engine quotes in dollars.
    expect(row!.confirmedAt).toBeNull();
    await deleteDeadline(dana, id);
  });

  it('keeps a confirmation when only the penalty changes', async () => {
    const id = await fresh();
    await setDeadlineConfirmed(dana, id, true, NOW);
    await editDeadline(dana, id, draft({ penaltyEstimate: '4000.00' }), NOW);

    const row = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    expect(row!.confirmedAt).not.toBeNull();
    expect(row!.penaltyEstimateCents).toBe(400_000);
    await deleteDeadline(dana, id);
  });

  it('is not found, not forbidden, for an id outside the workspace', async () => {
    await expect(editDeadline(dana, crypto.randomUUID(), draft(), NOW)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('status and confirmation', () => {
  it('lets the owner report their own deadline done without letting them waive it', async () => {
    const id = await fresh({ ownerId: priya.userId });

    await setDeadlineStatus(priya, id, 'complete', null, NOW);
    const done = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    expect(done!.status).toBe('complete');
    expect(done!.completedById).toBe(priya.userId);

    // Not-applicable takes the penalty out of the show's exposure, so it needs
    // the authority to change the plan — the same rule `skipped` needed.
    await expect(
      setDeadlineStatus(priya, id, 'not_applicable', 'Booth has no rigging this year', NOW),
    ).rejects.toThrow(ForbiddenError);
    await deleteDeadline(dana, id);
  });

  it('refuses a Member confirming a date against the manual', async () => {
    const id = await fresh({ ownerId: priya.userId });
    await expect(setDeadlineConfirmed(priya, id, true, NOW)).rejects.toThrow(ForbiddenError);
    await deleteDeadline(dana, id);
  });

  it('demands a written reason before it will waive one', async () => {
    const id = await fresh();
    await expect(setDeadlineStatus(dana, id, 'not_applicable', 'n/a', NOW)).rejects.toThrow(
      DeadlineError,
    );
    await setDeadlineStatus(dana, id, 'not_applicable', 'Venue supplies carpet this year', NOW);
    const row = await db.query.showDeadlines.findFirst({ where: eq(s.showDeadlines.id, id) });
    expect(row!.statusNote).toContain('carpet');
    await deleteDeadline(dana, id);
  });
});

describe('getRegister', () => {
  it('counts confirmed and unconfirmed exposure apart and shows what is owed next', async () => {
    const confirmed = await fresh({ dueDate: '2026-03-10', penaltyEstimate: '3125.00' });
    await setDeadlineConfirmed(dana, confirmed, true, NOW);
    const guessed = await fresh({
      title: 'Rigging order',
      kind: 'av_rigging',
      dueDate: '2026-03-20',
      penaltyEstimate: '1000.00',
    });

    const register = await getRegister(dana, showId, NOW);
    expect(register.exposure.atRiskCents).toBe(312_500);
    expect(register.exposure.atRiskUnconfirmedCents).toBe(100_000);

    const row = register.entries.find((e) => e.deadline.id === confirmed)!;
    expect(row.pending!.title).toContain('14-day warning');
    const unchecked = register.entries.find((e) => e.deadline.id === guessed)!;
    expect(unchecked.pending!.title).toContain('Confirm the date');

    await deleteDeadline(dana, confirmed);
    await deleteDeadline(dana, guessed);
  });
});

describe('sweepDeadlineAlerts', () => {
  it('writes once, then nothing — and again once the date moves', async () => {
    const id = await fresh({ dueDate: '2026-03-10', ownerId: priya.userId });
    await setDeadlineConfirmed(dana, id, true, NOW);

    const first = await sweepDeadlineAlerts(dana.orgId, NOW);
    const mine = first.planned.filter((a) => a.deadlineId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0].audience).toBe('owner');
    expect(first.written).toBeGreaterThan(0);

    // The dedupe is the whole feature: a nightly sweep that re-sends teaches
    // everyone to ignore the one that matters.
    const again = await sweepDeadlineAlerts(dana.orgId, NOW);
    expect(again.written).toBe(0);

    await editDeadline(dana, id, draft({ dueDate: '2026-03-12', ownerId: priya.userId }), NOW);
    await setDeadlineConfirmed(dana, id, true, NOW);
    const moved = await sweepDeadlineAlerts(dana.orgId, NOW);
    expect(moved.written).toBeGreaterThan(0);

    const written = await db
      .select()
      .from(s.alerts)
      .where(and(eq(s.alerts.orgId, dana.orgId), like(s.alerts.dedupeKey, `deadline:${id}:%`)));
    // The owner and the show runners both hold a copy of each.
    expect(written.some((a) => a.userId === priya.userId)).toBe(true);
    expect(written.some((a) => a.userId === dana.userId)).toBe(true);

    await deleteDeadline(dana, id);
  });

  it('sends an unowned deadline to whoever runs the show, and says it is unowned', async () => {
    const id = await fresh({ dueDate: '2026-03-05', ownerId: null });
    await setDeadlineConfirmed(dana, id, true, NOW);

    const { planned } = await sweepDeadlineAlerts(dana.orgId, NOW);
    const alert = planned.find((a) => a.deadlineId === id)!;
    expect(alert.audience).toBe('show_runners');
    expect(alert.body).toContain('Nobody owns this deadline');

    const rows = await db
      .select()
      .from(s.alerts)
      .where(like(s.alerts.dedupeKey, `deadline:${id}:%`));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId !== priya.userId)).toBe(true);

    await deleteDeadline(dana, id);
  });

  it('goes quiet on a deadline that has been completed', async () => {
    const id = await fresh({ dueDate: '2026-03-05' });
    await setDeadlineConfirmed(dana, id, true, NOW);
    await setDeadlineStatus(dana, id, 'complete', null, NOW);

    const { planned } = await sweepDeadlineAlerts(dana.orgId, NOW);
    expect(planned.find((a) => a.deadlineId === id)).toBeUndefined();
    await deleteDeadline(dana, id);
  });
});
