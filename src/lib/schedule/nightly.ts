import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { SOURCE_LABEL } from '@/lib/alerts/feed';
import { runAllSweeps, type EngineOutcome } from '@/lib/alerts/sweep';
import { sweepLeadRetention, type RetentionSweepResult } from '@/lib/leads/store';
import { deliverPending, type DeliveryRunResult } from '@/lib/notify/store';
import type { NotificationTransport } from '@/lib/integrations/notify/types';

type Db = ReturnType<typeof getDb>;

/**
 * The nightly job. Step 21, and the first thing in this product that is meant to
 * happen without anybody asking.
 *
 * Three stages, in this order, and the order is the argument:
 *
 * 1. **Every engine sweeps.** `runAllSweeps` already exists and already says
 *    which engines could not run. It goes first because everything after it
 *    reads what it wrote.
 * 2. **Retention erases.** This is the stage that changes what this product is:
 *    for three steps `retention_overdue` has alerted nightly with nothing
 *    running nightly, which is a documented commitment being documented-ly
 *    broken — the exact thing §5j says is worse than making no promise. A
 *    scheduler is the enforcement the promise always meant, so the sweep runs,
 *    and what it erased is written into the run's summary because an
 *    irreversible act performed by nobody has to leave a record made by
 *    something. It runs **after** the alert sweep and before delivery, so a
 *    `retention_overdue` alert raised in stage 1 and satisfied here is resolved
 *    by *tomorrow's* stage 1 rather than being carried tonight — which is one
 *    night of a stale alert, and is much better than the alternative, which is
 *    erasing personal data before the engine that reports on it has looked.
 * 3. **Delivery carries what is owed.** Last, because it can only carry what the
 *    first two stages produced, and because it is the only stage that talks to
 *    somebody outside the building.
 *
 * **A stage that throws does not cancel the run's record.** The row is written
 * at the start and closed at the end whatever happens, with `ok` false and the
 * error on it. A half-failed sweep reporting success is how a board goes quiet,
 * and a half-failed sweep reporting *nothing at all* is the same thing with no
 * evidence left behind.
 *
 * It deliberately does not swallow a stage failure to keep going. If the alert
 * sweep fails, tonight's alerts are last night's, and delivering them as though
 * they were fresh would be `flights/status.ts`'s unchecked flight raised to the
 * level of the whole product. The run stops, the row says where, and `/alerts`
 * shows a stale sweep rather than a confident feed.
 */

export type NightlyResult = {
  runId: string;
  orgId: string;
  trigger: 'schedule' | 'manual';
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  engines: EngineOutcome[];
  retention: RetentionSweepResult | null;
  delivery: DeliveryRunResult | null;
  error: string | null;
  /** The same lines the CLI prints and the row stores. */
  summary: string[];
};

export async function runNightly(
  orgId: string,
  opts: {
    trigger?: 'schedule' | 'manual';
    now?: Date;
    transport?: NotificationTransport;
    /**
     * Skip stage 2. Two callers pass it and both have the same reason: the
     * retention sweep really erases, so a test that ran it against the seeded
     * workspace and a seed that ran it against the leads it had just created
     * would each destroy the demo they exist to build. `pnpm leads --retention`
     * is where erasure is exercised deliberately, by somebody who typed it.
     */
    skipRetention?: boolean;
  } = {},
  db: Db = getDb(),
): Promise<NightlyResult> {
  const trigger = opts.trigger ?? 'manual';
  const startedAt = opts.now ?? new Date();

  const [run] = await db
    .insert(s.scheduledRuns)
    .values({ orgId, job: 'nightly', trigger, startedAt, ok: false })
    .returning({ id: s.scheduledRuns.id });

  const summary: string[] = [];
  let engines: EngineOutcome[] = [];
  let retention: RetentionSweepResult | null = null;
  let delivery: DeliveryRunResult | null = null;
  let error: string | null = null;

  try {
    engines = await runAllSweeps(orgId, startedAt, db);
    for (const e of engines) {
      summary.push(
        e.unavailable
          ? `${SOURCE_LABEL[e.source]}: could not run — ${e.unavailable}`
          : `${SOURCE_LABEL[e.source]}: ${e.raised} raised, ${e.resolved} resolved`,
      );
    }

    if (!opts.skipRetention) {
      retention = await sweepLeadRetention(orgId, startedAt, db);
      summary.push(
        retention.erased === 0
          ? `Retention: ${retention.examined} lead(s) examined, none past its date`
          : `Retention: erased ${retention.erased} of ${retention.examined} lead(s) — ` +
              retention.shows.map((sh) => `${sh.showName} ${sh.count}`).join(', '),
      );
    }

    delivery = await deliverPending(orgId, { now: startedAt, transport: opts.transport }, db);
    summary.push(
      `Delivery via ${delivery.transport}: ${delivery.messages} message(s), ` +
        `${delivery.sent} sent, ${delivery.rendered} rendered to nobody, ` +
        `${delivery.failed} failed, ${delivery.suppressed} suppressed, ` +
        `${delivery.undeliverable} with nowhere to go`,
    );
  } catch (err) {
    error = (err as Error).message;
    summary.push(`Stopped: ${error}`);
  }

  const finishedAt = new Date(startedAt.getTime());
  await db
    .update(s.scheduledRuns)
    .set({ finishedAt, ok: error === null, summary: summary.join('\n'), error })
    .where(eq(s.scheduledRuns.id, run.id));

  return {
    runId: run.id,
    orgId,
    trigger,
    startedAt,
    finishedAt,
    ok: error === null,
    engines,
    retention,
    delivery,
    error,
    summary,
  };
}

/* ------------------------------- did it run? ------------------------------- */

/**
 * How long a workspace may go without a run before the silence is the news.
 *
 * Deliberately longer than `STALE_AFTER_HOURS` (36) by half a day. The alert
 * feed marks an individual claim `unchecked` first; this says the *job* has
 * stopped. Getting them the same way round would mean the page reporting a
 * broken scheduler while still calling every row current.
 */
export const RUN_OVERDUE_HOURS = 48;

export type RunStanding = {
  lastRun: { startedAt: Date; ok: boolean; trigger: string; error: string | null } | null;
  /**
   * `never` · `manual_only` · `current` · `overdue` · `failing`.
   *
   * `manual_only` is its own answer rather than folded into `current`, because
   * "somebody ran it yesterday" and "it runs" are different assurances and only
   * one of them will still be true next week.
   */
  standing: 'never' | 'manual_only' | 'current' | 'overdue' | 'failing';
  hoursSince: number | null;
};

export async function getRunStanding(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<RunStanding> {
  const [row] = await db
    .select()
    .from(s.scheduledRuns)
    .where(and(eq(s.scheduledRuns.orgId, orgId), eq(s.scheduledRuns.job, 'nightly')))
    .orderBy(desc(s.scheduledRuns.startedAt))
    .limit(1);

  if (!row) return { lastRun: null, standing: 'never', hoursSince: null };

  const hoursSince = (now.getTime() - row.startedAt.getTime()) / 3_600_000;
  const lastRun = {
    startedAt: row.startedAt,
    ok: row.ok,
    trigger: row.trigger,
    error: row.error,
  };

  if (!row.ok) return { lastRun, standing: 'failing', hoursSince };
  if (hoursSince > RUN_OVERDUE_HOURS) return { lastRun, standing: 'overdue', hoursSince };
  if (row.trigger === 'manual') return { lastRun, standing: 'manual_only', hoursSince };
  return { lastRun, standing: 'current', hoursSince };
}

/** The sentence `/alerts` prints. One place, so two screens cannot disagree. */
export function describeRunStanding(r: RunStanding): string {
  switch (r.standing) {
    case 'never':
      return (
        'No sweep has ever run here. Every alert below is exactly as old as the last time ' +
        'somebody pressed Re-check everything.'
      );
    case 'manual_only':
      return (
        'The last sweep was run by a person, not on a schedule. Nothing here runs by itself ' +
        'until a scheduler is pointed at this workspace.'
      );
    case 'overdue':
      return (
        `The last sweep was ${Math.floor(r.hoursSince ?? 0)} hours ago. Nothing below has been ` +
        're-checked since, so it is what was true then — an empty feed is not evidence of a ' +
        'quiet night.'
      );
    case 'failing':
      return `The last sweep did not finish: ${r.lastRun?.error ?? 'no reason recorded'}.`;
    case 'current':
      return 'Swept on schedule.';
  }
}
