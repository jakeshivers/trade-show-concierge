import { and, eq } from 'drizzle-orm';
import * as s from '@/db/schema';
import { ForbiddenError } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import type { FlightProvider } from '@/lib/integrations/flights/types';
import { submitTravelRequest, type AgentDeps } from '@/lib/travel/agent';
import { travelersFor } from '@/lib/travel/queue';
import { addLodging } from '@/lib/lodging/store';
import type { ToolContext } from './tools';

/**
 * What the assistant is allowed to write: a draft, and only ever a draft.
 *
 * SCOPE.md §6a is unchanged by this step — an LLM parses requests into
 * constraints and narrates verdicts, and the deterministic policy engine is the
 * only thing that authorizes spend. Step 15 does not soften that; it plugs the
 * parser into a seam that has been sitting built and exercised since step 4.
 *
 * Three separate things make "read and draft only" structural rather than a
 * sentence in a prompt:
 *
 * 1. **The request is filed unconfirmed, and only a person can confirm it.**
 *    `submitTravelRequest` leaves `constraints_confirmed_at` null whenever
 *    `rawRequestText` is present, and the booking agent refuses to search an
 *    unconfirmed parse (`agent.ts`). The assistant does not hold
 *    `confirmConstraints` as a tool, so the one act that unblocks a search is
 *    only available on the screen, to the person whose trip it is.
 * 2. **Raw text is not optional here.** See `assertRawText` below.
 * 3. **The agent deps it is given contain a flight provider that cannot fly.**
 *    See `unsearchableProvider`.
 */

/**
 * A `FlightProvider` whose every method throws.
 *
 * Opening a request genuinely does not need a provider — the request is ours,
 * not the airline's — and `travel/actions.ts` already passes `null as never` for
 * that reason. That works and reads as an oversight; here it is load-bearing
 * enough to say out loud, because this caller is a language model and the object
 * is the only thing between it and a search. A null would fail with
 * `Cannot read properties of null`, which is indistinguishable from a bug. This
 * fails with a sentence naming the rule it just enforced.
 *
 * It also means the assistant works on an install with no Duffel key at all,
 * which is the ordinary case for a clean clone.
 */
export function unsearchableProvider(): FlightProvider {
  // `async` deliberately: every method on `FlightProvider` returns a promise, and
  // a synchronous throw from a promise-shaped method escapes past the caller's
  // `.catch` and lands somewhere with no context. Refusing has to arrive the way
  // any other provider failure would.
  const refuse = async (): Promise<never> => {
    throw new Error(
      'The assistant drafts travel requests; it never searches, holds, buys or cancels. ' +
        'A person confirms the constraints and the policy engine decides. SCOPE.md §6a.',
    );
  };
  return {
    name: 'unsearchable',
    isConfigured: () => false,
    search: refuse,
    hold: refuse,
    purchase: refuse,
    cancel: refuse,
  };
}

export function draftDeps(ctx: ToolContext): AgentDeps {
  return {
    db: ctx.db,
    provider: unsearchableProvider(),
    now: () => ctx.now,
    // Not "false because we are drafting" — false because nothing on this path
    // can reach a purchase at all. Rail 4 holds twice over.
    live: false,
  };
}

/**
 * The user's own words, or nothing.
 *
 * `submitTravelRequest` infers confirmation from the *absence* of raw text:
 * no raw text means a human typed the constraints into a form, so they are
 * confirmed by construction. That inference was correct for both callers it had
 * — the form and the dry-run script — and it silently inverts for this one. An
 * assistant that filed a request with no raw text would have its parse marked
 * human-confirmed and the agent would search it, which is the exact laundering
 * §6a forbids. So the draft path refuses rather than defaulting.
 */
function assertRawText(ctx: ToolContext): string {
  const text = ctx.rawRequestText.trim();
  if (!text) {
    throw new Error(
      'Refusing to file a travel request with no record of what was actually asked for: ' +
        'the request would be marked as human-confirmed and searched without anyone ' +
        'having read the parse.',
    );
  }
  return text;
}

export type TravelDraft = {
  travelerEmail?: string;
  showId?: string;
  originAirport?: string;
  destinationAirport: string;
  earliestDepartureLocal: string;
  latestArrivalLocal: string;
  returnEarliestDepartureLocal?: string;
  returnLatestArrivalLocal?: string;
  timezone?: string;
  cabinPreference?: string;
  notes?: string;
};

export type DraftResult = {
  drafted: 'travel_request' | 'lodging';
  id: string;
  /** What the person has to do next. The model relays this; it never performs it. */
  nextStep: string;
  summary: Record<string, unknown>;
};

export async function draftTravelRequest(
  ctx: ToolContext,
  draft: TravelDraft,
): Promise<DraftResult> {
  const raw = assertRawText(ctx);
  const timezone = await resolveZone(ctx, draft.showId, draft.timezone);
  const travelerId = await resolveTraveler(ctx, draft.travelerEmail);
  const origin = await resolveOrigin(ctx, travelerId, draft.originAirport);

  const local = (v: string | undefined): Date | null => {
    if (!v) return null;
    // Deliberately `zonedToInstant`, never `new Date()`: a window parsed in the
    // server's zone is wrong by hours on the two dates it matters most.
    return zonedToInstant(v.trim(), timezone);
  };

  const earliest = local(draft.earliestDepartureLocal);
  const latest = local(draft.latestArrivalLocal);
  if (!earliest || !latest) {
    throw new Error('A travel request needs both an earliest departure and a latest arrival.');
  }

  const row = await submitTravelRequest(
    {
      travelerId,
      showId: draft.showId ?? null,
      originAirport: origin.code,
      destinationAirport: draft.destinationAirport.trim().toUpperCase(),
      earliestDeparture: earliest,
      latestArrival: latest,
      returnEarliestDeparture: local(draft.returnEarliestDepartureLocal),
      returnLatestArrival: local(draft.returnLatestArrivalLocal),
      cabinPreference: draft.cabinPreference ?? null,
      rawRequestText: raw,
      notes: draft.notes ?? null,
    },
    ctx.actor,
    draftDeps(ctx),
  );

  return {
    drafted: 'travel_request',
    id: row.id,
    nextStep:
      `Nothing has been searched or priced. Open /travel/${row.id}, check the parsed ` +
      'constraints, and confirm them — the booking agent will not search until somebody has.',
    summary: {
      origin: row.originAirport,
      // Said out loud because the person confirming is the only check on it. A
      // defaulted origin that is silently correct nine times is the one that
      // gets waved through the tenth.
      originFromHomeAirport: origin.defaulted,
      destination: row.destinationAirport,
      timezoneUsed: timezone,
      earliestDeparture: row.earliestDeparture,
      latestArrival: row.latestArrival,
      returnEarliestDeparture: row.returnEarliestDeparture,
      returnLatestArrival: row.returnLatestArrival,
      constraintsConfirmedAt: row.constraintsConfirmedAt,
      status: row.status,
    },
  };
}

export type LodgingDraftInput = {
  showId: string;
  hotelName: string;
  checkInOn?: string;
  checkOutOn?: string;
  nightlyRate?: string;
  costCenterId?: string;
  notes?: string;
};

/**
 * A hotel *record*, because §5 keeps hotel booking out of v1. There is no
 * provider to refuse here — the row is the whole feature — so what makes this a
 * draft is that it is created deliberately incomplete: no confirmation code, and
 * a room block cutoff left unset rather than guessed.
 *
 * The cutoff in particular must never be inferred. It **owns** a row in the §5a
 * register the moment it is set (`lodging/store.ts`), so a guessed date there is
 * not a wrong field on a hotel record — it is a deadline the engine chases, and
 * eventually quotes money against, on a date nobody chose.
 */
export async function draftLodgingRecord(
  ctx: ToolContext,
  draft: LodgingDraftInput,
): Promise<DraftResult> {
  const costCenterId = draft.costCenterId ?? ctx.actor.costCenterId;
  if (!costCenterId) {
    // Non-negotiable #6: every financial row carries a cost center at creation,
    // never backfilled. Call `cost_centers` and pick one.
    throw new Error(
      'A lodging record is a spending row and needs a cost center at creation. ' +
        'Ask which one — this app never backfills a cost dimension.',
    );
  }

  const row = await addLodging(
    ctx.actor,
    draft.showId,
    {
      hotelName: draft.hotelName.trim(),
      checkInOn: draft.checkInOn?.trim() || null,
      checkOutOn: draft.checkOutOn?.trim() || null,
      // A decimal string as typed, parsed by `money/decimal.ts` downstream.
      // Never a float, and never cents invented from one.
      nightlyRate: draft.nightlyRate?.trim() || null,
      roomBlockCutoffOn: null,
      costCenterId,
      notes: draft.notes ?? null,
    },
    ctx.now,
    ctx.db,
  );

  return {
    drafted: 'lodging',
    id: row.id,
    nextStep:
      `Recorded on the show's Lodging tab. Nothing was booked — this app tracks hotels ` +
      'rather than reserving them. The room block cutoff was left blank on purpose: ' +
      'setting it creates a deadline the alert engine will chase, so it needs a real date ' +
      'off the contract, not an estimate.',
    summary: { hotelName: draft.hotelName, showId: draft.showId, roomBlockCutoff: null },
  };
}

/* -------------------------------- resolving -------------------------------- */

/**
 * Which zone a naive "2026-09-14T17:00" is read in.
 *
 * The travel form gets this from the show the user picked. The assistant may not
 * have a show, and there is no airport→zone table in this app, so the honest
 * options are to ask or to be wrong by up to a day. It asks.
 */
async function resolveZone(
  ctx: ToolContext,
  showId: string | undefined,
  explicit: string | undefined,
): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  if (showId) {
    const show = await ctx.db.query.shows.findFirst({
      where: and(eq(s.shows.id, showId), eq(s.shows.orgId, ctx.actor.orgId)),
    });
    if (show) return show.timezone;
  }
  throw new Error(
    'Which time zone are those times in? Attach the show this trip is for, or give the ' +
      "origin airport's IANA zone. Assuming one would move the window by hours, and a " +
      'departure window is what the policy engine rules against.',
  );
}

/**
 * Which airport the trip leaves from, when the person did not say.
 *
 * This is deliberately **not** the refusal `resolveZone` makes one line above,
 * and the difference is worth stating because they look alike. A time zone the
 * assistant guesses is an inference from nothing — there is no airport→zone table
 * here, so any answer is invented, and being wrong moves the window by hours
 * against the policy engine. A home airport is the opposite: it is a fact the
 * traveler themselves typed and saved, so using it is *reading a preference*
 * rather than filling a gap.
 *
 * It is still a default on a draft that nobody has confirmed. The request is
 * filed with `constraints_confirmed_at` null, the agent refuses to search until a
 * human has read the parse, and the result says `originFromHomeAirport` so the
 * person confirming sees which of the two it was.
 */
async function resolveOrigin(
  ctx: ToolContext,
  travelerId: string,
  explicit: string | undefined,
): Promise<{ code: string; defaulted: boolean }> {
  const said = explicit?.trim();
  if (said) return { code: said.toUpperCase(), defaulted: false };

  const traveler = await ctx.db.query.users.findFirst({
    where: and(eq(s.users.id, travelerId), eq(s.users.orgId, ctx.actor.orgId)),
  });
  if (traveler?.homeAirport) return { code: traveler.homeAirport, defaulted: true };

  throw new Error(
    'Which airport is this trip leaving from? There is no home airport on file for the ' +
      'traveler, and an origin is what the search is run from — guessing one would price a ' +
      'trip from a city nobody is in. Setting a home airport on /settings/profile makes this ' +
      'the last time it has to be asked.',
  );
}

/**
 * Turning a name into a traveler id — and the narrowest place the access posture
 * could have been broken.
 *
 * This resolves against `travelersFor`, which returns **only the actor** for a
 * Member. So a Member asking the assistant to book a colleague's flight gets a
 * refusal sourced from the same list the form's dropdown is built from, rather
 * than from a rule the model was told about. A `users` lookup here would have
 * been two lines shorter and would have handed the model a directory.
 */
async function resolveTraveler(
  ctx: ToolContext,
  email: string | undefined,
): Promise<string> {
  if (!email?.trim()) return ctx.actor.userId;
  const wanted = email.trim().toLowerCase();
  if (wanted === ctx.actor.email.toLowerCase()) return ctx.actor.userId;

  const people = await travelersFor(ctx.actor, ctx.db);
  const match = people.find((p) => p.email.toLowerCase() === wanted);
  if (!match) {
    throw new ForbiddenError(`open a travel request for ${email.trim()}`);
  }
  return match.id;
}
