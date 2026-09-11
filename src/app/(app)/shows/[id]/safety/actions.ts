'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import type { SafetyStanding } from '@/lib/safety/rollcall';
import { closeRollCall, recordSafetyResponse, startRollCall } from '@/lib/safety/store';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

/**
 * The roll call's writes.
 *
 * `answer` is the one worth reading, and it is deliberately **one action for two
 * acts**. Answering for yourself and relaying what a colleague told you on the
 * phone go through the same function, and the difference is `recordedById` — a
 * fact about the answer rather than a branch in the permission. Two entry points
 * would invite one of them to forget the column, and the column is the whole of
 * §5e's inversion.
 */

const asFormError = formErrorFrom([ForbiddenError, NotFoundError]);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/safety`);
  revalidatePath('/safety');
}

export async function beginRollCall(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await startRollCall(actor, showId, optional(form, 'note'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Roll call started. Work down the list — nobody counts as safe until somebody records that they have heard from them.',
  };
}

export async function endRollCall(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await closeRollCall(actor, str(form, 'checkId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Closed. Anyone who never answered stays unanswered in the record — closing does not mark anybody safe.',
  };
}

export async function answer(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const userId = str(form, 'userId');
  try {
    await recordSafetyResponse(
      actor,
      str(form, 'checkId'),
      userId,
      str(form, 'standing') as SafetyStanding,
      optional(form, 'note'),
    );
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok:
      actor.userId === userId
        ? 'Recorded.'
        : 'Recorded — noted as something you passed on, rather than as them answering.',
  };
}
