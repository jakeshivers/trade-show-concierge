'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import type { SafetyStanding } from '@/lib/safety/rollcall';
import { recordSafetyResponse } from '@/lib/safety/store';
import { type FormState, formErrorFrom, optional, str } from '../_components/form';

/**
 * The board's own write, and the only one it has.
 *
 * It is deliberately a second entry point to `recordSafetyResponse` rather than
 * an import of the show tab's `answer`, and that is not duplication for its own
 * sake: a route may not import a module out of another route's folder when the
 * path contains a dynamic segment. `import … from '../shows/[id]/safety/forms'`
 * type-checks, builds, and **404s every tab under `/shows/[id]`** — found by
 * `pnpm smoke`, which is the only thing in this repo that would have.
 *
 * The rule that keeps this honest is the one `/shipping`'s `confirmArrival`
 * already follows: a second *action* is fine, a second *write path* is not.
 * Everything that decides anything — the gate, the append-only response, the
 * `recorded_by_id` that carries §5e's inversion, the refusal to mark anybody
 * safe — is in the store and is reached identically from both screens. What
 * differs is only which paths are revalidated afterwards.
 */

const asFormError = formErrorFrom([ForbiddenError, NotFoundError]);

export async function answerFromBoard(_prev: FormState, form: FormData): Promise<FormState> {
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
  revalidatePath('/safety');
  revalidatePath(`/shows/${showId}/safety`);
  return {
    ok:
      actor.userId === userId
        ? 'Recorded.'
        : 'Recorded — noted as something you passed on, rather than as them answering.',
  };
}
