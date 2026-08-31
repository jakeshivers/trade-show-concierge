'use client';

import { useActionState } from 'react';
import { proposeShow } from '../actions';
import { Button } from '../../_components/ui';
import type { FormState } from '../../_components/form';

/**
 * The intake form.
 *
 * Short on purpose. A proposal is an argument, not a project plan — venue, dates,
 * a rough budget, and the reason. Everything else is filled in after somebody
 * says yes, and asking for it now is how a "should we do this?" form becomes a
 * form nobody fills in.
 */

const field =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

export function IntakeForm({ defaultTimezone }: { defaultTimezone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(proposeShow, {});

  return (
    <form action={action} className="space-y-5">
      <Field label="Show name" hint="As the organizer publishes it, with the year.">
        <input name="name" required minLength={2} className={field} placeholder="PACK EXPO International 2027" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First day">
          <input type="date" name="startsOn" required className={field} />
        </Field>
        <Field label="Last day">
          <input type="date" name="endsOn" required className={field} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City">
          <input name="city" className={field} />
        </Field>
        <Field label="State / region">
          <input name="region" className={field} />
        </Field>
        <Field label="Country">
          <input name="country" className={field} placeholder="US" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Venue">
          <input name="venueName" className={field} />
        </Field>
        <Field label="Website">
          <input type="url" name="website" className={field} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nearest airport"
          hint="Three-letter IATA code. The booking agent searches against it."
        >
          <input name="airportCode" maxLength={3} className={field} placeholder="ORD" />
        </Field>
        <Field
          label="Time zone"
          hint="Deadlines and move-in times are read in the show's local time, not yours."
        >
          <input name="timezone" required defaultValue={defaultTimezone} className={field} />
        </Field>
      </div>

      <Field label="Rough budget (USD)" hint="All-in guess. Refined after it is committed.">
        <input type="number" name="budget" min={0} step={100} className={field} />
      </Field>

      <Field label="Goals" hint="Optional. What would make this worth doing.">
        <textarea name="goals" rows={2} className={field} />
      </Field>

      <Field
        label="Why should we consider this show?"
        hint="Required, and permanent. This is what next year's calendar decision gets read against."
      >
        <textarea
          name="rationale"
          rows={3}
          required
          minLength={20}
          className={field}
          placeholder="Packaging automation is adjacent to our arm business and three inbound deals last quarter came from that segment…"
        />
      </Field>

      {state.error && <p className="text-sm text-rose-700 dark:text-rose-400">{state.error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? 'Proposing…' : 'Propose this show'}
      </Button>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
      {children}
    </label>
  );
}
