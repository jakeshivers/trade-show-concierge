/**
 * "Was it worth it?" without a screen. SCOPE.md §8, step 19.
 *
 *   pnpm roi                # every show, biggest cost first, with what is withheld
 *   pnpm roi <show id>      # one show, and every opportunity behind its figure
 *   pnpm roi --sync         # match leads to the CRM, cache opportunities, write back
 *   pnpm roi --sync --no-write   # read only; write no attribution into their CRM
 *
 * Read this output before reading the code. The arithmetic is one division and
 * it is the least interesting thing here — what the step is actually made of is
 * the list of figures this refuses to print, and the reason attached to each.
 * On a workspace with no CRM key that list is most of the page, which is the
 * honest state of the third north-star job rather than a broken one.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as schema from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { selectCrmProviderOrNull } from '../src/lib/roi/provider';
import {
  getRoiPortfolio,
  getShowRoi,
  listShowOpportunities,
  listSyncRuns,
  sweepRoiAlerts,
  syncCrm,
} from '../src/lib/roi/store';
import { MATURITY_LABEL, figureLabel } from '../src/lib/roi/rollup';
import type { Quotable, ShowRoi } from '../src/lib/roi/rollup';
import { DEFAULT_SETTINGS } from '../src/lib/roi/attribution';

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

/** A withheld figure prints its reason. That is the whole design, in one helper. */
function quote(label: string, q: Quotable): string {
  return q.ok ? `  ${label.padEnd(22)} ${money(q.cents)}` : `  ${label.padEnd(22)} — withheld: ${q.reason}`;
}

function detail(roi: ShowRoi) {
  console.log(`\n${roi.showName}  ·  ${MATURITY_LABEL[roi.maturity]}\n`);
  console.log(`  ${'Recorded cost'.padEnd(22)} ${roi.cost.isFloor ? '≥ ' : '  '}${money(roi.cost.totalCents)}`);
  console.log(`  ${'Leads'.padEnd(22)}   ${roi.leads.headline}`);
  console.log(`  ${'Meetings held'.padEnd(22)}   ${roi.meetingsHeld}`);
  console.log(
    `  ${'Pipeline (sourced)'.padEnd(22)}   ${money(roi.attribution.sourcedCents)} across ` +
      `${roi.attribution.sourcedCount} opportunit${roi.attribution.sourcedCount === 1 ? 'y' : 'ies'}` +
      (roi.attribution.replayed ? '   [replayed — not from a CRM]' : ''),
  );
  console.log(
    `  ${'Pipeline (influenced)'.padEnd(22)}   ${money(roi.attribution.influencedCents)} across ` +
      `${roi.attribution.influencedCount}`,
  );
  console.log('');
  console.log(quote('Cost per lead', roi.costPerLead));
  console.log(quote('Cost per meeting', roi.costPerMeeting));
  console.log(quote('Cost per opportunity', roi.costPerOpportunity));
  console.log(quote('Closed-won attributed', roi.closedWon));
  console.log(
    roi.pipelineMultiple.ok
      ? `  ${'Pipeline multiple'.padEnd(22)} ${roi.pipelineMultiple.multiple.toFixed(1)}×`
      : `  ${'Pipeline multiple'.padEnd(22)} — withheld: ${roi.pipelineMultiple.reason}`,
  );

  if (roi.gaps.length > 0) {
    console.log('\n  What is missing from the numbers above');
    for (const gap of roi.gaps) {
      console.log(`    · [${gap.kind}] ${gap.what}`);
    }
  }
  console.log(`\n  ${figureLabel(roi.settings)} · as of ${roi.asOf.toISOString().slice(0, 10)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const actor = await anyAdmin();

  if (args.includes('--sync')) {
    // The provider is chosen the same way every other integration's is, and it
    // never falls back — a run against replayed opportunities has to be a thing
    // somebody asked for out loud.
    // The *earliest* capture of each person, deliberately. One buyer met at two
    // shows is one CRM contact, and the replay projects its conversion shape off
    // the moment we first met them — which is the same moment `attribution.ts`
    // measures first touch from. Taking the latest would let the shape and the
    // model disagree about which conversation started the deal.
    const capturedAt = new Map<string, Date>();
    for (const row of await db
      .select({ email: schema.leads.email, capturedAt: schema.leads.capturedAt })
      .from(schema.leads)) {
      if (!row.email) continue;
      const seen = capturedAt.get(row.email);
      if (!seen || row.capturedAt < seen) capturedAt.set(row.email, row.capturedAt);
    }
    const choice = selectCrmProviderOrNull(process.env, {
      capturedAtFor: (email) => capturedAt.get(email) ?? null,
    });
    if ('unavailable' in choice) {
      console.log(`\nNo CRM is connected.\n\n  ${choice.unavailable}\n`);
      console.log(
        'The cost side of every show is unaffected — it is entirely ours. What is missing is the\n' +
          'return side, which is what `pnpm roi` will say about each show in those words.\n',
      );
      process.exit(1);
    }

    const write = !args.includes('--no-write');
    console.log(
      `\nSyncing against ${choice.choice.source}${choice.choice.replayed ? ' (replayed)' : ''}` +
        `${write ? ', writing attribution back' : ', reading only'}…\n`,
    );
    const result = await syncCrm(
      actor,
      choice.choice.provider,
      { replayed: choice.choice.replayed, writeAttribution: write },
      db,
    );
    console.log(`  leads considered   ${result.leadsConsidered}`);
    console.log(`    matched          ${result.matched}`);
    console.log(`    unmatched        ${result.unmatched}   (the CRM's answer)`);
    console.log(`    withheld         ${result.withheld}   (ours — no lawful basis, or erased)`);
    console.log(
      `  ${result.matched + result.unmatched + result.withheld === result.leadsConsidered ? '✓' : '✗'} accounted for`,
    );
    console.log(`  opportunities read ${result.opportunitiesRead}`);
    console.log(`  attributions written ${result.attributionsWritten}`);
    if (result.failedReason) console.log(`\n  ✗ the run failed: ${result.failedReason}`);
    if (result.problems.length > 0) {
      console.log('\n  Every refusal, kept:');
      for (const p of result.problems.slice(0, 20)) console.log(`    · ${p.reason}`);
      if (result.problems.length > 20) console.log(`    … and ${result.problems.length - 20} more`);
    }

    const sweep = await sweepRoiAlerts(actor.orgId, new Date(), db);
    console.log(`\n  ROI alerts: ${sweep.raised} raised, ${sweep.resolved} resolved\n`);
    return;
  }

  const showId = args.find((a) => !a.startsWith('--'));
  if (showId) {
    detail(await getShowRoi(actor, showId, {}, db));
    const opps = await listShowOpportunities(actor, showId, {}, db);
    if (opps.length > 0) {
      console.log('\n  Every opportunity behind that figure, and why it counts\n');
      for (const o of opps) {
        console.log(
          `    ${(o.amountCents === null ? 'no amount' : money(o.amountCents)).padStart(11)}  ` +
            `${o.verdictKind.padEnd(11)} ${o.name}${o.replayed ? '  [replayed]' : ''}`,
        );
        console.log(`                 ${o.verdict}`);
      }
    }
    console.log('');
    return;
  }

  const portfolio = await getRoiPortfolio(actor, {}, db);
  console.log(`\nROI across the calendar · ${figureLabel(portfolio.settings)}\n`);
  if (portfolio.replayed) {
    console.log(
      '  ⚠ Pipeline figures below are REPLAYED from a recorded conversion shape, not read from\n' +
        '    a CRM. They describe how booth conversations convert in general and assert nothing\n' +
        '    about this company. Every ratio derived from them is withheld rather than printed.\n',
    );
  }
  console.log(
    `  ${'Show'.padEnd(34)} ${'Cost'.padStart(11)} ${'Sourced'.padStart(12)} ${'Multiple'.padStart(9)}  Standing`,
  );
  for (const show of portfolio.shows) {
    console.log(
      `  ${show.showName.slice(0, 33).padEnd(34)} ` +
        `${(show.cost.isFloor ? '≥' : ' ') + money(show.cost.totalCents).padStart(10)} ` +
        `${money(show.attribution.sourcedCents).padStart(12)} ` +
        `${(show.pipelineMultiple.ok ? `${show.pipelineMultiple.multiple.toFixed(1)}×` : '—').padStart(9)}  ` +
        MATURITY_LABEL[show.maturity],
    );
  }
  console.log('');
  console.log(`  Total recorded cost      ${money(portfolio.totalCostCents)}`);
  console.log(`  Sourced pipeline         ${money(portfolio.sourcedPipelineCents)}`);
  console.log(
    `  Influenced (distinct)    ${money(portfolio.distinctInfluencedCents)}   ` +
      'the per-show influenced figures deliberately do not sum to this',
  );
  console.log(
    portfolio.portfolioMultiple.ok
      ? `  Portfolio multiple       ${portfolio.portfolioMultiple.multiple.toFixed(1)}×`
      : `  Portfolio multiple       — withheld: ${portfolio.portfolioMultiple.reason}`,
  );
  console.log(`  Too recent to score      ${portfolio.immature} of ${portfolio.shows.length}`);
  console.log(`  Figures that are floors  ${portfolio.incomplete} of ${portfolio.shows.length}`);

  const runs = await listSyncRuns(actor, 3, db);
  if (runs.length === 0) {
    console.log(
      '\n  No CRM sync has ever run in this workspace, so no lead has been offered to a CRM.\n' +
        '  That is why every pipeline figure above is zero — an absence, not a finding.\n' +
        '  `pnpm roi --sync` is the run; SCOPE §11.6 chose Salesforce.\n',
    );
  } else {
    const last = runs[0];
    console.log(
      `\n  Last sync: ${last.provider}${last.replayed ? ' (replayed)' : ''} at ` +
        `${last.startedAt.toISOString().slice(0, 16).replace('T', ' ')} — ` +
        `${last.matched} matched, ${last.unmatched} unmatched, ${last.withheld} withheld` +
        (last.failedReason ? `\n  ✗ ${last.failedReason}` : ''),
    );
  }
  console.log(
    `\n  ${DEFAULT_SETTINGS.windowDays}-day window, sourced model (SCOPE §11.7, resolved 2026-09-01).\n` +
      '  Both models are computed; sourced leads because it is the one a CFO will not discount.\n',
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
