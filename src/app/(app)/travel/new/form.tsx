'use client';

import { useActionState, useState } from 'react';
import { openRequest } from '../actions';
import { Button } from '../../_components/ui';
import type { FormState } from '../../_components/form';
import { Field, controlClass } from '../../_components/form-ui';

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

const fieldClass = controlClass('comfortable');

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
  travelers: { id: string; fullName: string; email: string; homeAirport: string | null }[];
  costCenters: { id: string; name: string; code: string | null }[];
  shows: Show[];
  me: { id: string; costCenterId: string | null };
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(openRequest, {});
  const [showId, setShowId] = useState('');
  const [travelerId, setTravelerId] = useState(me.id);
  const [timezone, setTimezone] = useState('America/Chicago');

  const chosen = shows.find((s) => s.id === showId);
  // **Whose** home airport, and it is the traveler's rather than the requester's.
  // A travel manager filing for a colleague is asking where that colleague leaves
  // from; prefilling their own would be a wrong answer that looks like a helpful
  // one, and the field it lands in is the one the policy engine rules against.
  const traveler = travelers.find((t) => t.id === travelerId);
  const home = traveler?.homeAirport ?? null;

  return (
    <form action={action} className="space-y-5">
      {state.error && (
        <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
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
          <select
            name="travelerId"
            value={travelerId}
            onChange={(e) => setTravelerId(e.target.value)}
            className={fieldClass}
          >
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
            className={fieldClass}
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
        <Field
          label="From"
          hint={
            home
              ? `IATA code. Prefilled from ${traveler?.id === me.id ? 'your' : `${traveler?.fullName.split(' ')[0]}’s`} home airport — type over it for this trip.`
              : 'IATA code. Set a home airport in your profile and this fills itself in.'
          }
        >
          {/*
            A default, not a lock. `key` remounts the input when the traveler
            changes so the prefill follows the person — the pattern the
            destination field already uses for the show. Typing over it is the
            whole override mechanism, and what gets stored is what was typed:
            `travel_requests.origin_airport` records the question this request
            actually asked, so changing a home airport next month never moves an
            open request or an offer that was priced from it.
          */}
          <input
            name="originAirport"
            required
            maxLength={3}
            defaultValue={home ?? ''}
            key={`origin-${travelerId}-${home ?? 'none'}`}
            className={`${fieldClass} uppercase`}
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
            className={`${fieldClass} uppercase`}
            placeholder="LAS"
          />
        </Field>
        <Field label="Cabin" hint="A preference. Policy has the final say.">
          <select name="cabinPreference" defaultValue="" className={fieldClass}>
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
          className={fieldClass}
        />
      </Field>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Outbound
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Earliest I can leave">
            <input type="datetime-local" name="earliestDeparture" required className={fieldClass} />
          </Field>
          <Field label="Latest I can arrive" hint="Usually move-in, or the first meeting.">
            <input type="datetime-local" name="latestArrival" required className={fieldClass} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Return — leave blank for one way
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Earliest I can leave">
            <input type="datetime-local" name="returnEarliestDeparture" className={fieldClass} />
          </Field>
          <Field label="Latest I can arrive home">
            <input type="datetime-local" name="returnLatestArrival" className={fieldClass} />
          </Field>
        </div>
      </fieldset>

      <Field
        label="Cost center"
        hint="Every financial row carries one at creation, never backfilled. Defaults to the traveler's."
      >
        <select name="costCenterId" defaultValue={me.costCenterId ?? ''} className={fieldClass}>
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
        <textarea name="notes" rows={2} className={fieldClass} />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Opening…' : 'Open request'}
        </Button>
        <span className="text-xs text-text-muted">
          This opens the request. Searching is the next step, and it is deliberate.
        </span>
      </div>
    </form>
  );
}

