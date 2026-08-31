'use client';

import { useActionState, useState } from 'react';
import {
  changeDeadlineStatus,
  confirmDeadline,
  createDeadline,
  removeDeadline,
  updateDeadline,
} from './deadline-actions';
import { Button } from '../../../_components/ui';
import { DEADLINE_KINDS, MIN_REASON } from '@/lib/deadlines/edit';
import type { RegisterEntry } from '@/lib/deadlines/store';
import type { FormState } from '../../../_components/form';
import { Message, QuietSubmit, Submit } from '../../../_components/form-ui';
import { zonedDateInput, zonedTimeInput } from '@/lib/datetime/zoned';

/**
 * The writable register.
 *
 * Same rule as the checklist forms: a control that would be refused is not
 * rendered, and where the gap could read as a missing feature the reason is
 * written next to it. Two things are specific to this screen:
 *
 * - **Confirm is its own control, not a checkbox on the edit form.** Confirming
 *   is the assertion that this date came off *this year's* manual, and it is what
 *   promotes the row's penalty from a guess into a figure the alert engine quotes
 *   in dollars. Burying it among title and owner would make it something people
 *   tick while editing something else.
 * - **The date and time inputs are labelled with the show's zone**, because that
 *   is what they are read in — 4:00pm on a register whose show is in Chicago is
 *   4:00pm in Chicago, wherever the person typing is sitting.
 */

const KIND_LABEL = (k: string) => k.replace(/_/g, ' ');

export function DeadlineRow({
  showId,
  timezone,
  entry,
  people,
  may,
}: {
  showId: string;
  timezone: string;
  entry: RegisterEntry;
  people: { id: string; fullName: string }[];
  may: { edit: boolean; confirm: boolean; waive: boolean };
}) {
  const { deadline: d } = entry;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {entry.mayComplete ? (
        <StatusControl showId={showId} entry={entry} mayWaive={may.waive} />
      ) : (
        <span className="text-xs text-text-muted">
          {entry.owner
            ? `${entry.owner.fullName} reports this one done.`
            : 'Unowned — whoever runs the show can assign it.'}
        </span>
      )}

      {may.confirm && d.status === 'open' && (
        <ConfirmControl showId={showId} deadlineId={d.id} confirmed={d.confirmedAt !== null} />
      )}

      {/* A derived row's date and title belong to the record it came from, so the
          full editor is not offered for one. `editDeadline` refuses it server-side
          either way; this is so the screen does not promise the refusal. */}
      {may.edit && !d.lodgingId && (
        <EditDeadline showId={showId} timezone={timezone} entry={entry} people={people} />
      )}
    </div>
  );
}

/* ------------------------------ status control ----------------------------- */

const STATES: { value: string; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'complete', label: 'Done — ordered' },
];

function StatusControl({
  showId,
  entry,
  mayWaive,
}: {
  showId: string;
  entry: RegisterEntry;
  mayWaive: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(changeDeadlineStatus, {});
  const [next, setNext] = useState<string>(entry.deadline.status);
  const needsReason = next === 'not_applicable';

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="deadlineId" value={entry.deadline.id} />
      <select
        name="status"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="rounded-md border border-border-strong bg-panel px-2 py-1 text-xs"
      >
        {STATES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {(mayWaive || entry.deadline.status === 'not_applicable') && (
          <option value="not_applicable">Does not apply this year</option>
        )}
      </select>

      {needsReason && (
        <input
          name="note"
          required
          minLength={MIN_REASON}
          defaultValue={entry.deadline.statusNote ?? ''}
          placeholder="Why does this deadline not apply?"
          className="min-w-56 flex-1 rounded-md border border-border-strong bg-panel px-2 py-1 text-xs"
        />
      )}

      <Submit disabled={pending || next === entry.deadline.status}>Save</Submit>
      <Message state={state} className="w-full" />
    </form>
  );
}

/* ------------------------------ confirm control ---------------------------- */

function ConfirmControl({
  showId,
  deadlineId,
  confirmed,
}: {
  showId: string;
  deadlineId: string;
  confirmed: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirmDeadline, {});

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="deadlineId" value={deadlineId} />
      <input type="hidden" name="confirmed" value={confirmed ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-border-strong px-2 py-1 text-xs font-medium disabled:opacity-40"
      >
        {confirmed ? 'Withdraw confirmation' : 'Confirm against the manual'}
      </button>
      <Message state={state} />
    </form>
  );
}

/* -------------------------------- add / edit ------------------------------- */

export function AddDeadlineForm({
  showId,
  timezone,
  people,
}: {
  showId: string;
  timezone: string;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createDeadline, {});

  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Add a deadline</summary>
      <Fields
        action={action}
        pending={pending}
        state={state}
        showId={showId}
        timezone={timezone}
        people={people}
        submitLabel="Add deadline"
      />
      <p className="mt-2 text-xs text-text-muted">
        A deadline you type is <strong>not</strong> confirmed by the act of typing it — the
        register cannot tell whether you read this year&rsquo;s manual or last year&rsquo;s
        spreadsheet. Until somebody confirms it, the engine chases the date and does not quote
        the penalty as established.
      </p>
    </details>
  );
}

function EditDeadline({
  showId,
  timezone,
  entry,
  people,
}: {
  showId: string;
  timezone: string;
  entry: RegisterEntry;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateDeadline, {});
  const [del, delAction, deleting] = useActionState<FormState, FormData>(removeDeadline, {});
  const { deadline: d } = entry;

  return (
    <details className="w-full">
      <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
        Edit
      </summary>
      <Fields
        action={action}
        pending={pending}
        state={state}
        showId={showId}
        timezone={timezone}
        people={people}
        deadline={d}
        submitLabel="Save changes"
      />
      {d.confirmedAt && (
        <p className="mt-2 text-xs text-warn">
          Moving the date withdraws its confirmation. A confirmation is an assertion about one
          specific date read off the manual; carrying it onto a different date would turn a
          guess into a quoted figure without anybody opening the document.
        </p>
      )}
      <form action={delAction} className="mt-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="deadlineId" value={d.id} />
        <QuietSubmit
          pending={deleting}
          className="text-bad underline hover:no-underline"
        >
          Delete this deadline
        </QuietSubmit>
        <span className="ml-2 text-xs text-text-muted">
          Deleting leaves no record that the deadline existed. If it simply does not apply this
          year, say so instead — that keeps the decision and its reason.
        </span>
        <Message state={del} />
      </form>
    </details>
  );
}

function Fields({
  action,
  pending,
  state,
  showId,
  timezone,
  people,
  deadline,
  submitLabel,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  state: FormState;
  showId: string;
  timezone: string;
  people: { id: string; fullName: string }[];
  deadline?: RegisterEntry['deadline'];
  submitLabel: string;
}) {
  return (
    <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="showId" value={showId} />
      {deadline && <input type="hidden" name="deadlineId" value={deadline.id} />}

      <Field label="Deadline" className="sm:col-span-2">
        <input name="title" required minLength={3} defaultValue={deadline?.title} className={INPUT} />
      </Field>
      <Field label="Kind">
        <select name="kind" defaultValue={deadline?.kind ?? 'advance_order'} className={INPUT}>
          {DEADLINE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL(k)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Owner" hint="Leave unassigned rather than guessing — an unowned row escalates.">
        <select name="ownerId" defaultValue={deadline?.ownerId ?? ''} className={INPUT}>
          <option value="">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Date (${timezone})`}>
        <input
          type="date"
          name="dueDate"
          required
          defaultValue={deadline ? zonedDateInput(deadline.dueAt, timezone) : ''}
          className={INPUT}
        />
      </Field>
      <Field
        label="Time of day"
        hint="From the manual. A 4pm cutoff recorded as 5pm is an hour of surcharge."
      >
        <input
          type="time"
          name="dueTime"
          required
          defaultValue={deadline ? zonedTimeInput(deadline.dueAt, timezone) : '17:00'}
          className={INPUT}
        />
      </Field>
      <Field label="Penalty estimate (USD)" hint="What missing it costs. Blank if genuinely unknown.">
        <input
          name="penaltyEstimate"
          inputMode="decimal"
          placeholder="3125.00"
          defaultValue={
            deadline?.penaltyEstimateCents != null
              ? (deadline.penaltyEstimateCents / 100).toFixed(2)
              : ''
          }
          className={INPUT}
        />
      </Field>
      <Field label="Source link" hint="The manual page this came from, if it is online.">
        <input name="sourceUrl" defaultValue={deadline?.sourceUrl ?? ''} className={INPUT} />
      </Field>
      <Field label="What the penalty is" className="sm:col-span-2">
        <textarea name="penaltyNote" rows={2} defaultValue={deadline?.penaltyNote ?? ''} className={INPUT} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" variant="secondary" disabled={pending}>
          {submitLabel}
        </Button>
        <Message state={state} density="comfortable" className="mt-2" />
      </div>
    </form>
  );
}

/* --------------------------------- bits ------------------------------------ */

const INPUT =
  'mt-1 w-full rounded-md border border-border-strong bg-panel px-2 py-1.5 text-sm';

function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
    </label>
  );
}

/**
 * The date and time inputs round-trip in the *show's* zone, never the browser's.
 * `toISOString()` on a 4pm-Pacific cutoff hands the form 23:00 the same day —
 * and saving that back would move every deadline seven hours on each edit.
 */
