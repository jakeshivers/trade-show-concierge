/**
 * Drayage — the general contractor's charge for moving freight between the dock
 * and the booth. SCOPE.md §5n.
 *
 *   pnpm drayage             # every show with freight, biggest estimate first
 *   pnpm drayage <show id>   # one show, crate by crate, with the arithmetic
 *
 * The output worth reading is the same half `pnpm cost` exists for: not the
 * number, but what it is missing and in whose words. A drayage estimate is a
 * prediction about somebody else's invoice, so a figure printed without the
 * crate that has no weight on it, or without the four crates nobody has said are
 * crated, is exactly the confidently-wrong number §5a spends its length arguing
 * against. Every one of those is a line here.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { BASIS_LABEL } from '../src/lib/drayage/edit';
import { getPortfolioDrayage, getShowDrayage, type ShowDrayage } from '../src/lib/drayage/store';

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

function headline(d: ShowDrayage): string {
  if (!d.estimate.total.ok) return '—';
  const figure = money(d.estimate.total.cents);
  // "at least" is not decoration. `cost/rollup.ts` uses the same word for the
  // same reason, and a figure that has quietly dropped an unweighed crate must
  // never be printed in the same voice as one that has not.
  return d.estimate.isFloor ? `at least ${figure}` : figure;
}

function printGaps(d: ShowDrayage, indent = '    ') {
  for (const g of d.estimate.gaps) console.log(`${indent}· ${g.what}`);
  if (d.estimate.coveredByRoundTrip > 0) {
    console.log(
      `${indent}· ${d.estimate.coveredByRoundTrip} return leg(s) already paid for on the way ` +
        'in — this card charges round trip',
    );
  }
  if (d.card && !d.card.confirmedAt) {
    console.log(
      `${indent}· the rate card has not been checked against this year's manual. Contractors ` +
        're-price annually, so this is last year until somebody says otherwise.',
    );
  }
}

async function one(actor: Actor, showId: string) {
  const d = await getShowDrayage(actor, showId, db);
  console.log(`\n${d.showName}\n${'─'.repeat(72)}`);

  if (!d.card) {
    console.log('\n  No rate card.');
  } else {
    const rates = [
      d.card.advanceCwtCents ? `advance ${money(d.card.advanceCwtCents)}/CWT` : null,
      d.card.showSiteCwtCents ? `show site ${money(d.card.showSiteCwtCents)}/CWT` : null,
    ].filter(Boolean);
    console.log(
      `\n  ${d.card.contractor ?? 'Contractor not recorded'} · ${rates.join(' · ')} · ` +
        `${d.card.minimumLb} lb minimum`,
    );
    console.log(`  ${BASIS_LABEL[d.card.basis]}`);
    console.log(
      `  special handling ${d.card.specialHandlingPct === null ? 'not stated on the card' : `+${d.card.specialHandlingPct}%`}` +
        ` · overtime ${d.card.overtimePct === null ? 'not stated' : `+${d.card.overtimePct}%`}` +
        ` · ${d.card.confirmedAt ? 'confirmed against the manual' : 'UNCONFIRMED'}`,
    );
  }

  if (d.estimate.perShipment.length) {
    console.log('');
    for (const p of d.estimate.perShipment) {
      const extra = p.specialHandlingCents
        ? `  (+${money(p.specialHandlingCents)} special handling)`
        : '';
      console.log(
        `  ${money(p.cents).padStart(10)}  ${String(p.hundredweight).padStart(4)} CWT ` +
          `(${p.billableLb} lb billable)  ${p.description}${extra}`,
      );
    }
  }

  console.log(`\n  ${headline(d)}`);
  if (!d.estimate.total.ok) console.log(`    ${d.estimate.total.reason}`);
  printGaps(d);
}

async function all(actor: Actor) {
  const rows = await getPortfolioDrayage(actor, db);
  // Biggest first, and shows with no figure last rather than sorted as zero —
  // a withheld estimate is not a small one, and putting it at the bottom of a
  // descending list is the only ordering that does not say it is.
  const ordered = [...rows].sort((a, b) => {
    const av = a.estimate.total.ok ? a.estimate.total.cents : -1;
    const bv = b.estimate.total.ok ? b.estimate.total.cents : -1;
    return bv - av;
  });

  console.log('\nDrayage across the calendar — the largest cost most shows have no figure for\n');
  for (const d of ordered) {
    // `considered`, not the priced rows: a show with six crates and no rate card
    // must not report zero crates, which reads as a show with no freight.
    const crates = d.estimate.considered;
    console.log(
      `  ${headline(d).padStart(18)}  ${d.showName.slice(0, 34).padEnd(34)} ` +
        // "No rate card" on a show with no freight is noise: there is nothing to
        // price, and a warning that fires on the ordinary case is one nobody reads.
        `${crates} crate${crates === 1 ? '' : 's'}${!d.card && crates > 0 ? ' · no rate card' : ''}`,
    );
    if (!d.estimate.total.ok && d.estimate.gaps.length === 0) continue;
    printGaps(d, '      ');
  }
  console.log('\n  pnpm drayage <show id> for one show, crate by crate.');
}

async function run() {
  const actor = await anyAdmin();
  const showId = process.argv[2];
  if (showId) await one(actor, showId);
  else await all(actor);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
