'use client';

import { useActionState, useState } from 'react';
import { addMeeting, capture, commit, erase, preview, runRetention, type ImportPreviewState } from './actions';
import { FIELD_LABEL, type LeadField } from '@/lib/leads/parse';
import type { FormState } from '../../../_components/form';
import { Message, QuietSubmit, Submit, controlClass } from '../../../_components/form-ui';

const input = controlClass('compact');

/**
 * The Leads tab's controls.
 *
 * The consent select is the one worth reading. It defaults to **"Not recorded"**
 * and always will: `consent.ts`'s first rule is that a lawful basis is never
 * manufactured from a default, and a select pre-set to "Consented" would do
 * exactly that every time somebody tabbed past it. The notice field appears only
 * when consent is chosen, because consent to an unstated purpose is not consent
 * to any purpose, and the store refuses it either way.
 */

const BASIS_OPTIONS = [
  { value: '', label: 'Lawful basis: not recorded' },
  { value: 'legitimate_interest', label: 'Legitimate interest (they gave us the badge)' },
  { value: 'consent', label: 'Consent (they were told, and agreed)' },
];

export function CaptureForm({ showId }: { showId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(capture, {});
  const [basis, setBasis] = useState('');

  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="showId" value={showId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="fullName" required placeholder="Name" className={input} />
        <input name="email" type="email" placeholder="Email" className={input} />
        <input name="company" placeholder="Company" className={input} />
        <input name="title" placeholder="Job title" className={input} />
        <input name="phone" placeholder="Phone" className={input} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input name="interests" placeholder="Interests, comma separated" className={`${input} min-w-56`} />
        <input name="notes" placeholder="Notes" className={`${input} min-w-64`} />
        <select
          name="basis"
          value={basis}
          onChange={(e) => setBasis(e.target.value)}
          className={input}
        >
          {BASIS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {basis === 'consent' && (
          <input
            name="consentNotice"
            required
            placeholder="What they were told"
            className={`${input} min-w-64`}
          />
        )}
        <Submit pending={pending} busy="Saving…">
          Capture
        </Submit>
      </div>
      <Message state={state} />
    </form>
  );
}

export function MeetingForm({
  showId,
  people,
  leads,
}: {
  showId: string;
  people: { id: string; fullName: string }[];
  leads: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(addMeeting, {});
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input name="subject" required placeholder="Who, or what it was about" className={`${input} min-w-64`} />
      <input name="company" placeholder="Company" className={input} />
      <input name="when" type="datetime-local" className={input} />
      {/* Three states, not two. A booked meeting nobody came to must not sit in
          the count of meetings held. */}
      <select name="outcome" className={input} defaultValue="booked">
        <option value="booked">Booked</option>
        <option value="held">Held</option>
        <option value="no_show">No-show</option>
      </select>
      <select name="ownerId" className={input} defaultValue="">
        <option value="">Owner: me</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <select name="leadId" className={input} defaultValue="">
        <option value="">No linked lead</option>
        {leads.map((l) => (
          <option key={l.id} value={l.id}>
            {l.fullName}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-text-muted">
        <input type="checkbox" name="isExistingCustomer" /> existing customer
      </label>
      <Submit pending={pending} busy="Saving…">
        Record
      </Submit>
      <Message state={state} className="w-full" />
    </form>
  );
}

export function EraseForm({ showId, leadId }: { showId: string; leadId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(erase, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-text-muted hover:underline"
      >
        Erase
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="leadId" value={leadId} />
      <input
        name="reason"
        required
        placeholder="Why — an erasure request, a row captured in error"
        className={`${input} min-w-72`}
      />
      <QuietSubmit pending={pending} busy="Erasing…">
        Erase permanently
      </QuietSubmit>
      <Message state={state} />
    </form>
  );
}

export function RetentionButton({ showId }: { showId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(runRetention, {});
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="showId" value={showId} />
      <Submit pending={pending} busy="Erasing…">
        Erase everything past its date
      </Submit>
      <Message state={state} />
    </form>
  );
}

/* --------------------------------- importing ------------------------------- */

const FIELDS: LeadField[] = [
  'fullName',
  'email',
  'phone',
  'company',
  'title',
  'notes',
  'interests',
  'externalRef',
  'consentBasis',
  'consentNotice',
];

/**
 * Upload, confirm the mapping, then import.
 *
 * The second step is not ceremony. `inferMapping` guesses well on the files
 * badge vendors ship and guesses confidently on the ones they do not — a column
 * called `Company` that holds the *exhibitor's* name would be filed as every
 * lead's employer, on every row, and nothing downstream would ever question it.
 * The preview also states the arithmetic before anything is written: every row
 * read lands in accepted, rejected or duplicate, and the three add up.
 */
export function ImportForm({ showId }: { showId: string }) {
  const [state, action, pending] = useActionState<ImportPreviewState, FormData>(preview, {});
  const [commitState, commitAction, committing] = useActionState<FormState, FormData>(commit, {});

  return (
    <div className="mt-3 space-y-3">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="file" name="file" accept=".csv,text/csv" className="text-xs" />
        <Submit pending={pending} busy="Reading…">
          Read the file
        </Submit>
        <Message state={state} />
      </form>

      {state.headers && state.counts && (
        <form action={commitAction} className="space-y-3 rounded-md border border-border p-3">
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="text" value={state.text ?? ''} />
          <input type="hidden" name="filename" value={state.filename ?? ''} />

          <p className="text-xs text-text-muted">
            {state.filename ? <span className="font-medium">{state.filename}</span> : 'File'} ·{' '}
            {state.counts.rowsRead} row(s) read · {state.counts.accepted} would be imported,{' '}
            {state.counts.rejected} rejected, {state.counts.duplicates} already here.
          </p>

          <div className="flex flex-wrap gap-2">
            {state.headers.map((header) => (
              <label key={header} className="flex flex-col gap-0.5 text-xs text-text-muted">
                <span className="font-mono">{header}</span>
                <select
                  name={`map:${header}`}
                  defaultValue={state.mapping?.[header] ?? ''}
                  className={input}
                >
                  <option value="">Do not import</option>
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {state.basisUnmapped && (
            <p className="text-xs text-warn">
              No column is mapped to a lawful basis, so every lead in this file will be recorded
              with none. That is the honest outcome for a scanner export — they will be counted and
              followed up, and withheld from anything outbound until somebody records what the booth
              actually said.
            </p>
          )}

          {state.problems && state.problems.length > 0 && (
            <ul className="space-y-0.5 text-xs text-text-muted">
              {state.problems.slice(0, 12).map((p) => (
                <li key={`${p.row}-${p.reason}`}>
                  row {p.row}: {p.reason}
                </li>
              ))}
              {state.problems.length > 12 && (
                <li>…and {state.problems.length - 12} more, all kept on the import record.</li>
              )}
            </ul>
          )}

          <div className="flex items-center gap-3">
            <Submit pending={committing} busy="Importing…">
              Import {state.counts.accepted} lead(s)
            </Submit>
            <QuietSubmit formAction={action} pending={pending} busy="Re-reading…">
              Re-check with this mapping
            </QuietSubmit>
            <Message state={commitState} />
          </div>
        </form>
      )}
    </div>
  );
}
