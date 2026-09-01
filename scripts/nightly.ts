/**
 * The nightly job, without a scheduler. SCOPE.md §10.21.
 *
 *   pnpm nightly              # run every stage against the seeded org
 *   pnpm nightly --dry        # sweep and plan, print the messages, send nothing
 *   pnpm nightly --deliver    # the delivery pass only
 *   pnpm nightly --standing   # when did it last run, and does anything run it
 *
 * The interesting output is the middle block. With no `SLACK_BOT_TOKEN` the
 * transport is `console`, which composes the *real* message from the *real*
 * alerts and delivers it to nobody — so this is the only way to read what a
 * colleague would actually receive without installing a Slack app first, and
 * every line it prints is recorded as `rendered`, never as `sent`.
 *
 * Run it twice. The second run sends nothing: a condition that held last night
 * and holds tonight is one alert row whose `created_at` never moved, and the
 * delivery rail is keyed on that. What *does* send on a second run is a
 * recurrence — a thing that resolved and came back — because `alerts/store.ts`
 * restarts the clock on those, and this inherits that decision rather than
 * making a second one.
 */
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import { runNightly, getRunStanding, describeRunStanding } from '../src/lib/schedule/nightly';
import { deliverPending } from '../src/lib/notify/store';
import { selectTransport } from '../src/lib/notify/provider';
import { schedulerSecret } from '../src/lib/schedule/principal';

const db = getDb();

async function orgId(): Promise<string> {
  const [org] = await db.select().from(schema.organizations).limit(1);
  if (!org) throw new Error('No organization. Run `pnpm db:reset`.');
  return org.id;
}

function transportLine() {
  try {
    const c = selectTransport();
    console.log(
      `Transport: ${c.transport.name}` +
        (c.live
          ? ' — messages reach people.'
          : ' — messages are composed and delivered to nobody. Set SLACK_BOT_TOKEN to change that.'),
    );
  } catch (err) {
    console.log(`Transport: misconfigured — ${(err as Error).message}`);
  }
  console.log(
    schedulerSecret()
      ? 'Scheduler: CRON_SECRET is set, so POST /api/cron/nightly will run this.'
      : 'Scheduler: none. CRON_SECRET is unset, so nothing runs this but you.',
  );
}

function printMessages(composed: { destination: { address: string }; text: string }[]) {
  if (composed.length === 0) {
    console.log('\nNothing to carry. Which is the ordinary night.');
    return;
  }
  console.log(`\n${composed.length} message(s), verbatim:\n`);
  for (const m of composed) {
    console.log(`  → ${m.destination.address}`);
    for (const line of m.text.split('\n')) console.log(`    ${line}`);
    console.log();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const org = await orgId();
  const now = new Date();

  transportLine();

  if (args.includes('--standing')) {
    const standing = await getRunStanding(org, now, db);
    console.log(`\nStanding: ${standing.standing}`);
    console.log(`  ${describeRunStanding(standing)}`);
    if (standing.lastRun) {
      console.log(
        `\n  last run ${standing.lastRun.startedAt.toISOString()} ` +
          `(${standing.lastRun.trigger}), ${standing.lastRun.ok ? 'ok' : 'failed'}`,
      );
    }
    return;
  }

  if (args.includes('--deliver') || args.includes('--dry')) {
    const dry = args.includes('--dry');
    if (dry) {
      console.log('\n--dry: planned and composed. Nothing is recorded and nothing is sent,');
      console.log('so tomorrow night still owes every message printed below.\n');
    }
    const result = await deliverPending(org, { now, dryRun: dry }, db);
    console.log(
      `  ${result.messages} message(s) to ${result.people} person/people: ` +
        `${result.sent} sent, ${result.rendered} rendered to nobody, ${result.failed} failed, ` +
        `${result.suppressed} suppressed, ${result.undeliverable} with nowhere to go`,
    );
    for (const u of result.unreachable) {
      console.log(`  ${u.name} has ${u.alerts} alert(s) worth carrying and no destination.`);
    }
    printMessages(result.composed);
    return;
  }

  console.log('\nRunning every stage, in the order a scheduler would\n');
  const run = await runNightly(org, { trigger: 'manual', now }, db);
  for (const line of run.summary) console.log(`  ${line}`);
  if (run.delivery) printMessages(run.delivery.composed);
  if (run.delivery?.unreachable.length) {
    console.log('Nowhere to carry these:');
    for (const u of run.delivery.unreachable) {
      console.log(`  ${u.name}: ${u.alerts} alert(s)`);
    }
    console.log();
  }
  console.log(run.ok ? '  Run finished.' : `  Run stopped: ${run.error}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
