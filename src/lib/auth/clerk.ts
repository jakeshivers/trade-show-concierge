import { eq, and } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import {
  LoginMethodNotPermittedError,
  NotAuthenticatedError,
  NotProvisionedError,
  type Actor,
} from '@/lib/auth/actor';
import { credentialsHeld, evaluateLoginMethods } from '@/lib/auth/login-methods';
import { effectiveLoginPolicy } from '@/lib/auth/login-policy-store';

/**
 * Clerk, behind the `getActor()` seam. SCOPE.md §10 step 7.
 *
 * Three rules this file exists to hold:
 *
 * 1. **Clerk says who you are; our database says what you may do.** The role and
 *    the org come from the `users` row, never from Clerk metadata. Spend authority
 *    that can be edited in another vendor's dashboard is spend authority outside
 *    our audit trail — and §3's separation of duties would be defeated by a
 *    `publicMetadata` edit.
 *
 * 2. **Signing in is not provisioning.** A verified Clerk session with no `users`
 *    row is authenticated and has no access. We never create the row: org
 *    membership decides who can spend money, and an unattended INSERT on first
 *    sign-in is an open door with a nice user experience.
 *
 * 3. **When Clerk is configured, it is the only way in.** `DEV_ACTOR_EMAIL` is
 *    never consulted on this path — a dev backdoor that survives into a
 *    configured deployment is the backdoor, not the fallback. See `actor.ts`.
 *
 * The import of `@clerk/nextjs/server` is deliberately dynamic: the scripts and
 * the test suite run this module's neighbours with no Clerk installed in their
 * request context, and a top-level import drags Next's server runtime into a
 * plain `tsx` process for no reason.
 */

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
}

/** What we need from a verified session. Kept structural so tests need no Clerk. */
export type ClerkSession = {
  userId: string;
  /** Set when an admin is impersonating; §3 forbids approving or purchasing under it. */
  impersonatorId?: string;
};

async function readSession(): Promise<ClerkSession | null> {
  const { auth } = await import('@clerk/nextjs/server');
  const session = await auth();
  if (!session.userId) return null;
  const actorClaim = session.actor as { sub?: string } | null | undefined;
  return {
    userId: session.userId,
    ...(actorClaim?.sub ? { impersonatorId: actorClaim.sub } : {}),
  };
}

/**
 * Map a Clerk user id to our user row.
 *
 * First sign-in links by verified email address and records `clerk_user_id`, so
 * the link is written once and every later request is an id lookup. The email
 * must already belong to a provisioned user — see rule 2 above.
 */
async function linkUser(session: ClerkSession, db = getDb()) {
  const byClerkId = await db.query.users.findFirst({
    where: eq(s.users.clerkUserId, session.userId),
  });
  if (byClerkId) return byClerkId;

  const { clerkClient } = await import('@clerk/nextjs/server');
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(session.userId);

  const primary = clerkUser.emailAddresses.find(
    (e) => e.id === clerkUser.primaryEmailAddressId,
  );
  if (!primary) throw new NotProvisionedError('this Clerk account has no primary email address');

  const byEmail = await db.query.users.findFirst({
    where: eq(s.users.email, primary.emailAddress.toLowerCase()),
  });
  if (!byEmail) throw new NotProvisionedError(primary.emailAddress);

  // Never re-point an existing link: two Clerk accounts claiming one user row is
  // a conflict to surface, not to resolve silently.
  if (byEmail.clerkUserId && byEmail.clerkUserId !== session.userId) {
    throw new NotProvisionedError(
      `${primary.emailAddress} is already linked to a different Clerk account`,
    );
  }

  const [linked] = await db
    .update(s.users)
    .set({ clerkUserId: session.userId })
    .where(and(eq(s.users.id, byEmail.id)))
    .returning();
  return linked;
}

/**
 * The login-method gate. Only an org running an allowlist pays for it — an
 * unrestricted org never makes the Backend API call.
 */
async function enforceLoginPolicy(orgId: string, clerkUserId: string, db = getDb()) {
  const policy = await effectiveLoginPolicy(orgId, db);
  if (policy.mode === 'unrestricted') return;

  const { clerkClient } = await import('@clerk/nextjs/server');
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(clerkUserId);

  const verdict = evaluateLoginMethods(policy, credentialsHeld(clerkUser));
  if (!verdict.permitted) throw new LoginMethodNotPermittedError(verdict.reason);
}

export async function resolveClerkActor(db = getDb()): Promise<Actor> {
  const session = await readSession();
  if (!session) throw new NotAuthenticatedError();

  const row = await linkUser(session, db);
  await enforceLoginPolicy(row.orgId, session.userId, db);

  return {
    userId: row.id,
    orgId: row.orgId,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    costCenterId: row.costCenterId,
    ...(session.impersonatorId ? { impersonatedBy: session.impersonatorId } : {}),
  };
}
