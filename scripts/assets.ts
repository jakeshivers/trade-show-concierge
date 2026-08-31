/**
 * The asset register and its engine, without a screen. SCOPE.md §5h.
 *
 *   pnpm assets              # every asset, worst first, and what would be said
 *   pnpm assets <show id>    # one show's reservations and allocations
 *   pnpm assets --sweep      # write tonight's alerts
 *
 * The register is on screen at /assets and on each show's Logistics tab. This
 * exists for the half a screen cannot show: what the *engine* would say tonight,
 * to whom, and — on most rows — that it would say nothing. Running `--sweep`
 * twice writes no second alert, which is the property the whole thing rests on.
 *
 * The two figures worth reading first are the ones no other board has: capital
 * currently outside the building, and the gap between what is on a shelf and
 * what is actually free.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { getAssetRegister, getCollateral, sweepAssetAlerts } from '../src/lib/assets/store';
import { RETURN_GRACE_HOURS, TURNAROUND_HOURS } from '../src/lib/assets/custody';

const db = getDb();

const money = (cents: number | null | undefined) =>
  cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const stamp = (d: Date | null, zone: string | null) =>
  d == null
    ? '—'
    : d.toLocaleString('en-US', {
        timeZone: zone ?? 'UTC',
        month: 'short',
        day: '2-digit',
        hour12: false,
      });

/** Read through an actor, because scoping is the store's job. An admin sees it all. */
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

async function overview(now: Date, showId?: string) {
  const actor = await anyAdmin();
  const register = await getAssetRegister(actor, { showId, asOf: now }, db);
  const { summary: s } = register;

  console.log('\nAssets — capital, and where it actually is\n');
  console.log(`  assets                      ${String(s.assets).padStart(3)}`);
  console.log(`  signed out                  ${String(s.out).padStart(3)}   (not a problem; just not here)`);
  console.log(`  overdue back                ${String(s.overdue).padStart(3)}   (past the window and ${RETURN_GRACE_HOURS}h of grace)`);
  console.log(`  unaccounted for             ${String(s.missing).padStart(3)}   (insurance, not a reminder)`);
  console.log(`  reserved and not fit to go  ${String(s.unserviceable).padStart(3)}   (a future claim, a past fact, nothing joining them)`);
  console.log(`  reserved and never taken    ${String(s.neverCollected).padStart(3)}   (the show went without it, or somebody took it quietly)`);
  console.log(`  capital outside the building ${money(s.atLargeCents).padStart(10)}`);
  console.log(`  capital unaccounted for      ${money(s.missingCents).padStart(10)}`);

  console.log('\n  asset                       tag            show                 window (local)          custody');
  for (const r of register.rows) {
    const zone = r.showTimezone;
    const window = r.reservation
      ? `${stamp(r.reservation.reservedFrom, zone)} → ${stamp(r.reservation.reservedTo, zone)}`
      : '—';
    const custody = r.custody
      ? r.custody.standing +
        (r.custody.standing === 'overdue' || r.custody.standing === 'missing'
          ? ` ${(r.custody.hoursPastDue / 24).toFixed(0)}d`
          : '')
      : r.serviceability.kind === 'unserviceable'
        ? `unreserved · ${r.serviceability.why}`
        : 'unreserved';
    console.log(
      `  ${r.asset.name.padEnd(27).slice(0, 27)} ${(r.asset.assetTag ?? '—').padEnd(14)} ` +
        `${(r.showName ?? '—').padEnd(20).slice(0, 20)} ${window.padEnd(23)} ${custody}`,
    );
    // Only where it is still actionable — which is what the engine decided, so
    // the script reads the alert rather than re-deciding it and disagreeing.
    if (r.alert?.reason === 'window_short_of_freight') {
      console.log('      ↳ window is shorter than the freight this show has booked');
    }
  }

  if (register.clashes.length > 0) {
    console.log(`\n  clashes — one thing, two shows (turnaround under ${TURNAROUND_HOURS}h is "possible")\n`);
    for (const c of register.clashes) {
      console.log(`  [${c.certainty}] ${c.assetName}: ${c.a.showName} ↔ ${c.b.showName}`);
      console.log(`      ${c.detail}`);
    }
  }

  const collateral = await getCollateral(actor, db);
  console.log('\nCollateral — on hand is not available\n');
  console.log('  item                          on hand  promised  in crates  available  threshold  level');
  for (const c of collateral) {
    const st = c.standing;
    console.log(
      `  ${c.item.name.padEnd(29).slice(0, 29)} ${String(st.onHand).padStart(7)} ` +
        `${String(st.committed).padStart(9)} ${String(st.issued).padStart(10)} ` +
        `${String(st.available).padStart(10)} ${String(st.threshold).padStart(10)}  ${st.level}`,
    );
  }

  const planned = (await sweepAssetAlerts(actor.orgId, now, db)).planned;
  console.log(`\nWhat the engine would say tonight — ${planned.length} alert${planned.length === 1 ? '' : 's'}\n`);
  if (planned.length === 0) console.log('  Nothing. Which is the usual answer and the right one.');
  for (const a of planned) {
    console.log(`  [${a.severity}] ${a.title}`);
    console.log(`      → ${a.userId ? 'the person who signed it out' : 'whoever runs the show'} · ${a.reason}`);
    console.log(`      ${a.body}\n`);
  }
}

async function sweep(now: Date) {
  const actor = await anyAdmin();
  const result = await sweepAssetAlerts(actor.orgId, now, db);
  console.log(
    `\nSwept ${result.reservations} reservations · ${result.planned.length} planned · ` +
      `${result.alertsWritten} alert rows written.`,
  );
  console.log('Run it again: nothing new is written, because an alert is keyed to the fact it reports.\n');
}

async function main() {
  const args = process.argv.slice(2);
  const now = new Date();
  if (args.includes('--sweep')) {
    await sweep(now);
    return;
  }
  await overview(now, args.find((a) => !a.startsWith('--')));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
