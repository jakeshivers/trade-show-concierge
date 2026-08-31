export type AuthMode = 'clerk' | 'dev';

/**
 * Which side of the `getActor()` seam is live. The app shell says so on screen.
 *
 * Its own module, and deliberately dependency-free: `proxy.ts` needs this answer
 * and must not drag the database client — PGlite ships WASM — into the proxy
 * bundle to get it. `AuthConfigError` is declared here rather than imported from
 * `actor.ts` for the same reason.
 */

/** A deployment that is half-configured for Clerk. Never thrown in dev mode. */
export class AuthConfigError extends Error {
  constructor(
    readonly present: string,
    readonly missing: string,
  ) {
    super(
      `${present} is set but ${missing} is not. Clerk needs both keys, and this app will ` +
        'not start on one.\n\n' +
        'Refusing rather than falling back, because the fallback is the dev seam: with one ' +
        'key missing this process would read DEV_ACTOR_EMAIL and serve whichever seeded ' +
        'user it names, to everyone, with no sign-in — and it would look like it was working. ' +
        `Set ${missing}, or unset ${present} to run on the dev seam deliberately.`,
    );
    this.name = 'AuthConfigError';
  }
}

/**
 * Both keys means Clerk; neither means the dev seam; **one means an error.**
 *
 * The one-key case is the whole reason this function is more than a boolean. The
 * ground rule is that the dev seam closes when Clerk opens, and it was written
 * against the case where Clerk is configured and a *lookup* fails. It did not
 * cover the case where Clerk is only half-configured — and there the fallback is
 * silent, total, and looks healthy: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is the
 * one that gets injected automatically by a hosting provider's integration,
 * `CLERK_SECRET_KEY` is the one a person has to remember, and the failure mode of
 * forgetting it is that the app serves a seeded admin's session to the public
 * internet without an error anywhere.
 *
 * A misconfigured deployment must fail to boot, not quietly downgrade its own
 * authentication. Whitespace counts as absent, so a blank value in a `.env` or a
 * dashboard field reads as "not set" rather than as a key.
 */
export function authMode(): AuthMode {
  const secret = process.env.CLERK_SECRET_KEY?.trim();
  const publishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();

  if (secret && publishable) return 'clerk';
  if (secret) throw new AuthConfigError('CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  if (publishable) {
    throw new AuthConfigError('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY');
  }
  return 'dev';
}
