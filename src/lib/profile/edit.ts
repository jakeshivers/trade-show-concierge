/**
 * Your own traveler details, validated.
 *
 * ## Why this module exists at all
 *
 * `travel/passengers.ts` refuses to build a `Passenger` without a full legal
 * name, a **date of birth**, an email and a **phone number**, and it is right to:
 * a plausible placeholder is accepted by the carrier and produces a real ticket
 * that does not match the traveler's ID at the gate. That rule has been in
 * `CLAUDE.md` since step 5 and is enforced.
 *
 * What nothing enforced was that a person could *supply* those fields. Until
 * this module there was no screen, no action and no store function anywhere in
 * the app that wrote `users.phone` or `users.born_on` — the only write to the
 * `users` table outside the seed is Clerk provisioning, which knows a name and
 * an email and nothing else. So the seeded workspace books flights and a real
 * one cannot: the agent throws `MissingTravelerDetailsError` naming the fields,
 * and the person reading that error has nowhere to go. The seed hid it by
 * filling the columns in directly.
 *
 * Duty of care has the same hole from the other end. §5o counts people with no
 * phone number apart and names them, and argues that the moment to look is
 * *before* an incident because a missing number is free to fix on a quiet
 * Tuesday — which was true of everybody except the person who wanted to fix it.
 *
 * ## What is validated, and what deliberately is not
 *
 * A **date of birth is a calendar date, not an instant**, and is stored as a
 * `YYYY-MM-DD` string for the reason `passengers.ts` already gives: putting it
 * through a `Date` moves it across time zones and a birthday that slips a day
 * is a passport mismatch. It must be a real date, in the past, and inside a
 * human lifespan — the last of those catches a mistyped year, which is the
 * common error and the one a carrier will accept.
 *
 * A **phone number is checked for shape and never reformatted**. It has to be
 * dialable, so it keeps its country code and its punctuation exactly as typed:
 * this app sends it to a carrier and puts it in front of somebody running a roll
 * call, and a "helpful" normalisation that drops a `+` is a number that does not
 * connect from abroad. Anything with a plausible run of digits is accepted.
 *
 * **Nothing here is defaulted.** Blank clears a field rather than leaving the
 * old value, because a person removing a wrong date of birth must be able to,
 * and every field except the name is legitimately empty.
 */

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export type ProfileEdit = {
  fullName: string;
  phone: string | null;
  bornOn: string | null;
  honorific: string | null;
  gender: string | null;
  knownTravelerNumber: string | null;
  seatPreference: string | null;
  homeAirport: string | null;
};

/** What a carrier will accept. Deliberately not a taxonomy of our own. */
export const GENDERS = ['m', 'f', 'x', 'u'] as const;
export const GENDER_LABEL: Record<string, string> = {
  m: 'Male',
  f: 'Female',
  x: 'Unspecified (X)',
  u: 'Undisclosed (U)',
};

export const HONORIFICS = ['mr', 'ms', 'mrs', 'miss', 'dr'] as const;
export const SEAT_PREFERENCES = ['aisle', 'window', 'no_preference'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A century and a bit. Wide on purpose: this catches a slipped year, not an age. */
const MAX_AGE_YEARS = 120;
const MIN_AGE_YEARS = 12;

function isRealDate(iso: string): boolean {
  if (!DATE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function validateProfile(
  input: {
    fullName: string;
    phone: string | null;
    bornOn: string | null;
    honorific: string | null;
    gender: string | null;
    knownTravelerNumber: string | null;
    seatPreference: string | null;
    homeAirport: string | null;
  },
  now: Date = new Date(),
): ProfileEdit {
  const fullName = input.fullName.trim();
  if (fullName.length < 2) {
    throw new ProfileError('A name is needed. It is what goes on the ticket.');
  }
  // Not a hard refusal at the profile boundary — `passengers.ts` is where a
  // one-word name stops a purchase, with the error that explains why. Saying it
  // here as well would refuse to store a name somebody genuinely goes by.

  const phone = input.phone?.trim() || null;
  if (phone !== null) {
    const digits = phone.replace(/[^\d]/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new ProfileError(
        `"${phone}" does not look like a phone number that could be dialled. Keep the ` +
          'country code — this number is given to a carrier and read by somebody running a ' +
          'roll call, and one that only works from inside one country is one that fails on ' +
          'the day it is needed.',
      );
    }
  }

  const bornOn = input.bornOn?.trim() || null;
  if (bornOn !== null) {
    if (!isRealDate(bornOn)) {
      throw new ProfileError(`"${bornOn}" is not a date. A date of birth is YYYY-MM-DD.`);
    }
    const at = Date.parse(`${bornOn}T00:00:00Z`);
    const years = (now.getTime() - at) / (365.25 * 24 * 3600 * 1000);
    if (years < 0) {
      throw new ProfileError('A date of birth in the future is a typo, not a birthday.');
    }
    if (years > MAX_AGE_YEARS || years < MIN_AGE_YEARS) {
      throw new ProfileError(
        `${bornOn} would make you ${Math.floor(years)}. That is almost always a mistyped ` +
          'year — and a wrong date of birth is accepted by the carrier and rejected at the gate.',
      );
    }
  }

  const pick = (value: string | null, allowed: readonly string[], field: string) => {
    const v = value?.trim() || null;
    if (v !== null && !allowed.includes(v)) {
      throw new ProfileError(`"${v}" is not a ${field} this app records.`);
    }
    return v;
  };

  return {
    fullName,
    phone,
    bornOn,
    honorific: pick(input.honorific, HONORIFICS, 'title'),
    gender: pick(input.gender, GENDERS, 'gender'),
    knownTravelerNumber: input.knownTravelerNumber?.trim() || null,
    seatPreference: pick(input.seatPreference, SEAT_PREFERENCES, 'seat preference'),
    homeAirport: airportCode(input.homeAirport),
  };
}

/* ------------------------------ home airport ------------------------------ */

const IATA_AIRPORT = /^[A-Za-z]{3}$/;

/**
 * The airport a person leaves from unless they say otherwise.
 *
 * Shape only. There is no airport table in this app — `assistant/draft.ts` says
 * so where it refuses to guess a time zone — so "is ORD a real airport" is a
 * question nothing here can answer, and pretending to would mean shipping a list
 * that goes stale. What *is* checkable is that three letters is the only thing a
 * flight search accepts, and a four-letter ICAO code (`KORD`) is the mistake
 * somebody who knows aviation actually makes.
 *
 * Uppercased on the way in, because it is compared against provider codes and a
 * lowercase default that silently fails to match is worse than no default.
 */
function airportCode(value: string | null): string | null {
  const v = value?.trim() || null;
  if (v === null) return null;
  if (!IATA_AIRPORT.test(v)) {
    throw new ProfileError(
      `"${v}" is not an airport code. Use the three-letter IATA code an airline would ` +
        'print on a boarding pass — ORD, not KORD and not "Chicago".',
    );
  }
  return v.toUpperCase();
}

/* ---------------------------- loyalty accounts ---------------------------- */

/** IATA airline designators are two characters and may carry a digit: `B6`, `9W`. */
const IATA_AIRLINE = /^[A-Za-z0-9]{2}$/;

export type LoyaltyAccountEdit = { airlineCode: string; accountNumber: string };

/**
 * A frequent-flyer number, validated as far as anything here honestly can.
 *
 * The airline code is checked for shape and uppercased — it has to match the
 * carrier on an offer or the number rides along attached to nothing. The
 * **account number is never reformatted**: carriers use digits, letters, and
 * lengths that disagree with each other, and this app's whole posture on
 * provider identifiers (`profile/edit.ts` on phone numbers, `shipping/carrier.ts`
 * on tracking numbers) is that a helpful normalisation is how a correct value
 * becomes a wrong one. Spaces are stripped only at the ends.
 *
 * Nothing here can tell a valid number from a typo, and that is the important
 * sentence: the carrier accepts both without comment, so the screen says the
 * app cannot confirm it rather than implying a saved number is a working one.
 */
export function validateLoyaltyAccount(input: {
  airlineCode: string;
  accountNumber: string;
}): LoyaltyAccountEdit {
  const airlineCode = input.airlineCode.trim();
  if (!IATA_AIRLINE.test(airlineCode)) {
    throw new ProfileError(
      `"${airlineCode}" is not an airline code. Use the two-character IATA designator — ` +
        'DL, AA, B6. It is what appears before the flight number on a boarding pass.',
    );
  }
  const accountNumber = input.accountNumber.trim();
  if (!accountNumber) {
    throw new ProfileError('A loyalty account needs a number. Blank removes it instead.');
  }
  if (accountNumber.length > 32) {
    throw new ProfileError(
      'That is longer than any frequent-flyer number a carrier issues. Check for a pasted ' +
        'label or a whole URL.',
    );
  }
  return { airlineCode: airlineCode.toUpperCase(), accountNumber };
}

/**
 * What a ticket still needs, in the words `passengers.ts` would use.
 *
 * Computed here so the profile screen can say it *before* somebody files a
 * travel request and meets the refusal, rather than only after. It deliberately
 * mirrors `passengerForUser`'s list rather than inventing a second one — two
 * opinions about what a ticket needs is how the screen comes to say you are
 * ready while the agent says you are not.
 */
export function missingForTicket(user: {
  fullName: string;
  email: string;
  phone: string | null;
  bornOn: string | null;
}): string[] {
  const missing: string[] = [];
  const parts = user.fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) missing.push('a full legal name (given and family)');
  if (!user.bornOn) missing.push('a date of birth');
  if (!user.email) missing.push('an email address');
  if (!user.phone) missing.push('a phone number');
  return missing;
}
