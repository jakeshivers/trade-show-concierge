'use client';

import { useActionState, useState } from 'react';
import { STRATEGY_KINDS, describeStrategy, type LoginPolicy } from '@/lib/auth/login-methods';
import { updateLoginPolicy } from './actions';
import type { FormState } from '../../_components/form';
import { Message } from '../../_components/form-ui';

export function LoginPolicyForm({ current }: { current: LoginPolicy }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateLoginPolicy, {});
  const [mode, setMode] = useState<LoginPolicy['mode']>(current.mode);
  const allowed = current.mode === 'allowlist' ? current.allowedStrategies : [];

  return (
    <form action={action} className="space-y-5 text-sm">
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
              <span className="block text-zinc-500">
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
          className="w-full rounded border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <Message state={state} density="comfortable" />

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? 'Saving…' : 'Save new version'}
      </button>
    </form>
  );
}
