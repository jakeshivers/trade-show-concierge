'use client';

import { useActionState, useState } from 'react';
import {
  answerRsvp,
  createSideEvent,
  dropRsvp,
  inviteToSideEvent,
  removeSideEvent,
  updateSideEvent,
} from './actions';
import { Button } from '../../../_components/ui';
import type { FormState } from '../../../_components/form';
import { Form, Message, QuietSubmit, Submit, ZonedDateTime, controlClass } from '../../../_components/form-ui';
import { SIDE_EVENT_KINDS } from '@/lib/team/edit';
import type { SideEventEntry } from '@/lib/team/store';
/**
 * Side events and their guest lists — the dinner, the partner briefing, the
 * customer breakfast.
 *
 * A dinner budget is money somebody gets charged for, so an event carries a cost
 * center like every other financial row: set at creation, never backfilled.
 */

/** The one input class string, from `_components/form-ui.tsx`. */
const inputClass = controlClass('compact');

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
        <p className="text-xs text-text-muted">
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
        <Form action={action} state={state} className="inline-flex items-center gap-1">
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="rsvpId" value={rsvpId} />
          <select
            name="status"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={inputClass}
          >
            <option value="invited">invited</option>
            <option value="accepted">accepted</option>
            <option value="tentative">tentative</option>
            <option value="declined">declined</option>
          </select>
          <button
            type="submit"
            disabled={pending || next === status}
            className={`${inputClass} font-medium disabled:opacity-40`}
          >
            Save
          </button>
        </Form>
      )}
      {mayRemove && (
        <Form action={dropAction} state={drop} className="inline">
          <input type="hidden" name="showId" value={showId} />
          <input type="hidden" name="rsvpId" value={rsvpId} />
          <button
            type="submit"
            disabled={dropping}
            className="text-xs text-text-muted hover:text-bad"
          >
            ×
          </button>
        </Form>
      )}
      {(state.error || drop.error) && (
        <span className="text-xs text-bad">
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
    <Form action={action} state={state} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="eventId" value={eventId} />
      <select name="userId" className={inputClass}>
        <option value="">A colleague…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <span className="text-xs text-text-muted">or</span>
      <input name="guestName" placeholder="Guest name" className={inputClass} />
      <input name="guestCompany" placeholder="Company" className={inputClass} />
      <input name="guestEmail" type="email" placeholder="Email" className={inputClass} />
      <Submit pending={pending}>
        Invite
      </Submit>
      <Message state={state} />
    </Form>
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
  return (
    <Form action={action} state={state} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      {event && <input type="hidden" name="eventId" value={event.id} />}
      <input
        name="name"
        required
        defaultValue={event?.name}
        placeholder="Customer dinner"
        className={inputClass}
      />
      <select name="kind" defaultValue={event?.kind ?? 'dinner'} className={inputClass}>
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
        className={inputClass}
      />
      <ZonedDateTime
        label="from"
        dateName="startsOn"
        timeName="startsAt"
        instant={event?.startsAt}
        timeZone={timezone}
        required
      />
      <ZonedDateTime
        label="to"
        dateName="endsOn"
        timeName="endsAt"
        instant={event?.endsAt}
        timeZone={timezone}
      />
      <input
        type="number"
        name="capacity"
        min={1}
        defaultValue={event?.capacity ?? ''}
        placeholder="Seats"
        className={`${inputClass} w-20`}
      />
      <input
        name="budget"
        defaultValue={event?.budgetCents != null ? (event.budgetCents / 100).toFixed(2) : ''}
        placeholder="Budget, e.g. 4500.00"
        className={inputClass}
      />
      <select name="hostId" defaultValue={event?.hostId ?? ''} className={inputClass}>
        <option value="">No host</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.fullName}
          </option>
        ))}
      </select>
      <select name="costCenterId" required defaultValue={event?.costCenterId ?? ''} className={inputClass}>
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
      <Message state={state} />
    </Form>
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
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Add a side event</summary>
      <Fields {...props} action={action} pending={pending} state={state} submitLabel="Add" />
      <p className="mt-2 text-xs text-text-muted">
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
      <summary className="cursor-pointer text-text-muted">Edit this event</summary>
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
      <Form action={dropAction} state={dropState} className="mt-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="eventId" value={entry.event.id} />
        <QuietSubmit pending={dropping}>
          Delete this event
        </QuietSubmit>
        <Message state={dropState} />
      </Form>
    </details>
  );
}
