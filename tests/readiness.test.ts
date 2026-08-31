import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { listShows, NotFoundError } from '@/lib/shows/store';
import {
  addTask,
  applyTemplate,
  deleteTask,
  editTask,
  getChecklist,
  getPortfolio,
  previewTemplate,
  setTaskStatus,
} from '@/lib/readiness/store';
import { ChecklistError } from '@/lib/readiness/edit';
import { findTemplate } from '@/lib/readiness/templates';

/**
 * Step 10 against the real database.
 *
 * The pure half — scoring, the template planner, the edit rules, the pace model —
 * is tested with no database in `src/lib/readiness/readiness.test.ts`. What can
 * only be checked here is the part that touches rows: that the unique index makes
 * a double apply a no-op even when the plan says otherwise, that a Member can
 * report progress on their own task but not skip it, and that a task id from
 * another workspace is *not found* rather than *forbidden*.
 */

const db = getDb();
const createdShows: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let dana: Actor;
let marcus: Actor;
let priya: Actor;
let automateId: string;
let medtechId: string;

beforeAll(async () => {
  dana = await actorFor('dana@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');

  const shows = await listShows(dana);
  automateId = shows.find((sh) => sh.name === 'Automate 2026')!.id;
  medtechId = shows.find((sh) => sh.name.startsWith('MedTech'))!.id;
});

afterAll(async () => {
  if (createdShows.length) await db.delete(s.shows).where(inArray(s.shows.id, createdShows));
});

/** A throwaway show to write against, so the seeded ones stay readable. */
async function scratchShow(name: string, startsOn: Date): Promise<string> {
  const [row] = await db
    .insert(s.shows)
    .values({
      orgId: dana.orgId,
      name,
      status: 'committed',
      timezone: 'America/Los_Angeles',
      startsOn,
      endsOn: new Date(startsOn.getTime() + 3 * 86_400_000),
    })
    .returning({ id: s.shows.id });
  createdShows.push(row.id);
  return row.id;
}

describe('getChecklist', () => {
  it('scores the seeded show and reports what is wrong beside the number', async () => {
    const list = await getChecklist(dana, automateId);
    expect(list.readiness.score).toBeGreaterThan(0);
    expect(list.readiness.score).toBeLessThan(100);
    expect(list.readiness.blocked).toBeGreaterThan(0);
    // The seeded skip carries its reason, which is what lets it leave the score.
    const skipped = list.entries.find((e) => e.task.status === 'skipped')!;
    expect(skipped.task.statusNote).toBeTruthy();
    expect(list.readiness.counted).toBeLessThan(list.readiness.total);
  });

  it('gives a member the whole checklist — planning is org-wide, travel is not', async () => {
    const asDana = await getChecklist(dana, automateId);
    const asPriya = await getChecklist(priya, automateId);
    expect(asPriya.entries.length).toBe(asDana.entries.length);
    // What differs is what she may do, not what she may see. SCOPE.md §3.
    expect(asPriya.may).toEqual({ edit: false, skip: false, applyTemplate: false });
    expect(asDana.may.edit).toBe(true);
  });

  it('refuses a show id from outside the workspace', async () => {
    const [other] = await db
      .insert(s.organizations)
      .values({ name: 'Rival Robotics' })
      .returning({ id: s.organizations.id });
    const [show] = await db
      .insert(s.shows)
      .values({
        orgId: other.id,
        name: 'Somebody else’s show',
        timezone: 'UTC',
        startsOn: new Date(),
        endsOn: new Date(),
      })
      .returning({ id: s.shows.id });

    await expect(getChecklist(dana, show.id)).rejects.toBeInstanceOf(NotFoundError);
    await db.delete(s.organizations).where(eq(s.organizations.id, other.id));
  });
});

describe('templates', () => {
  it('applies the standard list to an empty show and assigns nobody', async () => {
    const showId = await scratchShow('Template target', new Date(Date.now() + 200 * 86_400_000));
    const plan = await applyTemplate(dana, showId, 'standard-exhibitor');

    const after = await getChecklist(dana, showId);
    expect(after.entries.length).toBe(plan.create.length);
    expect(after.entries.every((e) => e.task.assigneeId === null)).toBe(true);
    expect(after.readiness.score).toBe(0);
    // Not null: there *is* a plan now, and nothing on it is done.
    expect(after.readiness.score).not.toBeNull();
  });

  it('is a no-op the second time, at the database rather than on trust', async () => {
    const showId = await scratchShow('Twice applied', new Date(Date.now() + 200 * 86_400_000));

    // Two people on the same screen: both computed a plan against an empty
    // checklist, and both press Apply. The second one's plan is stale by the
    // time it lands, so the unique index is what actually saves it — not the
    // planner, which was right when it ran.
    const stalePlan = await previewTemplate(dana, showId, 'tabletop');
    await applyTemplate(dana, showId, 'tabletop');
    expect(stalePlan.create.length).toBe(findTemplate('tabletop')!.items.length);

    // Applying again through the normal path adds nothing, because the plan is
    // recomputed and sees the rows.
    const second = await applyTemplate(dana, showId, 'tabletop');
    expect(second.create).toEqual([]);

    await db
      .insert(s.showTasks)
      .values(
        stalePlan.create.map((t) => ({
          showId,
          templateKey: t.templateKey,
          title: t.title,
          category: t.category,
          weight: t.weight,
          dueOn: t.dueOn,
          sortOrder: t.sortOrder,
        })),
      )
      .onConflictDoNothing({ target: [s.showTasks.showId, s.showTasks.templateKey] });

    const after = await getChecklist(dana, showId);
    expect(after.entries.length).toBe(findTemplate('tabletop')!.items.length);
  });

  it('leaves a started task alone and adds only what is missing', async () => {
    const showId = await scratchShow('Partly done', new Date(Date.now() + 200 * 86_400_000));
    await applyTemplate(dana, showId, 'tabletop');

    const before = await getChecklist(dana, showId);
    const contract = before.entries.find((e) => e.task.templateKey === 'tabletop:contract')!;
    await setTaskStatus(dana, contract.task.id, 'complete', null);

    // Applying the bigger template on top: shared keys are namespaced per
    // template, so the standard list brings its own contract task rather than
    // colliding with the tabletop one.
    const plan = await applyTemplate(dana, showId, 'standard-exhibitor');
    expect(plan.create.length).toBe(findTemplate('standard-exhibitor')!.items.length);

    const after = await getChecklist(dana, showId);
    const stillDone = after.entries.find((e) => e.task.id === contract.task.id)!;
    expect(stillDone.task.status).toBe('complete');
  });

  it('refuses a member, and an unknown template key', async () => {
    await expect(applyTemplate(priya, medtechId, 'tabletop')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(previewTemplate(dana, medtechId, 'nope')).rejects.toBeInstanceOf(ChecklistError);
  });
});

describe('task writes', () => {
  it('adds, edits and deletes a task, reading dates in the show’s zone', async () => {
    const showId = await scratchShow('Hand written', new Date(Date.now() + 100 * 86_400_000));
    const { id } = await addTask(dana, showId, {
      title: 'Order the drayage',
      category: 'shipping',
      weight: 3,
      dueOn: '2026-04-04',
      assigneeId: marcus.userId,
    });

    const list = await getChecklist(dana, showId);
    const task = list.entries.find((e) => e.task.id === id)!.task;
    // 5pm in Los Angeles on 4 April 2026 is 00:00Z on the 5th — the point of
    // resolving against the show's zone rather than the server's.
    expect(task.dueOn!.toISOString()).toBe('2026-04-05T00:00:00.000Z');
    expect(task.weight).toBe(3);

    await editTask(dana, id, {
      title: 'Order the drayage and I&D labor',
      category: 'shipping',
      weight: 2,
      dueOn: null,
      assigneeId: null,
    });
    const edited = (await getChecklist(dana, showId)).entries.find((e) => e.task.id === id)!;
    expect(edited.task.title).toContain('I&D');
    expect(edited.task.dueOn).toBeNull();
    expect(edited.assignee).toBeNull();

    await deleteTask(dana, id);
    expect((await getChecklist(dana, showId)).entries.some((e) => e.task.id === id)).toBe(false);
  });

  it('lets a member report progress on their own task but not skip it', async () => {
    const showId = await scratchShow('Priya’s task', new Date(Date.now() + 100 * 86_400_000));
    const { id } = await addTask(dana, showId, {
      title: 'Rehearse the booth demo',
      category: 'booth',
      weight: 3,
      assigneeId: priya.userId,
    });

    await setTaskStatus(priya, id, 'in_progress', null);
    const mine = (await getChecklist(priya, showId)).entries.find((e) => e.task.id === id)!;
    expect(mine.task.status).toBe('in_progress');
    expect(mine.mayUpdate).toBe(true);

    // Skipping drops the task out of the score, so it is a change to the plan.
    await expect(setTaskStatus(priya, id, 'skipped', 'Not needed this year')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // And an approver still cannot skip it without saying why.
    await expect(setTaskStatus(dana, id, 'skipped', 'nah')).rejects.toBeInstanceOf(ChecklistError);
    await setTaskStatus(dana, id, 'skipped', 'Demo is being shown from the main stage instead.');
    const skipped = (await getChecklist(dana, showId)).entries.find((e) => e.task.id === id)!;
    expect(skipped.task.status).toBe('skipped');
    expect(skipped.task.statusNote).toContain('main stage');
  });

  it('refuses a member a task that is not theirs, and refuses them editing at all', async () => {
    const showId = await scratchShow('Not Priya’s', new Date(Date.now() + 100 * 86_400_000));
    const { id } = await addTask(dana, showId, {
      title: 'Sign the space contract',
      category: 'legal',
      weight: 3,
      assigneeId: marcus.userId,
    });

    await expect(setTaskStatus(priya, id, 'complete', null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addTask(priya, showId, { title: 'Something', category: 'booth', weight: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteTask(priya, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getChecklist(priya, showId)).entries[0].mayUpdate).toBe(false);
  });

  it('stamps and then clears the completion, rather than leaving a stale timestamp', async () => {
    const showId = await scratchShow('Reopened', new Date(Date.now() + 100 * 86_400_000));
    const { id } = await addTask(dana, showId, {
      title: 'Print the datasheets',
      category: 'collateral',
      weight: 1,
    });

    await setTaskStatus(dana, id, 'complete', null);
    let task = (await getChecklist(dana, showId)).entries[0].task;
    expect(task.completedAt).not.toBeNull();
    expect(task.completedById).toBe(dana.userId);

    await setTaskStatus(dana, id, 'blocked', 'Printer quoted three weeks; the show is in two.');
    task = (await getChecklist(dana, showId)).entries[0].task;
    expect(task.completedAt).toBeNull();
    expect(task.completedById).toBeNull();
    expect(task.statusNote).toContain('Printer');
  });
});

describe('getPortfolio', () => {
  it('covers committed shows only — a prospect has nothing to be behind on', async () => {
    const rows = await getPortfolio(dana);
    const names = rows.map((r) => r.name);
    expect(names).toContain('Automate 2026');
    expect(names.some((n) => n.startsWith('PACK EXPO'))).toBe(false);
  });

  it('ranks the show in trouble first, with reasons rather than just a number', async () => {
    // A committed show with no checklist at all, opening inside the planning
    // window: the case the old scorer called 100% ready.
    const showId = await scratchShow('Unplanned and imminent', new Date(Date.now() + 20 * 86_400_000));
    const rows = await getPortfolio(dana);
    const row = rows.find((r) => r.id === showId)!;

    expect(row.readiness.score).toBeNull();
    expect(row.severity).toBe('critical');
    expect(row.concerns.join(' ')).toContain('No checklist');
    expect(rows[0].severity).toBe('critical');
  });

  it('carries deadline exposure onto the row, not just checklist state', async () => {
    const rows = await getPortfolio(dana);
    const automate = rows.find((r) => r.id === automateId)!;
    expect(automate.openDeadlines + automate.unconfirmedDeadlines).toBeGreaterThan(0);
    expect(automate.concerns.length).toBeGreaterThan(0);
  });
});
