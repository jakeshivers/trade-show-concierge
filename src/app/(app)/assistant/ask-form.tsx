'use client';

import { useActionState, useRef } from 'react';
import { Message, Submit } from '../_components/form-ui';
import type { FormState } from '../_components/form';
import { askAssistant } from './actions';

/**
 * The one input.
 *
 * It clears itself on a successful answer and does not on a failure, which is
 * the small thing chat forms get wrong: a question that came back "the assistant
 * is not configured" is a question the person still wants to ask once somebody
 * sets the variable, and retyping it is the app losing their work.
 */
export function AskForm({
  conversationId,
  placeholder,
}: {
  conversationId?: string;
  placeholder: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(askAssistant, {});
  const ref = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={ref}
      action={async (form) => {
        await action(form);
      }}
      className="space-y-2"
    >
      {conversationId && <input type="hidden" name="conversationId" value={conversationId} />}
      <div className="flex gap-2">
        <input
          name="question"
          required
          autoComplete="off"
          placeholder={placeholder}
          disabled={pending}
          className="w-full rounded-lg border border-border bg-panel px-3 py-2.5 text-sm text-text placeholder:text-text-muted focus:border-border-strong focus:outline-none disabled:opacity-60"
        />
        <Submit pending={pending} busy="Looking…" className="px-4">
          Ask
        </Submit>
      </div>
      <Message state={state} />
      {pending && (
        <p className="text-xs text-text-muted">
          Running the same store queries the screens run, as you. This can take a few seconds.
        </p>
      )}
    </form>
  );
}
