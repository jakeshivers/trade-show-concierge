import {
  calendarDaysBetween,
  shiftDaysPreservingLocalTime,
} from '@/lib/datetime/zoned';

/**
 * Cloning a show, as a pure function.
 *
 * SCOPE.md §5: "Clone a prior show with its tasks, deadlines, and shipping plan —
 * calendars are ~80% the same events yearly." The 20% is the whole problem. A
 * clone that copies too much is worse than no clone at all, because the copied
 * rows *look* like this year's facts: a confirmed deadline nobody re-read against
 * this year's exhibitor manual, a hotel confirmation code for a reservation that
 * does not exist, a tracking number for a crate that was delivered last March.
 *
 * Three rules fell out of writing this:
 *
 * 1. **Dates shift on the local calendar, not by elapsed milliseconds.** A 5:00pm
 *    deadline moved 364 days by arithmetic lands at 4:00pm or 6:00pm across a DST
 *    boundary. See `shiftDaysPreservingLocalTime`.
 * 2. **Confirmation is never carried.** Every copied deadline comes back
 *    unconfirmed, and every copied attendee comes back `invited`. Last year's
 *    "yes" is not evidence about this year, and a clone that presents it as such
 *    is the mechanism by which a $312,500 surcharge gets missed.
 * 3. **The "shipping plan" is not the shipments.** In this schema a shipment row
 *    carries a carrier, a tracking number, and a delivery history — copying one
 *    fabricates a shipment. What is genuinely plannable is which assets are
 *    reserved for the show and the deadlines that gate them, so those clone and
 *    shipments do not.
 */

export type CloneableShow = {
  id: string;
  name: string;
  timezone: string;
  startsOn: Date;
  endsOn: Date;
  moveInAt: Date | null;
  moveOutAt: Date | null;
  website: string | null;
  venueName: string | null;
  venueAddress: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  airportCode: string | null;
  boothNumber: string | null;
  boothSize: string | null;
  budgetCents: number | null;
  goals: string | null;
};

export type CloneableTask = {
  title: string;
  description: string | null;
  category: string;
  assigneeId: string | null;
  dueOn: Date | null;
  weight: number;
  sortOrder: number;
};

export type CloneableDeadline = {
  kind: string;
  title: string;
  dueAt: Date;
  penaltyEstimateCents: number | null;
  penaltyNote: string | null;
  ownerId: string | null;
  sourceUrl: string | null;
};

export type CloneableAttendee = {
  userId: string;
  role: string;
};

export type CloneableReservation = {
  assetId: string;
  reservedFrom: Date;
  reservedTo: Date;
  notes: string | null;
};

export type CloneSource = {
  show: CloneableShow;
  tasks: CloneableTask[];
  deadlines: CloneableDeadline[];
  attendees: CloneableAttendee[];
  reservations: CloneableReservation[];
};

export type CloneOptions = {
  name: string;
  /** First day of the new show, at the new show's local start time. */
  startsOn: Date;
  /** Defaults to the source show's zone; a venue move can change it. */
  timezone?: string;
  include: {
    tasks: boolean;
    deadlines: boolean;
    team: boolean;
    assets: boolean;
  };
};

export type ClonePlan = {
  show: Omit<CloneableShow, 'id'> & { status: 'prospect' };
  clonedFromId: string;
  shiftDays: number;
  tasks: (CloneableTask & { status: 'not_started' })[];
  deadlines: (CloneableDeadline & { confirmedAt: null })[];
  attendees: (CloneableAttendee & { status: 'invited' })[];
  reservations: CloneableReservation[];
  /** Plain-language notes for the confirm screen — what came, what deliberately did not. */
  carried: string[];
  dropped: string[];
};

export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

/**
 * What a clone never carries, and why. Rendered on the confirm screen: a person
 * about to create next year's show should be told what is *not* in it before they
 * find out by assuming it was.
 */
const NEVER_CLONED = [
  'Flights and travel requests — last year\'s itineraries, not this year\'s',
  'Lodging and confirmation codes — a copied confirmation code confirms nothing',
  'Shipments and tracking numbers — a copy would be a shipment that never shipped',
  'Expenses, leads, meetings, and outcomes — these are the record of what happened',
  'Booth shifts — they hang off show hours that are not set yet',
  // Step 16. A reservation's window carries over; its custody log never does.
  // "Signed out by Marcus on 9 July, returned damaged" copied onto next year's
  // show is a chain of custody for a journey that has not happened — the same
  // fabrication as a copied tracking number, and harder to spot because the
  // reservation it hangs off is legitimately cloned.
  'Chain of custody — a copied sign-out records a trip nobody took',
  'Collateral allocations — how many datasheets went last year is not a plan for this year',
];

export function planClone(source: CloneSource, options: CloneOptions): ClonePlan {
  const name = options.name.trim();
  if (name.length < 2) throw new CloneError('The new show needs a name.');

  const timezone = options.timezone ?? source.show.timezone;
  let shiftDays: number;
  try {
    shiftDays = calendarDaysBetween(source.show.startsOn, options.startsOn, timezone);
  } catch (err) {
    throw new CloneError(err instanceof Error ? err.message : String(err));
  }
  if (shiftDays === 0 && name === source.show.name) {
    throw new CloneError(
      'The clone has the same name and the same start date as the source. Change one of them.',
    );
  }

  const shift = (d: Date) => shiftDaysPreservingLocalTime(d, shiftDays, timezone);
  const shiftOrNull = (d: Date | null) => (d === null ? null : shift(d));

  const tasks = options.include.tasks
    ? source.tasks.map((t) => ({
        ...t,
        dueOn: shiftOrNull(t.dueOn),
        // Reset, always: a task's completion is a fact about the source show.
        status: 'not_started' as const,
      }))
    : [];

  const deadlines = options.include.deadlines
    ? source.deadlines.map((d) => ({
        ...d,
        dueAt: shift(d.dueAt),
        // Rule 2. Last year's manual is not this year's manual, and the shifted
        // date is a *prediction* until somebody reads the new one.
        confirmedAt: null,
      }))
    : [];

  const attendees = options.include.team
    ? source.attendees.map((a) => ({ ...a, status: 'invited' as const }))
    : [];

  const reservations = options.include.assets
    ? source.reservations.map((r) => ({
        ...r,
        reservedFrom: shift(r.reservedFrom),
        reservedTo: shift(r.reservedTo),
      }))
    : [];

  const carried: string[] = [];
  if (tasks.length) carried.push(`${tasks.length} readiness tasks, reset to not started`);
  if (deadlines.length)
    carried.push(`${deadlines.length} service-manual deadlines, dates predicted and unconfirmed`);
  if (attendees.length) carried.push(`${attendees.length} team members, all re-invited`);
  if (reservations.length)
    carried.push(`${reservations.length} asset reservations, unsigned-out and unreturned`);
  if (source.show.budgetCents !== null) carried.push('Budget, booth size, venue, and goals');

  const dropped = [...NEVER_CLONED];
  if (!options.include.tasks && source.tasks.length)
    dropped.push(`${source.tasks.length} readiness tasks — not selected`);
  if (!options.include.deadlines && source.deadlines.length)
    dropped.push(`${source.deadlines.length} service deadlines — not selected`);
  if (!options.include.team && source.attendees.length)
    dropped.push(`${source.attendees.length} team members — not selected`);
  if (!options.include.assets && source.reservations.length)
    dropped.push(`${source.reservations.length} asset reservations — not selected`);

  return {
    show: {
      name,
      timezone,
      status: 'prospect',
      startsOn: shift(source.show.startsOn),
      endsOn: shift(source.show.endsOn),
      moveInAt: shiftOrNull(source.show.moveInAt),
      moveOutAt: shiftOrNull(source.show.moveOutAt),
      website: source.show.website,
      venueName: source.show.venueName,
      venueAddress: source.show.venueAddress,
      city: source.show.city,
      region: source.show.region,
      country: source.show.country,
      airportCode: source.show.airportCode,
      // Booth number is the one venue fact that is never reassigned the same:
      // carrying "4218" into next year would put the crate at a stranger's booth.
      boothNumber: null,
      boothSize: source.show.boothSize,
      budgetCents: source.show.budgetCents,
      goals: source.show.goals,
    },
    clonedFromId: source.show.id,
    shiftDays,
    tasks,
    deadlines,
    attendees,
    reservations,
    carried,
    dropped,
  };
}
