import { desc, eq, isNull, and } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, isAdmin, type Actor } from '@/lib/auth/actor';
import {
  UNRESTRICTED,
  isUsablePolicy,
  type LoginPolicy,
  type StrategyId,
} from '@/lib/auth/login-methods';

/**
 * Where the org's login-method policy is read and written.
 *
 * Versioned and append-only, like the travel policy: "when did we go SSO-only,
 * and who decided it" has to stay answerable. Nothing here updates a row.
 */

type Db = ReturnType<typeof getDb>;

export type LivePolicy = {
  policy: LoginPolicy;
  version: number;
  reason: string;
  actorId: string | null;
  since: Date;
};

function toPolicy(row: typeof s.orgLoginPolicies.$inferSelect): LoginPolicy {
  return row.mode === 'allowlist'
    ? { mode: 'allowlist', allowedStrategies: row.allowedStrategies }
    : UNRESTRICTED;
}

/** An org that has never set one is unrestricted; that is a real answer, not a gap. */
export async function readLoginPolicy(orgId: string, db: Db = getDb()): Promise<LivePolicy | null> {
  const [row] = await db
    .select()
    .from(s.orgLoginPolicies)
    .where(and(eq(s.orgLoginPolicies.orgId, orgId), isNull(s.orgLoginPolicies.supersededAt)))
    .orderBy(desc(s.orgLoginPolicies.version))
    .limit(1);

  if (!row) return null;
  return {
    policy: toPolicy(row),
    version: row.version,
    reason: row.reason,
    actorId: row.actorId,
    since: row.createdAt,
  };
}

export async function effectiveLoginPolicy(orgId: string, db: Db = getDb()): Promise<LoginPolicy> {
  const live = await readLoginPolicy(orgId, db);
  return live?.policy ?? UNRESTRICTED;
}

export async function loginPolicyHistory(orgId: string, db: Db = getDb()) {
  return db
    .select()
    .from(s.orgLoginPolicies)
    .where(eq(s.orgLoginPolicies.orgId, orgId))
    .orderBy(desc(s.orgLoginPolicies.version));
}

export class UnusablePolicyError extends Error {
  constructor() {
    super('An allowlist with no permitted strategy locks every user out of the organization.');
    this.name = 'UnusablePolicyError';
  }
}

/**
 * Record a new version. Admin only — SCOPE.md §3, "Restrict permitted login methods."
 *
 * A reason is required in both directions. Relaxing a restriction is the change an
 * auditor cares about most, and an unexplained relaxation is the one worth catching.
 */
export async function setLoginPolicy(
  actor: Actor,
  input: { mode: 'unrestricted' } | { mode: 'allowlist'; allowedStrategies: StrategyId[] },
  reason: string,
  db: Db = getDb(),
): Promise<LivePolicy> {
  if (!isAdmin(actor)) throw new ForbiddenError('set the organization login policy');
  if (actor.impersonatedBy) throw new ForbiddenError('change auth settings while impersonating');
  if (reason.trim().length < 10) {
    throw new ForbiddenError('change the login policy without a written reason');
  }

  const next: LoginPolicy =
    input.mode === 'allowlist'
      ? { mode: 'allowlist', allowedStrategies: input.allowedStrategies }
      : UNRESTRICTED;
  if (!isUsablePolicy(next)) throw new UnusablePolicyError();

  const current = await readLoginPolicy(actor.orgId, db);
  const version = (current?.version ?? 0) + 1;

  if (current) {
    await db
      .update(s.orgLoginPolicies)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(s.orgLoginPolicies.orgId, actor.orgId),
          isNull(s.orgLoginPolicies.supersededAt),
        ),
      );
  }

  const [row] = await db
    .insert(s.orgLoginPolicies)
    .values({
      orgId: actor.orgId,
      version,
      mode: input.mode,
      allowedStrategies: input.mode === 'allowlist' ? input.allowedStrategies : [],
      reason: reason.trim(),
      actorId: actor.userId,
    })
    .returning();

  return {
    policy: toPolicy(row),
    version: row.version,
    reason: row.reason,
    actorId: row.actorId,
    since: row.createdAt,
  };
}
