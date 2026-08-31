'use client';

import { useActionState, useState } from 'react';
import { openRequest, type FormState } from '../actions';
import { Button } from '../../_components/ui';

/**
 * The request form.
 *
 * Two decisions worth stating.
 *
 * **Times are entered in a named zone, and the zone is on screen.** A departure
 * window is the one field where the reader's browser zone is definitely wrong:
 * "leave after 8am" means 8am where the airport is. The form carries an explicit
 * timezone and the action resolves it with `zonedToInstant`, never `new Date()`
 * — the same rule as flight times in `src/lib/datetime/zoned.ts`.
 *
 * **Windows, not flights.** The fields ask for the earliest the traveler can
 * leave and the latest they can arrive, because that is what the policy engine
 * rules against. Asking for a preferred flight would invite someone to pick one
 * and then be told no.
 */

const field =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

type Show = {
  id: string;
  name: string;
  airportCode: string | null;
  timezone: string;
  startsOn: string;
};

export function RequestForm({
  travelers,
  costCenters,
  shows,
  me,
}: {
  travelers: { id: string; fullName: string; email: string }[];
  costCenters: { id: string; name: string; code: string | null }[];
  shows: Show[];
  me: { id: string; costCenterId: string | null };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(openRequest, {});
  const [showId, setShowId] = useState('');
  const [timezone, setTimezone] = useState('America/Chicago');

  const chosen = shows.find((s) => s.id === showId);

  return (
    <form action={action} className="space-y-5">
      {state.error && (
        <p className="rounded-md bg-rose-100 px-3 py-2 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Traveler"
          hint={
            travelers.length === 1
              ? 'Requesting for someone else is a travel manager capability.'
              : 'Whose trip this is. The policy that applies is theirs, not yours.'
          }
        >
          <select name="travelerId" defaultValue={me.id} className={field}>
            {travelers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Show" hint="Optional. Links the spend to a show's true cost.">
          <select
            name="showId"
            value={showId}
            onChange={(e) => {
              setShowId(e.target.value);
              const s = shows.find((x) => x.id === e.target.value);
              if (s) setTimezone(s.timezone);
            }}
            className={field}
          >
            <option value="">— not for a show —</option>
            {shows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startsOn})
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="From" hint="IATA code.">
          <input
            name="originAirport"
            required
            maxLength={3}
            className={`${field} uppercase`}
            placeholder="ORD"
          />
        </Field>
        <Field label="To">
          <input
            name="destinationAirport"
            required
            maxLength={3}
            defaultValue={chosen?.airportCode ?? ''}
            key={chosen?.airportCode ?? 'none'}
            className={`${field} uppercase`}
            placeholder="LAS"
          />
        </Field>
        <Field label="Cabin" hint="A preference. Policy has the final say.">
          <select name="cabinPreference" defaultValue="" className={field}>
            <option value="">no preference</option>
            <option value="economy">economy</option>
            <option value="premium_economy">premium economy</option>
            <option value="business">business</option>
          </select>
        </Field>
      </div>

      <Field
        label="Time zone for the times below"
        hint="These windows are read in this zone, not in your browser's. Picking a show sets it."
      >
        <input
          name="timezone"
          required
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className={field}
        />
      </Field>

      <fieldset className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Outbound
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Earliest I can leave">
            <input type="datetime-local" name="earliestDeparture" required className={field} />
          </Field>
          <Field label="Latest I can arrive" hint="Usually move-in, or the first meeting.">
            <input type="datetime-local" name="latestArrival" required className={field} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Return — leave blank for one way
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Earliest I can leave">
            <input type="datetime-local" name="returnEarliestDeparture" className={field} />
          </Field>
          <Field label="Latest I can arrive home">
            <input type="datetime-local" name="returnLatestArrival" className={field} />
          </Field>
        </div>
      </fieldset>

      <Field
        label="Cost center"
        hint="Every financial row carries one at creation, never backfilled. Defaults to the traveler's."
      >
        <select name="costCenterId" defaultValue={me.costCenterId ?? ''} className={field}>
          <option value="">— the traveler&rsquo;s default —</option>
          {costCenters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code ? `${c.code} · ` : ''}
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Notes" hint="Anything an approver would want to know.">
        <textarea name="notes" rows={2} className={field} />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Opening…' : 'Open request'}
        </Button>
        <span className="text-xs text-zinc-500">
          This opens the request. Searching is the next step, and it is deliberate.
        </span>
      </div>
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
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
