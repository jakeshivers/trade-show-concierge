/**
 * The assistant without a screen. SCOPE.md §10 step 15.
 *
 *   pnpm assistant "where is the MedTech crate?"     # one question, as an admin
 *   pnpm assistant --as priya@… "am I flying anywhere?"
 *   pnpm assistant --tools                            # what each role may hold
 *
 * This exists for the half a chat window hides. On screen an answer is a
 * paragraph; here you can see the actual shape of the thing — which tools ran,
 * as whom, and what came back out of the store — which is the only way to check
 * the claim step 15 rests on. Run the same question `--as` a member and `--as`
 * an admin and the *results* differ while nothing about the prompt does. That
 * difference is the access model, and it is in the queries.
 *
 * With no `ANTHROPIC_API_KEY` and no `ASSISTANT_PROVIDER`, this prints the
 * variable to set and asks nothing. It does not fall back. Run it with
 * `ASSISTANT_PROVIDER=scripted` to exercise the loop and the real tools against
 * a keyword matcher — which chooses tools and writes no prose of its own,
 * because a canned sentence about a workspace it has never seen would be a
 * fabricated claim in a way a canned *tracking payload* is not.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { selectAssistantModelOrNull } from '../src/lib/assistant/provider';
import { toolsFor } from '../src/lib/assistant/access';
import { ask } from '../src/lib/assistant/store';
import { serializeResult } from '../src/lib/assistant/serialize';

const db = getDb();

async function actorFor(email: string | null): Promise<Actor> {
  const [user] = email
    ? await db.select().from(s.users).where(eq(s.users.email, email)).limit(1)
    : await db.select().from(s.users).where(eq(s.users.role, 'admin')).limit(1);
  if (!user) {
    throw new Error(
      email ? `No user ${email}. Run \`pnpm db:reset\`.` : 'No admin user. Run `pnpm db:reset`.',
    );
  }
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    costCenterId: user.costCenterId,
  };
}

/**
 * The tool surface, per role, side by side.
 *
 * Printed as a table because the interesting cell is an *absence*: a tool a role
 * does not hold is never described to the model at all, so there is no name for
 * it to call and no refusal for it to argue with.
 */
async function printTools() {
  const roles: Actor['role'][] = ['member', 'travel_manager', 'admin'];
  const base = await actorFor(null);
  const sets = roles.map((role) => new Set(toolsFor({ ...base, role }).map((t) => t.name)));
  const all = [...new Set(sets.flatMap((x) => [...x]))].sort();

  console.log('\nWhat the assistant may hold, by role\n');
  console.log(`  ${'tool'.padEnd(24)} member  manager  admin   kind`);
  for (const name of all) {
    const marks = sets.map((set) => (set.has(name) ? '  ✓   ' : '  —   ')).join('  ');
    const kind = toolsFor(base).find((t) => t.name === name)?.kind ?? 'read';
    console.log(`  ${name.padEnd(24)}${marks}  ${kind}`);
  }
  console.log(
    '\n  Every one of these is an existing store function, called as the asking actor,\n' +
      '  through the same access.ts gate a screen goes through. There is no tool that\n' +
      '  opens a query, and adding one is the single thing that would break the posture.\n',
  );
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--tools')) {
    await printTools();
    return;
  }

  const asIndex = argv.indexOf('--as');
  const email = asIndex >= 0 ? (argv[asIndex + 1] ?? null) : null;
  const question = argv.filter((a, i) => a !== '--as' && i !== asIndex + 1).join(' ').trim();

  if (!question) {
    console.log('Usage: pnpm assistant [--as email] "your question"');
    console.log('       pnpm assistant --tools');
    return;
  }

  const chosen = selectAssistantModelOrNull();
  if ('unavailable' in chosen) {
    console.log(`\nThe assistant is not configured.\n\n  ${chosen.unavailable}\n`);
    process.exitCode = 1;
    return;
  }

  const actor = await actorFor(email);
  console.log(`\nAsking as ${actor.fullName} <${actor.email}> — ${actor.role}`);
  console.log(`Model: ${chosen.choice.source}${chosen.choice.scripted ? '  (SCRIPTED — no model reasoned about this)' : ''}`);
  console.log(`\n  > ${question}\n`);

  const { turn } = await ask({ actor, model: chosen.choice.model, question });

  for (const step of turn.steps) {
    const args = step.input && Object.keys(step.input).length ? ` ${JSON.stringify(step.input)}` : '';
    console.log(`  · ${step.name}${args}`);
    if (step.error) {
      console.log(`      refused: ${step.error}`);
      continue;
    }
    // The authoritative half. The prose below is a paraphrase of exactly this,
    // and where the two disagree, this is the one that came out of the database.
    const { text } = serializeResult(step.result);
    const lines = text.split('\n');
    for (const line of lines.slice(0, 14)) console.log(`      ${line}`);
    if (lines.length > 14) console.log(`      … ${lines.length - 14} more lines`);
  }

  console.log(`\n${turn.text}\n`);

  if (turn.draftTravelRequestId) {
    console.log(`  Drafted travel request ${turn.draftTravelRequestId} — unconfirmed, unsearched.`);
    console.log(`  pnpm booking:audit ${turn.draftTravelRequestId}\n`);
  }
  if (turn.draftLodgingId) {
    console.log(`  Drafted lodging ${turn.draftLodgingId} — no room block cutoff set.\n`);
  }
  if (turn.truncated) console.log('  (stopped on a bound, not because the answer was finished)\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
