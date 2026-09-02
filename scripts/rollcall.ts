/**
 * Duty of care — who is unaccounted for. SCOPE.md §5o.
 *
 *   pnpm rollcall              # every show with people travelling
 *   pnpm rollcall <show id>    # one show: who to call, in the order to call them
 *
 * `RESEARCH.md` justifies this feature in one sentence — *"we know where
 * everyone is"* — and the output below is what taking that seriously looks like.
 * We do not know where anybody is. We know what a badge scanner recorded at
 * 8:04, what a carrier said about a flight, and what somebody typed into a travel
 * window in June, and the difference between those matters most at the moment
 * this screen gets read.
 *
 * So the useful half of this output is not the count. It is the **order** — who
 * to phone first — and the `basis` column, which says what each standing is
 * actually resting on.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { BASIS_LABEL } from '../src/lib/safety/presence';
import { getRollCall, getRollCallPortfolio, type ShowRollCall } from '../src/lib/safety/store';

const db = getDb();

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

const KIND_LABEL: Record<string, string> = {
  at_venue: 'at the venue',
  in_town: 'in town',
  in_transit: 'in transit',
  not_travelling: 'not there',
  unknown: 'UNKNOWN',
};

function age(minutes: number | null): string {
  if (minutes === null) return '';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function one(call: ShowRollCall) {
  console.log(`\n${call.showName}\n${'─'.repeat(78)}`);
  if (call.request) {
    console.log(
      `\n  Roll call started ${age(Math.floor((Date.now() - call.request.startedAt.getTime()) / 60_000))}` +
        (call.request.note ? ` — ${call.request.note}` : ''),
    );
  } else {
    console.log('\n  No roll call running.');
  }
  console.log(`  ${call.summary}\n`);

  for (const p of call.people) {
    const answered = p.response
      ? p.response.standing === 'needs_help'
        ? 'NEEDS HELP'
        : p.relayed
          ? 'ok (relayed)'
          : 'ok'
      : '—';
    const reach = p.phone ?? 'NO PHONE NUMBER';
    console.log(
      `  ${answered.padEnd(13)} ${p.presence.fullName.slice(0, 22).padEnd(22)} ` +
        `${KIND_LABEL[p.presence.kind].padEnd(15)} ${BASIS_LABEL[p.presence.basis].padEnd(28)} ` +
        `${age(p.presence.ageMinutes).padEnd(9)}${p.presence.stale ? '(stale) ' : ''}${reach}`,
    );
  }

  console.log(
    '\n  Nothing here marks anybody safe. A badge scan is not an answer — somebody who\n' +
      '  badged in twelve minutes ago is who you most need to hear from, not who you can\n' +
      '  stop worrying about.',
  );
}

async function all(actor: Actor) {
  const calls = await getRollCallPortfolio(actor);
  const travelling = calls.filter((c) => c.people.some((p) => p.presence.kind !== 'not_travelling'));

  console.log('\nDuty of care — who is expected where, and who could not be reached\n');
  if (travelling.length === 0) {
    console.log('  Nobody is travelling to any show.');
    return;
  }
  for (const c of travelling) {
    const flag = c.needsHelp > 0 ? '!! ' : c.unreachable > 0 ? ' ! ' : '   ';
    console.log(`${flag}${c.showName.slice(0, 34).padEnd(34)} ${c.summary}`);
  }
  console.log('\n  pnpm rollcall <show id> for one show, in the order to call people.');
}

async function run() {
  const actor = await anyAdmin();
  const showId = process.argv[2];
  if (showId) one(await getRollCall(actor, showId, new Date(), db));
  else await all(actor);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
