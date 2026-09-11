'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { MoneyParseError } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import { addLodging, assignRoom, deleteLodging, editLodging, unassignRoom } from '@/lib/lodging/store';
import { editDerivedDeadline } from '@/lib/deadlines/store';
import { DeadlineError } from '@/lib/deadlines/edit';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

/**
 * Lodging's writes.
 *
 * Note what is *not* here: nothing that sets a room block cutoff's alert
 * schedule, owner-by-date, or warning threshold. The cutoff derives a row in the
 * deadline register (`lodging/store.ts`), so all of that already exists and is
 * one implementation rather than two. `setCutoffOwner` below is the one thing the
 * register legitimately holds for a derived row.
 */

const EXPECTED = [
  TeamError,
  DeadlineError,
  ForbiddenError,
  NotFoundError,
  ZonedTimeError,
  MoneyParseError,
];

const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/lodging`);
  revalidatePath(`/shows/${showId}/readiness`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/itinerary');
  revalidatePath('/readiness');
}

function draftFrom(form: FormData) {
  return {
    hotelName: str(form, 'hotelName'),
    address: optional(form, 'address'),
    phone: optional(form, 'phone'),
    confirmationCode: optional(form, 'confirmationCode'),
    checkInOn: optional(form, 'checkInOn'),
    checkInAt: optional(form, 'checkInAt'),
    checkOutOn: optional(form, 'checkOutOn'),
    checkOutAt: optional(form, 'checkOutAt'),
    nightlyRate: optional(form, 'nightlyRate'),
    roomBlockCutoffOn: optional(form, 'roomBlockCutoffOn'),
    roomBlockCutoffAt: optional(form, 'roomBlockCutoffAt'),
    costCenterId: str(form, 'costCenterId'),
    notes: optional(form, 'notes'),
  };
}

export async function createLodging(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const hadCutoff = Boolean(optional(form, 'roomBlockCutoffOn'));
  try {
    await addLodging(actor, showId, draftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: hadCutoff
      ? 'Added. The room block cutoff now has a row in the deadline register, unconfirmed — the engine will chase the date, and will not quote a figure against it until somebody checks it.'
      : 'Added. No room block cutoff, so nothing will chase one.',
  };
}

export async function updateLodging(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editLodging(actor, str(form, 'lodgingId'), draftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Updated. Moving a cutoff moves its deadline and withdraws any confirmation on it.' };
}

export async function removeLodging(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await deleteLodging(actor, str(form, 'lodgingId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Deleted here — the reservation is still with the hotel.' };
}

export async function addRoomGuest(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await assignRoom(actor, str(form, 'lodgingId'), str(form, 'userId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

export async function dropRoomGuest(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await unassignRoom(actor, str(form, 'lodgingId'), str(form, 'userId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

/** Owner and penalty on the derived deadline; its date lives on the hotel row. */
export async function setCutoffOwner(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editDerivedDeadline(actor, str(form, 'deadlineId'), {
      ownerId: optional(form, 'ownerId'),
      penaltyEstimate: optional(form, 'penaltyEstimate'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Saved.' };
}
