/**
 * The ticket credit ledger, surfaced. SCOPE.md §5b.
 *
 *   pnpm credits                 # the org's exposure and every live credit
 *   pnpm credits <credit-id>     # one credit's full ledger, entry by entry
 *   pnpm credits --sweep         # write off what expired, warn about what will
 *
 * Phase A has no screens, so this is where the number that justifies the whole
 * feature — how much we are about to forfeit — becomes visible to a person.
 * The sweep is what a nightly job would run.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import {
  creditExposure,
  creditsExpiringSoon,
  daysUntil,
  reconcileCredit,
  runCreditMaintenance,
  visibilityOf,
} from '../src/lib/travel/credits';

const db = getDb();
const usd = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const day = (d: Date) => d.toISOString().slice(0, 10);

async function theOrg() {
  const org = await db.query.organizations.findFirst();
  if (!org) throw new Error('No organization. Run `pnpm db:reset` first.');
  return org;
}

async function overview(now: Date) {
  const org = await theOrg();
  const exposure = await creditExposure(db, org.id, now);

  console.log(`\nTicket credits — ${org.name}\n`);
  console.log(`  live and spendable      ${usd(exposure.liveCents)}`);
  console.log(`  expiring within 30 days ${usd(exposure.expiringWithin30Cents)}`);
  console.log(`  forfeited to expiry     ${usd(exposure.forfeitedCents)}`);
  console.log(
    `  needs a phone call      ${usd(exposure.redeemableElsewhereCents)}  ` +
      '(held by us, not redeemable through the booking provider)',
  );

  const rows = await db
    .select({
      credit: s.ticketCredits,
      holder: s.users.fullName,
    })
    .from(s.ticketCredits)
    .leftJoin(s.users, eq(s.ticketCredits.userId, s.users.id))
    .where(eq(s.ticketCredits.orgId, org.id))
    .orderBy(asc(s.ticketCredits.expiresOn));

  console.log('\n  holder            airline  remaining     expires      days  status          redeem');
  for (const { credit, holder } of rows) {
    const days = daysUntil(credit.expiresOn, now);
    console.log(
      `  ${(holder ?? '—').padEnd(17)} ${credit.airlineCode.padEnd(7)}  ` +
        `${usd(credit.remainingValueCents).padStart(9)}  ${day(credit.expiresOn)}  ` +
        `${String(days).padStart(5)}  ${credit.status.padEnd(15)} ` +
        `${visibilityOf(credit) === 'redeemable_here' ? 'agent' : 'airline'}`,
    );
  }

  const soon = await creditsExpiringSoon(db, org.id, now);
  if (soon.length) {
    console.log('\n  About to be lost:');
    for (const { credit, daysLeft, bucketDays } of soon) {
      console.log(
        `    ${usd(credit.remainingValueCents)} ${credit.airlineCode} in ${daysLeft} day(s) ` +
          `(${bucketDays}-day warning)`,
      );
    }
  }

  console.log('\n  pnpm credits <credit-id>   the ledger behind any one of these');
  console.log('  pnpm credits --sweep       write off what expired, warn about what will\n');
}

async function ledger(creditId: string) {
  const { credit, ledgerCents, cachedCents, ok } = await reconcileCredit(db, creditId);
  const holder = await db.query.users.findFirst({ where: eq(s.users.id, credit.userId) });

  console.log(
    `\n${credit.airlineCode} credit for ${holder?.fullName ?? credit.userId}` +
      `  ·  issued ${day(credit.issuedOn)}  ·  expires ${day(credit.expiresOn)}`,
  );
  console.log(
    `originally ${usd(credit.originalValueCents)}  ·  now ${usd(credit.remainingValueCents)}  ·  ` +
      `${credit.status}  ·  ${visibilityOf(credit) === 'redeemable_here' ? 'redeemable by the agent' : 'redeemable only with the airline'}\n`,
  );

  const entries = await db
    .select()
    .from(s.ticketCreditEntries)
    .where(eq(s.ticketCreditEntries.creditId, creditId))
    .orderBy(asc(s.ticketCreditEntries.occurredAt));

  for (const e of entries) {
    const delta = `${e.deltaCents >= 0 ? '+' : '−'}${usd(Math.abs(e.deltaCents))}`;
    console.log(
      `  ${e.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}  ${e.kind.padEnd(9)} ` +
        `${delta.padStart(10)}  → ${usd(e.balanceAfterCents).padStart(9)}   ${e.reason}`,
    );
  }

  // The balance is a projection; saying so is cheap and catching a drift is not.
  console.log(
    `\n  ledger ${usd(ledgerCents)} vs cached ${usd(cachedCents)} — ${ok ? 'reconciled ✓' : 'DRIFTED ✗'}\n`,
  );
}

async function sweep(now: Date) {
  const org = await theOrg();
  const result = await runCreditMaintenance(db, org.id, now);
  console.log(
    `\nSwept ${result.sweptCount} expired credit(s), writing off ${usd(result.forfeitedCents)}.\n` +
      `Warned about ${result.warned} credit(s) nearing expiry — ${result.alertsSent} alert(s) written.\n` +
      'Run again: the totals do not move, because each threshold speaks once.\n',
  );
}

async function main() {
  const arg = process.argv[2];
  const now = new Date();
  if (arg === '--sweep') return sweep(now);
  if (arg) return ledger(arg);
  return overview(now);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
