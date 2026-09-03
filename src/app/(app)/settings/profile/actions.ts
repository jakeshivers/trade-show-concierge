'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ProfileError } from '@/lib/profile/edit';
import { updateMyProfile } from '@/lib/profile/store';
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
