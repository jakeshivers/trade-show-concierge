import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type {
  AssistantModel,
  ModelReply,
  ModelRequest,
} from '@/lib/integrations/llm/types';
import { ScriptedAssistantModel, SCRIPTED_CLOSING } from '@/lib/integrations/llm/scripted/provider';
import { ModelNotConfiguredError } from '@/lib/integrations/llm/types';
import { selectAssistantModel, selectAssistantModelOrNull } from './provider';
import { specsFor, TOOLS, toolByName } from './tools';
import { toolsFor } from './access';
import { serializeResult, MAX_RESULT_CHARS } from './serialize';
import { systemPrompt } from './prompt';
import { runTurn, MAX_TURNS, MAX_TOOL_CALLS } from './loop';
import { unsearchableProvider } from './draft';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of step 15. No database, no keys, no network.
 *
 * What is worth testing here is not that the loop calls tools — that is visible
 * — but the four things that would fail silently: that a withheld tool is never
 * *described*, that a model naming one anyway gets no confirmation that it
 * exists, that the loop stops on its own bounds rather than the model's, and
 * that nothing on the draft path can reach a provider.
 */

const member: Actor = {
  userId: 'u-member',
  orgId: 'org-1',
  email: 'priya@example.test',
  fullName: 'Priya Raman',
  role: 'member',
  costCenterId: 'cc-1',
};
const admin: Actor = { ...member, userId: 'u-admin', email: 'shelley@example.test', fullName: 'Shelley Okafor', role: 'admin' };

/** A model that says exactly what the test tells it to, one reply per turn. */
function scripted(replies: Partial<ModelReply>[]): AssistantModel & { seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];
  let i = 0;
  return {
    name: 'test',
    seen,
    isConfigured: () => true,
    async respond(request) {
      seen.push(request);
      const r = replies[Math.min(i++, replies.length - 1)];
      return {
        provider: 'test',
        model: 'test',
        text: '',
        toolCalls: [],
        stopReason: 'end_turn',
        inputTokens: null,
        outputTokens: null,
        ...r,
      };
    },
  };
}

const db = null as never;
const NOW = new Date('2026-09-01T12:00:00Z');

describe('tool specs', () => {
  it('advertises exactly the schema the loop validates against', () => {
    for (const tool of TOOLS) {
      const [spec] = specsFor([tool]);
      expect(spec.inputSchema).toEqual(z.toJSONSchema(tool.schema));
    }
  });

  it('has no tool that takes an org id, a user id, or raw SQL', () => {
    // The posture in one assertion: nothing the model supplies may widen a
    // query. Every id a tool accepts names a *row* the store will scope anyway.
    for (const tool of TOOLS) {
      const props = Object.keys(
        (z.toJSONSchema(tool.schema) as { properties?: object }).properties ?? {},
      );
      expect(props).not.toContain('orgId');
      expect(props).not.toContain('userId');
      expect(props).not.toContain('sql');
      expect(props).not.toContain('query');
    }
  });

  it('holds no tool that commits spend', () => {
    expect(TOOLS.every((t) => t.kind === 'read' || t.kind === 'draft')).toBe(true);
    for (const forbidden of ['book', 'purchase', 'approve', 'confirm_constraints', 'search']) {
      expect(toolByName(forbidden)).toBeUndefined();
    }
  });
});

describe('access', () => {
  it('withholds lodging drafting from a member', () => {
    expect(toolsFor(member).map((t) => t.name)).not.toContain('draft_lodging');
    expect(toolsFor(admin).map((t) => t.name)).toContain('draft_lodging');
  });

  it('never describes a withheld tool to the model', async () => {
    const model = scripted([{ text: 'ok' }]);
    await runTurn({ actor: member, model, db, now: NOW, history: [], question: 'hello' });
    const names = model.seen[0].tools.map((t) => t.name);
    expect(names).not.toContain('draft_lodging');
  });

  it('answers a withheld tool the same way it answers an invented one', async () => {
    const model = scripted([
      {
        stopReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'draft_lodging', input: {} }],
      },
      { text: 'done' },
    ]);
    const turn = await runTurn({
      actor: member,
      model,
      db,
      now: NOW,
      history: [],
      question: 'book me a hotel',
    });
    // "not available to you" would be a map of what to aim at next.
    expect(turn.steps[0].error).toContain('not a tool');
    expect(turn.steps[0].error).not.toContain('not available to you');
    expect(turn.steps[0].result).toBeNull();
  });
});

describe('the loop stops on its own bounds', () => {
  it('gives up after MAX_TURNS rounds rather than looping', async () => {
    const model = scripted([
      { stopReason: 'tool_use', toolCalls: [{ id: 'c', name: 'nope', input: {} }] },
    ]);
    const turn = await runTurn({
      actor: member,
      model,
      db,
      now: NOW,
      history: [],
      question: 'go',
    });
    expect(turn.truncated).toBe(true);
    expect(model.seen.length).toBe(MAX_TURNS);
  });

  it('refuses a turn that asks for more tools than the cap', async () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, i) => ({
      id: `c${i}`,
      name: 'list_shows',
      input: {},
    }));
    const model = scripted([{ stopReason: 'tool_use', toolCalls: many }]);
    const turn = await runTurn({
      actor: member,
      model,
      db,
      now: NOW,
      history: [],
      question: 'everything',
    });
    expect(turn.steps).toHaveLength(0);
    expect(turn.truncated).toBe(true);
  });

  it('does not present a cut-off reply as a finished answer', async () => {
    const model = scripted([{ stopReason: 'max_tokens', text: 'The crate is' }]);
    const turn = await runTurn({
      actor: member,
      model,
      db,
      now: NOW,
      history: [],
      question: 'where is the crate',
    });
    expect(turn.truncated).toBe(true);
    expect(turn.text).toContain('cut off');
  });

  it('rejects arguments that do not match the schema, without running the tool', async () => {
    const model = scripted([
      { stopReason: 'tool_use', toolCalls: [{ id: 'c', name: 'get_show', input: { showId: 42 } }] },
      { text: 'ok' },
    ]);
    const turn = await runTurn({
      actor: member,
      model,
      db,
      now: NOW,
      history: [],
      question: 'show me',
    });
    expect(turn.steps[0].error).toContain('Invalid arguments');
    expect(turn.steps[0].input).toBeNull();
  });
});

describe('serialization', () => {
  it('sends dates as instants, never as a formatted local string', () => {
    const { text } = serializeResult({ dueAt: new Date('2026-02-03T16:00:00Z') });
    expect(text).toContain('2026-02-03T16:00:00.000Z');
  });

  it('says how much it dropped rather than clipping in silence', () => {
    const big = Array.from({ length: 4000 }, (_, i) => ({ id: i, name: 'a crate somewhere' }));
    const { text, truncated } = serializeResult(big);
    expect(truncated).toBe(true);
    expect(text).toContain('truncated');
    expect(text).toContain('Do not summarise it as complete');
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 500);
  });
});

describe('the draft path cannot reach a provider', () => {
  it('throws a sentence naming the rule rather than a null dereference', async () => {
    const p = unsearchableProvider();
    expect(p.isConfigured()).toBe(false);
    await expect(p.search({} as never)).rejects.toThrow(/never searches/);
    await expect(p.purchase({} as never)).rejects.toThrow(/never searches/);
    await expect(p.cancel('o', 'k')).rejects.toThrow(/never searches/);
  });
});

describe('the system prompt', () => {
  it('carries tense rather than access rules', () => {
    const text = systemPrompt(member, { asOf: NOW });
    expect(text).toContain('incurred');
    expect(text).toContain('unplanned');
    expect(text).toContain('secondhand');
    expect(text).toContain(member.email);
  });
});

describe('provider selection', () => {
  it('has no fallback', () => {
    expect(() => selectAssistantModel({})).toThrow(ModelNotConfiguredError);
    expect(() => selectAssistantModel({ ASSISTANT_PROVIDER: 'mistral' })).toThrow(
      /ASSISTANT_PROVIDER/,
    );
  });

  it('replays only when asked out loud, and says it is replaying', () => {
    const chosen = selectAssistantModel({ ASSISTANT_PROVIDER: 'scripted' });
    expect(chosen.scripted).toBe(true);
    const anthropic = selectAssistantModel({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(anthropic.scripted).toBe(false);
  });

  it('reports the missing variable rather than throwing at a screen', () => {
    const r = selectAssistantModelOrNull({});
    expect('unavailable' in r && r.unavailable).toContain('ANTHROPIC_API_KEY');
  });
});

describe('the scripted model asserts nothing', () => {
  const model = new ScriptedAssistantModel();
  const specs = specsFor(TOOLS);

  it('plans tool calls instead of writing prose about the workspace', async () => {
    const reply = await model.respond({
      system: '',
      messages: [{ role: 'user', text: 'which shows are coming up?' }],
      tools: specs,
      maxOutputTokens: 100,
    });
    expect(reply.stopReason).toBe('tool_use');
    expect(reply.toolCalls[0].name).toBe('list_shows');
    expect(reply.text).toBe('');
  });

  it('closes with a disclosure and no claim about anything', async () => {
    const reply = await model.respond({
      system: '',
      messages: [
        { role: 'user', text: 'which shows are coming up?' },
        { role: 'tool_results', results: [{ callId: 'x', content: '[]', isError: false }] },
      ],
      tools: specs,
      maxOutputTokens: 100,
    });
    expect(reply.stopReason).toBe('end_turn');
    expect(reply.text).toBe(SCRIPTED_CLOSING);
    // No digits: a replayed sentence must not carry a figure about a workspace
    // it has never seen.
    expect(reply.text).not.toMatch(/\d/);
  });

  it('never plans a tool the actor was not given', async () => {
    const reply = await model.respond({
      system: '',
      messages: [{ role: 'user', text: 'which shows are coming up?' }],
      tools: [],
      maxOutputTokens: 100,
    });
    expect(reply.toolCalls).toHaveLength(0);
  });
});
