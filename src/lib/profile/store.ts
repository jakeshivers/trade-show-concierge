import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { validateProfile, type ProfileEdit } from './edit';

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
    })
    .where(eq(s.users.id, actor.userId));
  return clean;
}
