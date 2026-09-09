'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { IntakeError } from '@/lib/shows/intake';
import { CloneError } from '@/lib/shows/clone';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { cloneShow, createProspect, decideShow, NotFoundError } from '@/lib/shows/store';
import { type FormState, formErrorFrom, optional } from '../_components/form';

/**
 * Every action re-resolves the actor server-side and lets the store enforce the
 * rules. The forms hide what a role may not do; that is a courtesy, not a
 * control — the same posture as `/settings/security`.
 */

const EXPECTED = [IntakeError, CloneError, ForbiddenError, NotFoundError, ZonedTimeError];

const asFormError = formErrorFrom(EXPECTED);

export async function proposeShow(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();

  const budget = optional(form, 'budget');
  let id: string;
  try {
    const created = await createProspect(actor, {
      name: String(form.get('name') ?? ''),
      startsOn: String(form.get('startsOn') ?? ''),
      endsOn: String(form.get('endsOn') ?? ''),
      city: optional(form, 'city'),
      region: optional(form, 'region'),
      country: optional(form, 'country'),
      venueName: optional(form, 'venueName'),
      website: optional(form, 'website'),
      airportCode: optional(form, 'airportCode'),
      timezone: String(form.get('timezone') ?? 'UTC'),
      // Entered in whole dollars; stored in integer cents, like every other
      // money column. SCOPE.md non-negotiable — never a float.
      budgetCents: budget === null ? null : Math.round(Number(budget) * 100),
      goals: optional(form, 'goals'),
      rationale: String(form.get('rationale') ?? ''),
    });
    id = created.id;
  } catch (err) {
    return asFormError(err, form);
  }

  revalidatePath('/shows');
  redirect(`/shows/${id}`);
}

export async function decide(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  const decision = form.get('decision') === 'declined' ? 'declined' : 'committed';

  try {
    await decideShow(actor, showId, decision, String(form.get('rationale') ?? ''));
  } catch (err) {
    return asFormError(err, form);
  }

  revalidatePath('/shows');
  revalidatePath(`/shows/${showId}`);
  return {};
}

export async function clone(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const sourceId = String(form.get('sourceId') ?? '');

  let id: string;
  try {
    const result = await cloneShow(actor, sourceId, {
      name: String(form.get('name') ?? ''),
      startsOn: String(form.get('startsOn') ?? ''),
      include: {
        tasks: form.get('include:tasks') === 'on',
        deadlines: form.get('include:deadlines') === 'on',
        team: form.get('include:team') === 'on',
        assets: form.get('include:assets') === 'on',
      },
    });
    id = result.id;
  } catch (err) {
    return asFormError(err, form);
  }

  revalidatePath('/shows');
  redirect(`/shows/${id}`);
}
