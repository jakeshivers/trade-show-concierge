'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { ChecklistError } from '@/lib/readiness/edit';
import {
  addTask,
  applyTemplate,
  deleteTask,
  editTask,
  setTaskStatus,
} from '@/lib/readiness/store';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { type FormState, formErrorFrom, optional } from '../../../_components/form';

/**
 * Same posture as `shows/actions.ts`: the actor is re-resolved server-side on
 * every call and the store enforces the rules. The buttons a screen chooses not
 * to render are a courtesy — `access.ts` is the control, and it runs here.
 */

const EXPECTED = [ChecklistError, ForbiddenError, NotFoundError, ZonedTimeError];

const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/readiness`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/shows');
  revalidatePath('/readiness');
}

function draftFrom(form: FormData) {
  return {
    title: String(form.get('title') ?? ''),
    description: optional(form, 'description'),
    category: String(form.get('category') ?? 'booth'),
    weight: Number(form.get('weight') ?? 1),
    dueOn: optional(form, 'dueOn'),
    assigneeId: optional(form, 'assigneeId'),
  };
}

export async function createTask(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await addTask(actor, showId, draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Task added.' };
}

export async function updateTask(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await editTask(actor, String(form.get('taskId') ?? ''), draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Task updated.' };
}

export async function changeStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await setTaskStatus(
      actor,
      String(form.get('taskId') ?? ''),
      String(form.get('status') ?? ''),
      optional(form, 'note'),
    );
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {};
}

export async function removeTask(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  try {
    await deleteTask(actor, String(form.get('taskId') ?? ''));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Task deleted.' };
}

export async function seedFromTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  let added = 0;
  try {
    const plan = await applyTemplate(actor, showId, String(form.get('templateKey') ?? ''));
    added = plan.create.length;
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {
    ok:
      added === 0
        ? 'Nothing added — every task in that template was already on this show.'
        : `Added ${added} ${added === 1 ? 'task' : 'tasks'}. Nothing was assigned.`,
  };
}
