/**
 * The true-cost rollup, without a screen. SCOPE.md §8a.
 *
 *   pnpm cost               # every committed show, nearest to now first
 *   pnpm cost <show id>     # one show, line by line, with its gaps
 *
 * §8a's claim is that this number is a query rather than a week of spreadsheet
 * archaeology. It is. The half worth reading here is the other one: what the
 * number is *missing*, in the words the app would use to say so. A cost figure
 * that does not say what it omits is the same fabricated bill §5a refuses to
 * quote, and most of the code behind this output exists to make the omissions
 * legible rather than to do the addition.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { getCostPortfolio, getShowCost } from '../src/lib/cost/store';
import { CATEGORY_LABEL, type ShowCost } from '../src/lib/cost/rollup';

const db = getDb();

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function anyAdmin(): Promise<Actor> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.role, 'admin')).limit(1);
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

const VERDICT: Record<string, string> = {
  complete: 'complete — every row that exists carries a figure',
  partial: 'partial — a floor, with named holes',
  thin: 'thin — most of this show’s cost is not in these numbers',
  empty: 'empty — nothing recorded. Not a cheap show.',
};

function detail(cost: ShowCost) {
  console.log(`\n${cost.showName}\n`);
  for (const line of cost.lines) {
    if (line.cents === 0 && line.counted === 0 && line.gaps.length === 0) continue;
    const paid =
      line.cents > 0 && line.paidCents === line.cents ? 'paid' : `${money(line.paidCents)} paid`;
    console.log(
      `  ${CATEGORY_LABEL[line.category].padEnd(20)} ${money(line.cents).padStart(11)}` +
        `   ${String(line.counted).padStart(2)} row(s), ${paid}`,
    );
  }
  console.log('  ' + '─'.repeat(46));
  console.log(
    `  ${(cost.isFloor ? 'at least' : 'true cost').padEnd(20)} ${money(cost.totalCents).padStart(11)}` +
      `   ${money(cost.paidCents)} paid, ${money(cost.committedCents)} committed`,
  );
  if (cost.creditFundedCents > 0) {
    console.log(
      `  ${'(credit-funded)'.padEnd(20)} ${money(cost.creditFundedCents).padStart(11)}` +
        '   fare covered by credits from an earlier cancellation — spent last year, not here',
    );
  }
  if (cost.consumedCents > 0) {
    console.log(
      `  ${'(stock consumed)'.padEnd(20)} ${money(cost.consumedCents).padStart(11)}` +
        '   issued off the shelf at unit cost — a valuation, not an outlay, so not added',
    );
  }
  if (cost.attendeeDays !== null) {
    console.log(
      `  ${'staff time'.padEnd(20)} ${String(cost.attendeeDays).padStart(8)} days` +
        '   deliberately not priced: there is no loaded rate here to price it with (§11.8)',
    );
  }

  console.log(`\n  coverage: ${VERDICT[cost.coverage.verdict]}`);
  if (cost.coverage.silent.length > 0) {
    console.log(`  silent categories: ${cost.coverage.silent.join(', ')}`);
  }
  for (const gap of cost.coverage.gaps) {
    console.log(`    · [${gap.kind}] ${gap.what}`);
  }
  console.log();
}

async function main() {
  const actor = await anyAdmin();
  const showId = process.argv.slice(2).find((a) => !a.startsWith('--'));

  if (showId) {
    detail(await getShowCost(actor, showId, {}, db));
    return;
  }

  const portfolio = await getCostPortfolio(actor, {}, db);
  console.log('\nTrue cost — every committed show, nearest to now first\n');
  for (const cost of portfolio.shows) {
    const flag = cost.isFloor ? '≥' : ' ';
    console.log(
      `  ${flag} ${money(cost.totalCents).padStart(11)}  ${cost.showName.padEnd(34)}` +
        `  ${cost.coverage.verdict}` +
        (cost.coverage.gaps.length > 0 ? `, ${cost.coverage.gaps.length} gap(s)` : ''),
    );
  }
  console.log('  ' + '─'.repeat(70));
  console.log(`    ${money(portfolio.totalCents).padStart(11)}  across ${portfolio.shows.length} shows`);
  console.log(
    `\n  ${portfolio.incomplete} of ${portfolio.shows.length} figures are floors rather than totals; ` +
      `${portfolio.unrecorded} show(s) have nothing recorded at all.`,
  );
  if (portfolio.creditFundedCents > 0) {
    console.log(
      `  ${money(portfolio.creditFundedCents)} of fare was covered by credits from earlier ` +
        'cancellations, and is counted on no show here.',
    );
  }
  console.log('\n  pnpm cost <show id> for one show, line by line, with its gaps named.\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
