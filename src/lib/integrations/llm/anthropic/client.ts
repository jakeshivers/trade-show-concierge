import Anthropic from '@anthropic-ai/sdk';
import {
  ModelNotConfiguredError,
  type AssistantModel,
  type ModelMessage,
  type ModelReply,
  type ModelRequest,
  type ModelStopReason,
  type ModelToolCall,
} from '../types';

/**
 * The Anthropic Messages API, behind `AssistantModel`.
 *
 * **Unlike the other three adapters, this one has never had a hand-written wire
 * schema, and that is the point.** `duffel/wire.ts`, `aeroapi/wire.ts` and
 * `easypost/wire.ts` are transcriptions of published docs, tested against
 * fixtures we invented — which proves we are self-consistent and cannot catch a
 * misread field name (SCOPE.md §10, step 12.5). Here the vendor ships the types
 * with the client, so the compiler checks the shape and there is nothing left
 * for a capture script to arbitrate. There is consequently no `wire.ts` and no
 * `fixtures.ts` beside this file, and that absence is deliberate rather than an
 * omission.
 *
 * It has still never been run against a live key. What that costs us is now
 * only *behavioural* — whether the model uses the tools well — and not
 * structural.
 *
 * This file makes no decisions. It translates our transcript into theirs, asks
 * once, and translates back. In particular it does **not** loop: a `tool_use`
 * stop comes straight back to the caller, because running a tool means choosing
 * an actor to run it as, and that choice must not live inside an adapter.
 */

export type AnthropicConfig = {
  apiKey: string | null;
  model: string;
  baseUrl?: string;
  /**
   * An identity-linked key acts *in* a workspace rather than owning one, and
   * the API refuses the request outright without the header rather than
   * choosing a default — the same posture this app takes everywhere else about
   * guessing. It is optional because a classic workspace key does not carry
   * one; when a key needs it and it is absent, the 400 names the header.
   */
  workspaceId?: string;
};

/**
 * Opus 5 by default. The assistant reads a workspace and drafts requests a
 * person then commits, so the failure worth avoiding is a confident wrong
 * summary rather than a slow one.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

export function anthropicConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnthropicConfig {
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    model: env.ASSISTANT_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    workspaceId: env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined,
  };
}

function toContent(m: ModelMessage): Anthropic.MessageParam {
  if (m.role === 'user') return { role: 'user', content: m.text };

  if (m.role === 'tool_results') {
    // Every result for one assistant turn goes back in a *single* user message.
    // Splitting them teaches the model to stop asking for tools in parallel.
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.callId,
        content: r.content,
        is_error: r.isError,
      })),
    };
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
  for (const c of m.toolCalls) {
    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input as object });
  }
  return { role: 'assistant', content: blocks };
}

function stopReasonOf(raw: Anthropic.Message['stop_reason']): ModelStopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export class AnthropicAssistantModel implements AssistantModel {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;

  constructor(private readonly config: AnthropicConfig) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  private sdk(): Anthropic {
    if (!this.config.apiKey) {
      throw new ModelNotConfiguredError('Anthropic', ['ANTHROPIC_API_KEY']);
    }
    this.client ??= new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      defaultHeaders: this.config.workspaceId
        ? { 'anthropic-workspace-id': this.config.workspaceId }
        : undefined,
    });
    return this.client;
  }

  async respond(request: ModelRequest): Promise<ModelReply> {
    const reply = await this.sdk().messages.create({
      model: this.config.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      // Adaptive thinking: the tool-choice reasoning here is exactly the part
      // worth paying for, and the cheapest place to get an answer wrong.
      thinking: { type: 'adaptive' },
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: request.messages.map(toContent),
    });

    const toolCalls: ModelToolCall[] = [];
    let text = '';
    for (const block of reply.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    return {
      provider: this.name,
      model: reply.model,
      text,
      toolCalls,
      stopReason: stopReasonOf(reply.stop_reason),
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    };
  }
}
