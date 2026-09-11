'use client';

import { useActionState } from 'react';
import { runSync } from './actions';
import type { FormState } from '../../_components/form';
import { Form, Message, Submit } from '../../_components/form-ui';

export function SyncForm({ canWrite }: { canWrite: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runSync, {});
  return (
    <Form action={action} state={state} className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-4">
        <Submit pending={pending} busy="Syncing…">
          Run a sync
        </Submit>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="write" defaultChecked={canWrite} disabled={!canWrite} />
          Write the show attribution back onto matched CRM records
        </label>
      </div>
      <Message state={state} />
    </Form>
  );
}
