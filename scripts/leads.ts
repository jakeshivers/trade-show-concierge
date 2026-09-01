/**
 * Lead capture, without a screen. SCOPE.md §8c.
 *
 *   pnpm leads                 # every show, worst first, with its coverage
 *   pnpm leads <show id>       # one show: the leads, the meetings, the gaps
 *   pnpm leads --sweep         # write tonight's lead alerts
 *   pnpm leads --retention     # erase everything past its date
 *
 * §8c calls the lead count the weakest link in the whole ROI story, and blames
 * rep behaviour. That is right about the cause and it is not what this output is
 * for. What it shows is the count **saying what it is missing** — "at least 6
 * leads, from 2 of 4 people on the booth" — because a cost-per-lead computed
 * over a silent undercount is confidently wrong in the direction that gets a
 * working show cut. Step 17's coverage indicator, on the return side.
 *
 * `--retention` is the one command in this product that destroys data on
 * purpose. It nulls the personal columns of every lead past its date and keeps
 * the shell, so the erasure is real and the lead count does not move.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import {
  getLeadBoard,
  getLeadPortfolio,
  listShowLeads,
  listShowMeetings,
  loadCoverage,
  planShowAlerts,
  sweepLeadAlerts,
  sweepLeadRetention,
} from '../src/lib/leads/store';
import { BASIS_LABEL } from '../src/lib/leads/consent';
import { mayQuotePerLead } from '../src/lib/leads/coverage';

const db = getDb();
const now = new Date();

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

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

async function portfolio(actor: Actor) {
  const rows = await getLeadPortfolio(actor, now, db);
  console.log('\nLead capture — worst first\n');
  if (rows.length === 0) {
    console.log('  Nothing on the calendar yet.\n');
    return;
  }
  for (const row of rows) {
    const c = row.coverage;
    console.log(`  ${row.showName}  (${row.status})`);
    console.log(`    ${c.headline}`);
    const bits: string[] = [];
    if (c.duplicateCount > 0) bits.push(`${c.duplicateCount} duplicate(s) held out of the count`);
    if (c.basis.unknown > 0) bits.push(`${c.basis.unknown} with no lawful basis`);
    if (c.retentionOverdue > 0) bits.push(`${c.retentionOverdue} past their erasure date`);
    if (c.retentionDueSoon > 0) bits.push(`${c.retentionDueSoon} due for erasure soon`);
    if (bits.length) console.log(`    ${bits.join(' · ')}`);
    const meetings = `${row.meetingsHeld} held, ${row.meetingsBooked} booked, ${row.meetingsNoShow} no-show`;
    console.log(`    meetings: ${meetings}`);
    const perLead = mayQuotePerLead(c);
    if (!perLead.ok && c.standing !== 'not_yet') {
      console.log(`    cost per lead: withheld — ${perLead.reason}`);
    }
    // Only where it is a finding: naming six people who have captured nothing on
    // a show that opens in seven weeks is noise, and noise is how a real one
    // stops being read.
    if ((c.standing === 'partial' || c.standing === 'none') && c.silent.length <= 6) {
      console.log(`    nothing from: ${c.silent.map((s) => s.fullName).join(', ')}`);
    }
    console.log('');
  }
  console.log('  pnpm leads <show id> for one show, lead by lead.\n');
}

async function detail(actor: Actor, showId: string) {
  const coverage = await loadCoverage(actor.orgId, now, db);
  const entry = coverage.get(showId);
  if (!entry) throw new Error(`No show ${showId} in this workspace.`);
  const [leads, meetings, board] = await Promise.all([
    listShowLeads(actor, showId, now, db),
    listShowMeetings(actor, showId, db),
    getLeadBoard(actor, showId, now, db),
  ]);

  console.log(`\n${entry.show.name}\n`);
  console.log(`  ${entry.coverage.headline}\n`);

  for (const lead of leads) {
    const flags: string[] = [BASIS_LABEL[lead.basis]];
    if (lead.redactedAt) flags.push(`erased ${day(lead.redactedAt)}`);
    if (lead.retention === 'overdue') flags.push('PAST ITS ERASURE DATE');
    if (lead.retention === 'due_soon') flags.push(`erase by ${day(lead.deleteAfter)}`);
    if (lead.duplicateOfId) flags.push('not counted — duplicate');
    if (!lead.redactedAt && !lead.outbound.usable) flags.push('not for outbound');
    console.log(
      `  ${lead.fullName.padEnd(26)} ${(lead.company ?? '—').padEnd(24)} ` +
        `${lead.source.padEnd(6)} ${(lead.capturedByName ?? 'imported').padEnd(20)} ${flags.join(' · ')}`,
    );
  }
  if (leads.length === 0) console.log('  No leads recorded.');

  if (board.possiblePairs.length > 0) {
    console.log('\n  Might be the same person — nothing merges these on its own:\n');
    for (const pair of board.possiblePairs) {
      console.log(
        `  ${pair.keep.fullName}${pair.company ? ` at ${pair.company}` : ''} — ` +
          `${day(pair.keep.capturedAt)} (${pair.keep.capturedByName ?? 'imported'}) ` +
          `and again ${day(pair.other.capturedAt)} (${pair.other.capturedByName ?? 'imported'})`,
      );
    }
  }

  console.log('');
  for (const m of meetings) {
    const when = m.occurredAt
      ? `held ${day(m.occurredAt)}`
      : m.noShowAt
        ? `no-show ${day(m.noShowAt)}`
        : `booked ${day(m.scheduledAt)}`;
    console.log(`  ${when.padEnd(20)} ${m.subject}${m.ownerName ? ` — ${m.ownerName}` : ''}`);
  }
  if (meetings.length === 0) console.log('  No meetings recorded.');

  const planned = (await planShowAlerts(actor.orgId, now, db)).filter((a) => a.showId === showId);
  if (planned.length) {
    console.log('\n  What the engine would say tonight:\n');
    for (const a of planned) {
      console.log(`  [${a.severity}] ${a.title}`);
      console.log(`     ${a.body}\n`);
    }
  } else {
    console.log('\n  The engine has nothing to say about this show tonight.\n');
  }
}

async function main() {
  const actor = await anyAdmin();
  const args = process.argv.slice(2);

  if (args.includes('--retention')) {
    const result = await sweepLeadRetention(actor.orgId, now, db);
    console.log(`\n${result.examined} lead(s) still hold personal data.`);
    console.log(`${result.erased} erased — names, emails and notes nulled; the count is unchanged.`);
    for (const show of result.shows) console.log(`  ${show.showName}: ${show.count}`);
    console.log('');
    return;
  }

  if (args.includes('--sweep')) {
    const result = await sweepLeadAlerts(actor.orgId, now, db);
    console.log(
      `\n${result.planned.length} condition(s) hold · ${result.raised} raised · ${result.resolved} resolved\n`,
    );
    for (const a of result.planned) console.log(`  [${a.severity}] ${a.title}`);
    console.log('');
    return;
  }

  const showId = args.find((a) => !a.startsWith('--'));
  if (showId) await detail(actor, showId);
  else await portfolio(actor);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
