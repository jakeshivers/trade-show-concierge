import type * as s from '@/db/schema';
import type { HoldRequest } from '@/lib/integrations/flights/types';

/**
 * Turning a user row into an airline passenger.
 *
 * This is the seam where the ground rule "no fake data behind a real
 * integration" gets tested hardest. An airline will not issue a ticket without a
 * date of birth, and a plausible-looking placeholder would be accepted by the
 * carrier and produce a real ticket in a name that does not match the traveler's
 * passport. So a missing field throws, naming every field that is missing and
 * whose profile it belongs to, and the request fails before any money moves.
 *
 * Dry runs never reach here, which is deliberate: an incomplete profile should
 * surface when someone tries to buy, not block the whole pipeline from being
 * exercised on a clean clone.
 */

export type Passenger = HoldRequest['passengers'][number];

export class MissingTravelerDetailsError extends Error {
  constructor(
    readonly userId: string,
    readonly email: string,
    readonly missing: string[],
  ) {
    super(
      `Cannot ticket ${email}: their traveler profile is missing ${missing.join(', ')}. ` +
        'An airline requires these to issue a ticket, and they must match the ' +
        'traveler’s ID — they are never defaulted or guessed.',
    );
    this.name = 'MissingTravelerDetailsError';
  }
}

/** Duffel splits the legal name; a single-word `fullName` is a family name of its own. */
export function splitName(fullName: string): { givenName: string; familyName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { givenName: parts[0] ?? '', familyName: parts[0] ?? '' };
  return { givenName: parts[0], familyName: parts.slice(1).join(' ') };
}

/**
 * `id` is left to the caller: it must be the *provider's* passenger id from the
 * offer being bought, which only the provider knows.
 */
export function passengerForUser(
  user: typeof s.users.$inferSelect,
  id = '',
): Passenger {
  const { givenName, familyName } = splitName(user.fullName);

  const missing: string[] = [];
  if (!givenName || !familyName) missing.push('a full legal name (given and family)');
  if (!user.bornOn) missing.push('a date of birth');
  if (!user.email) missing.push('an email address');
  if (!user.phone) missing.push('a phone number');
  if (missing.length) throw new MissingTravelerDetailsError(user.id, user.email, missing);

  return {
    id,
    givenName,
    familyName,
    email: user.email,
    phone: user.phone!,
    // Already a `YYYY-MM-DD` string: a birth date is a calendar date, not an
    // instant, and putting it through a Date would move it across time zones.
    bornOn: user.bornOn!,
    gender: user.gender ?? undefined,
    title: user.honorific ?? undefined,
  };
}
