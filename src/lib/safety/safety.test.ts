import { describe, it, expect } from 'vitest';
import { presenceFor, STALE_AFTER_MINUTES, type PresenceEvidence } from './presence';
import { buildRollCall, type RollCallRequest, type SafetyResponse } from './rollcall';

/**
 * What is being tested is not who is where. It is every case where a plausible
 * answer would leave somebody off a call list — a June travel window read as a
 * location, a cancelled flight read as travel, a badge scan read as an answer,
 * last March's "I'm fine" read as this morning's.
 */

const NOW = new Date('2027-03-16T15:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const ahead = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const person = (over: Partial<PresenceEvidence> = {}): PresenceEvidence => ({
  userId: 'u1',
  fullName: 'Priya Raman',
  attendeeStatus: 'confirmed',
  arrivesOn: null,
  departsOn: null,
  lastCheckInAt: null,
  flights: [],
  lodging: [],
  phone: '+1-555-0100',
  email: 'priya@example.com',
  ...over,
});

describe('presence', () => {
  it('reports somebody on the roster with no travel record as unknown, not absent', () => {
    // §5e refuses to flag an unrecorded travel window, because flagging everybody
    // flags nobody. A roll call inverts it: this person is the entire output.
    const p = presenceFor(person(), NOW);
    expect(p.kind).toBe('unknown');
    expect(p.basis).toBe('no_record');
  });

  it('lets a badge scan mean the building, and nothing else does', () => {
    const badged = presenceFor(person({ lastCheckInAt: ago(12) }), NOW);
    expect(badged.kind).toBe('at_venue');

    // A travel window is a plan somebody typed in June. It says the city.
    const windowed = presenceFor(
      person({ arrivesOn: ago(60 * 24), departsOn: ahead(60 * 24) }),
      NOW,
    );
    expect(windowed.kind).toBe('in_town');
  });

  it('keeps a stale badge scan as the strongest evidence, and marks it stale', () => {
    // Refusal 3: it is still the best thing we have about the building. What it
    // must not do is read as a claim about *now* without its age attached.
    const p = presenceFor(person({ lastCheckInAt: ago(200) }), NOW);
    expect(p.kind).toBe('at_venue');
    expect(p.stale).toBe(true);
    expect(p.ageMinutes).toBe(200);
    expect(STALE_AFTER_MINUTES.booth_check_in).toBeLessThan(200);
  });

  it('does not age an interval that contains now', () => {
    // Found by running the CLI: four people at the live show read "(stale)"
    // because their travel window *started* 18 hours ago. A window is not an
    // observation that has gone off, it is a bracket that is currently true —
    // and its weakness, that it was never precise, is already carried by it
    // producing `in_town` rather than `at_venue`.
    const windowed = presenceFor(
      person({ arrivesOn: ago(60 * 18), departsOn: ahead(60 * 48) }),
      NOW,
    );
    expect(windowed.kind).toBe('in_town');
    expect(windowed.stale).toBe(false);

    // A landing is an observation, and it does age.
    const landed = presenceFor(
      person({
        flights: [
          {
            direction: 'to_show',
            status: 'landed',
            departure: ago(60 * 30),
            arrival: ago(60 * 20),
            destinationAirport: 'SNA',
          },
        ],
      }),
      NOW,
    );
    expect(landed.kind).toBe('in_town');
    expect(landed.stale).toBe(true);
  });

  it('does not treat a cancelled flight as travel', () => {
    // The flattering reading: the roster looks accounted for, and somebody is
    // left off a call list.
    const p = presenceFor(
      person({
        flights: [
          {
            direction: 'to_show',
            status: 'cancelled',
            departure: ago(300),
            arrival: ago(120),
            destinationAirport: 'ORD',
          },
        ],
      }),
      NOW,
    );
    expect(p.kind).toBe('unknown');
  });

  it('counts a diverted flight as in transit, because the person is on it', () => {
    const p = presenceFor(
      person({
        flights: [
          {
            direction: 'to_show',
            status: 'diverted',
            departure: ago(90),
            arrival: ahead(60),
            destinationAirport: 'ORD',
          },
        ],
      }),
      NOW,
    );
    expect(p.kind).toBe('in_transit');
  });

  it('stops calling somebody in town once they have flown home', () => {
    const p = presenceFor(
      person({
        flights: [
          {
            direction: 'to_show',
            status: 'landed',
            departure: ago(3000),
            arrival: ago(2800),
            destinationAirport: 'ORD',
          },
          {
            direction: 'from_show',
            status: 'landed',
            departure: ago(200),
            arrival: ago(60),
            destinationAirport: 'SFO',
          },
        ],
      }),
      NOW,
    );
    expect(p.kind).not.toBe('in_town');
  });

  it('separates "has not left yet" from "nothing recorded"', () => {
    // Found by running the CLI: everybody at the live show read UNKNOWN and
    // sorted to the top, which is a list telling somebody to go and find four
    // colleagues who are at home. Opposite facts, and only one is a worry.
    const p = presenceFor(person({ arrivesOn: ahead(300), departsOn: ahead(4000) }), NOW);
    expect(p.kind).toBe('not_travelling');
    expect(p.basis).toBe('window_not_started');

    const nothing = presenceFor(person(), NOW);
    expect(nothing.basis).toBe('no_record');
  });

  it('lets a decision outrank an inference', () => {
    // Declined in June, and nobody deleted the travel window. Reporting them as
    // in town puts a name on a list of people to look for at a venue they are
    // two thousand miles from.
    const p = presenceFor(
      person({
        attendeeStatus: 'declined',
        arrivesOn: ago(60 * 24),
        departsOn: ahead(60 * 24),
      }),
      NOW,
    );
    expect(p.kind).toBe('not_travelling');
    expect(p.basis).toBe('declined');
  });
});

describe('the roll call', () => {
  const request: RollCallRequest = {
    id: 'rc-1',
    showId: 'show-1',
    startedAt: ago(30),
    startedById: 'u9',
    note: 'Venue evacuated',
  };

  const build = (people: PresenceEvidence[], responses: SafetyResponse[], req = request) =>
    buildRollCall(req, people, people.map((p) => presenceFor(p, NOW)), responses);

  const answer = (over: Partial<SafetyResponse> = {}): SafetyResponse => ({
    userId: 'u1',
    standing: 'ok',
    respondedAt: ago(5),
    recordedById: 'u1',
    note: null,
    ...over,
  });

  it('never lets presence answer for safety', () => {
    // The whole file. Somebody who badged in twelve minutes ago is the person
    // you most need to hear from about an incident at that venue.
    const call = build([person({ lastCheckInAt: ago(12) })], []);
    expect(call.accounted).toBe(0);
    expect(call.outstanding).toBe(1);
    expect(call.people[0].response).toBeNull();
  });

  it('discards a response that predates the roll call', () => {
    // "Checked in safe" at a show last March, marking somebody accounted for
    // during this morning's evacuation — silently, on the count read aloud.
    const call = build([person()], [answer({ respondedAt: ago(60 * 24 * 200) })]);
    expect(call.accounted).toBe(0);
    expect(call.outstanding).toBe(1);
  });

  it('counts a relayed answer and labels it', () => {
    // §5e inverted: hearsay is refused in a staffing number and is exactly what
    // a roll call needs. A system that discarded it would have people ringing
    // round a name that had already been reached.
    const call = build([person()], [answer({ recordedById: 'u7' })]);
    expect(call.accounted).toBe(1);
    expect(call.people[0].relayed).toBe(true);
  });

  it('keeps a first-hand answer unlabelled', () => {
    const call = build([person()], [answer()]);
    expect(call.people[0].relayed).toBe(false);
  });

  it('counts somebody with no phone number apart, because they were never reachable', () => {
    const call = build([person({ phone: null })], []);
    expect(call.unreachable).toBe(1);
    expect(call.summary).toContain('no phone number on file');
  });

  it('does not pad the denominator with people who are not travelling', () => {
    const call = build(
      [person({ userId: 'a', lastCheckInAt: ago(10) }), person({ userId: 'b', attendeeStatus: 'declined' })],
      [],
    );
    // Two on the roster, one in scope. Counting the person who declined in June
    // makes every headcount look better than it is.
    expect(call.outstanding).toBe(1);
    expect(call.people).toHaveLength(2);
  });

  it('reads someone who needs help first, ahead of everything', () => {
    const call = build(
      [
        person({ userId: 'a' }),
        person({ userId: 'b', fullName: 'Marcus Hale', lastCheckInAt: ago(10) }),
      ],
      [answer({ userId: 'b', standing: 'needs_help' })],
    );
    expect(call.people[0].presence.userId).toBe('b');
    expect(call.needsHelp).toBe(1);
    expect(call.summary).toContain('needs help');
  });

  it('puts the unanswered unknown at the top when nobody needs help', () => {
    const call = build(
      [
        person({ userId: 'a', fullName: 'Badged In', lastCheckInAt: ago(10) }),
        person({ userId: 'b', fullName: 'Nobody Knows' }),
      ],
      [],
    );
    expect(call.people[0].presence.userId).toBe('b');
  });

  it('says something useful when no roll call is running', () => {
    // The state a workspace is in almost all of the time, and the sentence that
    // matters most, because it is read while there is still time to fix a gap.
    const call = buildRollCall(
      null,
      [person({ phone: null })],
      [presenceFor(person({ phone: null }), NOW)],
      [],
    );
    expect(call.summary).toContain('no phone number on file');
    expect(call.accounted).toBe(0);
  });
});
