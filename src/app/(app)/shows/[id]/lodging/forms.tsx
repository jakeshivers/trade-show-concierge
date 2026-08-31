'use client';

import { useActionState } from 'react';
import {
  addRoomGuest,
  createLodging,
  dropRoomGuest,
  removeLodging,
  setCutoffOwner,
  updateLodging,
  type FormState,
} from './actions';
import { Button } from '../../../_components/ui';
import { DEFAULT_CHECK_IN, DEFAULT_CHECK_OUT } from '@/lib/lodging/edit';
import type { LodgingEntry } from '@/lib/lodging/store';

/**
 * The lodging tab's controls.
 *
 * The room block cutoff has **one** input on this page and none in the deadline
 * register, which is the whole point: two editable copies of a date is how the
 * date gets missed. What the register keeps for the derived row — an owner and a
 * priced penalty estimate — is offered here too, beside the date it belongs to,
 * rather than making somebody switch tabs to say who is chasing it.
 */

const input =
  'rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950';

function Err({ state }: { state: FormState }) {
  if (!state.error) return null;
  return <span className="w-full text-xs text-rose-700 dark:text-rose-400">{state.error}</span>;
}

function Ok({ state }: { state: FormState }) {
  if (!state.ok) return null;
  return <span className="w-full text-xs text-emerald-700 dark:text-emerald-400">{state.ok}</span>;
}

function local(d: Date | null, timeZone: string): { date: string; time: string } {
  if (!d) return { date: '', time: '' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

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
  const checkIn = local(lodging?.checkIn ?? null, timezone);
  const checkOut = local(lodging?.checkOut ?? null, timezone);
  const cutoff = local(lodging?.roomBlockCutoff ?? null, timezone);

  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      {lodging && <input type="hidden" name="lodgingId" value={lodging.id} />}
      <input
        name="hotelName"
        required
        defaultValue={lodging?.hotelName}
        placeholder="Hotel"
        className={input}
      />
      <input
        name="confirmationCode"
        defaultValue={lodging?.confirmationCode ?? ''}
        placeholder="Confirmation"
        className={input}
      />
      <input
        name="address"
        defaultValue={lodging?.address ?? ''}
        placeholder="Address"
        className={`${input} min-w-56`}
      />
      <input name="phone" defaultValue={lodging?.phone ?? ''} placeholder="Phone" className={input} />
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        in
        <input type="date" name="checkInOn" defaultValue={checkIn.date} className={input} />
        <input
          type="time"
          name="checkInAt"
          defaultValue={checkIn.time || DEFAULT_CHECK_IN}
          className={input}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        out
        <input type="date" name="checkOutOn" defaultValue={checkOut.date} className={input} />
        <input
          type="time"
          name="checkOutAt"
          defaultValue={checkOut.time || DEFAULT_CHECK_OUT}
          className={input}
        />
      </label>
      <input
        name="nightlyRate"
        defaultValue={lodging?.nightlyRateCents != null ? (lodging.nightlyRateCents / 100).toFixed(2) : ''}
        placeholder="Rate, e.g. 289.00"
        className={input}
      />
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        room block closes
        <input
          type="date"
          name="roomBlockCutoffOn"
          defaultValue={cutoff.date}
          className={input}
        />
        <input
          type="time"
          name="roomBlockCutoffAt"
          defaultValue={cutoff.time || '17:00'}
          className={input}
        />
      </label>
      <select
        name="costCenterId"
        required
        defaultValue={lodging?.costCenterId ?? ''}
        className={input}
      >
        <option value="">Cost center…</option>
        {costCenters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
      <input name="notes" defaultValue={lodging?.notes ?? ''} placeholder="Notes" className={input} />
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
      <Err state={state} />
      <Ok state={state} />
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
    <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-medium">Add a hotel</summary>
      <Fields {...props} action={action} pending={pending} state={state} submitLabel="Add hotel" />
      <p className="mt-2 text-xs text-zinc-500">
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
      <summary className="cursor-pointer text-zinc-500">Edit this hotel</summary>
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
        <button type="submit" disabled={dropping} className="text-xs text-zinc-500 hover:underline">
          Delete this hotel record
        </button>
        <Err state={dropState} />
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
      <select name="userId" required className={input}>
        <option value="">Put somebody in this block…</option>
        {entry.assignable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        Add
      </button>
      <Err state={state} />
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
        className="text-xs text-zinc-400 hover:text-rose-600"
      >
        ×
      </button>
      <Err state={state} />
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
      <select name="ownerId" defaultValue={ownerId ?? ''} className={input}>
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
        className={`${input} min-w-56`}
      />
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        Save
      </button>
      <Err state={state} />
    </form>
  );
}
