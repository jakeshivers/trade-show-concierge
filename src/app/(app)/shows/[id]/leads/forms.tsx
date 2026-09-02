'use client';

import { useActionState, useState } from 'react';
import {
  addMeeting,
  addTargetAccount,
  capture,
  commit,
  editLead,
  erase,
  markAsDuplicate,
  preview,
  removeTargetAccount,
  runRetention,
  unmarkAsDuplicate,
  type ImportPreviewState,
} from './actions';
import { FIELD_LABEL, type LeadField } from '@/lib/leads/parse';
import type { FormState } from '../../../_components/form';
import { plural } from '../../../_components/text';
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
  { value: '', label: 'Why we may follow up: not recorded' },
  { value: 'legitimate_interest', label: 'Legitimate interest (they gave us the badge)' },
  { value: 'consent', label: 'Consent (they were told, and agreed)' },
];

export type EditableLead = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  interests: string[] | null;
  basis: string;
  consentNotice: string | null;
};

/**
 * Correcting a lead.
 *
 * The same fields as capture and one behaviour that is not: the consent select
 * starts on whatever is *recorded*, so opening this on a scanner lead lands on
 * "not recorded" and the notice box appears the moment somebody picks consent —
 * which is the edit this form mostly exists for. `consent.ts` withholds those
 * rows from every outbound path until it happens, and two places on this page
 * tell the reader to come and do it.
 *
 * No `externalRef` control, on purpose. See `updateLead`.
 */
export function EditLeadForm({ showId, lead }: { showId: string; lead: EditableLead }) {
  const [state, action, pending] = useActionState<FormState, FormData>(editLead, {});
  const [basis, setBasis] = useState(lead.basis === 'unknown' ? '' : lead.basis);

  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="leadId" value={lead.id} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="fullName" required defaultValue={lead.fullName} placeholder="Name" className={input} />
        <input name="email" type="email" defaultValue={lead.email ?? ''} placeholder="Email" className={input} />
        <input name="company" defaultValue={lead.company ?? ''} placeholder="Company" className={input} />
        <input name="title" defaultValue={lead.title ?? ''} placeholder="Job title" className={input} />
        <input name="phone" defaultValue={lead.phone ?? ''} placeholder="Phone" className={input} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="interests"
          defaultValue={lead.interests?.join(', ') ?? ''}
          placeholder="Interests, comma separated"
          className={`${input} min-w-56`}
        />
        <input name="notes" defaultValue={lead.notes ?? ''} placeholder="Notes" className={`${input} min-w-64`} />
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
            defaultValue={lead.consentNotice ?? ''}
            placeholder="What they were told"
            className={`${input} min-w-64`}
          />
        )}
        <Submit pending={pending} busy="Saving…">
          Save
        </Submit>
      </div>
      <Message state={state} />
    </form>
  );
}

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
          Capture lead
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

/**
 * "Same person" / "two people" on a pair the machine would not settle.
 *
 * Deliberately two plain controls rather than a merge dialog: there is nothing
 * to merge. One row stops counting, and the other does not change at all.
 */
export function DuplicateForm({
  showId,
  leadId,
  ofLeadId,
}: {
  showId: string;
  leadId: string;
  ofLeadId: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(markAsDuplicate, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="ofLeadId" value={ofLeadId} />
      <Submit pending={pending} busy="Saving…">
        Same person — count once
      </Submit>
      <Message state={state} />
    </form>
  );
}

export function UndoDuplicateForm({ showId, leadId }: { showId: string; leadId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(unmarkAsDuplicate, {});
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="leadId" value={leadId} />
      <QuietSubmit pending={pending} busy="Saving…">
        Not a duplicate
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
            {state.counts.rowsRead} rows read · {state.counts.accepted} would be imported,{' '}
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
              No column says why we may follow up, so these leads will be imported without that on
              record. Scanner exports usually do not carry it. They will still be counted and you can
              still follow up on the conversation, but they will not go to marketing or a CRM until
              somebody records what the person was told.
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
              Import {plural(state.counts.accepted, 'lead', 'leads')}
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

/* ------------------------------ target accounts ----------------------------- */

export function TargetForm({
  showId,
  people,
}: {
  showId: string;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(addTargetAccount, {});
  const [priority, setPriority] = useState('target');

  return (
    <form action={action} className="mt-3 space-y-2">
      <input type="hidden" name="showId" value={showId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="companyName" required placeholder="Company" className={input} />
        <input
          name="aliases"
          placeholder="Other spellings, comma separated"
          className={`${input} min-w-56`}
        />
        <select
          name="priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className={input}
        >
          <option value="must_meet">Must meet</option>
          <option value="target">Target</option>
          <option value="watch">Watch</option>
        </select>
        <select name="ownerId" className={input} defaultValue="">
          <option value="">Nobody owns it yet</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* Required for a must-meet, and the store enforces it: this is the
            sentence somebody at the booth reads before they walk over. */}
        <input
          name="reason"
          required={priority === 'must_meet'}
          placeholder={
            priority === 'must_meet'
              ? 'Why — the sentence somebody at the booth reads'
              : 'Why (optional)'
          }
          className={`${input} min-w-72`}
        />
        <Submit pending={pending} busy="Saving…">
          Add target
        </Submit>
      </div>
      <Message state={state} />
    </form>
  );
}

export function RemoveTargetForm({ showId, targetId }: { showId: string; targetId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(removeTargetAccount, {});
  return (
    <form action={action} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="targetId" value={targetId} />
      <QuietSubmit pending={pending} busy="…">
        Remove
      </QuietSubmit>
      <Message state={state} />
    </form>
  );
}
