'use client';

import { useActionState } from 'react';
import { clone } from '../../actions';
import { Button } from '../../../_components/ui';
import type { FormState } from '../../../_components/form';

const field =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

export function CloneForm({
  sourceId,
  suggestedName,
  suggestedStart,
  counts,
}: {
  sourceId: string;
  suggestedName: string;
  suggestedStart: string;
  counts: { tasks: number; deadlines: number; team: number; assets: number };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(clone, {});

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="sourceId" value={sourceId} />

      <label className="block">
        <span className="text-sm font-medium">New show name</span>
        <input name="name" required defaultValue={suggestedName} className={field} />
      </label>

      <label className="block">
        <span className="text-sm font-medium">First day</span>
        <span className="mt-0.5 block text-xs text-zinc-500">
          Everything else shifts by the same number of calendar days, keeping its local time of
          day. A 5:00pm deadline stays a 5:00pm deadline even across a daylight-saving change.
        </span>
        <input type="date" name="startsOn" required defaultValue={suggestedStart} className={field} />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What to carry over</legend>
        {(
          [
            ['tasks', `${counts.tasks} readiness tasks`, 'Copied and reset to not started.'],
            [
              'deadlines',
              `${counts.deadlines} service deadlines`,
              'Dates are predicted from last year and arrive unconfirmed — somebody must read this year’s exhibitor manual.',
            ],
            ['team', `${counts.team} team members`, 'Everyone comes back as invited, not confirmed.'],
            ['assets', `${counts.assets} asset reservations`, 'Booth, displays, and AV, on shifted dates.'],
          ] as const
        ).map(([key, label, note]) => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" name={`include:${key}`} defaultChecked className="mt-1" />
            <span>
              <span className="font-medium">{label}</span>
              <span className="block text-xs text-zinc-500">{note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {state.error && <p className="text-sm text-rose-700 dark:text-rose-400">{state.error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? 'Cloning…' : 'Create the clone'}
      </Button>
    </form>
  );
}
