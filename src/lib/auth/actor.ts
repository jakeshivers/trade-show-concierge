import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users, type organizations } from '@/db/schema';
import { authMode } from '@/lib/auth/mode';

export { authMode, type AuthMode } from '@/lib/auth/mode';

/**
 * The authentication seam.
 *
 * Every query in the app resolves its caller through `getActor()`. It reads a
 * Clerk session when Clerk is configured and a seeded dev user when it is not.
 * Nothing downstream changes, because nothing downstream knows which it was —
 * which is what step 1 bought us and step 7 spent.
 *
 * **The switch is one-way.** With Clerk configured, `DEV_ACTOR_EMAIL` is never
 * consulted, even if a Clerk lookup fails. A fallback here would be a backdoor
 * that only opens when the front door is jammed.
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

/**
 * Authenticated, but nobody here. A Clerk session whose email matches no user row
 * is a person who signed in and has no access: provisioning is an admin act, and
 * creating the row on the way past would make sign-up the provisioning flow.
 */
export class NotProvisionedError extends Error {
  constructor(readonly identity: string) {
    super(
      `No user in this workspace matches ${identity}. An admin must add the account ` +
        'before it can be used.',
    );
    this.name = 'NotProvisionedError';
  }
}

/** The org's login-method allowlist refused this account. See `login-methods.ts`. */
export class LoginMethodNotPermittedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LoginMethodNotPermittedError';
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
 * Clerk mode: the session, mapped to a provisioned user row. Role and org come
 * from that row, never from Clerk metadata — see `clerk.ts`.
 *
 * Dev mode: `DEV_ACTOR_EMAIL` selects a seeded user, which makes it trivial to
 * exercise member / travel-manager / admin paths without a login flow, and keeps
 * `pnpm db:reset && pnpm test` working on a clean clone with zero accounts.
 */
export async function getActor(): Promise<Actor> {
  if (authMode() === 'clerk') {
    // Dynamic so a plain `tsx` script never drags Next's server runtime in.
    const { resolveClerkActor } = await import('@/lib/auth/clerk');
    return resolveClerkActor();
  }
  return devActor();
}

async function devActor(): Promise<Actor> {
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

/**
 * The same resolution, with "nobody is signed in" as a value rather than a throw.
 * The app shell needs to render a sign-in page without treating it as an error;
 * everything that touches data keeps using `getActor()`.
 *
 * Only *absence* is softened. A provisioning failure or a refused login method
 * still throws: those are answers, and swallowing them would show a stranger the
 * same blank page as a signed-out visitor.
 */
export async function getActorOrNull(): Promise<Actor | null> {
  try {
    return await getActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return null;
    throw err;
  }
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

export type ApprovalRoute =
  | { kind: 'eligible_approvers'; approverIds: string[] }
  | { kind: 'break_glass'; reason: string };

/**
 * Who can approve this request — and what happens when nobody can.
 *
 * Strict separation of duties deadlocks a one-admin org: their own over-policy
 * request has no eligible approver and would sit forever. Break-glass resolves
 * that without making the rule decorative: the requester may self-approve, but
 * only with a written justification, and the audit record is flagged so it is
 * visibly an exception rather than a normal approval.
 */
export function routeApproval(requesterId: string, orgMembers: Actor[]): ApprovalRoute {
  const approverIds = orgMembers
    .filter((m) => !m.impersonatedBy)
    .filter((m) => m.role === 'admin' || m.role === 'travel_manager')
    .filter((m) => m.userId !== requesterId)
    .map((m) => m.userId);

  if (approverIds.length > 0) return { kind: 'eligible_approvers', approverIds };

  return {
    kind: 'break_glass',
    reason:
      'No eligible approver exists for this request. Self-approval requires a written justification and is recorded as a break-glass exception.',
  };
}

/** A break-glass approval is only valid with a real justification attached. */
export function isValidBreakGlass(justification: string): boolean {
  return justification.trim().length >= 20;
}

export function assert(condition: boolean, action: string): asserts condition {
  if (!condition) throw new ForbiddenError(action);
}

export type Org = typeof organizations.$inferSelect;
