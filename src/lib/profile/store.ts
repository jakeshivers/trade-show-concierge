import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { validateLoyaltyAccount, validateProfile, type ProfileEdit } from './edit';

type Db = ReturnType<typeof getDb>;

/**
 * The only place in this product that writes a person's own traveler details.
 *
 * **It writes the actor's own row and nothing else**, and that is a rule rather
 * than a simplification. Everywhere this codebase has faced "may somebody fill
 * this in on your behalf" it has answered the same way and for the same reason:
 * `show_attendees.responded_at` exists because a `confirmed` typed by whoever
 * built the roster is hearsay inside a staffing number, and
 * `notification_channels` are resolved from the subject's own email because an
 * admin who could point somebody's alerts at an address of their choosing has
 * reopened the door `alerts/access.ts` closed.
 *
 * A date of birth is the sharpest case of all. `passengers.ts` refuses a
 * placeholder precisely because a plausible one buys a real ticket that fails at
 * the gate — and the person best placed to type a wrong date of birth confidently
 * is somebody who is not the traveler. So there is no admin write here, and an
 * `actor` parameter with no permission check beside it is deliberate: the scope
 * *is* the permission, expressed as the row it can reach.
 */
export async function getMyProfile(actor: Actor, db: Db = getDb()) {
  const user = await db.query.users.findFirst({ where: eq(s.users.id, actor.userId) });
  if (!user) throw new NotFoundError();
  return user;
}

export async function updateMyProfile(
  actor: Actor,
  input: Parameters<typeof validateProfile>[0],
  db: Db = getDb(),
): Promise<ProfileEdit> {
  const clean = validateProfile(input);
  await db
    .update(s.users)
    .set({
      fullName: clean.fullName,
      phone: clean.phone,
      bornOn: clean.bornOn,
      honorific: clean.honorific,
      gender: clean.gender,
      knownTravelerNumber: clean.knownTravelerNumber,
      seatPreference: clean.seatPreference,
      homeAirport: clean.homeAirport,
      preferredAirlines: clean.preferredAirlines,
    })
    .where(eq(s.users.id, actor.userId));
  return clean;
}

/* ---------------------------- loyalty accounts ---------------------------- */

/** Your own numbers, for the screen that edits them. Ordered so a list is stable. */
export async function getMyLoyaltyAccounts(actor: Actor, db: Db = getDb()) {
  return db
    .select()
    .from(s.userLoyaltyAccounts)
    .where(eq(s.userLoyaltyAccounts.userId, actor.userId))
    .orderBy(asc(s.userLoyaltyAccounts.airlineCode));
}

/**
 * Add a number, or replace the one already held for that carrier.
 *
 * An upsert rather than a refusal, deliberately: the unique index exists so
 * nothing downstream has to choose between two numbers for one airline, and the
 * person retyping a Delta number is correcting it, not filing a second account.
 * A conflict error here would make the fix "delete, then add", which is two acts
 * for one intention — and the intermediate state is a traveler with no number at
 * all on the carrier they fly most.
 */
export async function addMyLoyaltyAccount(
  actor: Actor,
  input: { airlineCode: string; accountNumber: string },
  db: Db = getDb(),
) {
  const clean = validateLoyaltyAccount(input);
  await db
    .insert(s.userLoyaltyAccounts)
    .values({ userId: actor.userId, ...clean })
    .onConflictDoUpdate({
      target: [s.userLoyaltyAccounts.userId, s.userLoyaltyAccounts.airlineCode],
      set: { accountNumber: clean.accountNumber },
    });
  return clean;
}

/**
 * Remove one. Scoped by `userId` in the `where` rather than checked after
 * loading — `shows/store.ts`'s posture, and the reason is the same: a delete that
 * loads first and compares is a delete that runs whenever somebody forgets the
 * comparison.
 */
export async function removeMyLoyaltyAccount(actor: Actor, id: string, db: Db = getDb()) {
  await db
    .delete(s.userLoyaltyAccounts)
    .where(
      and(eq(s.userLoyaltyAccounts.id, id), eq(s.userLoyaltyAccounts.userId, actor.userId)),
    );
}

/**
 * The numbers to send a carrier for one traveler, read on a ticketing path
 * rather than for a screen.
 *
 * Deliberately takes a **user id and no `Actor`**. Every other function in this
 * file is scoped to the actor's own row because these are the subject's own
 * facts; this one is called by the booking agent, which is already acting on a
 * `travel_requests` row whose traveler was resolved through `travelersFor` — so
 * the narrowing happened before this was reached, and adding an actor parameter
 * here would imply a second, weaker check exists. It returns what goes on a
 * ticket, not something a person is shown.
 */
export async function preferredAirlinesForTraveler(
  userId: string,
  db: Db = getDb(),
): Promise<string[]> {
  const row = await db.query.users.findFirst({ where: eq(s.users.id, userId) });
  return row?.preferredAirlines ?? [];
}

export async function loyaltyAccountsForTraveler(userId: string, db: Db = getDb()) {
  const rows = await db
    .select({
      airlineCode: s.userLoyaltyAccounts.airlineCode,
      accountNumber: s.userLoyaltyAccounts.accountNumber,
    })
    .from(s.userLoyaltyAccounts)
    .where(eq(s.userLoyaltyAccounts.userId, userId))
    .orderBy(asc(s.userLoyaltyAccounts.airlineCode));
  return rows;
}
