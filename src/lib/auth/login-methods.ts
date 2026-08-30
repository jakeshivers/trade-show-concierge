/**
 * Per-org control over permitted authentication strategies. SCOPE.md §3.
 *
 * "Everyone signs in with Okta, no passwords" is a hard blocker in enterprise
 * security review. This module is the decision half of that control: pure,
 * deterministic, and testable with no Clerk account, exactly like the policy
 * engine and the credit ledger.
 *
 * ── The correction this step forced ────────────────────────────────────────
 *
 * A login-method restriction is enforced at **sign-in**, and we are not present
 * at sign-in. Clerk is. Read the session it hands back — `auth()`, or the Backend
 * API `Session` object — and there is no record of *which* strategy authenticated
 * it: `Session` carries id, client, user, status, activity, and an impersonation
 * actor, and the token claims carry `factorVerificationAge` (how long ago a factor
 * was verified, in minutes) but never what that factor was. Verified against the
 * installed `@clerk/backend` 3.16 types, not assumed.
 *
 * So a gate that claimed "this session signed in with SAML" would be inventing
 * its evidence, which is the same failure as inventing a fare. What the Backend
 * API *does* expose is the set of credentials a user **holds** —
 * `passwordEnabled`, `externalAccounts[].provider`, `enterpriseAccounts[].provider`,
 * `web3Wallets`. That supports a different and still worthwhile check:
 *
 *   **a standing-credential check, not a sign-in-event check.**
 *
 * An org that is SSO-only fails this gate the moment a user holds a password,
 * whether or not they used it — which is the case that actually matters, because
 * a forbidden credential that exists is a forbidden credential that can be used.
 * Clerk's own instance settings remain the primary control; this is the second
 * gate and the auditable record of what the org intended.
 *
 * It fails **closed**: an allowlist org whose user presents no readable
 * credentials is refused, not waved through. An auth control that degrades to
 * "allowed" when its input is missing is decoration.
 */

/** The kinds of credential Clerk's Backend API lets us observe on a user. */
export const STRATEGY_KINDS = ['password', 'oauth', 'enterprise_sso', 'web3'] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

/**
 * A credential the user holds. `provider` is null for kinds that have none
 * (a password is a password); for the rest it is the normalized provider slug.
 */
export type HeldCredential = {
  kind: StrategyKind;
  provider: string | null;
};

/**
 * A policy entry: either a bare kind (`enterprise_sso` — any IdP) or a
 * kind-and-provider pair (`oauth:google`). The coarse form is what an org
 * usually means; the specific form is there for "Google, and only Google."
 */
export type StrategyId = string;

export const strategyId = (c: HeldCredential): StrategyId =>
  c.provider ? `${c.kind}:${c.provider}` : c.kind;

/**
 * Clerk prefixes provider slugs by protocol — `oauth_google`, `saml_okta`. The
 * prefix duplicates the kind we already record, so it is stripped here and the
 * stored policy stays readable: `oauth:google`, not `oauth:oauth_google`.
 */
export function normalizeProvider(raw: string): string {
  return raw.replace(/^(oauth_|saml_|oidc_|custom_)/, '').toLowerCase();
}

/**
 * The subset of Clerk's Backend `User` this module needs. Structural, so the real
 * `User` satisfies it and the tests can hand over a literal — no Clerk import in
 * the decision half.
 */
export type IdentitySource = {
  passwordEnabled: boolean;
  externalAccounts: readonly { provider: string }[];
  enterpriseAccounts: readonly { provider: string }[];
  web3Wallets: readonly unknown[];
};

export function credentialsHeld(user: IdentitySource): HeldCredential[] {
  const held: HeldCredential[] = [];
  if (user.passwordEnabled) held.push({ kind: 'password', provider: null });
  for (const a of user.externalAccounts) {
    held.push({ kind: 'oauth', provider: normalizeProvider(a.provider) });
  }
  for (const a of user.enterpriseAccounts) {
    held.push({ kind: 'enterprise_sso', provider: normalizeProvider(a.provider) });
  }
  if (user.web3Wallets.length > 0) held.push({ kind: 'web3', provider: null });
  return held;
}

/* ---------------------------------- policy --------------------------------- */

export type LoginPolicy =
  | { mode: 'unrestricted' }
  | { mode: 'allowlist'; allowedStrategies: readonly StrategyId[] };

export const UNRESTRICTED: LoginPolicy = { mode: 'unrestricted' };

export type LoginMethodVerdict =
  | { permitted: true; reason: string }
  | { permitted: false; violations: HeldCredential[]; reason: string };

/** A credential is permitted if the allowlist names its kind, or its exact pair. */
export function isPermitted(c: HeldCredential, allowed: readonly StrategyId[]): boolean {
  return allowed.includes(c.kind) || allowed.includes(strategyId(c));
}

/**
 * Does this user's standing set of credentials satisfy the org's policy?
 *
 * Note what is *not* asked: how they signed in. See the header.
 */
export function evaluateLoginMethods(
  policy: LoginPolicy,
  held: readonly HeldCredential[],
): LoginMethodVerdict {
  if (policy.mode === 'unrestricted') {
    return { permitted: true, reason: 'No login-method restriction is in force for this organization.' };
  }

  // Fail closed. An empty credential set means we could not read the user's
  // identities, not that they have none — refuse rather than assume.
  if (held.length === 0) {
    return {
      permitted: false,
      violations: [],
      reason:
        'This organization restricts sign-in methods, and no readable credentials were found ' +
        'on this account. Access is refused rather than assumed; an admin should confirm the ' +
        "account's identities in Clerk.",
    };
  }

  const violations = held.filter((c) => !isPermitted(c, policy.allowedStrategies));
  if (violations.length > 0) {
    return {
      permitted: false,
      violations,
      reason:
        `This organization permits sign-in with ${formatStrategies(policy.allowedStrategies)}. ` +
        `This account also holds ${formatStrategies(violations.map(strategyId))}, which must be ` +
        'removed in Clerk before it can be used here.',
    };
  }

  return {
    permitted: true,
    reason: `Every credential on this account is within the permitted set (${formatStrategies(
      policy.allowedStrategies,
    )}).`,
  };
}

/* ----------------------------- presentation -------------------------------- */

const KIND_LABELS: Record<StrategyKind, string> = {
  password: 'Password',
  oauth: 'Social sign-in',
  enterprise_sso: 'Enterprise SSO',
  web3: 'Web3 wallet',
};

export function describeStrategy(id: StrategyId): string {
  const [kind, provider] = id.split(':') as [StrategyKind, string | undefined];
  const label = KIND_LABELS[kind] ?? kind;
  return provider ? `${label} (${provider})` : label;
}

export function formatStrategies(ids: readonly StrategyId[]): string {
  if (ids.length === 0) return 'nothing';
  return ids.map(describeStrategy).join(', ');
}

/** A policy is only meaningful if it leaves at least one way in. */
export function isUsablePolicy(policy: LoginPolicy): boolean {
  return policy.mode === 'unrestricted' || policy.allowedStrategies.length > 0;
}
