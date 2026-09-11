/**
 * The day-of screen, without a screen. SCOPE.md §10 step 20.
 *
 *   pnpm day-of                    # which show is on the floor, and what it would say
 *   pnpm day-of <show id>          # one show's snapshot, as a device would hold it
 *   pnpm day-of <show id> --as priya@…   # the same snapshot for somebody else
 *   pnpm day-of <show id> --stale 90     # what the same snapshot says 90 minutes later
 *
 * Every other CLI in this product prints an engine's output. This one prints a
 * *cache*, and the reason it earns a command is `--stale`: the hard thing about
 * an offline screen is not what it says when it is fresh, it is what it stops
 * saying when it is not. Running the same snapshot at 0 and at 90 minutes is the
 * fastest way to see `degradeVerdicts` take the present tense off a crate line —
 * which is the one behaviour here that is impossible to check by looking at a
 * browser with a working connection.
 *
 * It builds the snapshot through `buildSnapshot`, as the route does, so what is
 * printed is the object a device would actually be holding rather than a second
 * rendering of the same rows.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { buildSnapshot, getTargetBoard, listDayOfShows } from '../src/lib/dayof/store';
import {
  degradeVerdicts,
  freshnessOf,
  shiftStanding,
  type DaySnapshot,
} from '../src/lib/dayof/snapshot';
import { summarizeTargets, targetStandings } from '../src/lib/dayof/targets';

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

const clock = (iso: string, zone: string) =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });

function printSnapshot(snapshot: DaySnapshot, readAt: Date, actor: Actor) {
  const view = degradeVerdicts(snapshot, readAt);
  const fresh = freshnessOf(view.capturedAt, readAt);
  const zone = view.show.timezone;

  console.log(`\n${view.show.name} — booth ${view.show.boothNumber ?? '—'}`);
  console.log(`  ${[view.show.venueName, view.show.city].filter(Boolean).join(' · ')}`);
  console.log(`  read as ${actor.fullName}, ${fresh.sentence}\n`);

  const standing = shiftStanding(view.shifts, readAt);
  switch (standing.kind) {
    case 'on_now':
      console.log(
        `  On the booth now  ${clock(standing.shift.startsAt, zone)}–${clock(standing.shift.endsAt, zone)}` +
          `  ${standing.endsInMinutes} min left` +
          (standing.shift.staff.length ? `  with ${standing.shift.staff.join(', ')}` : ''),
      );
      break;
    case 'next':
      console.log(
        `  Next shift        ${clock(standing.shift.startsAt, zone)}–${clock(standing.shift.endsAt, zone)}` +
          `  in ${Math.round(standing.startsInMinutes / 60)}h`,
      );
      break;
    case 'none_today':
      console.log('  No more shifts on this show.');
      break;
    case 'not_rostered':
      console.log('  Not on a booth shift here — which does not stop anybody capturing a lead.');
      break;
  }

  const short = view.shifts.filter((s) => s.effectiveCount < s.targetStaff);
  if (short.length) {
    console.log('\n  Shifts that cannot field their target:');
    for (const s of short) {
      console.log(
        `    ${clock(s.startsAt, zone)}–${clock(s.endsAt, zone)}  ${s.effectiveCount} of ${s.targetStaff}` +
          (s.overstated ? `  (the roster says ${s.assignedCount} — overstated)` : ''),
      );
    }
  }

  if (view.crates.length) {
    console.log('\n  Freight');
    for (const c of view.crates) {
      console.log(
        `    ${c.description.padEnd(34)} ${c.standing ?? 'standing withheld — nothing has re-checked the carrier'}`,
      );
    }
  }

  const standings = targetStandings(
    view.targets,
    view.leads.map((l) => ({
      id: l.id,
      fullName: l.fullName,
      company: l.company,
      capturedAt: new Date(l.capturedAt),
      duplicateOfId: l.duplicateOfId,
    })),
  );
  const summary = summarizeTargets(standings);
  console.log(`\n  Targets — ${summary.sentence}`);
  for (const s of standings) {
    console.log(
      `    ${s.met ? 'met      ' : s.target.priority === 'must_meet' ? 'MUST MEET' : 'not yet  '} ` +
        `${s.target.companyName}` +
        (s.met ? `  · ${s.leads[0].fullName}` : s.target.reason ? `  · ${s.target.reason}` : '') +
        (s.unowned ? '  · nobody owns this account' : ''),
    );
  }

  const counted = view.leads.filter((l) => !l.duplicateOfId).length;
  console.log(`\n  ${counted} leads recorded on this show.`);
  console.log(
    '  (A device would show its own queue beside this figure and never inside it.)\n',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const asIndex = args.indexOf('--as');
  const staleIndex = args.indexOf('--stale');
  const staleMinutes = staleIndex >= 0 ? Number(args[staleIndex + 1] ?? '0') : 0;
  const showId = args.find((a) => !a.startsWith('--') && a !== args[asIndex + 1] && a !== args[staleIndex + 1]);
  const actor = await actorFor(asIndex >= 0 ? args[asIndex + 1] : undefined);
  const now = new Date();

  if (!showId) {
    const shows = await listDayOfShows(actor, now, db);
    console.log('\nShows, nearest to now first\n');
    for (const s of shows) {
      console.log(
        `  ${s.onFloorNow ? 'ON THE FLOOR' : '            '}  ${s.name}` +
          `  ${s.city ?? ''}  booth ${s.boothNumber ?? '—'}  ${s.id}`,
      );
    }
    const floor = shows.find((s) => s.onFloorNow);
    console.log(
      floor
        ? `\n  pnpm day-of ${floor.id}\n`
        : '\n  Nothing on a floor right now. Pass a show id to see what a device would hold.\n',
    );
    return;
  }

  const snapshot = await buildSnapshot(actor, showId, now, db);
  printSnapshot(snapshot, now, actor);

  if (staleMinutes > 0) {
    // The same object, read later. Nothing about the snapshot changed; what
    // changed is what it is allowed to claim.
    console.log(`  ── the same snapshot, read ${staleMinutes} minutes later ──`);
    printSnapshot(snapshot, new Date(now.getTime() + staleMinutes * 60_000), actor);
  }

  const board = await getTargetBoard(actor, showId, db);
  const unowned = board.standings.filter((s) => s.unowned);
  if (unowned.length) {
    console.log(
      `  ${unowned.length} must-meet account${unowned.length === 1 ? ' has' : 's have'} no owner. ` +
        'An alert addressed to an owner who does not exist reaches nobody.\n',
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
