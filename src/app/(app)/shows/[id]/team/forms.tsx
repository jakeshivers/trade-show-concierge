'use client';

import { useActionState, useState } from 'react';
import {
  answerInvitation,
  answerRsvp,
  assignShift,
  createShift,
  createSideEvent,
  dropRsvp,
  inviteAttendee,
  inviteToSideEvent,
  removeShift,
  removeSideEvent,
  togglePresence,
  unassignShift,
  unstaffAttendee,
  updateAttendee,
  updateShift,
  updateSideEvent,
  type FormState,
} from './actions';
import { Button } from '../../../_components/ui';
import { ATTENDEE_STATUSES, SIDE_EVENT_KINDS } from '@/lib/team/edit';
import type { RosterEntry, ShiftEntry, SideEventEntry } from '@/lib/team/store';

/**
 * The writable team tab.
 *
 * Same rule as the checklist and register forms: a control that would be refused
 * is not rendered, and where the gap could read as a missing feature the reason
 * is written next to it. Two things are specific to this screen:
 *
 * - **Answering an invitation is its own control**, separate from the roster
 *   editor, and it is the one control on the page a Member gets. That is
 *   deliberate: booth coverage counts *confirmations*, so a confirmation typed
 *   by somebody else is a number standing in for a conversation nobody had.
 * - **Removing somebody asks twice when there is a ticket in their name.** The
 *   first refusal is the server's, and it names what is still out there. The
 *   second attempt carries the acknowledgement. See `team/store.ts`.
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

/* -------------------------------- attendees -------------------------------- */

export function AttendeeControls({
  showId,
  timezone,
  entry,
  mayStaff,
}: {
  showId: string;
  timezone: string;
  entry: RosterEntry;
  mayStaff: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      {entry.mayRespond && <AnswerForm showId={showId} timezone={timezone} entry={entry} />}
      {mayStaff && <EditAttendee showId={showId} timezone={timezone} entry={entry} />}
      {mayStaff && <UnstaffForm showId={showId} entry={entry} />}
    </div>
  );
}

function WindowFields({
  timezone,
  attendee,
}: {
  timezone: string;
  attendee: { arrivesOn: Date | null; departsOn: Date | null };
}) {
  const asLocal = (d: Date | null) =>
    d ? { date: iso(d, timezone).slice(0, 10), time: iso(d, timezone).slice(11, 16) } : { date: '', time: '' };
  const a = asLocal(attendee.arrivesOn);
  const b = asLocal(attendee.departsOn);
  return (
    <>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        lands
        <input type="date" name="arrivesOn" defaultValue={a.date} className={input} />
        <input type="time" name="arrivesAt" defaultValue={a.time} className={input} />
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        leaves
        <input type="date" name="departsOn" defaultValue={b.date} className={input} />
        <input type="time" name="departsAt" defaultValue={b.time} className={input} />
      </label>
    </>
  );
}

/** Local wall-clock rendering, so the inputs mean what the show's city means. */
function iso(d: Date, timeZone: string): string {
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
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function AnswerForm({
  showId,
  timezone,
  entry,
}: {
  showId: string;
  timezone: string;
  entry: RosterEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(answerInvitation, {});
  const [status, setStatus] = useState(entry.attendee.status);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="attendeeId" value={entry.attendee.id} />
      <select
        name="status"
        value={status}
        onChange={(e) => setStatus(e.target.value as typeof status)}
        className={input}
      >
        <option value="invited">Not answered</option>
        <option value="confirmed">I&rsquo;m going</option>
        <option value="declined">I can&rsquo;t make it</option>
        <option value="waitlist">Waitlist</option>
      </select>
      <WindowFields timezone={timezone} attendee={entry.attendee} />
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        Save
      </button>
      <Err state={state} />
    </form>
  );
}

function EditAttendee({
  showId,
  timezone,
  entry,
}: {
  showId: string;
  timezone: string;
  entry: RosterEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateAttendee, {});
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">Edit</summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="attendeeId" value={entry.attendee.id} />
        <input name="role" defaultValue={entry.attendee.role} className={input} />
        <select name="status" defaultValue={entry.attendee.status} className={input}>
          {ATTENDEE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <WindowFields timezone={timezone} attendee={entry.attendee} />
        <button type="submit" disabled={pending} className={`${input} font-medium`}>
          Save
        </button>
        <Err state={state} />
      </form>
    </details>
  );
}

function UnstaffForm({ showId, entry }: { showId: string; entry: RosterEntry }) {
  const [state, action, pending] = useActionState<FormState, FormData>(unstaffAttendee, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="attendeeId" value={entry.attendee.id} />
      {/* The second press carries the acknowledgement the server asked for. */}
      <input type="hidden" name="acknowledged" value={state.error ? 'true' : 'false'} />
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        {state.error ? 'Take them off anyway' : 'Take off this show'}
      </button>
      <Err state={state} />
    </form>
  );
}

export function InviteForm({
  showId,
  timezone,
  people,
}: {
  showId: string;
  timezone: string;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(inviteAttendee, {});
  return (
    <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-medium">Staff somebody on this show</summary>
      <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <select name="userId" required className={input}>
          <option value="">Who?</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
        <input name="role" required placeholder="Role, e.g. Technical demos" className={input} />
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          lands
          <input type="date" name="arrivesOn" className={input} />
          <input type="time" name="arrivesAt" className={input} />
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          leaves
          <input type="date" name="departsOn" className={input} />
          <input type="time" name="departsAt" className={input} />
        </label>
        <Button type="submit" disabled={pending}>
          Invite
        </Button>
        <Err state={state} />
        <Ok state={state} />
      </form>
      <p className="mt-2 text-xs text-zinc-500">
        Times are read in the show&rsquo;s own zone ({timezone}). A travel window is optional —
        plenty of people drive — but coverage uses it, so a shift somebody cannot physically reach
        is only visible once it is set.
      </p>
    </details>
  );
}

/* ---------------------------------- shifts --------------------------------- */

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
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={entry.shiftId} />
      <select name="userId" required className={input}>
        <option value="">Assign…</option>
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
    <form action={action} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={shiftId} />
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={pending}
        title="Take off this shift"
        className="text-xs text-zinc-400 hover:text-rose-600"
      >
        ×
      </button>
      <Err state={state} />
    </form>
  );
}

function DeleteShift({ showId, shiftId }: { showId: string; shiftId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(removeShift, {});
  return (
    <form action={action} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={shiftId} />
      <button type="submit" disabled={pending} className="text-xs text-zinc-500 hover:underline">
        Delete shift
      </button>
      <Err state={state} />
    </form>
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
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shiftId" value={entry.shiftId} />
      <input type="hidden" name="present" value="true" />
      <select name="userId" required className={input}>
        <option value="">Was actually there…</option>
        {options.map((s) => (
          <option key={s.userId} value={s.userId}>
            {s.fullName}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        Check in
      </button>
      <Err state={state} />
    </form>
  );
}

export function AddShiftForm({ showId, timezone }: { showId: string; timezone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createShift, {});
  return (
    <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-medium">Add a booth shift</summary>
      <form action={action} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="showId" value={showId} />
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          from
          <input type="date" name="startsOn" required className={input} />
          <input type="time" name="startsAt" required className={input} />
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          to
          <input type="date" name="endsOn" required className={input} />
          <input type="time" name="endsAt" required className={input} />
        </label>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          staff needed
          <input
            type="number"
            name="targetStaff"
            min={1}
            max={20}
            defaultValue={2}
            className={`${input} w-16`}
          />
        </label>
        <input name="notes" placeholder="Notes" className={input} />
        <Button type="submit" disabled={pending}>
          Add shift
        </Button>
        <Err state={state} />
        <Ok state={state} />
      </form>
      <p className="mt-2 text-xs text-zinc-500">Times are {timezone} — the show&rsquo;s zone.</p>
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
  const from = iso(entry.startsAt, timezone);
  const to = iso(entry.endsAt, timezone);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">Edit this shift</summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="shiftId" value={entry.shiftId} />
        <input type="date" name="startsOn" defaultValue={from.slice(0, 10)} className={input} />
        <input type="time" name="startsAt" defaultValue={from.slice(11, 16)} className={input} />
        <input type="date" name="endsOn" defaultValue={to.slice(0, 10)} className={input} />
        <input type="time" name="endsAt" defaultValue={to.slice(11, 16)} className={input} />
        <input
          type="number"
          name="targetStaff"
          min={1}
          max={20}
          defaultValue={entry.targetStaff}
          className={`${input} w-16`}
        />
        <input name="notes" defaultValue={entry.notes ?? ''} placeholder="Notes" className={input} />
        <button type="submit" disabled={pending} className={`${input} font-medium`}>
          Save
        </button>
        <Err state={state} />
      </form>
    </details>
  );
}

/* ------------------------------- side events ------------------------------- */

export function SideEventControls({
  showId,
  timezone,
  entry,
  people,
  costCenters,
  actorId,
}: {
  showId: string;
  timezone: string;
  entry: SideEventEntry;
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
  actorId: string;
}) {
  return (
    <div className="mt-2 space-y-2">
      {entry.mayManage && (
        <>
          <InviteGuestForm showId={showId} eventId={entry.event.id} people={people} />
          <SideEventFields
            showId={showId}
            timezone={timezone}
            entry={entry}
            people={people}
            costCenters={costCenters}
          />
        </>
      )}
      {!entry.mayManage && entry.rsvps.some((r) => r.user?.id === actorId) && (
        <p className="text-xs text-zinc-500">
          Only the host and whoever runs the show change this guest list. Your own answer is on your
          row.
        </p>
      )}
    </div>
  );
}

export function RsvpControl({
  showId,
  rsvpId,
  status,
  mayAnswer,
  mayRemove,
}: {
  showId: string;
  rsvpId: string;
  status: string;
  mayAnswer: boolean;
  mayRemove: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(answerRsvp, {});
  const [drop, dropAction, dropping] = useActionState<FormState, FormData>(dropRsvp, {});
  const [next, setNext] = useState(status);
  if (!mayAnswer && !mayRemove) return null;

  return (
    <span className="inline-flex items-center gap-1">
      {mayAnswer && (
        <form action={action} className="inline-flex items-center gap-1">
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="rsvpId" value={rsvpId} />
          <select
            name="status"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={input}
          >
            <option value="invited">invited</option>
            <option value="accepted">accepted</option>
            <option value="tentative">tentative</option>
            <option value="declined">declined</option>
          </select>
          <button
            type="submit"
            disabled={pending || next === status}
            className={`${input} font-medium disabled:opacity-40`}
          >
            Save
          </button>
        </form>
      )}
      {mayRemove && (
        <form action={dropAction} className="inline">
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="rsvpId" value={rsvpId} />
          <button
            type="submit"
            disabled={dropping}
            className="text-xs text-zinc-400 hover:text-rose-600"
          >
            ×
          </button>
        </form>
      )}
      {(state.error || drop.error) && (
        <span className="text-xs text-rose-700 dark:text-rose-400">
          {state.error ?? drop.error}
        </span>
      )}
    </span>
  );
}

function InviteGuestForm({
  showId,
  eventId,
  people,
}: {
  showId: string;
  eventId: string;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(inviteToSideEvent, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="eventId" value={eventId} />
      <select name="userId" className={input}>
        <option value="">A colleague…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <span className="text-xs text-zinc-400">or</span>
      <input name="guestName" placeholder="Guest name" className={input} />
      <input name="guestCompany" placeholder="Company" className={input} />
      <input name="guestEmail" type="email" placeholder="Email" className={input} />
      <button type="submit" disabled={pending} className={`${input} font-medium`}>
        Invite
      </button>
      <Err state={state} />
    </form>
  );
}

function Fields({
  action,
  pending,
  state,
  showId,
  timezone,
  people,
  costCenters,
  event,
  submitLabel,
}: {
  action: (form: FormData) => void;
  pending: boolean;
  state: FormState;
  showId: string;
  timezone: string;
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
  event?: SideEventEntry['event'];
  submitLabel: string;
}) {
  const from = event ? iso(event.startsAt, timezone) : null;
  const to = event?.endsAt ? iso(event.endsAt, timezone) : null;
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      {event && <input type="hidden" name="eventId" value={event.id} />}
      <input
        name="name"
        required
        defaultValue={event?.name}
        placeholder="Customer dinner"
        className={input}
      />
      <select name="kind" defaultValue={event?.kind ?? 'dinner'} className={input}>
        {SIDE_EVENT_KINDS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <input
        name="location"
        defaultValue={event?.location ?? ''}
        placeholder="Where"
        className={input}
      />
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        from
        <input type="date" name="startsOn" required defaultValue={from?.slice(0, 10)} className={input} />
        <input type="time" name="startsAt" required defaultValue={from?.slice(11, 16)} className={input} />
      </label>
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        to
        <input type="date" name="endsOn" defaultValue={to?.slice(0, 10) ?? ''} className={input} />
        <input type="time" name="endsAt" defaultValue={to?.slice(11, 16) ?? ''} className={input} />
      </label>
      <input
        type="number"
        name="capacity"
        min={1}
        defaultValue={event?.capacity ?? ''}
        placeholder="Seats"
        className={`${input} w-20`}
      />
      <input
        name="budget"
        defaultValue={event?.budgetCents != null ? (event.budgetCents / 100).toFixed(2) : ''}
        placeholder="Budget, e.g. 4500.00"
        className={input}
      />
      <select name="hostId" defaultValue={event?.hostId ?? ''} className={input}>
        <option value="">No host</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <select name="costCenterId" required defaultValue={event?.costCenterId ?? ''} className={input}>
        <option value="">Cost center…</option>
        {costCenters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
      <Err state={state} />
      <Ok state={state} />
    </form>
  );
}

export function AddSideEventForm(props: {
  showId: string;
  timezone: string;
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createSideEvent, {});
  return (
    <details className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-medium">Add a side event</summary>
      <Fields {...props} action={action} pending={pending} state={state} submitLabel="Add" />
      <p className="mt-2 text-xs text-zinc-500">
        A dinner budget is money somebody gets charged for, so it carries a cost center like every
        other financial row — set at creation, never backfilled.
      </p>
    </details>
  );
}

function SideEventFields({
  showId,
  timezone,
  entry,
  people,
  costCenters,
}: {
  showId: string;
  timezone: string;
  entry: SideEventEntry;
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateSideEvent, {});
  const [dropState, dropAction, dropping] = useActionState<FormState, FormData>(
    removeSideEvent,
    {},
  );
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">Edit this event</summary>
      <Fields
        showId={showId}
        timezone={timezone}
        people={people}
        costCenters={costCenters}
        event={entry.event}
        action={action}
        pending={pending}
        state={state}
        submitLabel="Save"
      />
      <form action={dropAction} className="mt-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="eventId" value={entry.event.id} />
        <button type="submit" disabled={dropping} className="text-xs text-zinc-500 hover:underline">
          Delete this event
        </button>
        <Err state={dropState} />
      </form>
    </details>
  );
}
