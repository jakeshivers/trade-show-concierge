import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { NotFoundError } from '@/lib/shows/store';
import { canApplyTemplate, canEditChecklist, canSkipTask, canUpdateStatus } from './access';
import { ChecklistError, planStatusChange, validateDraft, type TaskDraft } from './edit';
import { scoreChecklist, type Readiness } from './score';
import { findTemplate, planTemplate, type TemplatePlan } from './templates';
import { rollUpPortfolio, type PortfolioRow } from './portfolio';

export type { PortfolioRow };

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of readiness. Same posture as `shows/store.ts`: every query is
 * org-scoped at the source, and every decision it makes was made by a pure
 * function above it.
 *
 * A checklist carries no per-person narrowing — SCOPE.md §3, as corrected at step
 * 8, scopes *travel* rather than planning, and a task list with half the tasks
 * missing is not a plan. What is scoped here is writing, in `access.ts`.
 */

/** The local hour a hand-entered due date falls, in the show's zone. */
const DUE_HOUR = '17:00:00';

/** Load a show the actor's org owns, or 404. Never load-then-check. */
async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

/** Load a task by id, having proven the show it hangs off belongs to the org. */
async function requireTask(actor: Actor, taskId: string, db: Db) {
  const [row] = await db
    .select({ task: s.showTasks, show: s.shows })
    .from(s.showTasks)
    .innerJoin(s.shows, eq(s.showTasks.showId, s.shows.id))
    .where(and(eq(s.showTasks.id, taskId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('task');
  return row;
}

/* ---------------------------------- read ----------------------------------- */

export type ChecklistEntry = {
  task: typeof s.showTasks.$inferSelect;
  assignee: { id: string; fullName: string } | null;
  overdue: boolean;
  /** What this actor may do to this row — computed once, server-side. */
  mayUpdate: boolean;
};

export type Checklist = {
  show: typeof s.shows.$inferSelect;
  entries: ChecklistEntry[];
  readiness: Readiness;
  /** Everyone in the org, for the assignee picker. */
  people: { id: string; fullName: string }[];
  may: { edit: boolean; skip: boolean; applyTemplate: boolean };
};

export async function getChecklist(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<Checklist> {
  const show = await requireShow(actor, showId, db);

  const [rows, people] = await Promise.all([
    db
      .select({ task: s.showTasks, assignee: s.users })
      .from(s.showTasks)
      .leftJoin(s.users, eq(s.showTasks.assigneeId, s.users.id))
      .where(eq(s.showTasks.showId, showId))
      .orderBy(asc(s.showTasks.sortOrder)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
  ]);

  const readiness = scoreChecklist(rows.map((r) => r.task), asOf);

  return {
    show,
    entries: rows.map(({ task, assignee }) => ({
      task,
      assignee: assignee ? { id: assignee.id, fullName: assignee.fullName } : null,
      overdue:
        task.status !== 'complete' &&
        task.status !== 'skipped' &&
        task.dueOn != null &&
        task.dueOn.getTime() < asOf.getTime(),
      mayUpdate: canUpdateStatus(actor, task),
    })),
    readiness,
    people,
    may: {
      edit: canEditChecklist(actor),
      skip: canSkipTask(actor),
      applyTemplate: canApplyTemplate(actor),
    },
  };
}

/* --------------------------------- writes ---------------------------------- */

export async function addTask(
  actor: Actor,
  showId: string,
  draft: TaskDraft,
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canEditChecklist(actor)) throw new ForbiddenError('add a checklist task');
  const show = await requireShow(actor, showId, db);
  const valid = validateDraft(draft);

  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${s.showTasks.sortOrder}), -1) + 1` })
    .from(s.showTasks)
    .where(eq(s.showTasks.showId, showId));

  const [row] = await db
    .insert(s.showTasks)
    .values({
      showId,
      title: valid.title,
      description: valid.description,
      category: valid.category,
      weight: valid.weight,
      assigneeId: valid.assigneeId,
      // Read in the *show's* zone, not the browser's: a task due "the 4th" for a
      // show in Tokyo is due end of the 4th in Tokyo.
      dueOn: valid.dueOn ? zonedToInstant(`${valid.dueOn}T${DUE_HOUR}`, show.timezone) : null,
      sortOrder: Number(next),
    })
    .returning({ id: s.showTasks.id });

  return row;
}

export async function editTask(
  actor: Actor,
  taskId: string,
  draft: TaskDraft,
  db: Db = getDb(),
): Promise<void> {
  if (!canEditChecklist(actor)) throw new ForbiddenError('edit a checklist task');
  const { task, show } = await requireTask(actor, taskId, db);
  const valid = validateDraft(draft);

  await db
    .update(s.showTasks)
    .set({
      title: valid.title,
      description: valid.description,
      category: valid.category,
      weight: valid.weight,
      assigneeId: valid.assigneeId,
      dueOn: valid.dueOn ? zonedToInstant(`${valid.dueOn}T${DUE_HOUR}`, show.timezone) : null,
      updatedAt: new Date(),
    })
    .where(eq(s.showTasks.id, task.id));
}

/**
 * Move a task's status.
 *
 * Two gates, not one: whether this actor may touch this task at all, and — for
 * `skipped` — whether they may make that particular move. Splitting them means
 * the refusal says which rule it is, and a task's assignee gets "skipping is not
 * yours to do" rather than "not permitted", which is the difference between
 * understanding the product and filing a bug.
 */
export async function setTaskStatus(
  actor: Actor,
  taskId: string,
  next: string,
  note: string | null,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { task } = await requireTask(actor, taskId, db);

  if (!canUpdateStatus(actor, task)) {
    throw new ForbiddenError('update a task that is not assigned to them');
  }
  if (next === 'skipped' && !canSkipTask(actor)) {
    throw new ForbiddenError(
      'skip a task — a skip drops it out of the readiness score, so it belongs to whoever ' +
        'runs the show, not to the task’s owner',
    );
  }

  const change = planStatusChange(next, note, actor.userId, now);

  await db
    .update(s.showTasks)
    .set({
      status: change.status,
      statusNote: change.note,
      completedAt: change.completedAt,
      completedById: change.completedById,
      updatedAt: now,
    })
    .where(eq(s.showTasks.id, task.id));
}

export async function deleteTask(actor: Actor, taskId: string, db: Db = getDb()): Promise<void> {
  if (!canEditChecklist(actor)) throw new ForbiddenError('delete a checklist task');
  const { task } = await requireTask(actor, taskId, db);
  await db.delete(s.showTasks).where(eq(s.showTasks.id, task.id));
}

/* -------------------------------- templates -------------------------------- */

/** What applying a template would do — no writes. The screen shows this first. */
export async function previewTemplate(
  actor: Actor,
  showId: string,
  templateKey: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<TemplatePlan> {
  const show = await requireShow(actor, showId, db);
  const template = findTemplate(templateKey);
  if (!template) throw new ChecklistError(`No template named "${templateKey}".`);

  const tasks = await db
    .select({ templateKey: s.showTasks.templateKey, sortOrder: s.showTasks.sortOrder })
    .from(s.showTasks)
    .where(eq(s.showTasks.showId, showId));

  return planTemplate(template, { startsOn: show.startsOn, timezone: show.timezone, tasks }, asOf);
}

/**
 * Apply a template.
 *
 * `onConflictDoNothing` on `(show_id, template_key)` rather than trusting the
 * plan: the plan was computed from a read, and two people on the same screen both
 * see an empty checklist and both press Apply. The unique index is what makes
 * "applying twice adds nothing" true; the plan only makes it *visible*.
 */
export async function applyTemplate(
  actor: Actor,
  showId: string,
  templateKey: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<TemplatePlan> {
  if (!canApplyTemplate(actor)) throw new ForbiddenError('apply a checklist template');
  const plan = await previewTemplate(actor, showId, templateKey, asOf, db);
  if (plan.create.length === 0) return plan;

  await db
    .insert(s.showTasks)
    .values(
      plan.create.map((t) => ({
        showId,
        templateKey: t.templateKey,
        title: t.title,
        description: t.description,
        category: t.category,
        weight: t.weight,
        dueOn: t.dueOn,
        sortOrder: t.sortOrder,
      })),
    )
    .onConflictDoNothing({ target: [s.showTasks.showId, s.showTasks.templateKey] });

  return plan;
}

/* -------------------------------- portfolio -------------------------------- */

/** Shows that are actually being run — a prospect has nothing to be behind on. */
const LIVE_STATUSES: (typeof s.showStatusEnum.enumValues)[number][] = [
  'committed',
  'planning',
  'ready',
  'live',
];

export async function getPortfolio(
  actor: Actor,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<PortfolioRow[]> {
  const shows = await db
    .select()
    .from(s.shows)
    .where(
      and(
        eq(s.shows.orgId, actor.orgId),
        inArray(s.shows.status, LIVE_STATUSES),
      ),
    )
    .orderBy(asc(s.shows.startsOn));
  if (shows.length === 0) return [];

  const ids = shows.map((sh) => sh.id);
  const [tasks, deadlines] = await Promise.all([
    db
      .select({
        showId: s.showTasks.showId,
        status: s.showTasks.status,
        weight: s.showTasks.weight,
        dueOn: s.showTasks.dueOn,
      })
      .from(s.showTasks)
      .where(inArray(s.showTasks.showId, ids)),
    db
      .select({
        showId: s.showDeadlines.showId,
        dueAt: s.showDeadlines.dueAt,
        completedAt: s.showDeadlines.completedAt,
        confirmedAt: s.showDeadlines.confirmedAt,
        penaltyEstimateCents: s.showDeadlines.penaltyEstimateCents,
      })
      .from(s.showDeadlines)
      .where(inArray(s.showDeadlines.showId, ids)),
  ]);

  return rollUpPortfolio(
    shows.map((show) => {
      const open = deadlines.filter((d) => d.showId === show.id && !d.completedAt);
      const past = open.filter((d) => d.dueAt.getTime() < asOf.getTime());
      return {
        id: show.id,
        name: show.name,
        status: show.status,
        startsOn: show.startsOn,
        timezone: show.timezone,
        readiness: scoreChecklist(
          tasks.filter((t) => t.showId === show.id),
          asOf,
        ),
        overdueDeadlineCents: past.reduce((sum, d) => sum + (d.penaltyEstimateCents ?? 0), 0),
        openDeadlines: open.length - past.length,
        unconfirmedDeadlines: open.filter((d) => !d.confirmedAt).length,
      };
    }),
    asOf,
  );
}
