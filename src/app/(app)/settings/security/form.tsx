'use client';

import { useActionState, useState } from 'react';
import { STRATEGY_KINDS, describeStrategy, type LoginPolicy } from '@/lib/auth/login-methods';
import { updateLoginPolicy } from './actions';
import type { FormState } from '../../_components/form';
import { Form, Message } from '../../_components/form-ui';

export function LoginPolicyForm({ current }: { current: LoginPolicy }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateLoginPolicy, {});
  const [mode, setMode] = useState<LoginPolicy['mode']>(current.mode);
  const allowed = current.mode === 'allowlist' ? current.allowedStrategies : [];

  return (
    <Form action={action} state={state} className="space-y-5 text-sm">
      <fieldset className="space-y-2">
        <legend className="font-medium">Mode</legend>
        {(['unrestricted', 'allowlist'] as const).map((m) => (
          <label key={m} className="flex items-start gap-2">
            <input
              type="radio"
              name="mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">
                {m === 'unrestricted' ? 'Unrestricted' : 'Allowlist'}
              </span>
              <span className="block text-text-muted">
                {m === 'unrestricted'
                  ? 'Any sign-in method enabled for this instance is acceptable.'
                  : 'Only the methods checked below. Anything else on an account is refused.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2" disabled={mode !== 'allowlist'}>
        <legend className="font-medium">Permitted methods</legend>
        {STRATEGY_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 disabled:opacity-50">
            <input
              type="checkbox"
              name={`strategy:${k}`}
              defaultChecked={allowed.includes(k)}
            />
            {describeStrategy(k)}
          </label>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">Why (recorded, required)</span>
        <textarea
          name="reason"
          rows={2}
          required
          minLength={10}
          placeholder="e.g. Security review 2026-Q3: SSO only, passwords removed."
          className="w-full rounded border border-border-strong bg-panel p-2"
        />
      </label>

      <Message state={state} density="comfortable" />

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 font-medium text-brand-fg hover:bg-brand-hover disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save new version'}
      </button>
    </Form>
  );
}
