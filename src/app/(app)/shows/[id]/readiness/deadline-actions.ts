'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { DeadlineError } from '@/lib/deadlines/edit';
import {
  addDeadline,
  deleteDeadline,
  editDeadline,
  setDeadlineConfirmed,
  setDeadlineStatus,
} from '@/lib/deadlines/store';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { type FormState, formErrorFrom, optional } from '../../../_components/form';

/**
 * The register's writes. Same posture as `actions.ts` beside it: the actor is
 * re-resolved server-side on every call, and `deadlines/access.ts` is the
 * control — the buttons a screen declines to render are a courtesy.
 */

const EXPECTED = [DeadlineError, ForbiddenError, NotFoundError, ZonedTimeError];

const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/readiness`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/readiness');
}

function draftFrom(form: FormData) {
  return {
    title: String(form.get('title') ?? ''),
    kind: String(form.get('kind') ?? 'other'),
    dueDate: String(form.get('dueDate') ?? ''),
    dueTime: String(form.get('dueTime') ?? ''),
    penaltyEstimate: optional(form, 'penaltyEstimate'),
    penaltyNote: optional(form, 'penaltyNote'),
    ownerId: optional(form, 'ownerId'),
    sourceUrl: optional(form, 'sourceUrl'),
  };
}

export async function createDeadline(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await addDeadline(actor, showId, draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Deadline added — unconfirmed until somebody checks it against the manual.' };
}

export async function updateDeadline(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await editDeadline(actor, String(form.get('deadlineId') ?? ''), draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Deadline updated.' };
}

export async function changeDeadlineStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await setDeadlineStatus(
      actor,
      String(form.get('deadlineId') ?? ''),
      String(form.get('status') ?? ''),
      optional(form, 'note'),
    );
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {};
}

export async function confirmDeadline(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  const confirmed = form.get('confirmed') === 'true';
  try {
    await setDeadlineConfirmed(actor, String(form.get('deadlineId') ?? ''), confirmed);
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {
    ok: confirmed
      ? 'Confirmed. Its penalty is now quoted as an established figure.'
      : 'Confirmation withdrawn. It will be chased as a date again, not as an amount.',
  };
}

export async function removeDeadline(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await deleteDeadline(actor, String(form.get('deadlineId') ?? ''));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Deadline deleted.' };
}
