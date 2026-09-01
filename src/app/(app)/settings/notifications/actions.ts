'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { connectMyChannel, disableMyChannel, NotifyError } from '@/lib/notify/store';
import { runNightly } from '@/lib/schedule/nightly';
import { type FormState, formErrorFrom, str } from '../../_components/form';

const asFormError = formErrorFrom([NotifyError, ForbiddenError]);

/**
 * Connecting, disconnecting, and running the job by hand.
 *
 * `connect` takes **no address field**, and that is the point rather than a
 * simplification: the actor's own email goes to the transport and the transport
 * answers with an id. A Slack member id typed into a box is a claim, and a
 * message sent to a wrong one does not bounce — it is accepted, logged as sent,
 * and never seen.
 */
export async function connect(): Promise<FormState> {
  const actor = await getActor();
  try {
    const result = await connectMyChannel(actor);
    revalidatePath('/settings/notifications');
    if ('unreachable' in result) {
      // Not an error. "You are not in this workspace" is an ordinary fact, and
      // the transport wrote the sentence for it.
      return { error: result.unreachable };
    }
    return {
      ok:
        `Connected as ${result.channel.label ?? result.channel.address}. Alerts raised from now on ` +
        'will be carried here — anything already standing stays on /alerts, because switching a ' +
        'transport on does not replay history at somebody.',
    };
  } catch (err) {
    return asFormError(err);
  }
}

export async function disconnect(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await disableMyChannel(actor, str(form, 'reason'));
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/settings/notifications');
  return {
    ok: 'Turned off. The row stays, so “why did these stop” is still answerable, and every alert is still on /alerts.',
  };
}

/**
 * Run the whole nightly job now.
 *
 * Available to anybody, for `alerts/access.ts`'s reason: a sweep asks providers
 * what is true and a delivery pass carries what was already addressed. It is
 * recorded with `trigger: 'manual'`, which is what keeps "somebody ran it" and
 * "it runs" from reading the same on the page afterwards.
 */
export async function runNow(): Promise<FormState> {
  const actor = await getActor();
  const run = await runNightly(actor.orgId, { trigger: 'manual' });
  revalidatePath('/settings/notifications');
  revalidatePath('/alerts');
  if (!run.ok) return { error: `The run stopped: ${run.error}` };
  return { ok: run.summary.join(' · ') };
}
