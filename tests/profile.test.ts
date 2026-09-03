import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, type Actor } from '@/lib/auth/actor';
import { ProfileError, missingForTicket, validateProfile } from '@/lib/profile/edit';
import { getMyProfile, updateMyProfile } from '@/lib/profile/store';
import { passengerForUser, MissingTravelerDetailsError } from '@/lib/travel/passengers';

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

beforeAll(async () => {
  // A Member, deliberately: these are the subject's own facts and the screen is
  // not admin-only. If this only worked for an admin the feature would be wrong.
  process.env.DEV_ACTOR_EMAIL = MEMBER;
  actor = await getActor();
  original = await getMyProfile(actor);
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
    })
    .where(eq(s.users.id, original.id));
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
    });

    const me = await getMyProfile(actor);
    expect(me.phone).toBe('+1 415 555 0199');
    expect(me.bornOn).toBe('1990-04-02');
    expect(me.knownTravelerNumber).toBe('KTN123456');

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
