import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { canAcknowledge } from './access';
import {
  SOURCE_LABEL,
  orderFeed,
  summarizeFeed,
  type AlertKind,
  type AlertSeverity,
  type AlertSource,
  type FeedAlert,
  type FeedSummary,
} from './feed';

type Db = ReturnType<typeof getDb>;

/**
 * The only file that writes the `alerts` table, and — as of step 17 — the only
 * one that reads it for a person.
 *
 * Before this, five engines each carried their own copy of the same twelve-line
 * fan-out-and-insert. They had drifted in exactly the way `UI-REWORK.md` found
 * the form helpers had: three counted what was inserted, one counted what was
 * attempted, and none of them could express a condition *ending*, because
 * `onConflictDoNothing` has no opinion about a row that already exists. The
 * audience logic stays in each engine, where the reasoning about who cares about
 * a stalled crate lives; only the write is shared.
 *
 * **The bug the consolidation fixed.** `onConflictDoNothing` means a condition
 * that ends and recurs under the same dedupe key reuses the row somebody
 * acknowledged weeks ago — so the second occurrence arrives pre-dismissed and
 * nobody is ever told. That was invisible while nothing read the table. It is
 * the first thing a feed would have made real.
 */

/* ---------------------------------- writing -------------------------------- */

export type AlertWrite = {
  showId: string | null;
  /** Null means the whole org. Every engine today addresses a person. */
  userId: string | null;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Already fanned out — the recipient is part of the key. */
  dedupeKey: string;
};

export type AlertSyncResult = {
  /** New rows, plus conditions that had ended and have come back. */
  raised: number;
  /** Rows this sweep no longer plans, and therefore says are over. */
  resolved: number;
};

async function write(
  db: Db,
  args: {
    orgId: string;
    source: AlertSource;
    kind: AlertKind;
    writes: AlertWrite[];
    now: Date;
  },
): Promise<number> {
  const { orgId, source, kind, writes, now } = args;
  if (writes.length === 0) return 0;

  const keys = writes.map((w) => w.dedupeKey);
  const existing = await db
    .select({
      id: s.alerts.id,
      dedupeKey: s.alerts.dedupeKey,
      resolvedAt: s.alerts.resolvedAt,
    })
    .from(s.alerts)
    .where(and(eq(s.alerts.orgId, orgId), inArray(s.alerts.dedupeKey, keys)));
  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));

  let raised = 0;
  for (const w of writes) {
    const prior = byKey.get(w.dedupeKey);
    if (!prior) {
      await db
        .insert(s.alerts)
        .values({
          orgId,
          showId: w.showId,
          userId: w.userId,
          source,
          kind,
          severity: w.severity,
          title: w.title,
          body: w.body,
          dedupeKey: w.dedupeKey,
          createdAt: now,
          lastSeenAt: now,
        })
        // Two sweeps racing is not an error; the second one is just late.
        .onConflictDoNothing();
      raised += 1;
      continue;
    }

    // A condition that had resolved and is true again is a *new* occurrence:
    // its clock restarts and any acknowledgement of the earlier one is dropped,
    // because "I have seen this" was said about something that had ended.
    const recurrence = prior.resolvedAt !== null;
    await db
      .update(s.alerts)
      .set({
        // The sentence can move under a stable key — the same deadline says a
        // different number of days each night — so the latest wording wins.
        severity: w.severity,
        title: w.title,
        body: w.body,
        showId: w.showId,
        lastSeenAt: now,
        occurrences: recurrence ? 1 : sql`${s.alerts.occurrences} + 1`,
        ...(recurrence
          ? { createdAt: now, resolvedAt: null, acknowledgedAt: null, acknowledgedById: null }
          : {}),
      })
      .where(eq(s.alerts.id, prior.id));
    if (recurrence) raised += 1;
  }
  return raised;
}

/**
 * Record everything one engine says is true right now, and close what it no
 * longer says.
 *
 * **The precondition, and it is the whole basis of resolution:** `writes` must
 * be the *complete* set of conditions this source holds for this org — planned
 * over the whole population, not over the rows that happened to change. All four
 * nightly engines already work that way, each for its own reason, and
 * `shipping/alerts.ts` states the sharpest version: an engine that speaks only
 * on transitions is structurally incapable of reporting a stall, which is the
 * failure with no transition in it. That property is what lets absence mean
 * "over" here. A sweep that planned over a subset would silently resolve
 * everything it did not look at, which is a screen going quietly green.
 */
export async function syncConditionAlerts(
  db: Db,
  args: { orgId: string; source: AlertSource; writes: AlertWrite[]; now: Date },
): Promise<AlertSyncResult> {
  const { orgId, source, writes, now } = args;
  const raised = await write(db, { orgId, source, kind: 'condition', writes, now });

  const keys = writes.map((w) => w.dedupeKey);
  const live = and(
    eq(s.alerts.orgId, orgId),
    eq(s.alerts.source, source),
    eq(s.alerts.kind, 'condition'),
    isNull(s.alerts.resolvedAt),
  );
  const closed = await db
    .update(s.alerts)
    .set({ resolvedAt: now })
    .where(keys.length === 0 ? live : and(live, notInArray(s.alerts.dedupeKey, keys)))
    .returning({ id: s.alerts.id });

  return { raised, resolved: closed.length };
}

/**
 * Something that happened, once. A purchase, a credit the agent could not
 * reach at the moment it mattered. Nothing resolves these: the ticket was
 * bought, and no later state of the world makes that untrue.
 */
export async function recordNotices(
  db: Db,
  args: { orgId: string; source: AlertSource; writes: AlertWrite[]; now: Date },
): Promise<number> {
  return write(db, { ...args, kind: 'notice' });
}

/* ---------------------------------- reading -------------------------------- */

export type AlertFeed = {
  alerts: FeedAlert[];
  summary: FeedSummary;
};

/**
 * The guard over `alerts.source`, which is a text column and so can hold
 * anything an older build wrote.
 *
 * Derived from `SOURCE_LABEL` rather than listed here, and that is a repair
 * rather than a tidy-up. This used to be a hand-written array beside the union
 * in `feed.ts`, and step 19's seventh engine walked straight into the trap:
 * adding `'roi'` to the type compiled everywhere, wrote correct rows, and then
 * read every one of them back as `unknown` — so the feed labelled a whole
 * engine's output "Other" and `linkFor` sent it to the show page instead of the
 * ROI tab. Nothing failed. It was found by reading the CLI's output, which is
 * the same way step 17 found `onConflictDoNothing`.
 *
 * `SOURCE_LABEL` is a `Record<AlertSource, string>`, so the compiler already
 * refuses a missing member. Reading the guard off its keys makes one exhaustive
 * check do both jobs: a new source now cannot be added without a label, and
 * cannot have a label without being recognised at read time.
 */
const SOURCES = Object.keys(SOURCE_LABEL) as AlertSource[];

function asSource(raw: string): AlertSource {
  return (SOURCES as string[]).includes(raw) ? (raw as AlertSource) : 'unknown';
}

/**
 * The alerts addressed to this actor. There is no other read — see `access.ts`
 * for why an org-wide one would be a second audience model competing with the
 * five engines that already decided.
 */
export async function getAlertFeed(
  actor: Actor,
  opts: { asOf?: Date; includeSettledDays?: number } = {},
  db: Db = getDb(),
): Promise<AlertFeed> {
  const asOf = opts.asOf ?? new Date();
  // History is bounded rather than paged: a feed is a working surface, and an
  // alert resolved two months ago is an audit question, not a screen.
  const horizon = new Date(asOf.getTime() - (opts.includeSettledDays ?? 30) * 86_400_000);

  const ack = s.users;
  const rows = await db
    .select({
      alert: s.alerts,
      showName: s.shows.name,
      ackName: ack.fullName,
    })
    .from(s.alerts)
    .leftJoin(s.shows, eq(s.alerts.showId, s.shows.id))
    .leftJoin(ack, eq(s.alerts.acknowledgedById, ack.id))
    .where(
      and(
        eq(s.alerts.orgId, actor.orgId),
        or(eq(s.alerts.userId, actor.userId), isNull(s.alerts.userId)),
        or(isNull(s.alerts.resolvedAt), sql`${s.alerts.resolvedAt} >= ${horizon}`),
      ),
    );

  const alerts: FeedAlert[] = rows.map((r) => ({
    id: r.alert.id,
    source: asSource(r.alert.source),
    kind: r.alert.kind === 'notice' ? 'notice' : 'condition',
    severity: (r.alert.severity as AlertSeverity) ?? 'info',
    title: r.alert.title,
    body: r.alert.body,
    showId: r.alert.showId,
    showName: r.showName ?? null,
    dedupeKey: r.alert.dedupeKey,
    createdAt: r.alert.createdAt,
    lastSeenAt: r.alert.lastSeenAt,
    occurrences: r.alert.occurrences,
    resolvedAt: r.alert.resolvedAt,
    acknowledgedAt: r.alert.acknowledgedAt,
    acknowledgedByName: r.ackName ?? null,
  }));

  return { alerts: orderFeed(alerts, asOf), summary: summarizeFeed(alerts, asOf) };
}

/**
 * "I have seen this." Not "this is fixed" — the condition is still whatever it
 * was, and the next sweep will still find it. It stays on the feed under its own
 * heading, because an acknowledged crate is still in the wrong city.
 */
export async function acknowledgeAlert(
  actor: Actor,
  alertId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const row = await db.query.alerts.findFirst({ where: eq(s.alerts.id, alertId) });
  if (!row || row.orgId !== actor.orgId) throw new ForbiddenError('No such alert.');
  if (!canAcknowledge(actor, row.userId)) {
    throw new ForbiddenError('An alert is acknowledged by the person it was addressed to.');
  }
  await db
    .update(s.alerts)
    .set({ acknowledgedAt: now, acknowledgedById: actor.userId })
    .where(eq(s.alerts.id, alertId));
}

export async function unacknowledgeAlert(
  actor: Actor,
  alertId: string,
  db: Db = getDb(),
): Promise<void> {
  const row = await db.query.alerts.findFirst({ where: eq(s.alerts.id, alertId) });
  if (!row || row.orgId !== actor.orgId) throw new ForbiddenError('No such alert.');
  if (!canAcknowledge(actor, row.userId)) {
    throw new ForbiddenError('An alert is acknowledged by the person it was addressed to.');
  }
  await db
    .update(s.alerts)
    .set({ acknowledgedAt: null, acknowledgedById: null })
    .where(eq(s.alerts.id, alertId));
}
