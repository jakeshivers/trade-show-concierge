import { PRESENCE_ORDER, type Presence, type PresenceEvidence } from './presence';

/**
 * A roll call: who has answered, who has not, and who we have no way to ask.
 *
 * ## The distinction the whole file exists to protect
 *
 * **Presence and safety are different questions, and one must never answer the
 * other.** `presence.ts` says where somebody probably is. This says whether they
 * have told us they are all right. It is tempting — and it is the design every
 * first draft reaches for — to treat the two as one list, with a badge-in
 * standing in for an answer.
 *
 * That gets it exactly backwards. Somebody who badged into a booth shift at
 * 8:04am is *the person you most need to hear from* about a 10am incident at
 * that venue. Their presence makes them more urgent, not less. So presence never
 * marks anybody accounted for; it decides **who to call first**, and the answer
 * is the only thing that closes a name.
 *
 * ## The four refusals
 *
 * 1. **A response is a response to a request.** Responses carry the roll call
 *    they answer, and one recorded before the roll call started does not count —
 *    otherwise "checked in safe" from a show last March marks somebody accounted
 *    for during this morning's evacuation, silently, and the headcount that gets
 *    read aloud is wrong in the direction nobody checks.
 * 2. **A relayed answer counts, and §5e inverts here.** Booth coverage refuses a
 *    `confirmed` typed by somebody else — hearsay inside a staffing number, and
 *    it lands as `secondhand` and is not counted. A colleague saying "I have her
 *    on the phone, she is fine" is the *same data shape* and the opposite
 *    decision: in an emergency it is precisely the information you need, and a
 *    system that discarded it would have people ringing round a name that had
 *    already been reached. It counts, and it is labelled, because "she told us"
 *    and "he told us about her" are still different sentences.
 * 3. **Contactable is not contacted.** `users.phone` is nullable. A roll call
 *    reporting "12 of 14 reached" over a roster where three people have no phone
 *    number is lying about reach — the three were never reachable and their
 *    silence means nothing. They are counted separately and named, and the place
 *    that fact is useful is **before** an incident, which is why it is on the
 *    screen when nothing is happening.
 * 4. **Nobody is marked safe by the system, and there is no "assume OK".** The
 *    only thing that closes a name is somebody saying so. There is deliberately
 *    no timeout after which silence becomes assent, no inference from a badge
 *    scan, and no bulk "mark everyone safe" — each of which would be a way to
 *    produce a complete headcount without having spoken to anybody, which is the
 *    only outcome here worse than an incomplete one.
 */

export type SafetyStanding = 'ok' | 'needs_help';

export type SafetyResponse = {
  userId: string;
  standing: SafetyStanding;
  respondedAt: Date;
  /** Who typed it. Equal to `userId` when the person answered for themselves. */
  recordedById: string;
  note: string | null;
};

export type RollCallRequest = {
  id: string;
  showId: string;
  startedAt: Date;
  startedById: string;
  note: string | null;
};

export type PersonStanding = {
  presence: Presence;
  /** Null until somebody answers. Never inferred, never defaulted. Refusal 4. */
  response: SafetyResponse | null;
  /** True when the answer came from somebody other than the person. Refusal 2. */
  relayed: boolean;
  /** No phone number on file. They were never reachable. Refusal 3. */
  unreachable: boolean;
  phone: string | null;
  email: string;
};

export type RollCall = {
  request: RollCallRequest | null;
  people: PersonStanding[];
  /** Answered, first-hand or relayed. */
  accounted: number;
  /** Said they need help. Read first, always. */
  needsHelp: number;
  /** On the roster and silent. The output. */
  outstanding: number;
  /** Of the outstanding, those we have no way to reach. */
  unreachable: number;
  /**
   * The sentence in front of the count.
   *
   * Computed once, here, so the screen and the CLI cannot describe the same roll
   * call differently — `leads/coverage.ts`'s rule, at higher stakes.
   */
  summary: string;
};

/**
 * Who to call first.
 *
 * Not by how sure we are they are there — by how much their silence costs. An
 * unanswered `unknown` is the worst thing on the page: somebody on the roster
 * that nothing can locate and who has not spoken. Then the people we believe
 * were at the venue, then in the air, then merely in town. Answered names sink,
 * and `needs_help` overrides everything.
 */
export function rollCallOrder(a: PersonStanding, b: PersonStanding): number {
  const help = (p: PersonStanding) => (p.response?.standing === 'needs_help' ? 0 : 1);
  if (help(a) !== help(b)) return help(a) - help(b);

  const answered = (p: PersonStanding) => (p.response ? 1 : 0);
  if (answered(a) !== answered(b)) return answered(a) - answered(b);

  const rank = (p: PersonStanding) => PRESENCE_ORDER.indexOf(p.presence.kind);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);

  // Among equals, the people we cannot reach at all come first: their silence is
  // the least informative and the most expensive.
  if (a.unreachable !== b.unreachable) return a.unreachable ? -1 : 1;
  return a.presence.fullName.localeCompare(b.presence.fullName);
}

export function buildRollCall(
  request: RollCallRequest | null,
  evidence: PresenceEvidence[],
  presences: Presence[],
  responses: SafetyResponse[],
): RollCall {
  const byUser = new Map(evidence.map((e) => [e.userId, e] as const));

  // Refusal 1. A response that predates the request is not an answer to it.
  const relevant = request
    ? responses.filter((r) => r.respondedAt.getTime() >= request.startedAt.getTime())
    : [];
  const answerFor = new Map<string, SafetyResponse>();
  for (const r of relevant) {
    const held = answerFor.get(r.userId);
    if (!held || r.respondedAt.getTime() > held.respondedAt.getTime()) answerFor.set(r.userId, r);
  }

  const people: PersonStanding[] = presences.map((presence) => {
    const e = byUser.get(presence.userId);
    const response = answerFor.get(presence.userId) ?? null;
    return {
      presence,
      response,
      relayed: response !== null && response.recordedById !== response.userId,
      unreachable: !e?.phone,
      phone: e?.phone ?? null,
      email: e?.email ?? '',
    };
  });

  people.sort(rollCallOrder);

  // People who are not travelling are on the roster and are not in the count.
  // A roll call for a venue incident is about the people who could be at it, and
  // padding the denominator with colleagues who declined in June makes every
  // headcount look better than it is.
  const inScope = people.filter((p) => p.presence.kind !== 'not_travelling');
  const accounted = inScope.filter((p) => p.response !== null).length;
  const needsHelp = inScope.filter((p) => p.response?.standing === 'needs_help').length;
  const outstanding = inScope.length - accounted;
  const unreachable = inScope.filter((p) => p.response === null && p.unreachable).length;

  return {
    request,
    people,
    accounted,
    needsHelp,
    outstanding,
    unreachable,
    summary: summarize({ total: inScope.length, accounted, needsHelp, outstanding, unreachable, request }),
  };
}

function summarize(x: {
  total: number;
  accounted: number;
  needsHelp: number;
  outstanding: number;
  unreachable: number;
  request: RollCallRequest | null;
}): string {
  if (!x.request) {
    // The state a workspace is in almost all of the time, and the sentence
    // matters more than the ones below because it is the one somebody reads
    // while there is still time to fix the gaps.
    if (x.total === 0) return 'Nobody is travelling to this show.';
    const reach = x.unreachable
      ? ` ${x.unreachable} of them ${x.unreachable === 1 ? 'has' : 'have'} no phone number on file, so a roll call could not reach ${x.unreachable === 1 ? 'them' : 'them'} at all.`
      : ' Everybody has a phone number on file.';
    return `${x.total} ${x.total === 1 ? 'person is' : 'people are'} expected at this show.${reach}`;
  }

  const parts: string[] = [];
  if (x.needsHelp > 0) {
    parts.push(`${x.needsHelp} ${x.needsHelp === 1 ? 'person needs' : 'people need'} help`);
  }
  parts.push(`${x.accounted} of ${x.total} accounted for`);
  if (x.outstanding > 0) {
    // "Not yet answered", never "not safe". Silence is silence.
    parts.push(
      `${x.outstanding} ${x.outstanding === 1 ? 'has' : 'have'} not answered` +
        (x.unreachable ? `, including ${x.unreachable} with no phone number on file` : ''),
    );
  }
  return `${parts.join(' · ')}.`;
}
