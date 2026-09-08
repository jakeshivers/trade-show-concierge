import type * as s from '@/db/schema';
import type {
  HoldRequest,
  LoyaltyAccount,
  SearchRequest,
} from '@/lib/integrations/flights/types';

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
export type SearchPassenger = SearchRequest['passengers'][number];

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
 * What a ticket still needs — the one list, and the only one.
 *
 * It lives here, beside the thing that throws, so the profile screen can say it
 * *before* somebody files a travel request and meets the refusal. It used to
 * live in `profile/edit.ts` as a deliberate mirror of the inline list below,
 * and the two had already drifted: `splitName` maps a one-word `fullName` to a
 * given and family name that are the same word, so `!givenName || !familyName`
 * was false and the agent would have ticketed somebody whose name cannot match
 * their ID — the exact failure this module's header says it exists to prevent.
 * The screen was right, the agent was wrong, and one function is why that can no
 * longer be true in either direction. `profile/edit.ts` re-exports it.
 */
export function missingForTicket(user: {
  fullName: string;
  email: string;
  phone: string | null;
  bornOn: string | null;
}): string[] {
  const missing: string[] = [];
  // Counted rather than compared against `splitName`'s output: that helper's
  // one-word fallback deliberately produces two equal names so a *split* always
  // succeeds, and "John John" is a real name. What a ticket needs is two parts.
  if (user.fullName.trim().split(/\s+/).filter(Boolean).length < 2)
    missing.push('a full legal name (given and family)');
  if (!user.bornOn) missing.push('a date of birth');
  if (!user.email) missing.push('an email address');
  if (!user.phone) missing.push('a phone number');
  return missing;
}

/**
 * `id` is left to the caller: it must be the *provider's* passenger id from the
 * offer being bought, which only the provider knows.
 */
export function passengerForUser(
  user: typeof s.users.$inferSelect,
  id = '',
  loyaltyAccounts: LoyaltyAccount[] = [],
): Passenger {
  const { givenName, familyName } = splitName(user.fullName);

  const missing = missingForTicket(user);
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
    // Omitted rather than sent empty: an empty array is a statement to the
    // carrier that this passenger has no accounts, and the shapes the other
    // optional fields use here are all "absent means we are not saying".
    loyaltyAccounts: loyaltyAccounts.length ? loyaltyAccounts : undefined,
  };
}

/**
 * The same traveler, as a *search* needs them.
 *
 * A search is not a purchase, so this deliberately refuses nothing: an offer can
 * be priced for somebody whose date of birth is not on file, and the whole point
 * of `missingForTicket` telling them early is that the pipeline still runs while
 * they go and fill it in. What it must not do is split the name differently from
 * the purchase path — for eleven steps `agent.ts` did its own `split(' ')` here,
 * which sends one legal name to the carrier when quoting and a different one when
 * buying.
 *
 * Loyalty accounts are on the search because a member account can surface a fare
 * that is not otherwise offered, and the policy engine should rule against the
 * fare this traveler can actually be sold.
 */
export function searchPassengerForUser(
  user: Pick<typeof s.users.$inferSelect, 'fullName'>,
  loyaltyAccounts: LoyaltyAccount[] = [],
): SearchPassenger {
  const { givenName, familyName } = splitName(user.fullName);
  return {
    givenName: givenName || 'Unknown',
    familyName: familyName || givenName || 'Traveler',
    loyaltyAccounts: loyaltyAccounts.length ? loyaltyAccounts : undefined,
  };
}
