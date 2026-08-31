'use server';

import { revalidatePath } from 'next/cache';
import { ForbiddenError, getActor } from '@/lib/auth/actor';
import { acknowledgeAlert, unacknowledgeAlert } from '@/lib/alerts/store';
import { runAllSweeps } from '@/lib/alerts/sweep';
import { type FormState, formErrorFrom, str } from '../_components/form';

/**
 * The feed's two writes, and there are only two on purpose.
 *
 * A person may say "I have seen this", and may take it back. A person may not
 * *resolve* an alert: the condition is whatever the crate and the calendar make
 * it, and a screen that let somebody mark a stalled shipment as fine would be
 * the acknowledged-and-forgotten failure with a tidier interface. Only a sweep
 * closes a condition, by no longer finding it.
 *
 * Running the sweeps by hand is the third control, and it is here rather than on
 * a schedule because nothing in this product runs on a schedule yet (§10 step
 * 21). Until it does, an alert's freshness is a fact about when somebody last
 * pressed this, which is exactly what `standingOf`'s `unchecked` reports.
 */

const asFormError = formErrorFrom([ForbiddenError]);

function refresh() {
  revalidatePath('/alerts');
  revalidatePath('/');
}

export async function markSeen(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const actor = await getActor();
    await acknowledgeAlert(actor, str(form, 'alertId'));
    refresh();
    return { ok: 'Marked as seen.' };
  } catch (err) {
    return asFormError(err);
  }
}

export async function markUnseen(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const actor = await getActor();
    await unacknowledgeAlert(actor, str(form, 'alertId'));
    refresh();
    return { ok: 'Back on the list.' };
  } catch (err) {
    return asFormError(err);
  }
}

// Takes no arguments on purpose: it reads nothing from the form, and a function
// with fewer parameters is still a valid `useActionState` action.
export async function refreshAll(): Promise<FormState> {
  try {
    const actor = await getActor();
    const outcomes = await runAllSweeps(actor.orgId);
    refresh();
    const raised = outcomes.reduce((n, o) => n + o.raised, 0);
    const resolved = outcomes.reduce((n, o) => n + o.resolved, 0);
    const blocked = outcomes.filter((o) => o.unavailable);
    return {
      ok:
        `${raised} raised, ${resolved} resolved` +
        (blocked.length > 0
          ? ` — ${blocked.map((b) => b.source).join(' and ')} could not run, so nothing was ` +
            'raised or resolved for them.'
          : '.'),
    };
  } catch (err) {
    return asFormError(err);
  }
}
