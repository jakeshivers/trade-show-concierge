import { describe, it, expect } from 'vitest';
import {
  credentialsHeld,
  evaluateLoginMethods,
  formatStrategies,
  isPermitted,
  isUsablePolicy,
  normalizeProvider,
  strategyId,
  UNRESTRICTED,
  type HeldCredential,
  type LoginPolicy,
} from '@/lib/auth/login-methods';

/**
 * The login-method gate, tested the way the policy engine is: pure inputs, no
 * Clerk account, no network. See the module header for why this checks the
 * credentials an account *holds* rather than the one it signed in with.
 */

const ssoOnly: LoginPolicy = { mode: 'allowlist', allowedStrategies: ['enterprise_sso'] };

const okta: HeldCredential = { kind: 'enterprise_sso', provider: 'okta' };
const password: HeldCredential = { kind: 'password', provider: null };
const google: HeldCredential = { kind: 'oauth', provider: 'google' };

describe('reading credentials off a Clerk user', () => {
  it('maps every identity kind the Backend API exposes', () => {
    const held = credentialsHeld({
      passwordEnabled: true,
      externalAccounts: [{ provider: 'oauth_google' }],
      enterpriseAccounts: [{ provider: 'saml_okta' }],
      web3Wallets: [{}],
    });

    expect(held.map(strategyId).sort()).toEqual([
      'enterprise_sso:okta',
      'oauth:google',
      'password',
      'web3',
    ]);
  });

  it('strips the protocol prefix Clerk puts on provider slugs', () => {
    expect(normalizeProvider('oauth_google')).toBe('google');
    expect(normalizeProvider('saml_okta')).toBe('okta');
    expect(normalizeProvider('Okta')).toBe('okta');
  });

  it('reports an account with no identities as empty rather than guessing', () => {
    const held = credentialsHeld({
      passwordEnabled: false,
      externalAccounts: [],
      enterpriseAccounts: [],
      web3Wallets: [],
    });
    expect(held).toEqual([]);
  });
});

describe('matching a credential against an allowlist', () => {
  it('accepts a bare kind as permission for every provider of that kind', () => {
    expect(isPermitted(okta, ['enterprise_sso'])).toBe(true);
    expect(isPermitted(google, ['enterprise_sso'])).toBe(false);
  });

  it('accepts a kind:provider pair for exactly that provider', () => {
    expect(isPermitted(google, ['oauth:google'])).toBe(true);
    expect(isPermitted({ kind: 'oauth', provider: 'github' }, ['oauth:google'])).toBe(false);
  });
});

describe('the verdict', () => {
  it('permits everything when the org has set no restriction', () => {
    expect(evaluateLoginMethods(UNRESTRICTED, [password]).permitted).toBe(true);
  });

  it('permits an SSO-only account under an SSO-only policy', () => {
    expect(evaluateLoginMethods(ssoOnly, [okta]).permitted).toBe(true);
  });

  it('refuses an account that still holds a password, however it signed in', () => {
    const verdict = evaluateLoginMethods(ssoOnly, [okta, password]);
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    // The SSO credential is fine; only the password is named.
    expect(verdict.violations).toEqual([password]);
    expect(verdict.reason).toContain('Password');
  });

  it('fails closed when no credentials can be read', () => {
    const verdict = evaluateLoginMethods(ssoOnly, []);
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.violations).toEqual([]);
    expect(verdict.reason).toContain('refused');
  });

  it('never fails closed for an unrestricted org', () => {
    // The strict reading only applies where the org asked for it; an org with no
    // policy must not be locked out by an unreadable identity list.
    expect(evaluateLoginMethods(UNRESTRICTED, []).permitted).toBe(true);
  });
});

describe('guard rails on the policy itself', () => {
  it('rejects an allowlist that permits nothing', () => {
    expect(isUsablePolicy({ mode: 'allowlist', allowedStrategies: [] })).toBe(false);
    expect(isUsablePolicy(ssoOnly)).toBe(true);
    expect(isUsablePolicy(UNRESTRICTED)).toBe(true);
  });

  it('describes strategies in words an admin recognises', () => {
    expect(formatStrategies(['enterprise_sso', 'oauth:google'])).toBe(
      'Enterprise SSO, Social sign-in (google)',
    );
  });
});
