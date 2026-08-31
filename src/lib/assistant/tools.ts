import { z } from 'zod';
import type { Actor } from '@/lib/auth/actor';
import type { getDb } from '@/db';
import type { ModelToolSpec } from '@/lib/integrations/llm/types';

import { listShows, getShowDetail, getItinerary } from '@/lib/shows/store';
import { getChecklist, getPortfolio } from '@/lib/readiness/store';
import { getRegister } from '@/lib/deadlines/store';
import { getTeamBoard, getConflicts } from '@/lib/team/store';
import { getLodgingBoard } from '@/lib/lodging/store';
import { getFlightBoard } from '@/lib/flights/store';
import { getShipmentBoard } from '@/lib/shipping/store';
import { listRequests, loadRequest, travelersFor, costCentersFor } from '@/lib/travel/queue';
import { draftLodgingRecord, draftTravelRequest } from './draft';

/**
 * The tool surface — and the whole access model of step 15.
 *
 * **The rule this file exists to make true: the assistant has no database
 * access of its own.** Every entry below is an existing store function, called
 * with the asking actor, through the gate a screen goes through. Nothing here
 * opens a query, joins a table, or takes an `orgId` from the model.
 *
 * That is what makes "which room is Shelley in" safe for a Member to ask. It is
 * not refused by a filter in a prompt, which a model can be talked around and
 * which fails silently when it is. It is refused because `getLodgingBoard` calls
 * `travelerScope(actor)` and narrows the query before returning, exactly as it
 * does for the screen — the row is never retrieved, so there is nothing in the
 * transcript to leak and nothing for an instruction to override. The model's
 * input never reaches an authorization decision: it supplies a show id, and if
 * that show belongs to another org the store raises, because it always did.
 *
 * **The single thing that would break the posture is adding one tool that
 * queries around the actor** — a "look up any user", a raw SQL escape, a
 * convenience read that takes an org id. There is deliberately no such entry,
 * and a reviewer adding one should read this paragraph as the objection.
 *
 * Note what is absent by the same rule: `travelersFor` already returns *only the
 * actor* for a Member (`travel/queue.ts`), so the directory tool is the narrowing
 * rather than an exception to it.
 */

export type ToolContext = {
  actor: Actor;
  db: ReturnType<typeof getDb>;
  now: Date;
  /** The user's own words this turn. A draft records them; it never invents them. */
  rawRequestText: string;
};

export type AssistantTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  /**
   * `read` answers; `draft` writes a row a human still has to act on. Nothing is
   * `commit`, and there is no fourth kind — §6a's rule is that the deterministic
   * policy engine is the only thing that authorizes spend.
   */
  kind: 'read' | 'draft';
  run: (ctx: ToolContext, input: never) => Promise<unknown>;
};

/** Narrow helper so each tool below reads as its store call and nothing else. */
function tool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  schema: S;
  kind: 'read' | 'draft';
  run: (ctx: ToolContext, input: z.output<S>) => Promise<unknown>;
}): AssistantTool {
  return t as unknown as AssistantTool;
}

const noArgs = z.object({});
const showArg = z.object({
  showId: z.string().describe('The show id, from list_shows.'),
});

export const TOOLS: AssistantTool[] = [
  tool({
    name: 'list_shows',
    description:
      'Every show on the org calendar with its dates, city, status and readiness. ' +
      'The calendar is org-wide for everyone; start here to get a show id.',
    schema: noArgs,
    kind: 'read',
    run: (c) => listShows(c.actor, c.now, c.db),
  }),
  tool({
    name: 'get_show',
    description:
      'One show in detail: dates, venue, booth, budget, attendees, and the counts ' +
      'behind each tab.',
    schema: showArg,
    kind: 'read',
    run: (c, i) => getShowDetail(c.actor, i.showId, c.now, c.db),
  }),
  tool({
    name: 'my_itinerary',
    description:
      "The asking person's own trips: shows they are attending, their flights, their " +
      'travel requests, their rooms and their booth shifts. Always about the asker.',
    schema: noArgs,
    kind: 'read',
    run: (c) => getItinerary(c.actor, c.db),
  }),
  tool({
    name: 'readiness_portfolio',
    description:
      'Every show ranked by how far behind a pace curve it is, not by score. Use this ' +
      'for "what is behind" — a low score far out is on schedule and a high score next ' +
      'week may not be. A show with no checklist is unplanned, not ready.',
    schema: noArgs,
    kind: 'read',
    run: (c) => getPortfolio(c.actor, c.now, c.db),
  }),
  tool({
    name: 'show_checklist',
    description: "One show's readiness checklist, task by task, with status and owner.",
    schema: showArg,
    kind: 'read',
    run: (c, i) => getChecklist(c.actor, i.showId, c.now, c.db),
  }),
  tool({
    name: 'deadline_register',
    description:
      "One show's service manual deadlines, their penalties, and what the alert engine " +
      'will say next about each. A deadline nobody has confirmed is a guessed date: ' +
      'report it as a date to check, never as an amount at risk.',
    schema: showArg,
    kind: 'read',
    run: (c, i) => getRegister(c.actor, i.showId, c.now, c.db),
  }),
  tool({
    name: 'team_board',
    description:
      "One show's roster, booth shifts and side events, with real coverage: how many " +
      'people can actually work each shift rather than how many are assigned to it.',
    schema: showArg,
    kind: 'read',
    run: (c, i) => getTeamBoard(c.actor, i.showId, c.now, c.db),
  }),
  tool({
    name: 'staffing_conflicts',
    description:
      'People double-booked across overlapping shows. A finding marked "possible" was ' +
      'compared on show dates because a travel window was missing; say which it is.',
    schema: noArgs,
    kind: 'read',
    run: (c) => getConflicts(c.actor, c.db),
  }),
  tool({
    name: 'lodging_board',
    description:
      "One show's hotels and room blocks. Room assignments are narrowed to the asking " +
      'person unless they can approve travel.',
    schema: showArg,
    kind: 'read',
    run: (c, i) => getLodgingBoard(c.actor, i.showId, c.now, c.db),
  }),
  tool({
    name: 'flight_board',
    description:
      'Tracked flight legs ordered by what is wrong with them. An unchecked leg reads ' +
      '"unknown", which is not the same as on time.',
    schema: z.object({
      showId: z.string().optional().describe('Narrow to one show. Omit for everything.'),
    }),
    kind: 'read',
    run: (c, i) => getFlightBoard(c.actor, { showId: i.showId, asOf: c.now }, c.db),
  }),
  tool({
    name: 'shipment_board',
    description:
      'Crates ordered worst-first, each judged against its receiving window. A crate can ' +
      'be too early as well as too late, and "delivered" is the carrier\'s word — a crate ' +
      'is not received until a person says so.',
    schema: z.object({
      showId: z.string().optional().describe('Narrow to one show. Omit for everything.'),
    }),
    kind: 'read',
    run: (c, i) => getShipmentBoard(c.actor, { showId: i.showId, asOf: c.now }, c.db),
  }),
  tool({
    name: 'travel_requests',
    description:
      'Travel requests and where each one is in the booking machine. A Member sees only ' +
      'their own however this is called.',
    schema: z.object({
      scope: z.enum(['mine', 'all']).optional().describe('Defaults to everything visible.'),
    }),
    kind: 'read',
    run: (c, i) => listRequests(c.actor, { scope: i.scope }, c.db),
  }),
  tool({
    name: 'travel_request',
    description:
      'One travel request in full, including the standing of its offer — whether ' +
      'approving it would buy the fare shown or re-search for a new one.',
    schema: z.object({ requestId: z.string() }),
    kind: 'read',
    run: (c, i) => loadRequest(c.actor, i.requestId, c.db),
  }),
  tool({
    name: 'people',
    description:
      'Who the asking person may open a travel request for. Returns only the asker ' +
      'themselves unless they can approve travel.',
    schema: noArgs,
    kind: 'read',
    run: (c) => travelersFor(c.actor, c.db),
  }),
  tool({
    name: 'cost_centers',
    description: 'Cost centers a request may be booked to. Every financial row needs one.',
    schema: noArgs,
    kind: 'read',
    run: (c) => costCentersFor(c.actor, c.db),
  }),

  /* ------------------------------- drafting -------------------------------- */

  tool({
    name: 'draft_travel_request',
    description:
      'Open a travel request from what the person asked for. This does NOT search, ' +
      'price, book or authorize anything: it files the constraints you parsed and stops, ' +
      'and a human must confirm them before the booking agent will search at all. ' +
      'Give times as local airport time in ISO form (2026-09-14T17:00). Never guess a ' +
      'date the person did not give you — ask instead.',
    schema: z.object({
      travelerEmail: z
        .string()
        .optional()
        .describe('Defaults to the asking person. Only a travel manager may name another.'),
      showId: z.string().optional().describe('The show this trip is for, if there is one.'),
      originAirport: z.string().describe('IATA code, e.g. SFO.'),
      destinationAirport: z.string().describe('IATA code, e.g. LAS.'),
      earliestDepartureLocal: z.string().describe('Local at the origin: 2026-09-14T08:00'),
      latestArrivalLocal: z.string().describe('Local at the destination: 2026-09-14T12:00'),
      returnEarliestDepartureLocal: z.string().optional(),
      returnLatestArrivalLocal: z.string().optional(),
      timezone: z
        .string()
        .optional()
        .describe(
          'IANA zone those times are read in. Taken from the show when showId is given; ' +
            'required otherwise, because guessing moves the window by hours.',
        ),
      cabinPreference: z.string().optional(),
      notes: z.string().optional(),
    }),
    kind: 'draft',
    run: (c, i) => draftTravelRequest(c, i),
  }),
  tool({
    name: 'draft_lodging',
    description:
      'Record a hotel for a show. This app does not book hotels (v1 tracks them), so ' +
      'this creates a record for a person to fill in and confirm. Needs the authority ' +
      'to manage lodging; it will refuse otherwise and that refusal is the answer.',
    schema: z.object({
      showId: z.string(),
      hotelName: z.string(),
      checkInOn: z.string().optional().describe('Calendar date at the show, 2026-09-14.'),
      checkOutOn: z.string().optional(),
      nightlyRate: z
        .string()
        .optional()
        .describe('A decimal string exactly as quoted, e.g. "289.00". Never a number.'),
      costCenterId: z.string().optional().describe('From cost_centers. Required at creation.'),
      notes: z.string().optional(),
    }),
    kind: 'draft',
    run: (c, i) => draftLodgingRecord(c, i),
  }),
];

export function toolByName(name: string): AssistantTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * What the model is shown. Derived from the same Zod schema the loop validates
 * against, so a tool cannot advertise a shape it will then reject.
 */
export function specsFor(tools: AssistantTool[]): ModelToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema) as Record<string, unknown>,
  }));
}
