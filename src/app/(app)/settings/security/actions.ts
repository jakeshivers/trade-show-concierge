'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { STRATEGY_KINDS } from '@/lib/auth/login-methods';
import { setLoginPolicy, UnusablePolicyError } from '@/lib/auth/login-policy-store';
import { type FormState } from '../../_components/form';

/**
 * Record a new login policy version.
 *
 * The action re-resolves the actor server-side rather than trusting anything the
 * form sent: the page hid the form from non-admins, and that is a courtesy, not
 * a control.
 */
export async function updateLoginPolicy(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await getActor();
  const reason = String(formData.get('reason') ?? '');
  const mode = String(formData.get('mode') ?? 'unrestricted');

  const allowedStrategies = STRATEGY_KINDS.filter((k) => formData.get(`strategy:${k}`) === 'on');

  try {
    const saved = await setLoginPolicy(
      actor,
      mode === 'allowlist' ? { mode: 'allowlist', allowedStrategies } : { mode: 'unrestricted' },
      reason,
    );
    revalidatePath('/settings/security');
    return { ok: `Saved as version ${saved.version}.` };
  } catch (err) {
    if (err instanceof UnusablePolicyError || err instanceof ForbiddenError) {
      return { error: err.message };
    }
    throw err;
  }
}
