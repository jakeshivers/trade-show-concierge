import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import type { AssistantModel, ModelMessage } from '@/lib/integrations/llm/types';
import { runTurn, type ToolStep, type TurnResult } from './loop';
import { canUseAssistant } from './access';

type Db = ReturnType<typeof getDb>;

/**
 * Rows. The only file in `assistant/` that touches the database — the same split
 * every module since step 8 uses, and here it is doing double duty: it is also
 * the only place that could accidentally give the agent a query of its own.
 *
 * Note what these functions are scoped by. Everything else in the app scopes to
 * `actor.orgId` and then narrows by `travelerScope`. A conversation scopes to
 * `actor.userId` **and** `orgId`, with no widening for an approver, because the
 * tool results inside a transcript were retrieved under the scope of the person
 * who was talking. An admin reading a Member's transcript would be reading rows
 * that a query narrowed for somebody else — a lateral path around the exact
 * mechanism this step is built on. So there is no "read another user's
 * conversation" function here, and adding one would be the second way to break
 * the posture after adding an ungated tool.
 */

export type ConversationSummary = {
  id: string;
  title: string;
  provider: string;
  model: string;
  updatedAt: Date;
};

export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string; at: Date }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      at: Date;
      draftTravelRequestId: string | null;
      draftLodgingId: string | null;
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown> | null;
      result: unknown;
      error: string | null;
      at: Date;
    };

export type Transcript = {
  conversation: ConversationSummary;
  entries: TranscriptEntry[];
};

export async function listConversations(
  actor: Actor,
  db: Db = getDb(),
): Promise<ConversationSummary[]> {
  const rows = await db
    .select()
    .from(s.assistantConversations)
    .where(
      and(
        eq(s.assistantConversations.orgId, actor.orgId),
        eq(s.assistantConversations.userId, actor.userId),
      ),
    )
    .orderBy(desc(s.assistantConversations.updatedAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    provider: r.provider,
    model: r.model,
    updatedAt: r.updatedAt,
  }));
}

export async function getTranscript(
  actor: Actor,
  conversationId: string,
  db: Db = getDb(),
): Promise<Transcript> {
  const conversation = await requireConversation(actor, conversationId, db);
  const rows = await db
    .select()
    .from(s.assistantMessages)
    .where(eq(s.assistantMessages.conversationId, conversation.id))
    .orderBy(asc(s.assistantMessages.seq));

  return {
    conversation: {
      id: conversation.id,
      title: conversation.title,
      provider: conversation.provider,
      model: conversation.model,
      updatedAt: conversation.updatedAt,
    },
    entries: rows.map(toEntry),
  };
}

function toEntry(r: typeof s.assistantMessages.$inferSelect): TranscriptEntry {
  if (r.role === 'user') return { kind: 'user', id: r.id, text: r.text, at: r.createdAt };
  if (r.role === 'tool') {
    return {
      kind: 'tool',
      id: r.id,
      name: r.toolName ?? 'unknown',
      input: r.toolInputJson ?? null,
      result: r.toolResultJson ?? null,
      error: r.toolError,
      at: r.createdAt,
    };
  }
  return {
    kind: 'assistant',
    id: r.id,
    text: r.text,
    at: r.createdAt,
    draftTravelRequestId: r.draftTravelRequestId,
    draftLodgingId: r.draftLodgingId,
  };
}

async function requireConversation(actor: Actor, id: string, db: Db) {
  const row = await db.query.assistantConversations.findFirst({
    where: and(
      eq(s.assistantConversations.id, id),
      eq(s.assistantConversations.orgId, actor.orgId),
      eq(s.assistantConversations.userId, actor.userId),
    ),
  });
  if (!row) {
    // Deliberately the same answer for "does not exist" and "is somebody else's".
    throw new ForbiddenError('read this conversation');
  }
  return row;
}

/* ---------------------------------- asking --------------------------------- */

export type AskInput = {
  actor: Actor;
  model: AssistantModel;
  question: string;
  /** Omit to start a new conversation. */
  conversationId?: string;
  now?: Date;
  db?: Db;
};

export type AskResult = {
  conversationId: string;
  turn: TurnResult;
};

/**
 * One exchange, persisted.
 *
 * The transcript is replayed to the model rather than kept in memory, and it is
 * replayed **without tool results**. That is not a size optimisation. A tool
 * result is a snapshot of rows as they were at the moment it ran, and a crate
 * that was `in_transit` an hour ago is exactly the sort of fact a follow-up
 * question ("has it landed yet?") is about. Feeding the old snapshot back invites
 * the model to answer from it, which is how an assistant becomes confidently
 * stale. The prose stays — it is what the conversation is *about* — and anything
 * factual gets looked up again.
 */
export async function ask(input: AskInput): Promise<AskResult> {
  const { actor, model, question } = input;
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();

  if (!canUseAssistant(actor)) throw new ForbiddenError('use the assistant');
  const asked = question.trim();
  if (!asked) throw new Error('Ask something.');

  const conversation = input.conversationId
    ? await requireConversation(actor, input.conversationId, db)
    : await openConversation(actor, asked, model, now, db);

  const history = await replayFor(conversation.id, db);
  const turn = await runTurn({ actor, model, db, now, history, question: asked });

  await persist(conversation.id, asked, turn, now, db);

  await db
    .update(s.assistantConversations)
    .set({ updatedAt: now, provider: turn.provider, model: turn.model })
    .where(eq(s.assistantConversations.id, conversation.id));

  return { conversationId: conversation.id, turn };
}

async function openConversation(
  actor: Actor,
  firstQuestion: string,
  model: AssistantModel,
  now: Date,
  db: Db,
) {
  // The title is the question, trimmed — never a model-written summary. A title
  // is how a person finds a conversation again, and a paraphrase of what they
  // said is worse at that than what they said.
  const title = firstQuestion.length > 80 ? `${firstQuestion.slice(0, 77)}…` : firstQuestion;
  const [row] = await db
    .insert(s.assistantConversations)
    .values({
      orgId: actor.orgId,
      userId: actor.userId,
      title,
      provider: model.name,
      model: model.name,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

/** Prose only; see `ask`'s header for why the tool results are left behind. */
async function replayFor(conversationId: string, db: Db): Promise<ModelMessage[]> {
  const rows = await db
    .select()
    .from(s.assistantMessages)
    .where(eq(s.assistantMessages.conversationId, conversationId))
    .orderBy(asc(s.assistantMessages.seq));

  const out: ModelMessage[] = [];
  for (const r of rows) {
    if (r.role === 'user') out.push({ role: 'user', text: r.text });
    if (r.role === 'assistant' && r.text.trim()) {
      out.push({ role: 'assistant', text: r.text, toolCalls: [] });
    }
  }
  return out;
}

async function persist(
  conversationId: string,
  question: string,
  turn: TurnResult,
  now: Date,
  db: Db,
): Promise<void> {
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${s.assistantMessages.seq}), -1) + 1` })
    .from(s.assistantMessages)
    .where(eq(s.assistantMessages.conversationId, conversationId));

  let seq = Number(next);
  const rows: (typeof s.assistantMessages.$inferInsert)[] = [
    { conversationId, seq: seq++, role: 'user', text: question, createdAt: now },
  ];

  for (const step of turn.steps) {
    rows.push(toolRow(conversationId, seq++, step, now));
  }

  rows.push({
    conversationId,
    seq: seq++,
    role: 'assistant',
    text: turn.text,
    draftTravelRequestId: turn.draftTravelRequestId,
    draftLodgingId: turn.draftLodgingId,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    createdAt: now,
  });

  await db.insert(s.assistantMessages).values(rows);
}

function toolRow(
  conversationId: string,
  seq: number,
  step: ToolStep,
  now: Date,
): typeof s.assistantMessages.$inferInsert {
  return {
    conversationId,
    seq,
    role: 'tool',
    text: '',
    toolName: step.name,
    // The *validated* input, never the model's raw JSON: a transcript row is
    // evidence of what ran, and what ran is what came out of the Zod parse.
    toolInputJson: step.input ?? undefined,
    toolResultJson: step.result === undefined ? null : (step.result as never),
    toolError: step.error,
    createdAt: now,
  };
}
