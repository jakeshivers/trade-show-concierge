/**
 * The feed, and the five engines behind it, without a screen. SCOPE.md §10.17.
 *
 *   pnpm alerts                  # what an admin is owed right now
 *   pnpm alerts --as priya@…     # the same table for somebody else — it differs
 *   pnpm alerts --sweep          # run all five engines, then print the feed
 *
 * For twelve steps five engines wrote to the `alerts` table and nothing read it,
 * so `pnpm deadlines`, `pnpm flights`, `pnpm shipping`, `pnpm assets` and
 * `pnpm credits` were how a person heard any of them — one command per engine,
 * each showing what *it* would say, none of them showing what anybody is
 * actually owed. This is the other direction: one person, everything addressed
 * to them, worst first.
 *
 * Run `--sweep` twice. The second run raises nothing, and the interesting line
 * is `resolved`: an engine that no longer plans a condition is an engine saying
 * the thing is over, which is the only signal a crate arriving produces.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { getAlertFeed } from '../src/lib/alerts/store';
import { runAllSweeps } from '../src/lib/alerts/sweep';
import { SOURCE_LABEL, groupFeed, standingDays, standingOf } from '../src/lib/alerts/feed';

const db = getDb();

async function actorFor(email?: string): Promise<Actor> {
  const [user] = email
    ? await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    : await db.select().from(schema.users).where(eq(schema.users.role, 'admin')).limit(1);
  if (!user) throw new Error(email ? `No user ${email}.` : 'No admin user. Run `pnpm db:reset`.');
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    costCenterId: user.costCenterId,
  };
}

async function sweep(now: Date, actor: Actor) {
  console.log('\nRunning every engine, in the order the nightly job would\n');
  for (const o of await runAllSweeps(actor.orgId, now, db)) {
    if (o.unavailable) {
      console.log(`  ${SOURCE_LABEL[o.source].padEnd(9)} could not run — ${o.unavailable}`);
      console.log('            (nothing raised, and nothing resolved: not knowing is not good news)');
      continue;
    }
    console.log(
      `  ${SOURCE_LABEL[o.source].padEnd(9)} ${String(o.raised).padStart(3)} raised  ` +
        `${String(o.resolved).padStart(3)} resolved   ${o.detail ?? ''}`,
    );
  }
}

async function feed(now: Date, actor: Actor) {
  const { alerts, summary } = await getAlertFeed(actor, { asOf: now }, db);

  console.log(`\nAddressed to ${actor.fullName} (${actor.role})\n`);
  console.log(`  outstanding   ${String(summary.outstanding).padStart(3)}`);
  console.log(`  critical      ${String(summary.critical).padStart(3)}`);
  console.log(`  warning       ${String(summary.warning).padStart(3)}`);
  console.log(
    `  unchecked     ${String(summary.unchecked).padStart(3)}   ` +
      '(true when last looked at, and nothing has looked since)',
  );
  console.log(`  acknowledged  ${String(summary.acknowledged).padStart(3)}   (seen, and still true)`);
  console.log(`  resolved      ${String(summary.resolved).padStart(3)}   (ended — nobody had to clear these)`);
  console.log(
    `\n  ${groupFeed(alerts, now).filter((g) => g.rest.length > 0).length} of those are one sentence ` +
      'said by several rows at once.',
  );
  if (summary.oldestDays > 0) {
    console.log(`\n  oldest outstanding: ${summary.oldestDays} day(s)`);
  }

  console.log();
  const groups = groupFeed(alerts, now);
  for (const g of groups) {
    const a = g.lead;
    const standing = standingOf(a, now);
    const days = standingDays(a, now);
    console.log(
      `  ${a.severity.padEnd(8)} ${SOURCE_LABEL[a.source].padEnd(9)} ${standing.padEnd(12)} ` +
        `${days}d  ${a.title}`,
    );
    if (g.rest.length > 0) {
      console.log(
        `             and ${g.rest.length} more row(s) saying the same thing` +
          (g.showNames.length > 1 ? ` across ${g.showNames.join(', ')}` : '') +
          ' — one fact per row is right for the engine and wrong for a reader',
      );
    }
    if (a.occurrences > 1 && standing !== 'resolved') {
      console.log(`             said ${a.occurrences} times; first ${days} day(s) ago`);
    }
    if (a.body) console.log(`             ${a.body}`);
  }
  if (alerts.length === 0) {
    console.log('  Nothing. Which is the ordinary result, and is why the engines mostly say nothing.');
  }
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  const asIndex = args.indexOf('--as');
  const actor = await actorFor(asIndex >= 0 ? args[asIndex + 1] : undefined);
  const now = new Date();
  if (args.includes('--sweep')) await sweep(now, actor);
  await feed(now, actor);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
