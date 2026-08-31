/**
 * Ask a real Clerk instance the four things our code assumes. SCOPE.md §3.
 *
 *   pnpm clerk:verify              # every user in the instance
 *   pnpm clerk:verify <user_id>    # one, e.g. after impersonating them
 *
 * ## Why this exists
 *
 * `tests/auth-seam.test.ts` mocks `@clerk/nextjs/server` and feeds in objects
 * shaped the way we *believe* Clerk shapes them. That proves our half behaves,
 * which is worth having and is the same bargain the Duffel adapter makes — and
 * like the Duffel fixtures, it cannot detect a belief that is wrong. No real
 * Clerk session has ever reached this app.
 *
 * This talks to the Backend API and prints what actually comes back, next to
 * what the code expects, for the four claims that would fail silently:
 *
 *   1. **Provider slugs.** `normalizeProvider` strips `oauth_|saml_|oidc_|custom_`
 *      to turn Clerk's slug into the strategy id an allowlist is written against.
 *      If real slugs are shaped differently, the strip silently no-ops and every
 *      allowlist comparison comes out false — an org that permits Okta refuses
 *      the person signing in with Okta. Highest-risk unverified claim in the
 *      auth seam.
 *   2. **Array-ness.** `credentialsHeld` iterates `externalAccounts`,
 *      `enterpriseAccounts` and `web3Wallets` directly. Our `IdentitySource` type
 *      declares them non-optional, but that type is *structural* — we wrote it,
 *      Clerk did not. If the real API returns `undefined` for a user with none,
 *      the for-of throws a TypeError and the caller gets a 500 instead of the
 *      fail-closed refusal the module promises.
 *   3. **Impersonation.** `readSession` reads `session.actor.sub` and every test
 *      passes `actor: null`, so the whole impersonation path — which
 *      `canApproveRequestFor` and `setLoginPolicy` both refuse on — has never
 *      been exercised. Run this with a user id while impersonating them in the
 *      Clerk dashboard.
 *   4. **`auth()` under `proxy.ts`.** Next 16 renamed middleware to proxy;
 *      `proxy.ts`'s Clerk-mode branch has no test coverage at all. That one is
 *      checked by loading the app, not from here — this script says so and tells
 *      you what to click.
 *
 * Nothing here writes. It reads the Backend API and prints.
 */
import { credentialsHeld, normalizeProvider } from '../src/lib/auth/login-methods';
import { authMode } from '../src/lib/auth/mode';

const PREFIXES = ['oauth_', 'saml_', 'oidc_', 'custom_'];

function requireClerk(): void {
  // Throws AuthConfigError on exactly one key, which is its own useful answer.
  if (authMode() !== 'clerk') {
    throw new Error(
      'Clerk is not configured, so there is nothing real to ask.\n' +
        'Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in .env.local from a free ' +
        'dev instance at https://dashboard.clerk.com, then run this again.',
    );
  }
}

type ClerkUserish = {
  id: string;
  primaryEmailAddressId?: string | null;
  emailAddresses?: { id: string; emailAddress: string }[];
  passwordEnabled?: boolean;
  externalAccounts?: { provider: string }[];
  enterpriseAccounts?: { provider: string }[];
  web3Wallets?: unknown[];
};

/** `[]` and `undefined` are the whole question, so do not paper over either. */
function describeArray(name: string, value: unknown): string {
  if (value === undefined) return `${name}: UNDEFINED  ← credentialsHeld would throw on this`;
  if (!Array.isArray(value)) return `${name}: not an array (${typeof value})  ← unexpected`;
  return `${name}: [] length ${value.length}`;
}

function reportProviders(label: string, accounts: { provider: string }[] | undefined): void {
  if (!accounts || accounts.length === 0) {
    console.log(`      ${label}: none`);
    return;
  }
  for (const a of accounts) {
    const raw = a.provider;
    const stripped = normalizeProvider(raw);
    const recognised = PREFIXES.some((p) => raw.startsWith(p));
    console.log(
      `      ${label}: ${JSON.stringify(raw).padEnd(24)} → normalizeProvider → ` +
        `${JSON.stringify(stripped).padEnd(16)} ${
          recognised
            ? 'prefix recognised'
            : 'NO KNOWN PREFIX  ← the strip did nothing; allowlist comparisons will not match'
        }`,
    );
  }
}

async function main() {
  requireClerk();
  const only = process.argv[2];

  const { clerkClient } = await import('@clerk/nextjs/server');
  const client = await clerkClient();

  console.log('\nWhat a real Clerk instance actually returns\n');

  const users: ClerkUserish[] = only
    ? [(await client.users.getUser(only)) as unknown as ClerkUserish]
    : ((await client.users.getUserList({ limit: 25 })).data as unknown as ClerkUserish[]);

  if (users.length === 0) {
    console.log('  No users in this instance. Create one matching a seeded email first:');
    console.log('    shelley@northwindrobotics.test   priya@northwindrobotics.test\n');
    return;
  }

  let anyUndefined = false;
  let anyUnknownPrefix = false;

  for (const user of users) {
    const primary = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
    console.log(`  ${primary?.emailAddress ?? '(no primary email)'}  ${user.id}`);

    // Claim 2 — array-ness.
    console.log('    shape credentialsHeld() depends on:');
    for (const [name, value] of [
      ['externalAccounts', user.externalAccounts],
      ['enterpriseAccounts', user.enterpriseAccounts],
      ['web3Wallets', user.web3Wallets],
    ] as const) {
      const line = describeArray(name, value);
      if (line.includes('UNDEFINED')) anyUndefined = true;
      console.log(`      ${line}`);
    }
    console.log(`      passwordEnabled: ${user.passwordEnabled}`);

    // Claim 1 — provider slugs.
    console.log('    provider slugs vs. normalizeProvider:');
    reportProviders('oauth     ', user.externalAccounts);
    reportProviders('enterprise', user.enterpriseAccounts);
    for (const a of [...(user.externalAccounts ?? []), ...(user.enterpriseAccounts ?? [])]) {
      if (!PREFIXES.some((p) => a.provider.startsWith(p))) anyUnknownPrefix = true;
    }

    // What the gate would actually conclude, run through the real function.
    try {
      const held = credentialsHeld({
        passwordEnabled: user.passwordEnabled ?? false,
        externalAccounts: user.externalAccounts ?? [],
        enterpriseAccounts: user.enterpriseAccounts ?? [],
        web3Wallets: user.web3Wallets ?? [],
      });
      console.log(
        `    credentialsHeld() → ${held.map((h) => h.provider ?? h.kind).join(', ') || '(none)'}`,
      );
    } catch (err) {
      console.log(`    credentialsHeld() THREW: ${err instanceof Error ? err.message : err}`);
    }
    console.log('');
  }

  console.log('  ── Verdict ────────────────────────────────────────────────────────────\n');
  console.log(
    anyUnknownPrefix
      ? '  ✗ Claim 1: at least one provider slug carries no prefix normalizeProvider knows.\n' +
          '    The allowlist gate will not match those. login-methods.ts needs the real prefixes.'
      : '  ✓ Claim 1: every provider slug seen matches a prefix normalizeProvider strips.',
  );
  console.log(
    anyUndefined
      ? '  ✗ Claim 2: an identity array came back undefined. credentialsHeld() iterates it\n' +
          '    directly, so that user would 500 rather than fail closed.'
      : '  ✓ Claim 2: identity arrays are arrays, never undefined — credentialsHeld is safe.',
  );
  console.log(
    '\n  ? Claim 3 (impersonation): not observable from the Backend API. In the Clerk\n' +
      '    dashboard use "Impersonate user", then load /settings/security in the app: the\n' +
      '    shell prints the actor, and getActor() sets impersonatedBy from session.actor.sub.\n' +
      '    Every test today passes actor: null, so this path has never run.',
  );
  console.log(
    '\n  ? Claim 4 (auth() under proxy.ts): load any /shows page signed in. If proxy.ts\n' +
      "    resolves in Next 16, you get the page; if it does not, you get a redirect loop\n" +
      '    or an auth() error. proxy.ts has no test coverage of its Clerk branch.\n',
  );
  console.log(
    '  Enterprise SSO (enterpriseAccounts) may need a paid Clerk plan. If none appear\n' +
      "  above, that half of claim 1 stays unverified — say so in CLAUDE.md rather than\n" +
      '  implying it was checked.\n',
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  },
);
