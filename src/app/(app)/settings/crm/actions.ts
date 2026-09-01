'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, getActor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { selectCrmProviderOrNull } from '@/lib/roi/provider';
import { sweepRoiAlerts, syncCrm } from '@/lib/roi/store';
import { type FormState, formErrorFrom } from '../../_components/form';

const asFormError = formErrorFrom([ForbiddenError, NotFoundError]);

/**
 * Run a sync.
 *
 * The write half is a checkbox rather than always-on, and that is not a
 * preference toggle. Reading a customer's CRM changes nothing in it; writing an
 * attribution field puts our data into a database we do not own, which is the
 * only place in this product where a mistake lands outside our own tables. §8b
 * asks for the write, and asking before making it is the same courtesy the
 * booking agent extends before spending money.
 */
export async function runSync(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const db = getDb();

  // The recorded provider projects its conversion shape onto the date we
  // actually met somebody, and the *earliest* such date — one buyer met at two
  // shows is one CRM contact, and first touch is measured from the first
  // conversation in `attribution.ts`. Taking the latest would let the replay and
  // the model disagree about which show started the deal.
  const capturedAt = new Map<string, Date>();
  for (const row of await db
    .select({ email: s.leads.email, capturedAt: s.leads.capturedAt })
    .from(s.leads)) {
    if (!row.email) continue;
    const seen = capturedAt.get(row.email);
    if (!seen || row.capturedAt < seen) capturedAt.set(row.email, row.capturedAt);
  }

  const choice = selectCrmProviderOrNull(process.env, {
    capturedAtFor: (email) => capturedAt.get(email) ?? null,
  });
  if ('unavailable' in choice) return { error: choice.unavailable };

  try {
    const result = await syncCrm(
      actor,
      choice.choice.provider,
      {
        replayed: choice.choice.replayed,
        writeAttribution: form.get('write') === 'on',
      },
      db,
    );
    await sweepRoiAlerts(actor.orgId);
    revalidatePath('/settings/crm');
    revalidatePath('/roi');
    revalidatePath('/alerts');

    if (result.failedReason) {
      return {
        error:
          `The run failed partway through: ${result.failedReason} ` +
          `Everything it read before that is kept — ${result.matched} lead(s) matched and ` +
          `${result.opportunitiesRead} opportunit(ies) cached — because discarding a half-run ` +
          'would make every transient outage cost a full re-sync.',
      };
    }
    return {
      ok:
        `${result.matched} matched, ${result.unmatched} not found in the CRM, ${result.withheld} withheld by us. ` +
        `${result.opportunitiesRead} opportunit${result.opportunitiesRead === 1 ? 'y' : 'ies'} read, ` +
        `${result.attributionsWritten} attribution${result.attributionsWritten === 1 ? '' : 's'} written back.`,
    };
  } catch (err) {
    return asFormError(err);
  }
}
