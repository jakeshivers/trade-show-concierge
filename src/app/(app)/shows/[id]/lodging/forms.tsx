'use client';

import { useActionState } from 'react';
import {
  addRoomGuest,
  createLodging,
  dropRoomGuest,
  removeLodging,
  setCutoffOwner,
  updateLodging,
} from './actions';
import { Button } from '../../../_components/ui';
import { DEFAULT_CHECK_IN, DEFAULT_CHECK_OUT } from '@/lib/lodging/edit';
import type { LodgingEntry } from '@/lib/lodging/store';
import type { FormState } from '../../../_components/form';
import {
  Message,
  QuietSubmit,
  Submit,
  ZonedDateTime,
  controlClass,
} from '../../../_components/form-ui';

/**
 * The lodging tab's controls.
 *
 * The room block cutoff has **one** input on this page and none in the deadline
 * register, which is the whole point: two editable copies of a date is how the
 * date gets missed. What the register keeps for the derived row — an owner and a
 * priced penalty estimate — is offered here too, beside the date it belongs to,
 * rather than making somebody switch tabs to say who is chasing it.
 */

/** The one input class string, from `_components/form-ui.tsx`. */
const inputClass = controlClass('compact');

function Fields({
  action,
  pending,
  state,
  showId,
  timezone,
  costCenters,
  lodging,
  submitLabel,
}: {
  action: (form: FormData) => void;
  pending: boolean;
  state: FormState;
  showId: string;
  timezone: string;
  costCenters: { id: string; code: string; name: string }[];
  lodging?: LodgingEntry['lodging'];
  submitLabel: string;
}) {
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      {lodging && <input type="hidden" name="lodgingId" value={lodging.id} />}
      <input
        name="hotelName"
        required
        defaultValue={lodging?.hotelName}
        placeholder="Hotel"
        className={inputClass}
      />
      <input
        name="confirmationCode"
        defaultValue={lodging?.confirmationCode ?? ''}
        placeholder="Confirmation"
        className={inputClass}
      />
      <input
        name="address"
        defaultValue={lodging?.address ?? ''}
        placeholder="Address"
        className={`${inputClass} min-w-56`}
      />
      <input name="phone" defaultValue={lodging?.phone ?? ''} placeholder="Phone" className={inputClass} />
      <ZonedDateTime
        label="in"
        dateName="checkInOn"
        timeName="checkInAt"
        instant={lodging?.checkIn}
        timeZone={timezone}
        defaultTime={DEFAULT_CHECK_IN}
      />
      <ZonedDateTime
        label="out"
        dateName="checkOutOn"
        timeName="checkOutAt"
        instant={lodging?.checkOut}
        timeZone={timezone}
        defaultTime={DEFAULT_CHECK_OUT}
      />
      <input
        name="nightlyRate"
        defaultValue={lodging?.nightlyRateCents != null ? (lodging.nightlyRateCents / 100).toFixed(2) : ''}
        placeholder="Rate, e.g. 289.00"
        className={inputClass}
      />
      {/*
        The only editable copy of this date in the app. It derives a row in the
        deadline register (lodging/store.ts), and the register refuses to edit it
        there — two editable copies of one date is how the date gets missed.
      */}
      <ZonedDateTime
        label="room block closes"
        dateName="roomBlockCutoffOn"
        timeName="roomBlockCutoffAt"
        instant={lodging?.roomBlockCutoff}
        timeZone={timezone}
        defaultTime="17:00"
      />
      <select
        name="costCenterId"
        required
        defaultValue={lodging?.costCenterId ?? ''}
        className={inputClass}
      >
        <option value="">Cost center…</option>
        {costCenters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
      <input name="notes" defaultValue={lodging?.notes ?? ''} placeholder="Notes" className={inputClass} />
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
      <Message state={state} />
    </form>
  );
}

export function AddLodgingForm(props: {
  showId: string;
  timezone: string;
  costCenters: { id: string; code: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createLodging, {});
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Add a hotel</summary>
      <Fields {...props} action={action} pending={pending} state={state} submitLabel="Add hotel" />
      <p className="mt-2 text-xs text-text-muted">
        Times are read in {props.timezone}, the show&rsquo;s own zone. Setting a room block cutoff
        creates a row in this show&rsquo;s deadline register and the escalation engine takes it from
        there — it arrives unconfirmed, like every hand-entered deadline, so it is chased as a date
        and never quoted as an amount until somebody checks it against the contract.
      </p>
    </details>
  );
}

export function EditLodgingForm({
  showId,
  timezone,
  costCenters,
  entry,
}: {
  showId: string;
  timezone: string;
  costCenters: { id: string; code: string; name: string }[];
  entry: LodgingEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateLodging, {});
  const [dropState, dropAction, dropping] = useActionState<FormState, FormData>(removeLodging, {});
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-text-muted">Edit this hotel</summary>
      <Fields
        showId={showId}
        timezone={timezone}
        costCenters={costCenters}
        lodging={entry.lodging}
        action={action}
        pending={pending}
        state={state}
        submitLabel="Save"
      />
      <form action={dropAction} className="mt-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="lodgingId" value={entry.lodging.id} />
        <QuietSubmit pending={dropping}>
          Delete this hotel record
        </QuietSubmit>
        <Message state={dropState} />
      </form>
    </details>
  );
}

export function RoomGuests({
  showId,
  entry,
}: {
  showId: string;
  entry: LodgingEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(addRoomGuest, {});
  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="lodgingId" value={entry.lodging.id} />
      <select name="userId" required className={inputClass}>
        <option value="">Put somebody in this block…</option>
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
    </form>
  );
}

export function DropGuestButton({
  showId,
  lodgingId,
  userId,
}: {
  showId: string;
  lodgingId: string;
  userId: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(dropRoomGuest, {});
  return (
    <form action={action} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="lodgingId" value={lodgingId} />
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={pending}
        title="Take out of this room block"
        className="text-xs text-text-muted hover:text-bad"
      >
        ×
      </button>
      <Message state={state} />
    </form>
  );
}

export function CutoffOwnerForm({
  showId,
  deadlineId,
  ownerId,
  penaltyEstimateCents,
  people,
}: {
  showId: string;
  deadlineId: string;
  ownerId: string | null;
  penaltyEstimateCents: number | null;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(setCutoffOwner, {});
  return (
    <form action={action} className="mt-1 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="deadlineId" value={deadlineId} />
      <select name="ownerId" defaultValue={ownerId ?? ''} className={inputClass}>
        <option value="">Nobody owns it</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <input
        name="penaltyEstimate"
        defaultValue={penaltyEstimateCents != null ? (penaltyEstimateCents / 100).toFixed(2) : ''}
        placeholder="What blowing it costs, e.g. 6200.00"
        className={`${inputClass} min-w-56`}
      />
      <Submit pending={pending}>
        Save
      </Submit>
      <Message state={state} />
    </form>
  );
}
