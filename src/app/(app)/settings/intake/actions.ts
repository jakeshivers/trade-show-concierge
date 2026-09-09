'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { LeadError } from '@/lib/leads/edit';
import { createIntakeKey, revokeIntakeKey } from '@/lib/leads/store';
import { type FormState, formErrorFrom, optional, str } from '../../_components/form';

const asFormError = formErrorFrom([LeadError, ForbiddenError, NotFoundError]);

/**
 * Issuing and revoking intake keys.
 *
 * `issue` returns the plaintext token in its `ok` message, which is the only
 * time it will ever exist outside the caller's own configuration — only the hash
 * is stored, so there is no "show me that key again". The message says so
 * rather than leaving somebody to discover it.
 */
export async function issue(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    const { token } = await createIntakeKey(actor, {
      label: str(form, 'label'),
      showId: optional(form, 'showId'),
    });
    revalidatePath('/settings/intake');
    return {
      ok: `${token} — copy this now. Only its hash is stored, so it cannot be shown again. Issue a new key rather than trying to recover this one.`,
    };
  } catch (err) {
    return asFormError(err, form);
  }
}

export async function revoke(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await revokeIntakeKey(actor, str(form, 'keyId'));
  } catch (err) {
    return asFormError(err, form);
  }
  revalidatePath('/settings/intake');
  return { ok: 'Revoked. The row stays, so the leads this key wrote are still traceable to it.' };
}
