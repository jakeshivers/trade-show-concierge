'use client';

import { useActionState, useState } from 'react';
import {
  answerInvitation,
  inviteAttendee,
  unstaffAttendee,
  updateAttendee,
} from './actions';
import { Button } from '../../../_components/ui';
import type { FormState } from '../../../_components/form';
import {
  Message,
  Submit,
  ZonedDateTime,
  controlClass,
} from '../../../_components/form-ui';
import { ATTENDEE_STATUSES } from '@/lib/team/edit';
import type { RosterEntry } from '@/lib/team/store';
/**
 * The roster: who is going, whether they have said so, and when they are in town.
 *
 * Two rules shape this file and neither is cosmetic:
 *
 * - **Answering an invitation is its own control**, separate from the roster
 *   editor. Booth coverage counts *confirmations* (`team/coverage.ts`), so a
 *   confirmation typed by somebody else is a number standing in for a
 *   conversation nobody had — and it renders as a filled slot, which is the one
 *   thing nobody looks at again.
 * - **Removing somebody asks twice when there is a ticket in their name.** The
 *   first refusal is the server's and it names what is still out there; the
 *   second attempt carries the acknowledgement. Un-staffing cancels nothing
 *   outside this app. See `team/store.ts`.
 */

/** The one input class string, from `_components/form-ui.tsx`. */
const inputClass = controlClass('compact');

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
      {entry.isSelf ? (
        <AnswerForm showId={showId} timezone={timezone} entry={entry} />
      ) : (
        entry.mayRespond && <RecordAnswerForm showId={showId} timezone={timezone} entry={entry} />
      )}
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
  return (
    <>
      <ZonedDateTime
        label="lands"
        dateName="arrivesOn"
        timeName="arrivesAt"
        instant={attendee.arrivesOn}
        timeZone={timezone}
      />
      <ZonedDateTime
        label="leaves"
        dateName="departsOn"
        timeName="departsAt"
        instant={attendee.departsOn}
        timeZone={timezone}
      />
    </>
  );
}

/**
 * Your own row. First person, because it is you answering.
 */
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
        className={inputClass}
      >
        <option value="invited">Not answered</option>
        <option value="confirmed">I&rsquo;m going</option>
        <option value="declined">I can&rsquo;t make it</option>
        <option value="waitlist">Waitlist</option>
      </select>
      <WindowFields timezone={timezone} attendee={entry.attendee} />
      <Submit pending={pending}>
        Save
      </Submit>
      <Message state={state} />
    </form>
  );
}

/**
 * Somebody else's row, when you may answer for them.
 *
 * The permission is right and stays: people go on leave, and a roster only its
 * subject can correct fills up with stale rows. The *framing* was the defect —
 * an admin opening this tab was shown "I'm going" on all five colleagues' rows,
 * because the control was written once for the actor's own row and then rendered
 * wherever the permission happened to allow.
 *
 * So it is a different control with a different name. Recording what somebody
 * told you is a legitimate act; it is just not the same act, and it says on the
 * row that the store will not stamp `responded_at` for it — because a
 * confirmation is only a confirmation when its subject made it, and booth
 * coverage counts confirmations.
 */
function RecordAnswerForm({
  showId,
  timezone,
  entry,
}: {
  showId: string;
  timezone: string;
  entry: RosterEntry;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(answerInvitation, {});
  const first = entry.user.fullName.split(' ')[0];

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">Record {first}&rsquo;s answer</summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="attendeeId" value={entry.attendee.id} />
        <select name="status" defaultValue={entry.attendee.status} className={inputClass}>
          <option value="invited">Not answered</option>
          <option value="confirmed">Said they are going</option>
          <option value="declined">Said they cannot make it</option>
          <option value="waitlist">Waitlist</option>
        </select>
        <WindowFields timezone={timezone} attendee={entry.attendee} />
        <Submit pending={pending}>Record</Submit>
        <Message state={state} />
        <p className="w-full text-zinc-500">
          Secondhand: the row is only marked answered when {first} answers it.
        </p>
      </form>
    </details>
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
        <input name="role" defaultValue={entry.attendee.role} className={inputClass} />
        <select name="status" defaultValue={entry.attendee.status} className={inputClass}>
          {ATTENDEE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <WindowFields timezone={timezone} attendee={entry.attendee} />
        <Submit pending={pending}>
          Save
        </Submit>
        <Message state={state} />
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
      <Submit pending={pending}>
        {state.error ? 'Take them off anyway' : 'Take off this show'}
      </Submit>
      <Message state={state} />
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
        <select name="userId" required className={inputClass}>
          <option value="">Who?</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
        <input name="role" required placeholder="Role, e.g. Technical demos" className={inputClass} />
        <ZonedDateTime label="lands" dateName="arrivesOn" timeName="arrivesAt" timeZone={timezone} />
        <ZonedDateTime label="leaves" dateName="departsOn" timeName="departsAt" timeZone={timezone} />
        <Button type="submit" disabled={pending}>
          Invite
        </Button>
        <Message state={state} />
      </form>
      <p className="mt-2 text-xs text-zinc-500">
        Times are read in the show&rsquo;s own zone ({timezone}). A travel window is optional —
        plenty of people drive — but coverage uses it, so a shift somebody cannot physically reach
        is only visible once it is set.
      </p>
    </details>
  );
}
