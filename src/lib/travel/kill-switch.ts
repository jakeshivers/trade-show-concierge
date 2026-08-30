import { desc, eq } from 'drizzle-orm';
import type { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, isAdmin, type Actor } from '@/lib/auth/actor';

/**
 * The kill switch — an admin toggle that halts automated purchasing instantly.
 * SCOPE.md §6c rail 5.
 *
 * Three decisions worth stating, because each one was a fork:
 *
 * 1. **It lives in the database, not the environment.** `FLIGHT_BOOKING_LIVE`
 *    already gates live purchasing, but flipping an env var means a deploy, and
 *    a rail you cannot pull for ten minutes is not a rail. This one takes effect
 *    on the next database read.
 *
 * 2. **It halts dry runs too.** A dry-run booking spends nothing, so halting it
 *    looks like theatre — but the whole point of a kill switch is that it is
 *    exercised in the path you actually run every day. If halting only changed
 *    behaviour when `live` was true, its first real test would be during the
 *    incident it exists for.
 *
 * 3. **It stops the agent from buying; it does not stop it from working.**
 *    Search, policy evaluation, and escalation all continue while halted, so
 *    when purchasing resumes there is a queue of judged requests rather than a
 *    hole in the record. Nothing is lost, and nothing is bought.
 */

type Db = ReturnType<typeof getDb>;

export type PurchasingStatus = {
  halted: boolean;
  /** When the current state began. Null for an org that has never toggled it. */
  since: Date | null;
  reason: string | null;
  actorId: string | null;
};

export class PurchasingHaltedError extends Error {
  constructor(
    readonly orgId: string,
    readonly status: PurchasingStatus,
  ) {
    super(
      `Automated purchasing is halted for this organization` +
        (status.since ? ` (since ${status.since.toISOString()})` : '') +
        `: ${status.reason ?? 'no reason recorded'}. ` +
        'An admin must resume purchasing before the agent can book anything.',
    );
    this.name = 'PurchasingHaltedError';
  }
}

const ACTIVE: PurchasingStatus = { halted: false, since: null, reason: null, actorId: null };

/** The newest row wins; no rows at all means purchasing is allowed. */
export async function purchasingStatus(orgId: string, db: Db): Promise<PurchasingStatus> {
  const [latest] = await db
    .select()
    .from(s.bookingControls)
    .where(eq(s.bookingControls.orgId, orgId))
    .orderBy(desc(s.bookingControls.createdAt), desc(s.bookingControls.id))
    .limit(1);

  if (!latest) return ACTIVE;
  return {
    halted: latest.purchasingHalted,
    since: latest.createdAt,
    reason: latest.reason,
    actorId: latest.actorId,
  };
}

export async function assertPurchasingAllowed(orgId: string, db: Db): Promise<void> {
  const status = await purchasingStatus(orgId, db);
  if (status.halted) throw new PurchasingHaltedError(orgId, status);
}

async function toggle(
  orgId: string,
  halted: boolean,
  actor: Actor,
  reason: string,
  db: Db,
  now: () => Date,
): Promise<PurchasingStatus> {
  if (!isAdmin(actor)) {
    throw new ForbiddenError(`${halted ? 'halt' : 'resume'} automated purchasing`);
  }
  if (actor.orgId !== orgId) {
    throw new ForbiddenError('change the kill switch of another organization');
  }
  if (!reason.trim()) {
    throw new Error(
      `A reason is required to ${halted ? 'halt' : 'resume'} purchasing — ` +
        'the switch is an audit record, not a boolean.',
    );
  }

  await db.insert(s.bookingControls).values({
    orgId,
    purchasingHalted: halted,
    reason: reason.trim(),
    actorId: actor.userId,
    createdAt: now(),
  });

  return purchasingStatus(orgId, db);
}

export function haltPurchasing(
  orgId: string,
  actor: Actor,
  reason: string,
  db: Db,
  now: () => Date = () => new Date(),
): Promise<PurchasingStatus> {
  return toggle(orgId, true, actor, reason, db, now);
}

export function resumePurchasing(
  orgId: string,
  actor: Actor,
  reason: string,
  db: Db,
  now: () => Date = () => new Date(),
): Promise<PurchasingStatus> {
  return toggle(orgId, false, actor, reason, db, now);
}

/** The full toggle history, newest first — the answer to "who turned it back on". */
export async function purchasingHistory(orgId: string, db: Db) {
  return db
    .select()
    .from(s.bookingControls)
    .where(eq(s.bookingControls.orgId, orgId))
    .orderBy(desc(s.bookingControls.createdAt));
}
