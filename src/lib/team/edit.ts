import { optionalDecimalToCents } from '@/lib/money/decimal';
import type { AttendeeStatus } from './coverage';

/**
 * The team screens as pure functions: what a row must contain, and what a change
 * has to carry with it.
 *
 * Shaped like `readiness/edit.ts` and `deadlines/edit.ts` — validation here, rows
 * in `store.ts`. Two rules are specific to people rather than to tasks or dates:
 *
 * 1. **Every time on this screen is a local time, read in the show's zone.** A
 *    booth shift is "9am to 1pm" in the convention centre's city and nowhere
 *    else, and a dinner at 7pm is 7pm there. This is `deadlines/edit.ts`'s rule
 *    arriving from a second direction, and the register's argument holds here
 *    too: the alternative is a grid that is an hour wrong twice a year.
 * 2. **Taking somebody off a show does not cancel what was bought for them.**
 *    A ticket is with the airline, a room is with the hotel, and un-staffing
 *    someone in this app tells neither. Same shape as the cancel correction at
 *    step 9 (SCOPE.md §6d) and answered the same way — not by refusing, and not
 *    by pretending, but by making the person do it deliberately with the list in
 *    front of them. See `describeDetachment` below.
 */

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

export const ATTENDEE_STATUSES: AttendeeStatus[] = [
  'invited',
  'confirmed',
  'declined',
  'waitlist',
];

export type SideEventKind = 'dinner' | 'demo' | 'seminar' | 'reception' | 'meeting' | 'other';

export const SIDE_EVENT_KINDS: SideEventKind[] = [
  'dinner',
  'demo',
  'seminar',
  'reception',
  'meeting',
  'other',
];

export type RsvpStatus = 'invited' | 'accepted' | 'declined' | 'tentative';

export const RSVP_STATUSES: RsvpStatus[] = ['invited', 'accepted', 'declined', 'tentative'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `YYYY-MM-DD` + `HH:MM`, both required together or both absent. */
export function requireLocalDateTime(date: string, time: string, what: string): string {
  if (!DATE.test(date.trim())) throw new TeamError(`${what} needs a date, as YYYY-MM-DD.`);
  if (!TIME.test(time.trim())) {
    throw new TeamError(
      `${what} needs a time of day, as HH:MM in the show’s own time zone — a booth grid ` +
        'read in the reader’s browser zone is wrong for everyone who travelled to be there.',
    );
  }
  return `${date.trim()}T${time.trim()}:00`;
}

/* -------------------------------- attendees -------------------------------- */

export type AttendeeDraft = {
  userId: string;
  role: string;
  status: string;
  /** `YYYY-MM-DD` in the show's zone, or empty for "not planned yet". */
  arrivesOn?: string | null;
  arrivesAt?: string | null;
  departsOn?: string | null;
  departsAt?: string | null;
  notes?: string | null;
};

export type ValidatedAttendee = {
  userId: string;
  role: string;
  status: AttendeeStatus;
  /** Naive local strings; `store.ts` resolves them against the show's zone. */
  arrivesLocal: string | null;
  departsLocal: string | null;
  notes: string | null;
};

export function validateAttendee(draft: AttendeeDraft): ValidatedAttendee {
  const userId = draft.userId?.trim() ?? '';
  if (!userId) throw new TeamError('Pick somebody to staff on this show.');

  const role = draft.role.trim();
  if (role.length < 2) throw new TeamError('A roster row needs a role — what are they there to do?');
  if (role.length > 80) throw new TeamError('Roles are capped at 80 characters.');

  if (!ATTENDEE_STATUSES.includes(draft.status as AttendeeStatus)) {
    throw new TeamError(`"${draft.status}" is not an attendance status.`);
  }

  // A travel window is optional — plenty of people drive, and forcing a guess
  // here would put a fabricated arrival time into the coverage model, which
  // counts on it (`coverage.ts`). But half a window is not information.
  const arrivesLocal = optionalWindowEnd(draft.arrivesOn, draft.arrivesAt, 'Arrival');
  const departsLocal = optionalWindowEnd(draft.departsOn, draft.departsAt, 'Departure');
  if (arrivesLocal && departsLocal && departsLocal <= arrivesLocal) {
    throw new TeamError('Departure has to be after arrival.');
  }

  return {
    userId,
    role,
    status: draft.status as AttendeeStatus,
    arrivesLocal,
    departsLocal,
    notes: draft.notes?.trim() || null,
  };
}

function optionalWindowEnd(
  date: string | null | undefined,
  time: string | null | undefined,
  what: string,
): string | null {
  const d = date?.trim() ?? '';
  const t = time?.trim() ?? '';
  if (!d && !t) return null;
  if (!d) throw new TeamError(`${what} has a time but no date.`);
  return requireLocalDateTime(d, t || '12:00', `${what} time`);
}

/**
 * What is already attached to this person on this show, in words.
 *
 * Un-staffing somebody is allowed — people drop off shows constantly. What is
 * not allowed is doing it without seeing that a ticket in their name still
 * exists. `store.ts` refuses the write unless the caller passes the
 * acknowledgement, and this is the sentence it refuses with.
 */
export type Detachment = {
  ticketedFlights: number;
  lodgingRooms: number;
  shifts: number;
  acceptedSideEvents: number;
};

export function describeDetachment(d: Detachment): string | null {
  const parts: string[] = [];
  if (d.ticketedFlights)
    parts.push(
      `${d.ticketedFlights} ticketed flight${d.ticketedFlights === 1 ? '' : 's'} — still with the airline; taking them off this roster does not cancel or refund anything`,
    );
  if (d.lodgingRooms)
    parts.push(
      `${d.lodgingRooms} hotel room assignment${d.lodgingRooms === 1 ? '' : 's'} — the reservation stays with the hotel`,
    );
  if (d.shifts)
    parts.push(`${d.shifts} booth shift${d.shifts === 1 ? '' : 's'}, which will be dropped`);
  if (d.acceptedSideEvents)
    parts.push(
      `${d.acceptedSideEvents} accepted side-event RSVP${d.acceptedSideEvents === 1 ? '' : 's'}, which will be dropped`,
    );
  if (parts.length === 0) return null;
  return `This person has ${parts.join('; ')}.`;
}

/* ---------------------------------- shifts --------------------------------- */

export type ShiftDraft = {
  startsOn: string;
  startsAt: string;
  endsOn: string;
  endsAt: string;
  targetStaff: number | string;
  notes?: string | null;
};

export type ValidatedShift = {
  startsLocal: string;
  endsLocal: string;
  targetStaff: number;
  notes: string | null;
};

export const MAX_SHIFT_HOURS = 14;

export function validateShift(draft: ShiftDraft): ValidatedShift {
  const startsLocal = requireLocalDateTime(draft.startsOn ?? '', draft.startsAt ?? '', 'A shift start');
  const endsLocal = requireLocalDateTime(draft.endsOn ?? '', draft.endsAt ?? '', 'A shift end');
  if (endsLocal <= startsLocal) throw new TeamError('A shift has to end after it starts.');

  // Naive strings sort correctly and the difference is only used as a sanity
  // bound, so this does not need the zone. A 20-hour "shift" is a typo, and one
  // typo here quietly halves every coverage figure on the show.
  const hours =
    (Date.parse(`${endsLocal}Z`) - Date.parse(`${startsLocal}Z`)) / 3_600_000;
  if (hours > MAX_SHIFT_HOURS) {
    throw new TeamError(
      `That is a ${Math.round(hours)}-hour shift. Booth coverage is rostered in slots people ` +
        `can actually stand; split it into shifts of ${MAX_SHIFT_HOURS} hours or less.`,
    );
  }

  const target = Number(draft.targetStaff);
  if (!Number.isInteger(target) || target < 1 || target > 20) {
    throw new TeamError('A shift needs a staffing target between 1 and 20.');
  }

  return { startsLocal, endsLocal, targetStaff: target, notes: draft.notes?.trim() || null };
}

/* ------------------------------- side events ------------------------------- */

export type SideEventDraft = {
  name: string;
  kind: string;
  location?: string | null;
  startsOn: string;
  startsAt: string;
  endsOn?: string | null;
  endsAt?: string | null;
  capacity?: string | number | null;
  /** A decimal string as typed, e.g. "4500.00". Never a float. */
  budget?: string | null;
  hostId?: string | null;
  costCenterId: string;
  notes?: string | null;
};

export type ValidatedSideEvent = {
  name: string;
  kind: SideEventKind;
  location: string | null;
  startsLocal: string;
  endsLocal: string | null;
  capacity: number | null;
  budgetCents: number | null;
  hostId: string | null;
  costCenterId: string;
  notes: string | null;
};

export function validateSideEvent(draft: SideEventDraft): ValidatedSideEvent {
  const name = draft.name.trim();
  if (name.length < 3) throw new TeamError('A side event needs a name.');
  if (name.length > 200) throw new TeamError('Side event names are capped at 200 characters.');

  if (!SIDE_EVENT_KINDS.includes(draft.kind as SideEventKind)) {
    throw new TeamError(`"${draft.kind}" is not a side event kind.`);
  }

  const startsLocal = requireLocalDateTime(draft.startsOn ?? '', draft.startsAt ?? '', 'A side event');
  const endsLocal =
    draft.endsOn?.trim() || draft.endsAt?.trim()
      ? requireLocalDateTime(draft.endsOn ?? '', draft.endsAt ?? '', 'The side event end')
      : null;
  if (endsLocal && endsLocal <= startsLocal) {
    throw new TeamError('A side event has to end after it starts.');
  }

  let capacity: number | null = null;
  if (draft.capacity != null && String(draft.capacity).trim() !== '') {
    capacity = Number(draft.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TeamError('Capacity is a whole number of seats, or blank for no limit.');
    }
  }

  // Through the shared decimal parser, never parseFloat — a dinner budget is a
  // financial row and §4's rule is that every one of those carries a cost center.
  const budgetCents = optionalDecimalToCents(draft.budget ?? null);
  const costCenterId = draft.costCenterId?.trim() ?? '';
  if (!costCenterId) {
    throw new TeamError('A side event needs a cost center — somebody is paying for the dinner.');
  }

  return {
    name,
    kind: draft.kind as SideEventKind,
    location: draft.location?.trim() || null,
    startsLocal,
    endsLocal,
    capacity,
    budgetCents,
    hostId: draft.hostId?.trim() || null,
    costCenterId,
    notes: draft.notes?.trim() || null,
  };
}

/* ----------------------------------- RSVPs --------------------------------- */

export type RsvpDraft = {
  userId?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  guestCompany?: string | null;
  status: string;
};

export type ValidatedRsvp = {
  userId: string | null;
  guestName: string | null;
  guestEmail: string | null;
  guestCompany: string | null;
  status: RsvpStatus;
};

export function validateRsvp(draft: RsvpDraft): ValidatedRsvp {
  const userId = draft.userId?.trim() || null;
  const guestName = draft.guestName?.trim() || null;

  // The schema's comment says "either an internal user or an external guest, not
  // both", and nothing enforced it. A row with both is a guest list that
  // double-counts against capacity and a person who gets invited twice.
  if (userId && guestName) {
    throw new TeamError('An RSVP is either a colleague or an outside guest, not both.');
  }
  if (!userId && !guestName) {
    throw new TeamError('An RSVP needs a colleague or a guest name.');
  }
  if (!RSVP_STATUSES.includes(draft.status as RsvpStatus)) {
    throw new TeamError(`"${draft.status}" is not an RSVP status.`);
  }

  return {
    userId,
    guestName,
    guestEmail: draft.guestEmail?.trim() || null,
    guestCompany: draft.guestCompany?.trim() || null,
    status: draft.status as RsvpStatus,
  };
}

/**
 * Capacity is a hard number — the restaurant has that many seats.
 *
 * Only `accepted` counts. Counting invitations would refuse the twentieth
 * invitation to an eighteen-seat dinner that nine people have already declined,
 * which is not how anybody fills a table.
 */
export function rsvpFits(
  capacity: number | null,
  acceptedCount: number,
  next: RsvpStatus,
  wasAccepted: boolean,
): true | string {
  if (capacity === null || next !== 'accepted' || wasAccepted) return true;
  if (acceptedCount < capacity) return true;
  return (
    `That dinner seats ${capacity} and ${acceptedCount} people have already accepted. ` +
    'Raise the capacity if the venue really has the room — the number here is the one ' +
    'somebody will be turned away against.'
  );
}
