import Anthropic from '@anthropic-ai/sdk';
import {
  ExtractorNotConfiguredError,
  type DeadlineCandidate,
  type DeadlineExtractor,
  type ExtractionReply,
  type ExtractionRequest,
} from '../types';

/**
 * The Messages API as a deadline extractor.
 *
 * Like `llm/anthropic/client.ts` there is **no `wire.ts` and no fixtures file**,
 * for the same reason: the vendor ships the types, so there is no hand-copied
 * schema here to be wrong about and nothing for a capture script to arbitrate.
 * Unlike that one, this adapter *has* been run against a live key — there is a
 * working `ANTHROPIC_API_KEY` on this machine, which is why step 22 was picked
 * over Slack, SSO, hosting, AeroAPI and EasyPost.
 *
 * What is unverified here is not structural, it is **recall against a layout
 * nobody in this repo has seen**, and `manual/coverage.ts` is the thing that
 * measures it. See SCOPE.md §5a.
 *
 * This file makes no decisions. It sends the page text, asks once, and hands
 * back whatever came out. Three choices inside it are load-bearing:
 *
 * 1. **Structured output rather than a tool.** A tool call would mean handing a
 *    tool list to a code path whose input is a file from outside the company.
 *    `output_config.format` constrains the shape with no tool surface at all.
 * 2. **`strict`-shaped schema — `additionalProperties: false` and every field
 *    required.** Nullable fields are `["string", "null"]` rather than optional,
 *    so "the manual prints no time" arrives as an explicit null instead of an
 *    absent key that reads identically to a field the model forgot.
 * 3. **A truncated reply is reported as truncated and never as a result.** A
 *    manual read half way through yields fewer deadlines with exactly the
 *    confidence of a complete read. That is the silent miss §5a exists to
 *    prevent, so `max_tokens` is generous, the request streams (128K-class
 *    outputs time out otherwise), and `stop_reason` is carried up rather than
 *    swallowed.
 */

export type ExtractConfig = {
  apiKey: string | null;
  model: string;
  baseUrl?: string;
  workspaceId?: string;
};

/**
 * Opus 5. The failure worth avoiding is a missed deadline in a badly laid-out
 * table, which is a reading-comprehension problem rather than a latency one, and
 * a manual is read once per show.
 */
export const DEFAULT_EXTRACT_MODEL = 'claude-opus-5';

/** Room for a long register. Streamed, so this does not risk an HTTP timeout. */
const MAX_OUTPUT_TOKENS = 32000;

export function extractConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ExtractConfig {
  return {
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    model: env.MANUAL_EXTRACT_MODEL?.trim() || DEFAULT_EXTRACT_MODEL,
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    workspaceId: env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined,
  };
}

const nullableString = { type: ['string', 'null'] } as const;

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'kind',
    'dueDate',
    'dueTime',
    'penaltyEstimate',
    'penaltyNote',
    'page',
    'snippet',
  ],
  properties: {
    title: { type: 'string', description: 'What is due, in the manual’s own words.' },
    kind: {
      type: 'string',
      description:
        'One of: advance_order, electrical, furniture_carpet, av_rigging, labor, ' +
        'warehouse_cutoff, direct_to_show, booth_registration, staff_registration, ' +
        'room_block, sponsorship_artwork, other. Use "other" rather than guessing.',
    },
    dueDate: { type: 'string', description: 'YYYY-MM-DD, in the show’s own time zone.' },
    dueTime: {
      ...nullableString,
      description:
        'HH:MM, 24-hour, only when the manual prints a time. Null otherwise — do not ' +
        'assume end of day. A 4:00pm warehouse cutoff recorded as 17:00 is a real penalty.',
    },
    penaltyEstimate: {
      ...nullableString,
      description:
        'A decimal amount as printed, e.g. "3125.00", when the manual states a fixed fee. ' +
        'Null for a percentage surcharge or where no amount is given. Never compute one.',
    },
    penaltyNote: {
      ...nullableString,
      description: 'What the manual says happens if this is missed, in its own words.',
    },
    page: { type: 'integer', description: 'The page number this was read from, 1-indexed.' },
    snippet: {
      type: 'string',
      description:
        'The text this was read from, copied EXACTLY from that page — same characters, ' +
        'same order. It is checked against the page and the deadline is discarded if it ' +
        'does not occur there.',
    },
  },
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deadlines'],
  properties: { deadlines: { type: 'array', items: CANDIDATE_SCHEMA } },
} as const;

/**
 * The system prompt carries **tense and evidence rules, and nothing
 * load-bearing** — `assistant/prompt.ts`'s rule, and it matters more here. Every
 * refusal that has to hold is in code: the anchor check is in `anchor.ts`, the
 * kind and date validation in `candidates.ts`, the confirmation gate in
 * `store.ts`, and the rule that nothing extracted is quoted in dollars until a
 * person confirms it is enforced by the step 11 engine that was already there.
 * Nothing below is trusted to be obeyed.
 */
const SYSTEM = [
  'You read exhibitor service manuals and list the deadlines in them.',
  '',
  'A deadline is a date by which an exhibitor must do something — order electrical, ship',
  'freight to the advance warehouse, register staff, submit artwork, book a room block.',
  'Missing one usually costs money. The show’s own dates, move-in and move-out times,',
  'copyright years, and document revision dates are NOT deadlines.',
  '',
  'Rules:',
  '- Every deadline must carry the page it is on and a snippet copied exactly from that',
  '  page. The snippet is checked against the document; a deadline whose snippet does not',
  '  occur on the page it names is discarded. Copy, do not paraphrase, and do not repair',
  '  typography.',
  '- If you are not sure a date is a deadline, include it anyway with kind "other". A date',
  '  proposed and rejected by a person costs a second; a deadline nobody noticed costs a',
  '  surcharge. Somebody reads and confirms every row before any of it is acted on.',
  '- Never state a penalty amount the manual does not print. A percentage surcharge is a',
  '  note, not an amount.',
  '- Never assume a time of day. If the manual does not print one, the time is null.',
  '- If a page carries no text, say nothing about it.',
].join('\n');

export class AnthropicDeadlineExtractor implements DeadlineExtractor {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;

  constructor(private readonly config: ExtractConfig) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  private sdk(): Anthropic {
    if (!this.config.apiKey) {
      throw new ExtractorNotConfiguredError('Anthropic', ['ANTHROPIC_API_KEY']);
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

  async extract(request: ExtractionRequest): Promise<ExtractionReply> {
    const { showName, opensOn, closesOn, timezone } = request.context;

    const stream = this.sdk().messages.stream({
      model: this.config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      // The reading is the part worth paying for and the cheapest place to be
      // wrong: a deadline in a run-together table is exactly what adaptive
      // thinking is for.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            `Exhibitor service manual for ${showName}, which opens ${opensOn} and closes`,
            `${closesOn}. All dates and times are in ${timezone}. Where the manual prints a`,
            'date with no year, use the year that puts it before the show opens.',
            '',
            'List every deadline in it.',
            '',
            request.document,
          ].join('\n'),
        },
      ],
    });

    const reply = await stream.finalMessage();

    let text = '';
    for (const block of reply.content) if (block.type === 'text') text += block.text;

    return {
      provider: this.name,
      model: reply.model,
      candidates: parseCandidates(text),
      truncated: reply.stop_reason === 'max_tokens',
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    };
  }
}

/**
 * Read the constrained JSON back.
 *
 * Structured output makes the *shape* reliable; it makes nothing about the
 * contents true, so everything here is read defensively and every field is
 * handed on as-was for `candidates.ts` to validate. A row that is not an object
 * is dropped here rather than crashing the run — one malformed entry must not
 * discard a manual's worth of correct ones, which would turn a shape problem
 * into the silent miss.
 */
export function parseCandidates(text: string): DeadlineCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = (parsed as { deadlines?: unknown })?.deadlines;
  if (!Array.isArray(rows)) return [];

  const out: DeadlineCandidate[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const nul = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
    out.push({
      title: str(r.title),
      kind: str(r.kind),
      dueDate: str(r.dueDate),
      dueTime: nul(r.dueTime),
      penaltyEstimate: nul(r.penaltyEstimate),
      penaltyNote: nul(r.penaltyNote),
      page: typeof r.page === 'number' ? r.page : 0,
      snippet: str(r.snippet),
    });
  }
  return out;
}
