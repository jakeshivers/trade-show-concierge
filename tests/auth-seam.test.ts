import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import {
  authMode,
  getActor,
  getActorOrNull,
  ForbiddenError,
  LoginMethodNotPermittedError,
  NotAuthenticatedError,
  NotProvisionedError,
} from '@/lib/auth/actor';
import {
  readLoginPolicy,
  loginPolicyHistory,
  setLoginPolicy,
  UnusablePolicyError,
} from '@/lib/auth/login-policy-store';

/**
 * Step 7: the seam with Clerk behind it.
 *
 * Clerk itself is mocked — the point of these tests is that *our* half behaves,
 * with zero keys and no network, which is the same bargain the Duffel adapter
 * makes. What a live key would confirm is noted in CLAUDE.md.
 */

const clerkAuth = vi.fn();
const getUser = vi.fn();

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => clerkAuth(),
  clerkClient: async () => ({ users: { getUser: (id: string) => getUser(id) } }),
}));

const db = getDb();
const ADMIN = 'dana@northwindrobotics.test';
const MEMBER = 'priya@northwindrobotics.test';

async function userByEmail(email: string) {
  const row = await db.query.users.findFirst({ where: eq(s.users.email, email) });
  if (!row) throw new Error(`seed missing ${email}`);
  return row;
}

function signedInAs(clerkUserId: string, email: string, identities: Partial<{
  passwordEnabled: boolean;
  externalAccounts: { provider: string }[];
  enterpriseAccounts: { provider: string }[];
}> = {}) {
  clerkAuth.mockResolvedValue({ userId: clerkUserId, actor: null });
  getUser.mockResolvedValue({
    id: clerkUserId,
    primaryEmailAddressId: 'idn_1',
    emailAddresses: [{ id: 'idn_1', emailAddress: email }],
    passwordEnabled: identities.passwordEnabled ?? false,
    externalAccounts: identities.externalAccounts ?? [],
    enterpriseAccounts: identities.enterpriseAccounts ?? [],
    web3Wallets: [],
  });
}

function useClerk() {
  process.env.CLERK_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_not_a_real_key';
}

const savedEnv = { ...process.env };

beforeEach(() => {
  clerkAuth.mockReset();
  getUser.mockReset();
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  process.env.DEV_ACTOR_EMAIL = ADMIN;
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await db.delete(s.orgLoginPolicies);
  await db.update(s.users).set({ clerkUserId: null });
});

describe('which side of the seam is live', () => {
  it('is the dev seam with no Clerk keys', async () => {
    expect(authMode()).toBe('dev');
    expect((await getActor()).email).toBe(ADMIN);
  });

  it('is Clerk as soon as both keys are present', () => {
    useClerk();
    expect(authMode()).toBe('clerk');
  });

  it('never falls back to the dev actor once Clerk is configured', async () => {
    // The backdoor test. DEV_ACTOR_EMAIL names a real seeded admin, and a signed-out
    // Clerk session must still be signed out — not quietly promoted to that admin.
    useClerk();
    clerkAuth.mockResolvedValue({ userId: null, actor: null });
    await expect(getActor()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('reports absence as null and everything else as a throw', async () => {
    delete process.env.DEV_ACTOR_EMAIL;
    expect(await getActorOrNull()).toBeNull();
  });
});

describe('mapping a Clerk session onto a provisioned user', () => {
  it('links by verified email on first sign-in and by id thereafter', async () => {
    useClerk();
    signedInAs('user_clerk_dana', ADMIN);

    const actor = await getActor();
    expect(actor.email).toBe(ADMIN);
    // The link is written once...
    expect((await userByEmail(ADMIN)).clerkUserId).toBe('user_clerk_dana');

    // ...and the second request is an id lookup: no Backend API call at all.
    getUser.mockReset();
    const again = await getActor();
    expect(again.userId).toBe(actor.userId);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('takes role and org from our records, not from Clerk', async () => {
    useClerk();
    signedInAs('user_clerk_priya', MEMBER);
    const actor = await getActor();
    expect(actor.role).toBe('member');
    expect(actor.orgId).toBe((await userByEmail(MEMBER)).orgId);
  });

  it('refuses a verified session that matches nobody here', async () => {
    useClerk();
    signedInAs('user_clerk_stranger', 'nobody@example.test');
    await expect(getActor()).rejects.toBeInstanceOf(NotProvisionedError);
    // And provisions nothing on the way past.
    const rows = await db.select().from(s.users);
    expect(rows.some((r) => r.email === 'nobody@example.test')).toBe(false);
  });

  it('refuses a second Clerk account claiming an already-linked user', async () => {
    useClerk();
    signedInAs('user_clerk_dana', ADMIN);
    await getActor();

    signedInAs('user_clerk_impostor', ADMIN);
    await expect(getActor()).rejects.toBeInstanceOf(NotProvisionedError);
  });
});

describe('the login-method gate at the seam', () => {
  it('costs an unrestricted org nothing', async () => {
    useClerk();
    signedInAs('user_clerk_dana', ADMIN);
    await getActor();
    getUser.mockClear();

    // Second call: linked by id, and no policy means no identity lookup either.
    await getActor();
    expect(getUser).not.toHaveBeenCalled();
  });

  it('refuses a session whose account holds a forbidden credential', async () => {
    const admin = await userByEmail(ADMIN);
    await setLoginPolicy(
      {
        userId: admin.id,
        orgId: admin.orgId,
        email: admin.email,
        fullName: admin.fullName,
        role: 'admin',
        costCenterId: admin.costCenterId,
      },
      { mode: 'allowlist', allowedStrategies: ['enterprise_sso'] },
      'Security review: Okta only, no passwords.',
    );

    useClerk();
    signedInAs('user_clerk_priya', MEMBER, {
      passwordEnabled: true,
      enterpriseAccounts: [{ provider: 'saml_okta' }],
    });

    await expect(getActor()).rejects.toBeInstanceOf(LoginMethodNotPermittedError);
  });

  it('admits the same account once the password is gone', async () => {
    const admin = await userByEmail(ADMIN);
    await setLoginPolicy(
      {
        userId: admin.id,
        orgId: admin.orgId,
        email: admin.email,
        fullName: admin.fullName,
        role: 'admin',
        costCenterId: admin.costCenterId,
      },
      { mode: 'allowlist', allowedStrategies: ['enterprise_sso'] },
      'Security review: Okta only, no passwords.',
    );

    useClerk();
    signedInAs('user_clerk_priya', MEMBER, {
      enterpriseAccounts: [{ provider: 'saml_okta' }],
    });

    expect((await getActor()).email).toBe(MEMBER);
  });
});

describe('recording the policy', () => {
  async function actorFor(email: string) {
    const row = await userByEmail(email);
    return {
      userId: row.id,
      orgId: row.orgId,
      email: row.email,
      fullName: row.fullName,
      role: row.role,
      costCenterId: row.costCenterId,
    };
  }

  it('is an admin decision, and a written one', async () => {
    const member = await actorFor(MEMBER);
    await expect(
      setLoginPolicy(member, { mode: 'unrestricted' }, 'because I said so'),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const admin = await actorFor(ADMIN);
    await expect(setLoginPolicy(admin, { mode: 'unrestricted' }, 'why')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses an allowlist that locks everybody out', async () => {
    const admin = await actorFor(ADMIN);
    await expect(
      setLoginPolicy(
        admin,
        { mode: 'allowlist', allowedStrategies: [] },
        'Tightening sign-in for the security review.',
      ),
    ).rejects.toBeInstanceOf(UnusablePolicyError);
  });

  it('appends versions instead of updating, and keeps one live', async () => {
    const admin = await actorFor(ADMIN);
    await setLoginPolicy(
      admin,
      { mode: 'allowlist', allowedStrategies: ['enterprise_sso'] },
      'Security review 2026-Q3: SSO only.',
    );
    await setLoginPolicy(
      admin,
      { mode: 'unrestricted' },
      'Okta outage on 2026-09-01; relaxing until it is back.',
    );

    const live = await readLoginPolicy(admin.orgId);
    expect(live?.version).toBe(2);
    expect(live?.policy.mode).toBe('unrestricted');

    const history = await loginPolicyHistory(admin.orgId);
    expect(history).toHaveLength(2);
    expect(history.filter((r) => r.supersededAt === null)).toHaveLength(1);
    // The relaxation is on the record with its reason — the version an auditor wants.
    expect(history[0].reason).toContain('Okta outage');
  });
});
