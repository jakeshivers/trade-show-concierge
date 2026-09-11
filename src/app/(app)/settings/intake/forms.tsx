'use client';

import { useActionState } from 'react';
import { issue, revoke } from './actions';
import type { FormState } from '../../_components/form';
import { Form, Message, QuietSubmit, Submit, controlClass } from '../../_components/form-ui';

const input = controlClass('compact');

export function IssueForm({ shows }: { shows: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(issue, {});
  return (
    <Form action={action} state={state} className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="label"
          required
          placeholder="What holds this key — “Anaheim booth scanner”"
          className={`${input} min-w-72`}
        />
        <select name="showId" className={input} defaultValue="">
          <option value="">Every show in this workspace</option>
          {shows.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Submit pending={pending} busy="Issuing…">
          Issue a key
        </Submit>
      </div>
      {state.ok && (
        <p role="status" className="break-all rounded-md bg-muted p-2 font-mono text-xs">
          {state.ok}
        </p>
      )}
      {state.error && <Message state={state} />}
    </Form>
  );
}

export function RevokeButton({ keyId }: { keyId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(revoke, {});
  return (
    <Form action={action} state={state} className="flex items-center gap-2">
      <input type="hidden" name="keyId" value={keyId} />
      <QuietSubmit pending={pending} busy="Revoking…">
        Revoke
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}
