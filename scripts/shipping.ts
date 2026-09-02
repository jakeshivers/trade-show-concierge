/**
 * The shipping board and its engine, without a screen. SCOPE.md §5g.
 *
 *   pnpm shipping           # every crate, what is wrong, and what would be said
 *   pnpm shipping <show id> # one show's freight
 *   pnpm shipping --sync    # ask the tracking provider, write scans and alerts
 *
 * The board is on screen at /shipping and on each show's Logistics tab. This
 * exists for the half a screen cannot show: what the *engine* would say tonight,
 * to whom, and — most of the time — that it would say nothing at all. Running
 * `--sync` twice writes no second alert and appends no second scan, which are
 * the two properties the whole feature rests on: a timeline that doubles every
 * night is not a timeline, and a stall reported hourly is one nobody reads.
 *
 * With no `EASYPOST_API_KEY` and no `SHIPMENT_TRACKING_PROVIDER`, `--sync`
 * prints the variable to set and checks nothing. It does not fall back to
 * replay, and the board still renders — the shipments are ours; only the scans
 * are a carrier's.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { getShipmentBoard, showsMissingReturnLeg, syncShipmentTracking } from '../src/lib/shipping/store';
import { selectTrackingProviderOrNull } from '../src/lib/shipping/provider';

const db = getDb();

const stamp = (d: Date | null, zone: string | null) =>
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
 * script that queried around it would show something the app never does. An
 * admin, so the CLI sees the whole workspace.
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

async function overview(now: Date, showId?: string) {
  const actor = await anyAdmin();
  const board = await getShipmentBoard(actor, { showId, asOf: now }, db);
  const { summary: s } = board;

  console.log(
    '\nShipping — every crate still owed to somebody, nearest deadline first\n' +
      '  (settled freight and shows closed out more than 30 days are not listed)\n',
  );
  console.log(`  tracked                     ${String(s.tracked).padStart(3)}`);
  console.log(`  outside the receiving window${String(s.missingWindow).padStart(3)}   (late, or too early to be accepted)`);
  console.log(`  silent longer than normal   ${String(s.stalled).padStart(3)}   (no scan, and no status field says so)`);
  console.log(`  on a dock, not at the booth ${String(s.unreceived).padStart(3)}   (delivered ≠ received)`);
  console.log(`  nobody owns them            ${String(s.unowned).padStart(3)}   (an alert addressed to nobody)`);
  console.log(`  status unknown              ${String(s.unknown).padStart(3)}   (not the same as fine)`);
  console.log(`  never checked               ${String(s.neverChecked).padStart(3)}`);
  console.log(`  confirmed at the booth      ${String(s.settled).padStart(3)}   (the only figure that means done)`);

  console.log(
    '\n  due (local)      crate                     dir/consign        status        window                 last scan',
  );
  for (const r of board.rows) {
    const c = r.shipment;
    const zone = r.showTimezone;
    const window =
      r.window.standing === 'not_applicable'
        ? '—'
        : r.window.hoursSpare === null
          ? r.window.standing
          : `${r.window.standing} ${r.window.hoursSpare.toFixed(0)}h${r.window.brokenSincePromise ? ' SLIPPED' : ''}`;
    const scan =
      r.stall.kind === 'moving'
        ? c.lastScanAt
          ? `${((now.getTime() - c.lastScanAt.getTime()) / 3_600_000).toFixed(0)}h ago`
          : 'none'
        : `${r.stall.kind.toUpperCase()} ${(r.stall.sinceHours / 24).toFixed(1)}d`;
    console.log(
      `  ${stamp(c.mustArriveBy, zone).padEnd(16)} ${c.description.slice(0, 25).padEnd(25)} ` +
        `${`${c.direction}/${c.consignment}`.slice(0, 18).padEnd(18)} ${r.status.padEnd(13)} ` +
        `${window.padEnd(22)} ${scan}`,
    );
  }

  const alerts = board.rows.map((r) => r.alert).filter((a) => a !== null);
  const gaps = await showsMissingReturnLeg(actor.orgId, now, db);
  console.log(`\n  What the engine would say tonight (${alerts.length + gaps.length}):`);
  if (alerts.length + gaps.length === 0) {
    console.log('    nothing — every crate is either fine or already spoken for.');
  }
  for (const a of [...alerts, ...gaps]) {
    console.log(`    [${a.severity.padEnd(8)}] ${a.title}`);
    console.log(`                 ${a.body}`);
  }
  if (gaps.length > 0) {
    console.log(
      '\n  The last of those has no shipment behind it. It fires on the absence of one —\n' +
        '  freight went out to a show that has moved out, and nothing is recorded coming back.\n' +
        '  §5f made a delayed flight home silent on purpose; freight is the opposite, because\n' +
        '  the leg home is the one that actually goes missing.',
    );
  }

  const choice = selectTrackingProviderOrNull();
  console.log(
    '\n  tracking provider: ' +
      ('choice' in choice
        ? `${choice.choice.source}${choice.choice.replayed ? ' (replayed payloads — no carrier was asked)' : ''}`
        : `none. ${choice.unavailable}`),
  );
  console.log('  pnpm shipping --sync    ask it, and write what it says\n');
}

async function sync(now: Date) {
  const actor = await anyAdmin();
  const choice = selectTrackingProviderOrNull();
  if (!('choice' in choice)) {
    console.log(`\nNothing was checked.\n\n  ${choice.unavailable}\n`);
    return;
  }

  const result = await syncShipmentTracking(actor.orgId, choice.choice.provider, now, db);
  console.log(
    `\n${result.checked} shipment(s) were due a check against ${choice.choice.source}` +
      `${choice.choice.replayed ? ' (replayed payloads — no carrier was asked)' : ''}; ` +
      `${result.changed} changed, ${result.scansAdded} new scan(s), ${result.noRecord} had no record.`,
  );
  console.log(
    `${result.planned.length} crate(s) had something worth saying; ${result.alertsWritten} alert row(s) written.` +
      '\nRun again and both figures for *new* work go to zero: a scan is keyed by its own\n' +
      'fingerprint so a tracker returning its whole history appends nothing the second time,\n' +
      'and an alert is keyed to the receiving deadline and the standing rather than to the\n' +
      'carrier’s estimate, which moves every time anybody asks.\n',
  );
}

async function main() {
  const now = new Date();
  const arg = process.argv[2];
  if (arg === '--sync') return sync(now);
  return overview(now, arg);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
