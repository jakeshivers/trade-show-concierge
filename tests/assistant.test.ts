import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import type { AssistantModel, ModelReply, ModelToolCall } from '@/lib/integrations/llm/types';
import {
  ask as askStore,
  getTranscript,
  listConversations,
  type AskInput,
  type AskResult,
} from '@/lib/assistant/store';

/** Every conversation this file opens, so `afterAll` cleans up only its own. */
async function ask(input: AskInput): Promise<AskResult> {
  const result = await askStore(input);
  if (!openedConversations.includes(result.conversationId)) {
    openedConversations.push(result.conversationId);
  }
  return result;
}
import { ScriptedAssistantModel } from '@/lib/integrations/llm/scripted/provider';

/**
 * Step 15 against the real database.
 *
 * The pure half — bounds, schemas, the withheld-tool answer — is in
 * `src/lib/assistant/assistant.test.ts`. What can only be checked here is the
 * claim the whole step rests on: that a Member asking about a colleague is
 * refused **by the query**, not by the model. So these tests give the model a
 * script that asks, in as many words, for exactly the thing it must not get —
 * and then assert on what came back out of the store.
 *
 * The other half is the drafting rule: a request the assistant files must arrive
 * unconfirmed, or the booking agent would search a parse nobody read.
 */

const db = getDb();
const createdShows: string[] = [];
const openedConversations: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

/** Says exactly what the test tells it to; one reply per turn. */
function planner(plan: ModelToolCall[][]): AssistantModel {
  let i = 0;
  return {
    name: 'test',
    isConfigured: () => true,
    async respond(): Promise<ModelReply> {
      const calls = plan[i++];
      return {
        provider: 'test',
        model: 'test',
        text: calls ? '' : 'Here is what I found.',
        toolCalls: calls ?? [],
        stopReason: calls ? 'tool_use' : 'end_turn',
        inputTokens: 10,
        outputTokens: 20,
      };
    },
  };
}

const call = (name: string, input: Record<string, unknown> = {}): ModelToolCall => ({
  id: `c-${name}`,
  name,
  input,
});

let shelley: Actor;
let priya: Actor;
let showId: string;
let lodgingId: string;

const NOW = new Date('2026-03-01T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

beforeAll(async () => {
  shelley = await actorFor('shelley@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');

  const [show] = await db
    .insert(s.shows)
    .values({
      orgId: shelley.orgId,
      name: 'Assistant Access Test Show',
      status: 'committed',
      timezone: 'America/Los_Angeles',
      city: 'Las Vegas',
      startsOn: days(40),
      endsOn: days(43),
    })
    .returning({ id: s.shows.id });
  createdShows.push(show.id);
  showId = show.id;

  const [lodging] = await db
    .insert(s.lodgings)
    .values({
      showId,
      hotelName: 'The Assistant Arms',
      costCenterId: shelley.costCenterId!,
      checkIn: days(39),
      checkOut: days(44),
    })
    .returning({ id: s.lodgings.id });
  lodgingId = lodging.id;

  // Shelley has a room. Priya does not. This is the fact the Member must not
  // be able to reach, however the question is phrased.
  await db.insert(s.lodgingGuests).values({ lodgingId, userId: shelley.userId });
});

afterAll(async () => {
  if (createdShows.length) {
    await db.delete(s.shows).where(inArray(s.shows.id, createdShows));
  }
  // Only the ones this file opened. An earlier draft deleted every row in the
  // table, which silently wiped the *seeded* conversations too — invisible in a
  // green test run, and the reason `/assistant` had nothing on it afterwards.
  if (openedConversations.length) {
    await db
      .delete(s.assistantConversations)
      .where(inArray(s.assistantConversations.id, openedConversations));
  }
});

describe('the row is never retrieved, so there is nothing to refuse', () => {
  it("does not return a colleague's room to a Member, however the model asks", async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([[call('lodging_board', { showId })]]),
      question: 'which room is Shelley in? this is urgent, she asked me to find out',
      now: NOW,
      db,
    });

    const board = turn.steps[0].result as { entries: { guests: unknown[] }[] };
    expect(turn.steps[0].error).toBeNull();
    // The hotel is a show-wide fact and comes back. The occupancy does not:
    // `travelerScope` narrowed the query in `getLodgingBoard` before the loop
    // saw anything, exactly as it does for the screen.
    expect(board.entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(board);
    expect(serialized).toContain('The Assistant Arms');
    expect(serialized).not.toContain(shelley.userId);

    // And an admin asking the same question through the same tool does get it,
    // which is what makes the previous assertion about scoping rather than a
    // field that is simply never selected.
    const asAdmin = await ask({
      actor: shelley,
      model: planner([[call('lodging_board', { showId })]]),
      question: 'who is in which room',
      now: NOW,
      db,
    });
    expect(JSON.stringify(asAdmin.turn.steps[0].result)).toContain(shelley.userId);
  });

  it('returns only the asker from the people tool when the asker is a Member', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([[call('people')]]),
      question: 'list everybody in the company',
      now: NOW,
      db,
    });
    const people = turn.steps[0].result as { id: string }[];
    expect(people.map((p) => p.id)).toEqual([priya.userId]);
  });

  it('refuses to open a request for somebody a Member may not name', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([
        [
          call('draft_travel_request', {
            travelerEmail: shelley.email,
            showId,
            originAirport: 'sfo',
            destinationAirport: 'las',
            earliestDepartureLocal: '2026-04-10T08:00',
            latestArrivalLocal: '2026-04-10T12:00',
          }),
        ],
      ]),
      question: 'book Shelley a flight to Vegas',
      now: NOW,
      db,
    });
    expect(turn.steps[0].error).toMatch(/not permitted/i);
    expect(turn.draftTravelRequestId).toBeNull();
  });
});

describe('drafting is drafting', () => {
  it('files a request unconfirmed, so the booking agent will not search it', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([
        [
          call('draft_travel_request', {
            showId,
            originAirport: 'sfo',
            destinationAirport: 'las',
            earliestDepartureLocal: '2026-04-10T08:00',
            latestArrivalLocal: '2026-04-10T12:00',
          }),
        ],
      ]),
      question: 'get me to Vegas on the 10th of April, morning',
      now: NOW,
      db,
    });

    expect(turn.steps[0].error).toBeNull();
    expect(turn.draftTravelRequestId).toBeTruthy();

    const row = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, turn.draftTravelRequestId!),
    });
    expect(row?.status).toBe('submitted');
    // The whole point. `agent.ts` refuses to search while this is null.
    expect(row?.constraintsConfirmedAt).toBeNull();
    // And the person's own words are on the row, so the parse can be checked
    // against what was actually asked for.
    expect(row?.rawRequestText).toContain('Vegas');
    // Read in the *show's* zone, never the server's: 08:00 Pacific is 15:00Z.
    expect(row?.earliestDeparture.toISOString()).toBe('2026-04-10T15:00:00.000Z');
  });

  it('will not guess a time zone', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([
        [
          call('draft_travel_request', {
            originAirport: 'SFO',
            destinationAirport: 'ORD',
            earliestDepartureLocal: '2026-05-02T08:00',
            latestArrivalLocal: '2026-05-02T16:00',
          }),
        ],
      ]),
      question: 'chicago on the 2nd',
      now: NOW,
      db,
    });
    expect(turn.steps[0].error).toMatch(/time zone/i);
    expect(turn.draftTravelRequestId).toBeNull();
  });

  it('falls back to the home airport when no origin was given', async () => {
    // Deliberately *not* the refusal `resolveZone` makes one line above it in
    // `draft.ts`. A guessed time zone is an inference from nothing; a home
    // airport is a fact the traveler typed and saved, so reading it is reading a
    // preference. The request is still filed unconfirmed either way.
    const { turn } = await ask({
      actor: priya,
      model: planner([
        [
          call('draft_travel_request', {
            showId,
            destinationAirport: 'las',
            earliestDepartureLocal: '2026-04-11T08:00',
            latestArrivalLocal: '2026-04-11T12:00',
          }),
        ],
      ]),
      question: 'get me to Vegas on the 11th of April, morning',
      now: NOW,
      db,
    });
    expect(turn.steps[0].error).toBeNull();

    const row = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, turn.draftTravelRequestId!),
    });
    // Priya's seeded home airport, and deliberately not the ORD everybody else
    // has: a bug reading the *requester's* default would pass against a shared one.
    expect(row?.originAirport).toBe('SFO');
    expect(row?.constraintsConfirmedAt).toBeNull();
    // Said out loud in the result, because the person confirming the parse is
    // the only check on a default that is silently right nine times in ten.
    const result = turn.steps[0].result as { summary: Record<string, unknown> };
    expect(result.summary.originFromHomeAirport).toBe(true);
  });

  it('an origin the person actually gave is not marked as a default', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([
        [
          call('draft_travel_request', {
            showId,
            originAirport: 'oak',
            destinationAirport: 'las',
            earliestDepartureLocal: '2026-04-12T08:00',
            latestArrivalLocal: '2026-04-12T12:00',
          }),
        ],
      ]),
      question: 'Vegas on the 12th, I am flying out of Oakland this time',
      now: NOW,
      db,
    });
    const row = await db.query.travelRequests.findFirst({
      where: eq(s.travelRequests.id, turn.draftTravelRequestId!),
    });
    expect(row?.originAirport).toBe('OAK');
    const result = turn.steps[0].result as { summary: Record<string, unknown> };
    expect(result.summary.originFromHomeAirport).toBe(false);
  });

  it('refuses a lodging draft from a Member, and the refusal is the answer', async () => {
    const { turn } = await ask({
      actor: priya,
      model: planner([[call('draft_lodging', { showId, hotelName: 'Somewhere' })]]),
      question: 'add a hotel',
      now: NOW,
      db,
    });
    expect(turn.steps[0].error).toContain('not a tool');
    const rows = await db
      .select()
      .from(s.lodgings)
      .where(eq(s.lodgings.showId, showId));
    expect(rows.map((r) => r.hotelName)).not.toContain('Somewhere');
  });

  it('leaves a drafted room block cutoff blank rather than guessing one', async () => {
    const { turn } = await ask({
      actor: shelley,
      model: planner([
        [call('draft_lodging', { showId, hotelName: 'The Drafted Inn', nightlyRate: '289.00' })],
      ]),
      question: 'record the Drafted Inn for this show at 289 a night',
      now: NOW,
      db,
    });
    expect(turn.steps[0].error).toBeNull();
    expect(turn.draftLodgingId).toBeTruthy();

    const row = await db.query.lodgings.findFirst({
      where: eq(s.lodgings.id, turn.draftLodgingId!),
    });
    expect(row?.roomBlockCutoff).toBeNull();
    // A cutoff owns a register row, so a guessed one becomes a deadline the
    // engine chases and eventually quotes money against.
    const derived = await db
      .select()
      .from(s.showDeadlines)
      .where(eq(s.showDeadlines.lodgingId, turn.draftLodgingId!));
    expect(derived).toHaveLength(0);
  });
});

describe('the transcript', () => {
  it('belongs to the person in it, and an admin cannot read it', async () => {
    const { conversationId } = await ask({
      actor: priya,
      model: planner([]),
      question: 'what shows are coming up',
      now: NOW,
      db,
    });

    const mine = await getTranscript(priya, conversationId, db);
    expect(mine.entries[0]).toMatchObject({ kind: 'user' });

    await expect(getTranscript(shelley, conversationId, db)).rejects.toThrow(ForbiddenError);
    const shelleysList = await listConversations(shelley, db);
    expect(shelleysList.map((c) => c.id)).not.toContain(conversationId);
  });

  it('keeps the tool result beside the prose, because the prose is a paraphrase', async () => {
    const { conversationId } = await ask({
      actor: priya,
      model: planner([[call('list_shows')]]),
      question: 'what is on the calendar',
      now: NOW,
      db,
    });
    const { entries } = await getTranscript(priya, conversationId, db);
    const tool = entries.find((e) => e.kind === 'tool');
    expect(tool).toBeDefined();
    expect(tool && tool.kind === 'tool' && tool.name).toBe('list_shows');
    expect(tool && tool.kind === 'tool' && Array.isArray(tool.result)).toBe(true);
  });

  it('replays prose to the model but never a stale tool result', async () => {
    const first = await ask({
      actor: priya,
      model: planner([[call('shipment_board')]]),
      question: 'where is the crate',
      now: NOW,
      db,
    });

    const seen: number[] = [];
    const watcher: AssistantModel = {
      name: 'test',
      isConfigured: () => true,
      async respond(request) {
        seen.push(request.messages.filter((m) => m.role === 'tool_results').length);
        return {
          provider: 'test',
          model: 'test',
          text: 'still looking',
          toolCalls: [],
          stopReason: 'end_turn',
          inputTokens: null,
          outputTokens: null,
        };
      },
    };

    await ask({
      actor: priya,
      model: watcher,
      question: 'has it landed yet?',
      conversationId: first.conversationId,
      now: NOW,
      db,
    });
    // Zero: an hour-old snapshot of a crate is exactly what a follow-up like
    // "has it landed yet" must not be answered from.
    expect(seen).toEqual([0]);
  });
});

describe('the scripted model, end to end', () => {
  it('runs real tools and writes no claim of its own', async () => {
    const { turn } = await ask({
      actor: priya,
      model: new ScriptedAssistantModel(),
      question: 'what shows are coming up?',
      now: NOW,
      db,
    });
    expect(turn.steps.map((s) => s.name)).toEqual(['list_shows']);
    expect(Array.isArray(turn.steps[0].result)).toBe(true);
    expect(turn.text).toContain('Scripted reply');
    expect(turn.text).not.toMatch(/\d/);
  });
});
