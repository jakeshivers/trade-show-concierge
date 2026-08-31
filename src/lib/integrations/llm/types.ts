/**
 * Language model provider interface.
 *
 * The fourth integration behind an interface, and the same posture as the first
 * three: with no API key the app still runs, says "the assistant is not
 * configured", and never invents an answer. SCOPE.md non-negotiable #2.
 *
 * What this interface deliberately does **not** do is run the loop. It performs
 * one exchange — here is the system prompt, the transcript so far, and the tools
 * you may ask for; reply with prose, or with tool calls, and say why you
 * stopped. Whether to run a tool, which actor to run it as, whether the answer
 * is allowed to exist at all, and when to stop are `src/lib/assistant/loop.ts`'s
 * job. The provider is the least trustworthy thing in the loop and the least
 * testable, so nothing that has to be right may live inside it.
 *
 * This is also the first integration where a vendor SDK exists, and using it
 * closes the gap step 12.5 named. Duffel, AeroAPI and EasyPost are hand-written
 * wire types checked against fixtures we wrote ourselves — a closed loop that
 * proves internal consistency and structurally cannot catch a wrong field name.
 * `@anthropic-ai/sdk` ships the wire types with the API, so there is no
 * hand-copied schema here to be wrong about. The `scripted` provider below is
 * therefore not a fixture of *the vendor's* payloads; it is a fixture of this
 * interface, which is ours.
 */

/** One entry in the transcript, in the model's terms rather than the screen's. */
export type ModelMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'tool_results'; results: ModelToolResult[] };

export type ModelToolCall = {
  /** Provider-assigned, and the only thing that pairs a call with its result. */
  id: string;
  name: string;
  /** Raw, unvalidated JSON from the model. The loop validates before dispatch. */
  input: unknown;
};

export type ModelToolResult = {
  callId: string;
  /** Serialized result, or the refusal. Both are ordinary results to the model. */
  content: string;
  isError: boolean;
};

/** What a tool looks like to the model. Handlers live in `assistant/tools.ts`. */
export type ModelToolSpec = {
  name: string;
  description: string;
  /** JSON Schema. Produced from the Zod schema the loop validates against. */
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens: number;
};

export type ModelStopReason =
  | 'end_turn'
  | 'tool_use'
  /** Ran out of output room. The loop must not treat a truncated turn as final. */
  | 'max_tokens'
  /** The model declined. Not an error — a legitimate outcome to render. */
  | 'refusal';

export type ModelReply = {
  provider: string;
  model: string;
  text: string;
  toolCalls: ModelToolCall[];
  stopReason: ModelStopReason;
  /** For the audit row. Null where a provider does not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
};

export interface AssistantModel {
  readonly name: string;
  isConfigured(): boolean;
  respond(request: ModelRequest): Promise<ModelReply>;
}

export class ModelNotConfiguredError extends Error {
  constructor(provider: string, envVars: string[]) {
    super(
      `${provider} is not configured. The assistant needs ${envVars.join(', ')}. ` +
        'Nothing here invents an answer without it.',
    );
    this.name = 'ModelNotConfiguredError';
  }
}
