'use client';

import { useActionState } from 'react';
import { connect, disconnect, runNow } from './actions';
import type { FormState } from '../../_components/form';
import { Message, QuietSubmit, Submit, controlClass } from '../../_components/form-ui';

const input = controlClass('compact');

export function ConnectForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(connect, {});
  return (
    <form action={action} className="mt-3 space-y-2">
      <Submit pending={pending} busy="Asking the transport…">
        Connect {email}
      </Submit>
      <Message state={state} />
    </form>
  );
}

export function DisconnectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(disconnect, {});
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input
        name="reason"
        required
        placeholder="Why — the log answers “why did these stop” with this"
        className={`${input} min-w-80`}
      />
      <QuietSubmit pending={pending} busy="Turning off…">
        Turn off
      </QuietSubmit>
      <Message state={state} />
    </form>
  );
}

export function RunNowForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(runNow, {});
  return (
    <form action={action} className="space-y-2">
      <Submit pending={pending} busy="Sweeping, erasing, delivering…">
        Run the nightly job now
      </Submit>
      <Message state={state} />
    </form>
  );
}
