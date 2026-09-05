'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ProfileError } from '@/lib/profile/edit';
import {
  addMyLoyaltyAccount,
  removeMyLoyaltyAccount,
  updateMyProfile,
} from '@/lib/profile/store';
import { type FormState, formErrorFrom, optional, str } from '../../_components/form';

const asFormError = formErrorFrom([ProfileError, ForbiddenError, NotFoundError]);

export async function saveProfile(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await updateMyProfile(actor, {
      fullName: str(form, 'fullName'),
      phone: optional(form, 'phone'),
      bornOn: optional(form, 'bornOn'),
      honorific: optional(form, 'honorific'),
      gender: optional(form, 'gender'),
      knownTravelerNumber: optional(form, 'knownTravelerNumber'),
      seatPreference: optional(form, 'seatPreference'),
      homeAirport: optional(form, 'homeAirport'),
      preferredAirlines: optional(form, 'preferredAirlines'),
    });
  } catch (err) {
    return asFormError(err);
  }
  // The name and phone show up in three other places: the roll call reads the
  // phone, the show's team tab reads the name, and the flight board reads both.
  revalidatePath('/settings/profile');
  revalidatePath('/safety');
  revalidatePath('/travel/new');
  revalidatePath('/', 'layout');
  return { ok: 'Saved.' };
}

export async function saveLoyaltyAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await addMyLoyaltyAccount(actor, {
      airlineCode: str(form, 'airlineCode'),
      accountNumber: str(form, 'accountNumber'),
    });
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/settings/profile');
  return {
    ok: 'Saved. It will be sent to that carrier from your next search onward — this app ' +
      'cannot confirm the airline accepted it, so check your statement after the trip.',
  };
}

export async function deleteLoyaltyAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await removeMyLoyaltyAccount(actor, str(form, 'id'));
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/settings/profile');
  // Deliberately says what it does not do. A ticket already issued carries the
  // number the carrier was given at the time; removing the row here changes what
  // the *next* booking sends and nothing that has already been bought.
  return { ok: 'Removed. Tickets already issued keep the number they were bought with.' };
}
