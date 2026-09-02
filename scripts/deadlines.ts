/**
 * The service manual deadline register, surfaced. SCOPE.md §5a.
 *
 *   pnpm deadlines            # the register, what it exposes, and what is owed
 *   pnpm deadlines --sweep    # write the alerts that are due
 *
 * The register is on screen at /shows/<id>/readiness. This exists for the half
 * that has no screen: the *engine* — what it would say tonight, to whom, and in
 * which tense. `--sweep` is what a nightly job would run, and running it twice
 * writes nothing the second time, which is the property the whole feature rests
 * on. An alert that repeats every night teaches everyone to close it unread.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import {
  planDeadlineAlerts,
  summarizeExposure,
  type AlertableDeadline,
} from '../src/lib/deadlines/alerts';
import { sweepDeadlineAlerts } from '../src/lib/deadlines/store';
import { zonedDateInput } from '../src/lib/datetime/zoned';

const db = getDb();
const usd = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
/**
 * A deadline's date, in the zone the deadline is *kept* in.
 *
 * This was `d.toISOString().slice(0, 10)` for eleven steps, which is the exact
 * ground rule CLAUDE.md names — and it was invisible the whole time because every
 * seeded deadline had a daytime hour, so UTC and the show's calendar agreed.
 * Step 22 made it visible in a minute: an extracted deadline whose manual printed
 * no time is filed at 23:59 local, and 23:59 in Chicago is tomorrow in UTC, so
 * the CLI reported every one of them a day late. A register that moves a date by
 * a day is the failure the §5a engine exists to prevent, arriving through the
 * tool built to inspect it. The view layer had four copies of this same bug and
 * `scripts/` had a fifth, where nothing was watching.
 */
const day = (d: Date, timeZone: string) => zonedDateInput(d, timeZone);

async function theOrg() {
  const org = await db.query.organizations.findFirst();
  if (!org) throw new Error('No organization. Run `pnpm db:reset` first.');
  return org;
}

async function load(orgId: string) {
  const rows = await db
    .select({ deadline: s.showDeadlines, show: s.shows, owner: s.users })
    .from(s.showDeadlines)
    .innerJoin(s.shows, eq(s.showDeadlines.showId, s.shows.id))
    .leftJoin(s.users, eq(s.showDeadlines.ownerId, s.users.id))
    .where(inArray(s.shows.orgId, [orgId]))
    .orderBy(asc(s.showDeadlines.dueAt));
  return rows;
}

async function overview(now: Date) {
  const org = await theOrg();
  const rows = await load(org.id);
  const items: AlertableDeadline[] = rows.map((r) => ({ ...r.deadline }));
  const e = summarizeExposure(items, now);

  console.log(`\nService manual deadlines — ${org.name}\n`);
  console.log(`  open, still ahead of us      ${String(e.open).padStart(3)}`);
  console.log(`  already missed               ${String(e.missed).padStart(3)}`);
  console.log(`  unconfirmed against a manual ${String(e.unconfirmed).padStart(3)}`);
  console.log(`  nobody owns                  ${String(e.unowned).padStart(3)}`);
  console.log(`\n  avoidable, on confirmed dates   ${usd(e.atRiskCents)}`);
  // Kept apart on purpose: adding a figure from the manual to a figure somebody
  // guessed produces a number that is neither, and it would be the biggest one
  // on the screen.
  console.log(`  avoidable, on unconfirmed dates ${usd(e.atRiskUnconfirmedCents)}  (a guess until checked)`);
  console.log(`  already incurred                ${usd(e.incurredCents)}  (spent, not at risk)`);

  console.log('\n  due          show                 deadline                            penalty   owner        state');
  for (const { deadline: d, show, owner } of rows) {
    const state =
      d.status !== 'open'
        ? d.status
        : d.dueAt < now
          ? 'MISSED'
          : d.confirmedAt
            ? 'open'
            : 'unconfirmed';
    console.log(
      `  ${day(d.dueAt, show.timezone)}   ${show.name.slice(0, 20).padEnd(20)} ${d.title.slice(0, 35).padEnd(35)} ` +
        `${usd(d.penaltyEstimateCents).padStart(9)}  ${(owner?.fullName ?? '—').padEnd(12)} ${state}`,
    );
  }

  const planned = planDeadlineAlerts(items, now);
  console.log(`\n  What the engine would say tonight (${planned.length}):`);
  if (planned.length === 0) console.log('    nothing — every open deadline is outside every window.');
  for (const a of planned) {
    console.log(`    [${a.severity.padEnd(8)}] → ${a.audience === 'owner' ? 'owner' : 'show runners'}  ${a.title}`);
    console.log(`                 ${a.body}`);
  }

  console.log('\n  pnpm deadlines --sweep    write them\n');
}

async function sweep(now: Date) {
  const org = await theOrg();
  const { planned, written } = await sweepDeadlineAlerts(org.id, now);
  console.log(
    `\n${planned.length} deadline(s) had something owed; ${written} alert row(s) written.` +
      (written === 0 && planned.length > 0
        ? '\nNothing new — every one of these has already been sent (the seed runs this same\n' +
          'sweep). An alert is keyed to the deadline *and its date*: move a deadline and it\n' +
          'speaks again; leave it alone and it stays quiet, which is the point.\n'
        : '\nRun again and nothing is written, because an alert is keyed to the deadline *and\n' +
          'its date*. Move a deadline and it speaks again; leave it alone and it stays quiet.\n'),
  );
}

async function main() {
  const now = new Date();
  return process.argv[2] === '--sweep' ? sweep(now) : overview(now);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
