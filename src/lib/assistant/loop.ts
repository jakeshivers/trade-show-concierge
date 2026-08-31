import { z } from 'zod';
import type { Actor } from '@/lib/auth/actor';
import { ForbiddenError } from '@/lib/auth/actor';
import type { getDb } from '@/db';
import type {
  AssistantModel,
  ModelMessage,
  ModelToolResult,
} from '@/lib/integrations/llm/types';
import { toolsFor } from './access';
import { specsFor, type ToolContext } from './tools';
import { serializeResult } from './serialize';
import { systemPrompt } from './prompt';

/**
 * The agent loop. Everything that decides anything lives here or above it, and
 * nothing that decides anything lives in the provider.
 *
 * It is a manual loop rather than the SDK's tool runner, for one reason: every
 * tool call has to run as a specific `Actor`, and be recorded as having done so.
 * A runner that executes tools from inside the provider is a runner that has to
 * be handed a closure over the actor, which puts the most important decision in
 * this step behind the least testable boundary in it. Here the dispatch is
 * ordinary code with an explicit actor argument, and `loop.test.ts` can hand it
 * a Member and assert what came back.
 *
 * Three bounds, all of them ours rather than the model's:
 *
 * - `MAX_TURNS` — a model that keeps asking for tools stops being useful long
 *   before it stops being expensive.
 * - `MAX_TOOL_CALLS` — the same bound counted across the turn, because one turn
 *   asking for twelve boards is the same problem.
 * - a truncated reply (`max_tokens`) is never treated as a finished answer.
 */

export const MAX_TURNS = 6;
export const MAX_TOOL_CALLS = 12;
export const MAX_OUTPUT_TOKENS = 4096;

export type ToolStep = {
  name: string;
  input: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
};

export type TurnResult = {
  text: string;
  steps: ToolStep[];
  /** Set when a draft tool wrote a row a human still has to act on. */
  draftTravelRequestId: string | null;
  draftLodgingId: string | null;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the loop stopped on a bound rather than because the model finished. */
  truncated: boolean;
};

export type RunTurnInput = {
  actor: Actor;
  model: AssistantModel;
  db: ReturnType<typeof getDb>;
  now: Date;
  /** The transcript so far, oldest first. This turn's question is `question`. */
  history: ModelMessage[];
  question: string;
};

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const { actor, model, db, now, question } = input;

  const available = toolsFor(actor);
  const specs = specsFor(available);
  const ctx: ToolContext = { actor, db, now, rawRequestText: question };

  const messages: ModelMessage[] = [...input.history, { role: 'user', text: question }];
  const steps: ToolStep[] = [];
  let draftTravelRequestId: string | null = null;
  let draftLodgingId: string | null = null;
  let truncated = false;
  let last = { provider: model.name, model: model.name, inTok: null as number | null, outTok: null as number | null };
  let text = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await model.respond({
      system: systemPrompt(actor, { asOf: now }),
      messages,
      tools: specs,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    last = {
      provider: reply.provider,
      model: reply.model,
      inTok: reply.inputTokens,
      outTok: reply.outputTokens,
    };
    if (reply.text.trim()) text = reply.text;

    if (reply.stopReason === 'max_tokens') {
      // A cut-off answer is not an answer. Saying so is cheaper than letting a
      // half-sentence about a crate stand as the finding.
      truncated = true;
      text = `${text}\n\n[This reply was cut off before it finished. Ask again more narrowly.]`;
      break;
    }
    if (reply.stopReason !== 'tool_use' || reply.toolCalls.length === 0) break;

    if (steps.length + reply.toolCalls.length > MAX_TOOL_CALLS) {
      truncated = true;
      text =
        `${text}\n\n[Stopped after ${steps.length} lookups without reaching an answer. ` +
        'Ask about one show or one board at a time.]';
      break;
    }

    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });

    const results: ModelToolResult[] = [];
    for (const call of reply.toolCalls) {
      const step = await dispatch(ctx, available, call.name, call.input);
      steps.push(step);

      const draft = draftIdOf(step);
      if (draft?.kind === 'travel_request') draftTravelRequestId = draft.id;
      if (draft?.kind === 'lodging') draftLodgingId = draft.id;

      results.push({
        callId: call.id,
        content: step.error ?? serializeResult(step.result).text,
        isError: step.error !== null,
      });
    }
    // All results for one assistant turn go back in one message. Splitting them
    // teaches the model to stop asking for tools in parallel.
    messages.push({ role: 'tool_results', results });

    if (turn === MAX_TURNS - 1) {
      truncated = true;
      text = `${text}\n\n[Stopped after ${MAX_TURNS} rounds of lookups without an answer.]`;
    }
  }

  return {
    text: text.trim(),
    steps,
    draftTravelRequestId,
    draftLodgingId,
    provider: last.provider,
    model: last.model,
    inputTokens: last.inTok,
    outputTokens: last.outTok,
    truncated,
  };
}

/**
 * One tool call, as the actor.
 *
 * Every failure here comes back as an ordinary tool *result* rather than an
 * exception, and that is deliberate: a refusal is information the model should
 * relay ("you can only see your own room assignment"), and a crash would end the
 * turn with the person's question unanswered and no explanation. What must never
 * happen — and does not, because `available` is the gated list — is a refused
 * tool running anyway.
 */
async function dispatch(
  ctx: ToolContext,
  available: ReturnType<typeof toolsFor>,
  name: string,
  rawInput: unknown,
): Promise<ToolStep> {
  const tool = available.find((t) => t.name === name);
  if (!tool) {
    // Either a hallucinated name or a real tool this actor does not hold, and
    // the two are answered **identically** on purpose. "That tool exists but is
    // not available to you" is a map: it confirms the capability, names it, and
    // invites a second attempt through some other door. "That is not a tool"
    // ends it. The withheld tool was never described in the first place
    // (`access.ts`), and this is the same rule at the other end of the turn.
    return {
      name,
      input: null,
      result: null,
      error: `${name} is not a tool. Available: ${available.map((t) => t.name).join(', ')}.`,
    };
  }

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      name,
      input: null,
      result: null,
      error: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
    };
  }
  const input = parsed.data as Record<string, unknown>;

  try {
    const result = await tool.run(ctx, input as never);
    return { name, input, result, error: null };
  } catch (err) {
    // A ForbiddenError is the store's answer, not a fault: pass its sentence
    // through so the person is told what they may not do and by which rule.
    if (err instanceof ForbiddenError) {
      return { name, input, result: null, error: (err as Error).message };
    }
    return { name, input, result: null, error: `${name} failed: ${(err as Error).message}` };
  }
}

function draftIdOf(step: ToolStep): { kind: string; id: string } | null {
  const r = step.result as { drafted?: string; id?: string } | null;
  if (!r || typeof r !== 'object' || !r.drafted || !r.id) return null;
  return { kind: r.drafted, id: r.id };
}
