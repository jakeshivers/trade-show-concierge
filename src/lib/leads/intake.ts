import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The REST endpoint's credential, and the first principal in this product that
 * is not a person.
 *
 * Every access decision in this app so far has run through `getActor()`, which
 * resolves a human: a Clerk session or a seeded dev user, mapped to a `users`
 * row that says the role. A badge scanner has no session and no row, and the
 * temptation is to give it one — a service user with a role, which flows through
 * `getActor()` and then straight into every store function in the codebase.
 *
 * **That is the mistake this file exists to avoid**, and it is the assistant's
 * lesson from step 15 in a different costume: there, the access model is the
 * tool list rather than the prompt, because a capable principal with a
 * restraining instruction is one injection away from being a capable principal.
 * Here, an `IntakePrincipal` is deliberately **not an `Actor`**. It cannot be
 * passed to `listShows`, or `getAlertFeed`, or anything else, because it is the
 * wrong type — the compiler enforces the boundary that a role check would only
 * describe. It carries one capability, which is appending a lead to one show.
 *
 * Three more properties, each a way an API key goes wrong:
 *
 * - **Only the hash is stored.** A leaked database backup is not a set of
 *   working keys, and the plaintext is displayed exactly once, at creation.
 * - **The key is scoped to a show wherever possible.** A scanner rented for
 *   three days in Anaheim has no business writing leads to next year's Detroit
 *   show, and the narrowest credential that does the job is the one to issue.
 *   Org-wide is permitted and the screen says what it costs.
 * - **Revocation is a timestamp, never a delete.** "Which key wrote these forty
 *   leads" has to stay answerable after the key is gone — which is the same
 *   reason a declined show is kept and a cancelled booking's row survives.
 *
 * Comparison is constant-time. Overkill for a self-hosted workspace and free,
 * and the alternative is the one bug in this file that would never be found.
 */

export const KEY_PREFIX = 'tsc_lead_';

export type IntakePrincipal = {
  keyId: string;
  orgId: string;
  /** Null means every show in the org. Discouraged; see the header. */
  showId: string | null;
  label: string;
};

export type IssuedKey = {
  /** Shown once, never stored. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
};

export function issueKey(): IssuedKey {
  const secret = randomBytes(24).toString('base64url');
  const token = `${KEY_PREFIX}${secret}`;
  return {
    token,
    tokenHash: hashToken(token),
    // Enough to tell two keys apart on a screen and not enough to be one.
    tokenPrefix: `${KEY_PREFIX}${secret.slice(0, 6)}`,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * The `Authorization` header, reduced to a token — or nothing.
 *
 * `Bearer <token>` and a bare token are both accepted, because half of the
 * scanner middleware in the world sends one and half sends the other, and a
 * rejection that reads "unauthorized" for a formatting difference costs a day
 * of somebody's integration.
 */
export function readBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const raw = header.trim();
  const token = /^bearer\s+/i.test(raw) ? raw.replace(/^bearer\s+/i, '').trim() : raw;
  return token.startsWith(KEY_PREFIX) ? token : null;
}

export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export type IntakeRefusal =
  | { kind: 'no_credential'; status: 401; message: string }
  | { kind: 'unknown_key'; status: 401; message: string }
  | { kind: 'revoked'; status: 401; message: string }
  | { kind: 'wrong_show'; status: 403; message: string }
  | { kind: 'invalid'; status: 422; message: string };

/**
 * What a refusal says out loud.
 *
 * An unknown key and a revoked key are told apart deliberately, which is the
 * opposite of the rule §3 applies to a Member loading a colleague's travel
 * request — there, "forbidden" would confirm that a colleague is flying
 * somewhere, so it is "not found". Here the caller already holds a credential
 * we issued, so there is nothing to confirm, and "your key was revoked on the
 * 4th" is the difference between a five-minute fix and a support ticket.
 */
export const REFUSALS = {
  noCredential: (): IntakeRefusal => ({
    kind: 'no_credential',
    status: 401,
    message:
      'No intake key. Send it as `Authorization: Bearer tsc_lead_…`. Keys are issued in Settings → Lead intake.',
  }),
  unknownKey: (): IntakeRefusal => ({
    kind: 'unknown_key',
    status: 401,
    message: 'That intake key is not recognised in any workspace.',
  }),
  revoked: (at: Date): IntakeRefusal => ({
    kind: 'revoked',
    status: 401,
    message: `That intake key was revoked on ${at.toISOString().slice(0, 10)}. Issue a new one rather than restoring it.`,
  }),
  wrongShow: (): IntakeRefusal => ({
    kind: 'wrong_show',
    status: 403,
    message:
      'That key is scoped to a different show. A key issued for one show cannot write leads to another — issue a key for this show.',
  }),
  invalid: (message: string): IntakeRefusal => ({ kind: 'invalid', status: 422, message }),
};
