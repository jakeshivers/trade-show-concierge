'use client';

import { useActionState } from 'react';
import {
  assignShift,
  createShift,
  removeShift,
  togglePresence,
  unassignShift,
  updateShift,
} from './actions';
import { Button } from '../../../_components/ui';
import type { FormState } from '../../../_components/form';
import { Form, Message, QuietSubmit, Submit, ZonedDateTime, controlClass } from '../../../_components/form-ui';
import type { ShiftEntry } from '@/lib/team/store';
/**
 * Booth shifts: the window, how many people it needs, who is assigned, and — once
 * it has run — who actually stood there.
 *
 * Assignment and presence are deliberately different controls, because they are
 * different claims. `shift_assignments` is a plan and `shift_presence` is a
 * record of what happened, and the check-in control only appears on a shift that
 * is over: offering it beforehand invites somebody to pre-record their own
 * attendance, which turns the one honest number on the page into another
 * forecast.
 */

/** The one input class string, from `_components/form-ui.tsx`. */
const inputClass = controlClass('compact');

export function ShiftControls({
  showId,
  entry,
  mayStaff,
  actorId,
}: {
  showId: string;
  entry: ShiftEntry;
  mayStaff: boolean;
  actorId: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {mayStaff && entry.assignable.length > 0 && (
        <AssignForm showId={showId} entry={entry} />
      )}
      {mayStaff && <DeleteShift showId={showId} shiftId={entry.shiftId} />}
      {entry.presence && (
        <PresenceForm showId={showId} entry={entry} actorId={actorId} mayStaff={mayStaff} />
      )}
    </div>
  );
}

function AssignForm({ showId, entry }: { showId: string; entry: ShiftEntry }) {
  const [state, action, pending] = useActionState<FormState, FormData>(assignShift, {});
  return (
    <Form action={action} state={state} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={entry.shiftId} />
      <select name="userId" required className={inputClass}>
        <option value="">Assign…</option>
        {entry.assignable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <Submit pending={pending}>
        Add
      </Submit>
      <Message state={state} />
    </Form>
  );
}

export function UnassignButton({
  showId,
  shiftId,
  userId,
}: {
  showId: string;
  shiftId: string;
  userId: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(unassignShift, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={shiftId} />
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={pending}
        title="Take off this shift"
        className="text-xs text-text-muted hover:text-bad"
      >
        ×
      </button>
      <Message state={state} />
    </Form>
  );
}

function DeleteShift({ showId, shiftId }: { showId: string; shiftId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(removeShift, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={shiftId} />
      <QuietSubmit pending={pending}>
        Delete shift
      </QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

function PresenceForm({
  showId,
  entry,
  actorId,
  mayStaff,
}: {
  showId: string;
  entry: ShiftEntry;
  actorId: string;
  mayStaff: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(togglePresence, {});
  const mine = entry.standings.find((s) => s.userId === actorId);
  const options = mayStaff ? entry.standings : mine ? [mine] : [];
  if (options.length === 0) return null;

  return (
    <Form action={action} state={state} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={entry.shiftId} />
      <input type="hidden" name="present" value="true" />
      <select name="userId" required className={inputClass}>
        <option value="">Was actually there…</option>
        {options.map((s) => (
          <option key={s.userId} value={s.userId}>
            {s.fullName}
          </option>
        ))}
      </select>
      <Submit pending={pending}>
        Check in
      </Submit>
      <Message state={state} />
    </Form>
  );
}

export function AddShiftForm({ showId, timezone }: { showId: string; timezone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createShift, {});
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Add a booth shift</summary>
      <Form action={action} state={state} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="showId" value={showId} />
        <ZonedDateTime label="from" dateName="startsOn" timeName="startsAt" timeZone={timezone} required />
        <ZonedDateTime label="to" dateName="endsOn" timeName="endsAt" timeZone={timezone} required />
        <label className="flex items-center gap-1 text-xs text-text-muted">
          staff needed
          <input
            type="number"
            name="targetStaff"
            min={1}
            max={20}
            defaultValue={2}
            className={`${inputClass} w-16`}
          />
        </label>
        <input name="notes" placeholder="Notes" className={inputClass} />
        <Button type="submit" disabled={pending}>
          Add shift
        </Button>
        <Message state={state} />
      </Form>
      <p className="mt-2 text-xs text-text-muted">Times are {timezone} — the show&rsquo;s zone.</p>
    </details>
  );
}

export function EditShiftForm({
  showId,
  timezone,
  entry,
}: {
  showId: string;
  timezone: string;
  entry: ShiftEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateShift, {});
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-text-muted">Edit this shift</summary>
      <Form action={action} state={state} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="shiftId" value={entry.shiftId} />
        <ZonedDateTime
          label="from"
          dateName="startsOn"
          timeName="startsAt"
          instant={entry.startsAt}
          timeZone={timezone}
        />
        <ZonedDateTime
          label="to"
          dateName="endsOn"
          timeName="endsAt"
          instant={entry.endsAt}
          timeZone={timezone}
        />
        <input
          type="number"
          name="targetStaff"
          min={1}
          max={20}
          defaultValue={entry.targetStaff}
          className={`${inputClass} w-16`}
        />
        <input name="notes" defaultValue={entry.notes ?? ''} placeholder="Notes" className={inputClass} />
        <Submit pending={pending}>
          Save
        </Submit>
        <Message state={state} />
      </Form>
    </details>
  );
}
