'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { MoneyParseError } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import {
  addAttendee,
  addRsvp,
  addShift,
  addSideEvent,
  assignToShift,
  clearPresence,
  deleteShift,
  deleteSideEvent,
  editAttendee,
  editShift,
  editSideEvent,
  recordPresence,
  removeAttendee,
  removeRsvp,
  respondToInvitation,
  setRsvpStatus,
  unassignFromShift,
} from '@/lib/team/store';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

/**
 * The team tab's writes. Same posture as the readiness and register actions: the
 * actor is re-resolved server-side on every call, and `team/access.ts` is the
 * control — the buttons a screen declines to render are a courtesy.
 */

const EXPECTED = [TeamError, ForbiddenError, NotFoundError, ZonedTimeError, MoneyParseError];

const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/team`);
  revalidatePath(`/shows/${showId}/lodging`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/itinerary');
}

/* -------------------------------- attendees -------------------------------- */

function windowFrom(form: FormData) {
  return {
    arrivesOn: optional(form, 'arrivesOn'),
    arrivesAt: optional(form, 'arrivesAt'),
    departsOn: optional(form, 'departsOn'),
    departsAt: optional(form, 'departsAt'),
  };
}

export async function inviteAttendee(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addAttendee(actor, showId, {
      userId: str(form, 'userId'),
      role: str(form, 'role'),
      status: 'invited',
      ...windowFrom(form),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Invited. They stay “invited” until they answer for themselves — booth coverage counts confirmations, and a confirmation nobody gave is a hole that looks filled.',
  };
}

export async function updateAttendee(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editAttendee(actor, str(form, 'attendeeId'), {
      userId: '',
      role: str(form, 'role'),
      status: str(form, 'status'),
      ...windowFrom(form),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Roster updated.' };
}

export async function answerInvitation(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await respondToInvitation(actor, str(form, 'attendeeId'), str(form, 'status'), windowFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Answered.' };
}

export async function unstaffAttendee(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await removeAttendee(actor, str(form, 'attendeeId'), form.get('acknowledged') === 'true');
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Taken off this show. Nothing outside this app was cancelled.' };
}

/* ---------------------------------- shifts --------------------------------- */

function shiftFrom(form: FormData) {
  return {
    startsOn: str(form, 'startsOn'),
    startsAt: str(form, 'startsAt'),
    endsOn: str(form, 'endsOn'),
    endsAt: str(form, 'endsAt'),
    targetStaff: str(form, 'targetStaff'),
    notes: optional(form, 'notes'),
  };
}

export async function createShift(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addShift(actor, showId, shiftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Shift added.' };
}

export async function updateShift(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editShift(actor, str(form, 'shiftId'), shiftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Shift updated.' };
}

export async function removeShift(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await deleteShift(actor, str(form, 'shiftId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Shift deleted.' };
}

export async function assignShift(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await assignToShift(actor, str(form, 'shiftId'), str(form, 'userId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

export async function unassignShift(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await unassignFromShift(actor, str(form, 'shiftId'), str(form, 'userId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

export async function togglePresence(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const present = form.get('present') === 'true';
  try {
    if (present) await recordPresence(actor, str(form, 'shiftId'), str(form, 'userId'));
    else await clearPresence(actor, str(form, 'shiftId'), str(form, 'userId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

/* ------------------------------- side events ------------------------------- */

function sideEventFrom(form: FormData) {
  return {
    name: str(form, 'name'),
    kind: str(form, 'kind'),
    location: optional(form, 'location'),
    startsOn: str(form, 'startsOn'),
    startsAt: str(form, 'startsAt'),
    endsOn: optional(form, 'endsOn'),
    endsAt: optional(form, 'endsAt'),
    capacity: optional(form, 'capacity'),
    budget: optional(form, 'budget'),
    hostId: optional(form, 'hostId'),
    costCenterId: str(form, 'costCenterId'),
    notes: optional(form, 'notes'),
  };
}

export async function createSideEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addSideEvent(actor, showId, sideEventFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Side event added.' };
}

export async function updateSideEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editSideEvent(actor, str(form, 'eventId'), sideEventFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Side event updated.' };
}

export async function removeSideEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await deleteSideEvent(actor, str(form, 'eventId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Side event deleted.' };
}

export async function inviteToSideEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addRsvp(actor, str(form, 'eventId'), {
      userId: optional(form, 'userId'),
      guestName: optional(form, 'guestName'),
      guestEmail: optional(form, 'guestEmail'),
      guestCompany: optional(form, 'guestCompany'),
      status: 'invited',
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Added to the guest list.' };
}

export async function answerRsvp(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await setRsvpStatus(actor, str(form, 'rsvpId'), str(form, 'status'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}

export async function dropRsvp(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await removeRsvp(actor, str(form, 'rsvpId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}
