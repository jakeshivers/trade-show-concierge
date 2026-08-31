import type {
  AssistantModel,
  ModelMessage,
  ModelReply,
  ModelRequest,
  ModelToolCall,
} from '../types';

/**
 * A model stand-in that replays **tool plans**, never prose.
 *
 * The other three integrations have a `recorded` provider that replays captured
 * payloads, and the rule each of them obeys is that a replay may describe a
 * *shape* and must not assert a fact about this workspace: EasyPost's replay
 * projects a recorded journey onto the crate's real transit window, AeroAPI's
 * projects a recorded delay onto the real block time. Recorded prose has no
 * equivalent move available. "MedTech is 62% ready and two deadlines are at
 * risk" is not a shape that can be projected onto anything — it is a sentence
 * about a different workspace, and replaying it would put a fabricated figure in
 * front of a person under the app's own byline. That is the failure §5a spends a
 * whole engine avoiding.
 *
 * So this provider replays only the half that *can* be replayed: which tools a
 * question calls for. The tools then run for real, against the real database, as
 * the real actor, and the closing text is a fixed sentence that hands the reader
 * those results rather than characterising them. Every number a person sees on a
 * scripted run came out of the store this run, and the screen says the narration
 * is scripted.
 *
 * It is a keyword matcher and it is not pretending otherwise. Its job is to make
 * the loop, the tool gates and the drafting path exercisable with zero keys —
 * `pnpm test` and `pnpm assistant` — not to answer questions well.
 */

type Script = {
  key: string;
  /** Matched against the lowercased user turn. All must appear. */
  match: string[][];
  /** Tool calls to request, in order, one batch per turn. */
  turns: { name: string; input: Record<string, unknown> }[][];
};

/**
 * Deliberately small. Each entry exists because some path through the loop needs
 * exercising without a key, not because it makes the matcher smarter.
 */
export const SCRIPTS: Script[] = [
  // Ordered most specific first, and that order is load-bearing: nearly every
  // question about this product mentions a show, so a `show` script placed
  // first swallows "where is the crate for the live show?" and answers it with
  // a calendar.
  {
    key: 'freight',
    match: [['crate'], ['shipment'], ['freight'], ['booth arriv']],
    turns: [[{ name: 'shipment_board', input: {} }]],
  },
  {
    key: 'flights',
    match: [['delay'], ['flight board'], ['on time'], ['land']],
    turns: [[{ name: 'flight_board', input: {} }]],
  },
  {
    key: 'itinerary',
    match: [['my trip'], ['itinerary'], ['am i flying'], ['my flight'], ['where am i']],
    turns: [[{ name: 'my_itinerary', input: {} }]],
  },
  {
    key: 'travel',
    match: [['travel request'], ['approval'], ['my requests']],
    turns: [[{ name: 'travel_requests', input: {} }]],
  },
  {
    key: 'readiness',
    match: [['ready'], ['readiness'], ['behind']],
    turns: [[{ name: 'readiness_portfolio', input: {} }]],
  },
  {
    key: 'shows',
    match: [['show'], ['calendar'], ['coming up'], ['schedule']],
    turns: [[{ name: 'list_shows', input: {} }]],
  },
];

/**
 * The one sentence the scripted provider is allowed to write, and the reason it
 * is allowed: it characterises nothing. Everything specific below it came from a
 * tool that ran this turn.
 */
export const SCRIPTED_CLOSING =
  'Scripted reply: no language model is configured, so this run chose which tools to ' +
  'call from a keyword match and then read the results out of the workspace for real. ' +
  'Every tool result in this exchange is live; this sentence is the only canned part, ' +
  'and it is deliberately the only part, because a canned sentence about a workspace it ' +
  'has never seen would be a fabricated claim.';

export class ScriptedAssistantModel implements AssistantModel {
  readonly name = 'scripted';

  isConfigured(): boolean {
    return true;
  }

  async respond(request: ModelRequest): Promise<ModelReply> {
    const asked = lastUserText(request.messages).toLowerCase();
    const script = SCRIPTS.find((s) => s.match.some((all) => all.every((t) => asked.includes(t))));
    const turnsTaken = request.messages.filter((m) => m.role === 'tool_results').length;

    const plan = script?.turns[turnsTaken];
    const available = new Set(request.tools.map((t) => t.name));

    if (plan) {
      // A tool the actor may not use is simply absent from `request.tools`. Asking
      // for it anyway would exercise the loop's refusal path rather than the
      // matcher's intent, so a plan naming an unavailable tool is dropped, not
      // downgraded — the run then closes and says what it could not reach.
      const calls: ModelToolCall[] = plan
        .filter((p) => available.has(p.name))
        .map((p, i) => ({ id: `scripted_${turnsTaken}_${i}`, name: p.name, input: p.input }));

      if (calls.length > 0) {
        return {
          provider: this.name,
          model: 'scripted',
          text: '',
          toolCalls: calls,
          stopReason: 'tool_use',
          inputTokens: null,
          outputTokens: null,
        };
      }
    }

    return {
      provider: this.name,
      model: 'scripted',
      text: script
        ? SCRIPTED_CLOSING
        : `${SCRIPTED_CLOSING}\n\nNo script matched that question, so nothing was looked up. ` +
          `A configured model would have chosen from: ${[...available].sort().join(', ')}.`,
      toolCalls: [],
      stopReason: 'end_turn',
      inputTokens: null,
      outputTokens: null,
    };
  }
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m.text;
  }
  return '';
}
