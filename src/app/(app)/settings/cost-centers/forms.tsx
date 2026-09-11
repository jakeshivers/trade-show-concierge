'use client';

import { useActionState } from 'react';
import { Field, Form, Input, Message, QuietSubmit, Submit } from '../../_components/form-ui';
import { addCostCenter, rename, toggle } from './actions';

export function AddCostCenterForm() {
  const [state, action, pending] = useActionState(addCostCenter, {});
  return (
    <Form action={action} state={state} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" hint="Letters, digits and hyphens. What a finance export reconciles on.">
          <Input name="code" density="comfortable" placeholder="MKT-EVENTS" required />
        </Field>
        <Field label="Name" hint="Readable a year from now.">
          <Input name="name" density="comfortable" placeholder="Marketing — Events" required />
        </Field>
      </div>
      <Submit pending={pending} busy="Adding…">Add a cost center</Submit>
      <Message state={state} />
    </Form>
  );
}

export function RenameForm({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState(rename, {});
  return (
    <Form action={action} state={state} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Input name="name" defaultValue={name} className="min-w-48" />
      <QuietSubmit pending={pending} busy="…">Rename</QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

export function ToggleForm({ id, active }: { id: string; active: boolean }) {
  const [state, action, pending] = useActionState(toggle, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? 'false' : 'true'} />
      <QuietSubmit pending={pending} busy="…">
        {active ? 'Switch off' : 'Switch on'}
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}
