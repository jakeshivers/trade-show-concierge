'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { ModelNotConfiguredError } from '@/lib/integrations/llm/types';
import { selectAssistantModel } from '@/lib/assistant/provider';
import { ask } from '@/lib/assistant/store';
import { formErrorFrom, str, type FormState } from '../_components/form';

const asFormError = formErrorFrom(
  [ForbiddenError, ModelNotConfiguredError],
  { messagedErrorsAreAnswers: true },
);

/**
 * One exchange.
 *
 * A server action rather than a streaming route, and that is a real trade: the
 * answer arrives all at once after several seconds instead of a token at a time.
 * It buys the thing this step is actually about — every tool runs on the server
 * as the actor `getActor()` resolved, inside the request, with no token the
 * browser holds and no endpoint the browser can call with a different actor id.
 * Streaming is a presentation improvement over that and can be added without
 * moving a single access decision.
 */
export async function askAssistant(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const question = str(form, 'question').trim();
  if (!question) return { error: 'Ask something.' };

  const existing = str(form, 'conversationId');

  let id: string;
  try {
    const { model } = selectAssistantModel();
    const result = await ask({
      actor,
      model,
      question,
      conversationId: existing || undefined,
    });
    id = result.conversationId;
  } catch (err) {
    return asFormError(err);
  }

  revalidatePath('/assistant');
  if (!existing) redirect(`/assistant/${id}`);
  return { ok: 'Answered.' };
}
