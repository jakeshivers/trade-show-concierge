import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { optionalDecimalToCents } from '@/lib/money/decimal';
import { NotFoundError } from '@/lib/shows/store';
import {
  canCompleteDeadline,
  canConfirmDeadline,
  canEditDeadlines,
  canWaiveDeadline,
} from './access';
import {
  DeadlineError,
  planDeadlineStatus,
  validateDeadline,
  type DeadlineDraft,
} from './edit';
import {
  planDeadlineAlerts,
  summarizeExposure,
  type AlertableDeadline,
  type Exposure,
  type PlannedAlert,
} from './alerts';
import { syncConditionAlerts, type AlertWrite } from '@/lib/alerts/store';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of the deadline engine. Same posture as `readiness/store.ts`:
 * org-scoped at the source, and every decision it makes was made by a pure
 * function above it.
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

/** Load a deadline, having proven the show it hangs off belongs to the org. */
async function requireDeadline(actor: Actor, deadlineId: string, db: Db) {
  const [row] = await db
    .select({ deadline: s.showDeadlines, show: s.shows })
    .from(s.showDeadlines)
    .innerJoin(s.shows, eq(s.showDeadlines.showId, s.shows.id))
    .where(and(eq(s.showDeadlines.id, deadlineId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('deadline');
  return row;
}

type DeadlineRow = typeof s.showDeadlines.$inferSelect;

function alertable(d: DeadlineRow): AlertableDeadline {
  return {
    id: d.id,
    showId: d.showId,
    title: d.title,
    kind: d.kind,
    dueAt: d.dueAt,
    status: d.status,
    penaltyEstimateCents: d.penaltyEstimateCents,
    penaltyNote: d.penaltyNote,
    ownerId: d.ownerId,
    confirmedAt: d.confirmedAt,
  };
}

/* ---------------------------------- read ----------------------------------- */

export type RegisterEntry = {
  deadline: DeadlineRow;
  owner: { id: string; fullName: string } | null;
  /** Negative once the date has passed. */
  daysUntil: number;
  /** What this actor may do to this row — computed once, server-side. */
  mayComplete: boolean;
  /** What the engine will say about it next, if anything. */
  pending: PlannedAlert | null;
};

export type Register = {
  show: typeof s.shows.$inferSelect;
  entries: RegisterEntry[];
  exposure: Exposure;
  people: { id: string; fullName: string }[];
  may: { edit: boolean; confirm: boolean; waive: boolean };
};

export async function getRegister(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<Register> {
  const show = await requireShow(actor, showId, db);

  const [rows, people] = await Promise.all([
    db
      .select({ deadline: s.showDeadlines, owner: s.users })
      .from(s.showDeadlines)
      .leftJoin(s.users, eq(s.showDeadlines.ownerId, s.users.id))
      .where(eq(s.showDeadlines.showId, showId))
      .orderBy(asc(s.showDeadlines.dueAt)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
  ]);

  const items = rows.map((r) => alertable(r.deadline));
  const planned = new Map(
    planDeadlineAlerts(items, asOf).map((a) => [a.deadlineId, a] as const),
  );

  return {
    show,
    entries: rows.map(({ deadline, owner }) => ({
      deadline,
      owner: owner ? { id: owner.id, fullName: owner.fullName } : null,
      daysUntil: Math.floor((deadline.dueAt.getTime() - asOf.getTime()) / 86_400_000),
      mayComplete: canCompleteDeadline(actor, deadline),
      pending: planned.get(deadline.id) ?? null,
    })),
    exposure: summarizeExposure(items, asOf),
    people,
    may: {
      edit: canEditDeadlines(actor),
      confirm: canConfirmDeadline(actor),
      waive: canWaiveDeadline(actor),
    },
  };
}

/* --------------------------------- writes ---------------------------------- */

/** `YYYY-MM-DD` + `HH:MM` in the show's zone → the instant it actually falls. */
function dueInstant(dueDate: string, dueTime: string, timezone: string): Date {
  return zonedToInstant(`${dueDate}T${dueTime}:00`, timezone);
}

export async function addDeadline(
  actor: Actor,
  showId: string,
  draft: DeadlineDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canEditDeadlines(actor)) throw new ForbiddenError('add a service manual deadline');
  const show = await requireShow(actor, showId, db);
  const valid = validateDeadline(draft);

  const [row] = await db
    .insert(s.showDeadlines)
    .values({
      showId,
      kind: valid.kind,
      title: valid.title,
      dueAt: dueInstant(valid.dueDate, valid.dueTime, show.timezone),
      penaltyEstimateCents: valid.penaltyEstimateCents,
      penaltyNote: valid.penaltyNote,
      ownerId: valid.ownerId,
      sourceUrl: valid.sourceUrl,
      // A hand-entered deadline is not confirmed by the act of typing it. The
      // person typing may be reading the manual or may be copying last year's
      // spreadsheet, and the register cannot tell — so confirmation stays an
      // explicit, separate act. `alerts.ts`, correction 1.
      confirmedAt: null,
      updatedAt: now,
    })
    .returning({ id: s.showDeadlines.id });

  return row;
}

export async function editDeadline(
  actor: Actor,
  deadlineId: string,
  draft: DeadlineDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canEditDeadlines(actor)) throw new ForbiddenError('edit a service manual deadline');
  const { deadline, show } = await requireDeadline(actor, deadlineId, db);
  if (deadline.lodgingId) throw new DeadlineError(DERIVED_IS_READ_ONLY);
  const valid = validateDeadline(draft);
  const dueAt = dueInstant(valid.dueDate, valid.dueTime, show.timezone);

  // Moving the date un-confirms the row. Confirmation is an assertion about one
  // specific date read off the manual; carrying it onto a different date would
  // let an edit launder a guess into a confirmed figure without anyone looking at
  // the document. Alerts already sent are voided by the date in their dedupe key.
  const moved = dueAt.getTime() !== deadline.dueAt.getTime();

  await db
    .update(s.showDeadlines)
    .set({
      kind: valid.kind,
      title: valid.title,
      dueAt,
      penaltyEstimateCents: valid.penaltyEstimateCents,
      penaltyNote: valid.penaltyNote,
      ownerId: valid.ownerId,
      sourceUrl: valid.sourceUrl,
      // Typing a time is a person deciding what the hour is, whether or not they
      // changed it. That is precisely what the flag was waiting for.
      dueTimeAssumed: false,
      ...(moved ? { confirmedAt: null, confirmedById: null } : {}),
      updatedAt: now,
    })
    .where(eq(s.showDeadlines.id, deadline.id));
}

/**
 * Mark a deadline done, re-open it, or take it out of scope.
 *
 * Two gates, not one — the same shape as `setTaskStatus`, so a refusal names the
 * rule it broke rather than saying "not permitted".
 */
export async function setDeadlineStatus(
  actor: Actor,
  deadlineId: string,
  next: string,
  note: string | null,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  const { deadline } = await requireDeadline(actor, deadlineId, db);

  if (!canCompleteDeadline(actor, deadline)) {
    throw new ForbiddenError('update a deadline they do not own');
  }
  if (next === 'not_applicable' && !canWaiveDeadline(actor)) {
    throw new ForbiddenError(
      'mark a deadline not applicable — that takes its penalty out of the show’s exposure ' +
        'and stops it alerting, so it belongs to whoever runs the show',
    );
  }

  const change = planDeadlineStatus(next, note, actor.userId, now);

  await db
    .update(s.showDeadlines)
    .set({
      status: change.status,
      statusNote: change.note,
      completedAt: change.completedAt,
      completedById: change.completedById,
      updatedAt: now,
    })
    .where(eq(s.showDeadlines.id, deadline.id));
}

/**
 * Confirm — or un-confirm — a date against this year's manual.
 *
 * Reversible on purpose: "I checked and this is wrong" has to be as easy to say
 * as "I checked and it is right", or the only way to withdraw a confirmation is
 * to edit the date to something else, which is worse.
 */
export async function setDeadlineConfirmed(
  actor: Actor,
  deadlineId: string,
  confirmed: boolean,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canConfirmDeadline(actor)) {
    throw new ForbiddenError(
      'confirm a deadline — confirmation is what promotes a predicted date into a figure the ' +
        'alert engine quotes in dollars',
    );
  }
  const { deadline } = await requireDeadline(actor, deadlineId, db);

  // An extracted row whose manual printed no time of day was filed at 23:59 and
  // flagged. Confirming it would assert that end-of-day was read off the
  // document, when what was actually read was a date — and the hour is the half
  // §5a made mandatory, because a warehouse that shuts at 4:00pm and a register
  // that says 5pm differ by a drayage penalty. So the hour has to be looked at
  // before the row can be promoted into a figure the engine quotes. Editing the
  // deadline is what clears the flag, and the edit form says which time came from
  // the manual and which did not.
  if (confirmed && deadline.dueTimeAssumed) {
    throw new DeadlineError(
      'This deadline was read from the manual as a date with no time of day, so it was filed ' +
        'at 23:59. Set the time — from the manual if it prints one, or end of day deliberately ' +
        'if it does not — and then confirm it. Confirming is what lets the engine quote this ' +
        'row’s penalty, and an hour on this register is a drayage charge.',
    );
  }

  await db
    .update(s.showDeadlines)
    .set({
      confirmedAt: confirmed ? now : null,
      confirmedById: confirmed ? actor.userId : null,
      updatedAt: now,
    })
    .where(eq(s.showDeadlines.id, deadline.id));
}

export async function deleteDeadline(
  actor: Actor,
  deadlineId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canEditDeadlines(actor)) throw new ForbiddenError('delete a service manual deadline');
  const { deadline } = await requireDeadline(actor, deadlineId, db);
  if (deadline.lodgingId) throw new DeadlineError(DERIVED_IS_READ_ONLY);
  await db.delete(s.showDeadlines).where(eq(s.showDeadlines.id, deadline.id));
}

/**
 * A derived row's *date* belongs to the record it came from; everything else
 * belongs to the register.
 *
 * Step 12 introduced the first of these — a lodging row's room block cutoff owns
 * a deadline (`lodging/store.ts`). The date has exactly one editable home, or the
 * two copies drift and whichever screen you are not looking at holds the version
 * you needed. But ownership and a penalty estimate are register facts: an unowned
 * deadline escalates (`alerts.ts`, correction 3), and somebody who has priced
 * what a blown room block actually costs should be able to say so here.
 */
export async function editDerivedDeadline(
  actor: Actor,
  deadlineId: string,
  fields: { ownerId?: string | null; penaltyEstimate?: string | null; penaltyNote?: string | null },
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canEditDeadlines(actor)) throw new ForbiddenError('edit a service manual deadline');
  const { deadline } = await requireDeadline(actor, deadlineId, db);
  if (!deadline.lodgingId) {
    throw new DeadlineError('That deadline is an ordinary register row — edit it in full.');
  }

  await db
    .update(s.showDeadlines)
    .set({
      ownerId: fields.ownerId?.trim() || null,
      penaltyEstimateCents: optionalDecimalToCents(fields.penaltyEstimate ?? null),
      penaltyNote: fields.penaltyNote?.trim() || deadline.penaltyNote,
      updatedAt: now,
    })
    .where(eq(s.showDeadlines.id, deadline.id));
}

const DERIVED_IS_READ_ONLY =
  'This deadline is derived from a room block cutoff on the show’s lodging, so its date and ' +
  'title live there — edit the hotel record and this row follows. Two editable copies of one ' +
  'date is how the date gets missed. Its owner and penalty estimate are still yours to set.';

/* ---------------------------------- sweep ---------------------------------- */

export type SweepResult = {
  planned: PlannedAlert[];
  /** Alerts actually written — a repeat run writes none, which is the feature. */
  written: number;
  /** Rows tonight's plan no longer contains: done, waived, confirmed, or moved. */
  resolved: number;
};

/**
 * Fire what is owed, for one org.
 *
 * Written to `alerts` rather than to email, for the reason `travel/notify.ts`
 * gives: the row is the durable record that the notification was owed, and a
 * transport added later cannot erase it. Step 17 builds the feed; step 21 adds
 * Slack behind this same call.
 *
 * It counts what was written, not what was attempted — the dedupe *is* the
 * feature here, so a second run reporting "14 alerts sent" would be reporting the
 * opposite of what happened. Step 17 added the other half of that sentence: a
 * third run, after somebody completed the task, reports one *resolved*, because
 * a plan that no longer contains a key is this engine saying the thing is over.
 */
export async function sweepDeadlineAlerts(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<SweepResult> {
  const rows = await db
    .select({ deadline: s.showDeadlines })
    .from(s.showDeadlines)
    .innerJoin(s.shows, eq(s.showDeadlines.showId, s.shows.id))
    .where(and(eq(s.shows.orgId, orgId), inArray(s.shows.status, LIVE_STATUSES)));

  const planned = planDeadlineAlerts(rows.map((r) => alertable(r.deadline)), now);

  const runners = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  const writes: AlertWrite[] = [];
  for (const alert of planned) {
    // An owner-addressed alert still copies the show runners: the owner is who
    // acts, but a missed advance order is the show lead's money either way. An
    // unowned one has no first recipient at all — correction 3 — so it is
    // addressed to the runners and says so in its body.
    const recipients = new Set<string>(runners.map((r) => r.id));
    if (alert.audience === 'owner' && alert.ownerId) recipients.add(alert.ownerId);

    for (const userId of recipients) {
      writes.push({
        showId: alert.showId,
        userId,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        dedupeKey: `${alert.dedupeKey}:${userId}`,
      });
    }
  }

  // There is no early return on an empty plan any more, and the reason is the
  // key shape §5a argued for: a deadline alert is keyed to the deadline *and its
  // date*, so completing a task, confirming it, waiving it or moving the date
  // all take the row out of tonight's plan. Absence is how every one of those
  // reaches the feed, and an early return would have made "nothing is wrong" the
  // one outcome that changes nothing on screen.
  const { raised, resolved } = await syncConditionAlerts(db, {
    orgId,
    source: 'deadline',
    writes,
    now,
  });
  return { planned, written: raised, resolved };
}

/** A prospect has no deadlines to miss; a closed show's have already resolved. */
const LIVE_STATUSES: (typeof s.showStatusEnum.enumValues)[number][] = [
  'committed',
  'planning',
  'ready',
  'live',
];

export { DeadlineError };
