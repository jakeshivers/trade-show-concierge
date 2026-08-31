/**
 * The flight board and its engine, without a screen. SCOPE.md §5f.
 *
 *   pnpm flights           # every tracked flight, what is wrong, and what would be said
 *   pnpm flights --sync    # ask the status provider, write the changes and the alerts
 *
 * The board is on screen at /flights. This exists for the half a screen cannot
 * show: what the *engine* would say tonight, to whom, and — far more often —
 * that it would say nothing at all. Running `--sync` twice writes no second
 * alert, which is the property the whole feature rests on: a delay that reports
 * itself every fifteen minutes as the estimate jitters is one nobody reads.
 *
 * With no `AEROAPI_KEY` and no `FLIGHT_STATUS_PROVIDER`, `--sync` prints the
 * variable to set and checks nothing. It does not fall back to replay, and the
 * board still renders — the flights are ours; only the readings are a
 * provider's.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { getFlightBoard, syncFlightStatuses } from '../src/lib/flights/store';
import { selectStatusProviderOrNull } from '../src/lib/flights/provider';

const db = getDb();

const hhmm = (d: Date | null, zone: string | null) =>
  d == null
    ? '—'
    : d.toLocaleString('en-US', {
        timeZone: zone ?? 'UTC',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

/**
 * The board is read through an actor, because scoping is the store's job and a
 * script that queried around it would be showing something the app never does.
 * An admin, so the CLI sees the whole workspace — a member's board is their own
 * three flights, which is correct on screen and useless here.
 */
async function anyAdmin(): Promise<Actor> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.role, 'admin'))
    .limit(1);
  if (!user) throw new Error('No admin user. Run `pnpm db:reset` first.');
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    costCenterId: user.costCenterId,
  };
}

async function overview(now: Date) {
  const actor = await anyAdmin();
  const board = await getFlightBoard(actor, { asOf: now }, db);
  const { summary: s } = board;

  console.log(`\nFlight board — every tracked leg in the workspace\n`);
  console.log(`  tracked                     ${String(s.tracked).padStart(3)}`);
  console.log(`  cancelled or diverted       ${String(s.disrupted).padStart(3)}`);
  console.log(`  arrival buffer at risk      ${String(s.bufferAtRisk).padStart(3)}   (the number worth a page)`);
  // Kept apart deliberately: a delay that costs nothing is weather, and folding
  // it into the figure above is how a board teaches people to ignore that figure.
  console.log(`  delayed, buffer still holds ${String(s.delayedButClear).padStart(3)}   (weather, not news)`);
  console.log(`  status unknown              ${String(s.unknown).padStart(3)}   (not the same as on time)`);
  console.log(`  never checked               ${String(s.neverChecked).padStart(3)}`);

  console.log(
    '\n  departs (local)   flight       route      traveler      status      buffer                 checked',
  );
  for (const r of board.rows) {
    const f = r.flight;
    const zone = f.originTimeZone ?? r.showTimezone ?? null;
    const buffer =
      r.buffer.standing === 'not_applicable'
        ? '—'
        : r.buffer.standing === 'no_arrival'
          ? 'no arrival'
          : `${r.buffer.hoursBefore!.toFixed(1)}h / ${r.buffer.requiredHours}h${
              r.buffer.brokenSincePurchase ? ' BROKEN' : ''
            }`;
    const checked =
      r.freshness.kind === 'never_checked'
        ? 'never'
        : r.freshness.kind === 'stale'
          ? `${r.freshness.ageMinutes}m STALE`
          : `${r.freshness.ageMinutes}m`;
    console.log(
      `  ${hhmm(f.scheduledDeparture, zone).padEnd(16)} ${`${f.airlineCode} ${f.flightNumber}`.padEnd(11)} ` +
        `${`${f.originAirport}→${f.destinationAirport}`.padEnd(9)} ${r.travelerName.slice(0, 12).padEnd(13)} ` +
        `${r.status.padEnd(11)} ${buffer.padEnd(22)} ${checked}`,
    );
  }

  const alerts = board.rows.map((r) => r.alert).filter((a) => a !== null);
  console.log(`\n  What the engine would say tonight (${alerts.length}):`);
  if (alerts.length === 0) {
    console.log('    nothing — every leg is either fine or already spoken for.');
  }
  for (const a of alerts) {
    console.log(`    [${a.severity.padEnd(8)}] ${a.title}`);
    console.log(`                 ${a.body}`);
  }

  const choice = selectStatusProviderOrNull();
  console.log(
    '\n  status provider: ' +
      ('choice' in choice
        ? `${choice.choice.source}${choice.choice.replayed ? ' (replayed payloads — no airline was asked)' : ''}`
        : `none. ${choice.unavailable}`),
  );
  console.log('  pnpm flights --sync    ask it, and write what it says\n');
}

async function sync(now: Date) {
  const actor = await anyAdmin();
  const choice = selectStatusProviderOrNull();
  if (!('choice' in choice)) {
    console.log(`\nNothing was checked.\n\n  ${choice.unavailable}\n`);
    return;
  }

  const result = await syncFlightStatuses(actor.orgId, choice.choice.provider, now, db);
  console.log(
    `\n${result.checked} leg(s) were due a check against ${choice.choice.source}` +
      `${choice.choice.replayed ? ' (replayed payloads — no airline was asked)' : ''}; ` +
      `${result.changed} changed, ${result.noRecord} had no record.`,
  );
  console.log(
    `${result.planned.length} leg(s) had something worth saying; ${result.alertsWritten} alert row(s) written.` +
      (result.alertsWritten === 0 && result.planned.length > 0
        ? '\nNothing new — each of these has already been sent. A flight alert is keyed to the\n' +
          'standing it reports, not to the estimate: an arrival time that drifts four minutes\n' +
          'either way all evening is not four new pieces of news.\n'
        : '\nRun again and nothing is written, for the same reason: the key carries the standing\n' +
          '(inside the buffer, past move-in, cancelled), not the moving estimate.\n'),
  );
}

async function main() {
  const now = new Date();
  return process.argv[2] === '--sync' ? sync(now) : overview(now);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
