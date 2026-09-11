/**
 * Where somebody probably is, and how old that guess is.
 *
 * ## What this is, and what it deliberately is not
 *
 * `RESEARCH.md` ranks duty of care ninth and justifies it in one sentence: *"we
 * know where everyone is."* **We do not**, and the whole of this module is the
 * consequence of taking that seriously. What this app holds is a set of
 * operational records kept for other reasons — a booth check-in, a landed
 * flight, a hotel stay, a travel window somebody typed in June — and every one
 * of them is evidence of *expected* presence at some instant in the past. None
 * of them is a location.
 *
 * That distinction is not pedantry. The screen this feeds is read when something
 * has happened at a venue, by somebody deciding who to phone first, and a list
 * that presents "Marcus — at the venue" with the same confidence for a man who
 * badged into a shift twelve minutes ago and a man whose June travel window
 * happens to contain today is worse than no list. The first is a fact about this
 * morning. The second is a plan.
 *
 * **This is not a location tracker and must never become one.** Every standing
 * below is derived from a row the app already had. Nothing here reads a device,
 * asks for a position, or wants a consent dialog, and the moment something does,
 * this stops being a feature about knowing who to call and becomes a feature
 * about watching staff. §5j's whole posture, arriving somewhere it would be very
 * easy to give up.
 *
 * ## The four refusals
 *
 * 1. **Unknown is not absent, and here that inverts §5e.** Booth coverage
 *    deliberately does *not* flag an unrecorded travel window, because plenty of
 *    people drive and flagging everybody flags nobody. A roll call is the exact
 *    opposite: the person nobody can account for is the entire output. So a
 *    confirmed attendee with no travel record at all is `unknown` and sorts
 *    **first**, not last — the same underlying gap, read in the other direction,
 *    because the cost of the two mistakes has swapped places.
 * 2. **Evidence ages, and the strongest signal is usually the stalest.** A booth
 *    check-in is the best evidence of being at the venue in this entire product,
 *    and it was true at 8:04am. Past a threshold a standing stops being a claim
 *    about now — `dayof/snapshot.ts`'s `degradeVerdicts` rule, and §5f's
 *    unchecked flight before it. So every standing carries the instant its
 *    evidence was true, `stale` is a property rather than a re-classification,
 *    and the screen renders the age.
 * 3. **Precision is not confidence.** A travel window says somebody is in the
 *    city for four days; it does not say they are in the building. `in_town` and
 *    `at_venue` are different standings and the narrower one requires the
 *    stronger evidence, because "at the venue" is what makes a person's absence
 *    from a headcount alarming.
 * 4. **A cancelled or diverted flight is not travel.** Somebody whose only
 *    evidence of presence is a flight that never went is not in the city. It is
 *    the flattering reading — the roster looks accounted-for — and it is the one
 *    that leaves a person off a call list.
 */

/** Strongest first. The order is the order a roll call reads. */
export type PresenceKind =
  /** Badged into a booth shift. The only evidence of *the building*. */
  | 'at_venue'
  /** Landed, or in a hotel, or inside a typed travel window. In the city. */
  | 'in_town'
  /** In the air, or departed and not yet landed. */
  | 'in_transit'
  /** Declined the show, or their window has ended. Not expected here. */
  | 'not_travelling'
  /** On the roster and nothing says where they are. The point of the exercise. */
  | 'unknown';

export type PresenceBasis =
  | 'booth_check_in'
  | 'flight_landed'
  | 'flight_in_air'
  | 'lodging_stay'
  | 'travel_window'
  | 'declined'
  | 'window_ended'
  | 'window_not_started'
  | 'no_record';

export const BASIS_LABEL: Record<PresenceBasis, string> = {
  booth_check_in: 'badged into a booth shift',
  flight_landed: 'flight landed',
  flight_in_air: 'in the air',
  lodging_stay: 'hotel stay covers now',
  travel_window: 'travel window covers now',
  declined: 'declined the show',
  window_ended: 'travel window has ended',
  window_not_started: 'has not left yet',
  no_record: 'nothing recorded',
};

export type PresenceEvidence = {
  userId: string;
  fullName: string;
  /** Null when they are not on this show's roster at all. */
  attendeeStatus: 'invited' | 'confirmed' | 'declined' | 'waitlist' | null;
  arrivesOn: Date | null;
  departsOn: Date | null;
  /** The most recent booth check-in for this show, if any. */
  lastCheckInAt: Date | null;
  /** Legs on this show, with whatever the status provider last said. */
  flights: {
    /** The database's own words: `to_show` / `from_show`, never re-spelled. */
    direction: 'to_show' | 'from_show' | 'unknown';
    status: 'scheduled' | 'active' | 'landed' | 'delayed' | 'diverted' | 'cancelled' | 'unknown';
    departure: Date;
    arrival: Date;
    destinationAirport: string;
  }[];
  /** Hotel stays covering this show. */
  lodging: { checkIn: Date | null; checkOut: Date | null }[];
  /** How to reach them. Nullable, and that is a finding rather than a detail. */
  phone: string | null;
  email: string;
};

export type Presence = {
  userId: string;
  fullName: string;
  kind: PresenceKind;
  basis: PresenceBasis;
  /**
   * When the evidence was true. Null where the standing rests on no evidence at
   * all, which is `unknown` and is the one case with nothing to be stale.
   */
  asOf: Date | null;
  /** Minutes since `asOf`, or null. Rendered, never rounded into the standing. */
  ageMinutes: number | null;
  /** Past the threshold for its kind. A property, never a re-classification. */
  stale: boolean;
};

/**
 * How long each piece of evidence speaks for — **keyed by basis, not by kind.**
 *
 * That distinction is the correction, and getting it wrong first made the live
 * show's roll call say `(stale)` beside four people whose travel windows contain
 * this moment. **An interval that contains now does not age; an observation
 * does.** A badge scan is a thing that happened at 8:04 and perishes fast —
 * somebody who badged in three hours ago has had lunch, gone to a session, or
 * left the building. A travel window is not an observation at all: it is a
 * bracket somebody typed in June, it is *currently true*, and its weakness is
 * that it was never precise rather than that it has gone off. Marking it stale
 * says "we have not heard in 18 hours" when the truth is "we never had a signal,
 * only a plan" — and those call for different actions.
 *
 * The coarseness is already carried, by such evidence producing `in_town` rather
 * than `at_venue`. Staleness is reserved for evidence that was once precise.
 *
 * The numbers are judgement calls, stated here rather than buried, so an
 * argument about them is an argument about one constant.
 */
export const STALE_AFTER_MINUTES: Record<PresenceBasis, number | null> = {
  booth_check_in: 90,
  flight_landed: 12 * 60,
  flight_in_air: 3 * 60,
  // Intervals containing now. Never stale — see the header.
  lodging_stay: null,
  travel_window: null,
  // Standings that rest on a decision or on nothing. Nothing to perish.
  declined: null,
  window_ended: null,
  window_not_started: null,
  no_record: null,
};

function within(at: Date, from: Date | null, to: Date | null): boolean {
  if (!from || !to) return false;
  return at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
}

/** A flight that never went is not travel. Refusal 4. */
function flew(status: PresenceEvidence['flights'][number]['status']): boolean {
  return status !== 'cancelled';
}

export function presenceFor(e: PresenceEvidence, asOf: Date): Presence {
  const build = (kind: PresenceKind, basis: PresenceBasis, at: Date | null): Presence => {
    const ageMinutes = at ? Math.floor((asOf.getTime() - at.getTime()) / 60_000) : null;
    const limit = STALE_AFTER_MINUTES[basis];
    return {
      userId: e.userId,
      fullName: e.fullName,
      kind,
      basis,
      asOf: at,
      ageMinutes,
      stale: limit !== null && ageMinutes !== null && ageMinutes > limit,
    };
  };

  // Declined is a decision somebody made, and it outranks every inference. A
  // person who said they are not coming, whose June travel window was never
  // deleted, must not be reported as in town.
  if (e.attendeeStatus === 'declined') return build('not_travelling', 'declined', null);

  // The only evidence of *the building* in this entire product. Even stale, it
  // is the strongest thing here — refusal 3 — so it wins, and carries its age.
  if (e.lastCheckInAt && e.lastCheckInAt.getTime() <= asOf.getTime()) {
    return build('at_venue', 'booth_check_in', e.lastCheckInAt);
  }

  const legs = e.flights.filter((f) => flew(f.status));

  // In the air right now: departed, not yet arrived. `diverted` still counts —
  // the plane is somewhere and the person is on it, which is exactly the thing
  // a roll call needs to know.
  const airborne = legs.find(
    (f) =>
      f.departure.getTime() <= asOf.getTime() &&
      f.arrival.getTime() > asOf.getTime() &&
      (f.status === 'active' || f.status === 'delayed' || f.status === 'diverted'),
  );
  if (airborne) return build('in_transit', 'flight_in_air', airborne.departure);

  // Landed on the way in, and not yet flown home.
  const arrived = legs
    .filter(
      (f) =>
        f.direction === 'to_show' &&
        f.status === 'landed' &&
        f.arrival.getTime() <= asOf.getTime(),
    )
    .sort((a, b) => b.arrival.getTime() - a.arrival.getTime())[0];
  const flownHome = legs.some(
    (f) =>
      f.direction === 'from_show' &&
      f.status === 'landed' &&
      f.arrival.getTime() <= asOf.getTime(),
  );
  if (arrived && !flownHome) return build('in_town', 'flight_landed', arrived.arrival);

  const staying = e.lodging.find((l) => within(asOf, l.checkIn, l.checkOut));
  if (staying) return build('in_town', 'lodging_stay', staying.checkIn);

  if (within(asOf, e.arrivesOn, e.departsOn)) {
    // Coarse, and deliberately never `at_venue`. It is a plan somebody typed in
    // June, and the age it carries is how long ago it started rather than how
    // recently anybody saw them.
    return build('in_town', 'travel_window', e.arrivesOn);
  }

  if (e.departsOn && e.departsOn.getTime() < asOf.getTime()) {
    return build('not_travelling', 'window_ended', e.departsOn);
  }

  // A window that has not started is not a missing window, and this was found by
  // running `pnpm rollcall` rather than by a test. Everybody at the live show
  // read as UNKNOWN and sorted to the top — a list telling somebody to go and
  // find four colleagues who are at home, hours from a flight they have not
  // taken. "Nothing recorded" and "has not left yet" are opposite facts, and
  // only one of them is a person to worry about.
  if (e.arrivesOn && e.arrivesOn.getTime() > asOf.getTime()) {
    return build('not_travelling', 'window_not_started', e.arrivesOn);
  }

  // Refusal 1. On the roster, nothing says where they are, and this is the
  // answer the whole screen exists to produce. It is not "absent".
  return build('unknown', 'no_record', null);
}

/** Strongest evidence first is the wrong order for a roll call. See `rollcall.ts`. */
export const PRESENCE_ORDER: PresenceKind[] = [
  'unknown',
  'in_transit',
  'at_venue',
  'in_town',
  'not_travelling',
];
