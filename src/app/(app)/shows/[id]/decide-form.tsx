'use client';

import { useActionState } from 'react';
import { decide, type FormState } from '../actions';
import { Button } from '../../_components/ui';

/**
 * Commit or decline a prospect.
 *
 * One textarea, two buttons, and the reason is required by the server rather than
 * by this form — but saying so here means an admin writes the sentence while they
 * still remember it, instead of finding out after they click.
 */
export function DecideForm({ showId }: { showId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(decide, {});

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      <label className="block">
        <span className="text-sm font-medium">Why?</span>
        <span className="mt-0.5 block text-xs text-zinc-500">
          Recorded permanently against this show. A year from now this is the note that
          argues for — or against — doing it again.
        </span>
        <textarea
          name="rationale"
          rows={3}
          required
          minLength={20}
          placeholder="Booth space rose 40% and last year sourced $190k against $61k all-in…"
          className="mt-2 w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <div className="flex gap-2">
        <Button type="submit" name="decision" value="committed" disabled={pending}>
          Commit to this show
        </Button>
        <Button type="submit" name="decision" value="declined" variant="secondary" disabled={pending}>
          Decline
        </Button>
      </div>

      {state.error && <p className="text-sm text-rose-700 dark:text-rose-400">{state.error}</p>}
    </form>
  );
}
