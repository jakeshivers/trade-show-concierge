'use client';

import { useActionState } from 'react';
import { proposeShow } from '../actions';
import { Button } from '../../_components/ui';
import type { FormState } from '../../_components/form';
import { Field, Form, Message, controlClass } from '../../_components/form-ui';

/**
 * The intake form.
 *
 * Short on purpose. A proposal is an argument, not a project plan — venue, dates,
 * a rough budget, and the reason. Everything else is filled in after somebody
 * says yes, and asking for it now is how a "should we do this?" form becomes a
 * form nobody fills in.
 */

const fieldClass = controlClass('comfortable');

export function IntakeForm({ defaultTimezone }: { defaultTimezone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(proposeShow, {});

  return (
    <Form action={action} state={state} className="space-y-5">
      <Field label="Show name" hint="As the organizer publishes it, with the year.">
        <input name="name" required minLength={2} className={fieldClass} placeholder="PACK EXPO International 2027" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First day">
          <input type="date" name="startsOn" required className={fieldClass} />
        </Field>
        <Field label="Last day">
          <input type="date" name="endsOn" required className={fieldClass} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City">
          <input name="city" className={fieldClass} />
        </Field>
        <Field label="State / region">
          <input name="region" className={fieldClass} />
        </Field>
        <Field label="Country">
          <input name="country" className={fieldClass} placeholder="US" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Venue">
          <input name="venueName" className={fieldClass} />
        </Field>
        <Field label="Website">
          <input type="url" name="website" className={fieldClass} />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Nearest airport"
          hint="Three-letter IATA code. The booking agent searches against it."
        >
          <input name="airportCode" maxLength={3} className={fieldClass} placeholder="ORD" />
        </Field>
        <Field
          label="Time zone"
          hint="Deadlines and move-in times are read in the show's local time, not yours."
        >
          <input name="timezone" required defaultValue={defaultTimezone} className={fieldClass} />
        </Field>
      </div>

      <Field label="Rough budget (USD)" hint="All-in guess. Refined after it is committed.">
        <input type="number" name="budget" min={0} step={100} className={fieldClass} />
      </Field>

      <Field label="Goals" hint="Optional. What would make this worth doing.">
        <textarea name="goals" rows={2} className={fieldClass} />
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
          className={fieldClass}
          placeholder="Packaging automation is adjacent to our arm business and three inbound deals last quarter came from that segment…"
        />
      </Field>

      <Message state={state} density="comfortable" />

      <Button type="submit" disabled={pending}>
        {pending ? 'Proposing…' : 'Propose this show'}
      </Button>
    </Form>
  );
}

