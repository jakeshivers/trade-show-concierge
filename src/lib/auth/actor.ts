import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users, type organizations } from '@/db/schema';

/**
 * The authentication seam.
 *
 * Every query in the app resolves its caller through `getActor()`. Today that
 * reads a seeded dev user; at build step 7 it reads a Clerk session. Nothing
 * downstream changes, because nothing downstream knows which it was.
 *
 * See SCOPE.md §10, "A correction to §2 and §3".
 */

export type UserRole = 'member' | 'travel_manager' | 'admin';

export type Actor = {
  userId: string;
  orgId: string;
  email: string;
  fullName: string;
  role: UserRole;
  costCenterId: string | null;
  /** Set when an admin is impersonating. Both identities are logged; see SCOPE.md §3. */
  impersonatedBy?: string;
};

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No authenticated actor');
    this.name = 'NotAuthenticatedError';
  }
}

export class ForbiddenError extends Error {
  constructor(action: string) {
    super(`Actor is not permitted to ${action}`);
    this.name = 'ForbiddenError';
  }
}

/**
 * Resolve the current actor.
 *
 * Dev mode: `DEV_ACTOR_EMAIL` selects a seeded user, which makes it trivial to
 * exercise member / travel-manager / admin paths without a login flow.
 */
export async function getActor(): Promise<Actor> {
  const email = process.env.DEV_ACTOR_EMAIL;
  if (!email) throw new NotAuthenticatedError();

  const db = getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!row) throw new NotAuthenticatedError();

  return {
    userId: row.id,
    orgId: row.orgId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    costCenterId: row.costCenterId,
  };
}

/* --------------------------------- policy ---------------------------------- */

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

export function canApprove(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'travel_manager';
}

/**
 * Separation of duties: a Travel Manager may approve others' requests but never
 * their own — those escalate to an Admin. Impersonation can never approve at all,
 * or the rule is trivially defeated by an admin becoming the approver.
 * See SCOPE.md §3.
 */
export function canApproveRequestFor(actor: Actor, requesterId: string): boolean {
  if (actor.impersonatedBy) return false;
  if (actor.role === 'admin') return actor.userId !== requesterId;
  if (actor.role === 'travel_manager') return actor.userId !== requesterId;
  return false;
}

export function assert(condition: boolean, action: string): asserts condition {
  if (!condition) throw new ForbiddenError(action);
}

export type Org = typeof organizations.$inferSelect;
