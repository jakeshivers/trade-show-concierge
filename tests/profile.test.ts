import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, type Actor } from '@/lib/auth/actor';
import {
  ProfileError,
  missingForTicket,
  validateLoyaltyAccount,
  validateProfile,
} from '@/lib/profile/edit';
import {
  addMyLoyaltyAccount,
  getMyLoyaltyAccounts,
  getMyProfile,
  loyaltyAccountsForTraveler,
  removeMyLoyaltyAccount,
  updateMyProfile,
} from '@/lib/profile/store';
import {
  passengerForUser,
  searchPassengerForUser,
  MissingTravelerDetailsError,
} from '@/lib/travel/passengers';

/**
 * The screen that closes the hole under the booking spine.
 *
 * The load-bearing claim is not that a form saves — it is that **the fields this
 * screen writes are exactly the fields `passengers.ts` refuses to buy a ticket
 * without**, and that the two cannot drift apart. That is asserted here by
 * driving the real `passengerForUser` against a row this module wrote, rather
 * than by comparing two lists of strings.
 */

const MEMBER = 'priya@northwindrobotics.test';

let actor: Actor;
let original: typeof s.users.$inferSelect;
let originalLoyalty: (typeof s.userLoyaltyAccounts.$inferSelect)[];

beforeAll(async () => {
  // A Member, deliberately: these are the subject's own facts and the screen is
  // not admin-only. If this only worked for an admin the feature would be wrong.
  process.env.DEV_ACTOR_EMAIL = MEMBER;
  actor = await getActor();
  original = await getMyProfile(actor);
  originalLoyalty = await getMyLoyaltyAccounts(actor);
});

afterAll(async () => {
  // Put the seeded row back: other suites read this user.
  await getDb()
    .update(s.users)
    .set({
      fullName: original.fullName,
      phone: original.phone,
      bornOn: original.bornOn,
      honorific: original.honorific,
      gender: original.gender,
      knownTravelerNumber: original.knownTravelerNumber,
      seatPreference: original.seatPreference,
      homeAirport: original.homeAirport,
    })
    .where(eq(s.users.id, original.id));

  // Same reason: the seed gives this Member a UA account and other suites read
  // the seeded workspace as it was built.
  await getDb()
    .delete(s.userLoyaltyAccounts)
    .where(eq(s.userLoyaltyAccounts.userId, original.id));
  if (originalLoyalty.length) {
    await getDb().insert(s.userLoyaltyAccounts).values(originalLoyalty);
  }
});

describe('validating your own details', () => {
  const base = {
    fullName: 'Ada Lovelace',
    phone: '+1 415 555 0101',
    bornOn: '1990-04-02',
    honorific: null,
    gender: null,
    knownTravelerNumber: null,
    seatPreference: null,
    homeAirport: null,
  };

  it('keeps a phone number exactly as typed, punctuation and country code included', () => {
    // Not reformatted: this number is dialled from abroad during a roll call,
    // and a normalisation that drops the + is a number that does not connect.
    expect(validateProfile(base).phone).toBe('+1 415 555 0101');
  });

  it('refuses a date of birth that would make somebody 400', () => {
    // The common error is a mistyped year, and it is the one a carrier accepts.
    expect(() => validateProfile({ ...base, bornOn: '1626-04-02' })).toThrow(ProfileError);
  });

  it('refuses a date of birth in the future', () => {
    expect(() => validateProfile({ ...base, bornOn: '2099-01-01' })).toThrow(ProfileError);
  });

  it('refuses a phone number too short to dial', () => {
    expect(() => validateProfile({ ...base, phone: '555' })).toThrow(ProfileError);
  });

  it('treats blank as clearing a field rather than as leaving it alone', () => {
    // A person removing a wrong date of birth has to be able to.
    expect(validateProfile({ ...base, bornOn: '  ' }).bornOn).toBeNull();
  });

  it('refuses a gender code a carrier would not accept', () => {
    expect(() => validateProfile({ ...base, gender: 'yes' })).toThrow(ProfileError);
  });
});

describe('what a ticket still needs', () => {
  it('names the same gaps passengerForUser refuses on', () => {
    const bare = {
      fullName: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: null,
      bornOn: null,
    };
    expect(missingForTicket(bare)).toEqual(['a date of birth', 'a phone number']);
  });

  it('says nothing is missing once both are present', () => {
    expect(
      missingForTicket({
        fullName: 'Ada Lovelace',
        email: 'ada@example.test',
        phone: '+14155550101',
        bornOn: '1990-04-02',
      }),
    ).toEqual([]);
  });
});

describe('against the real row', () => {
  it('writes the fields, and the agent can then build a passenger from them', async () => {
    await updateMyProfile(actor, {
      fullName: 'Ada Lovelace',
      phone: '+1 415 555 0199',
      bornOn: '1990-04-02',
      honorific: 'dr',
      gender: 'f',
      knownTravelerNumber: 'KTN123456',
      seatPreference: 'aisle',
      homeAirport: 'sfo',
    });

    const me = await getMyProfile(actor);
    expect(me.phone).toBe('+1 415 555 0199');
    expect(me.bornOn).toBe('1990-04-02');
    expect(me.knownTravelerNumber).toBe('KTN123456');
    // Uppercased on the way in: it is compared against provider codes, and a
    // lowercase default that silently fails to match is worse than none.
    expect(me.homeAirport).toBe('SFO');

    // The whole point of the screen: what it saved is enough to buy a ticket.
    const passenger = passengerForUser(me, 'pas_1');
    expect(passenger.bornOn).toBe('1990-04-02');
    expect(passenger.phone).toBe('+1 415 555 0199');
    expect(passenger.familyName).toBe('Lovelace');
  });

  it('clearing the date of birth is what the agent then refuses on', async () => {
    await updateMyProfile(actor, {
      fullName: 'Ada Lovelace',
      phone: '+1 415 555 0199',
      bornOn: null,
      honorific: null,
      gender: null,
      homeAirport: null,
      knownTravelerNumber: null,
      seatPreference: null,
    });
    const me = await getMyProfile(actor);
    // Before this module existed there was no way to reach this state from a
    // screen — and no way to leave it either, which was the actual bug.
    expect(() => passengerForUser(me, 'pas_1')).toThrow(MissingTravelerDetailsError);
    expect(missingForTicket(me)).toEqual(['a date of birth']);
  });
});

/**
 * The home airport, and the loyalty accounts.
 *
 * Two features with the same shape as everything else on this screen: a column
 * a rule already wanted and nothing could write. `SearchRequest.passengers`
 * has carried `loyaltyAccounts` since step 5 and the Duffel adapter has mapped
 * it since step 5 — nothing ever filled it, so every ticket this product bought
 * was issued with no mileage credit and no screen said so.
 */
describe('home airport', () => {
  const base = {
    fullName: 'Ada Lovelace',
    phone: '+1 415 555 0199',
    bornOn: '1990-04-02',
    honorific: null,
    gender: null,
    knownTravelerNumber: null,
    seatPreference: null,
  };

  it('refuses an ICAO code, which is the mistake somebody who knows aviation makes', () => {
    expect(() => validateProfile({ ...base, homeAirport: 'KORD' })).toThrow(ProfileError);
    expect(() => validateProfile({ ...base, homeAirport: 'Chicago' })).toThrow(ProfileError);
  });

  it('is a shape check and never a lookup, so an unlikely code is still accepted', () => {
    // There is no airport table here — `assistant/draft.ts` refuses to guess a
    // time zone for the same reason. Shipping a list to validate against is
    // shipping a list that goes stale, and the refusal a stale list produces is
    // "that airport does not exist" about one that does.
    expect(validateProfile({ ...base, homeAirport: 'zzz' }).homeAirport).toBe('ZZZ');
  });

  it('blank clears it, like every other optional field here', () => {
    expect(validateProfile({ ...base, homeAirport: '  ' }).homeAirport).toBeNull();
  });
});

describe('loyalty accounts', () => {
  it('takes a two-character IATA designator, digits included', () => {
    expect(validateLoyaltyAccount({ airlineCode: 'b6', accountNumber: '99123' })).toEqual({
      airlineCode: 'B6',
      accountNumber: '99123',
    });
    expect(validateLoyaltyAccount({ airlineCode: '9w', accountNumber: 'X1' }).airlineCode).toBe(
      '9W',
    );
    expect(() => validateLoyaltyAccount({ airlineCode: 'DAL', accountNumber: '1' })).toThrow(
      ProfileError,
    );
  });

  it('never reformats the number', () => {
    // Carriers disagree about length, case and separators. The phone rule and
    // `shipping/carrier.ts` both say the same thing: a helpful normalisation is
    // how a correct value becomes a wrong one.
    const a = validateLoyaltyAccount({ airlineCode: 'DL', accountNumber: '  12 34-AB  ' });
    expect(a.accountNumber).toBe('12 34-AB');
  });

  it('re-adding a carrier corrects the number rather than filing a second one', async () => {
    await addMyLoyaltyAccount(actor, { airlineCode: 'DL', accountNumber: 'WRONG1' });
    await addMyLoyaltyAccount(actor, { airlineCode: 'dl', accountNumber: 'RIGHT2' });
    const mine = await getMyLoyaltyAccounts(actor);
    const delta = mine.filter((a) => a.airlineCode === 'DL');
    // One row, because nothing downstream may be asked to choose between two
    // numbers for one carrier — the unique index is what makes that true.
    expect(delta).toHaveLength(1);
    expect(delta[0].accountNumber).toBe('RIGHT2');
  });

  it('reaches the carrier on the ticket, not just on the search', async () => {
    await addMyLoyaltyAccount(actor, { airlineCode: 'UA', accountNumber: 'UA777' });
    const me = await getMyProfile(actor);
    const loyalty = await loyaltyAccountsForTraveler(actor.userId);

    // The half that was missing: `HoldRequest` is what buys the ticket, and it
    // is where the miles actually credit. A search-only wiring is a feature the
    // traveler can see saved and never earns from.
    const passenger = passengerForUser(
      { ...me, bornOn: '1990-04-02', phone: '+14155550199' },
      'pas_1',
      loyalty,
    );
    expect(passenger.loyaltyAccounts).toContainEqual({
      airlineCode: 'UA',
      accountNumber: 'UA777',
    });

    const search = searchPassengerForUser(me, loyalty);
    expect(search.loyaltyAccounts).toEqual(passenger.loyaltyAccounts);
    // And the same name split on both, which `agent.ts` did not do for eleven
    // steps: it re-implemented `splitName` inline for the search only.
    expect(search.familyName).toBe(passenger.familyName);
  });

  it('sends nothing rather than an empty list when there are none', async () => {
    const mine = await getMyLoyaltyAccounts(actor);
    for (const row of mine) await removeMyLoyaltyAccount(actor, row.id);
    const me = await getMyProfile(actor);
    const loyalty = await loyaltyAccountsForTraveler(actor.userId);
    expect(loyalty).toEqual([]);
    // Absent means "we are not saying", which is what every other optional
    // field on a passenger means. An empty array is a claim about the traveler.
    expect(searchPassengerForUser(me, loyalty).loyaltyAccounts).toBeUndefined();
  });

  it('will not delete somebody else’s row even given its id', async () => {
    const db = getDb();
    const other = await db.query.users.findFirst({
      where: eq(s.users.email, 'marcus@northwindrobotics.test'),
    });
    const [theirs] = await db
      .insert(s.userLoyaltyAccounts)
      .values({ userId: other!.id, airlineCode: 'AS', accountNumber: 'AS1' })
      .returning();

    await removeMyLoyaltyAccount(actor, theirs.id);

    const still = await db.query.userLoyaltyAccounts.findFirst({
      where: eq(s.userLoyaltyAccounts.id, theirs.id),
    });
    // Scoped in the `where`, never loaded-then-compared: a delete that checks
    // afterwards is a delete that runs whenever somebody forgets the check.
    expect(still).toBeTruthy();
    await db.delete(s.userLoyaltyAccounts).where(eq(s.userLoyaltyAccounts.id, theirs.id));
  });
});
