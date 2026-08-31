'use client';

import { useActionState } from 'react';
import { markSeen, markUnseen, refreshAll } from './actions';
import type { FormState } from '../_components/form';
import { Message, QuietSubmit, Submit } from '../_components/form-ui';

export function SeenButton({ alertId, seen }: { alertId: string; seen: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    seen ? markUnseen : markSeen,
    {},
  );
  return (
    <form action={action} className="inline">
      <input type="hidden" name="alertId" value={alertId} />
      <QuietSubmit pending={pending} busy="…">
        {seen ? 'Put it back' : 'I have seen this'}
      </QuietSubmit>
      <Message state={state} />
    </form>
  );
}

export function RefreshButton() {
  const [state, action, pending] = useActionState<FormState, FormData>(refreshAll, {});
  return (
    <form action={action}>
      <Submit pending={pending} busy="Asking every engine…">
        Re-check everything
      </Submit>
      <Message state={state} />
    </form>
  );
}
