/**
 * The service manual reader, with and without a database.
 *
 *   pnpm manual <show id> <file.pdf>   read a manual into that show's register
 *   pnpm manual <show id>              what has been read for that show already
 *   pnpm manual:probe <file.pdf> --opens 2027-03-15 [--closes …] [--tz …]
 *
 * ## `--probe` is this feature's `pnpm duffel:capture`
 *
 * Our synthetic corpus and the extraction prompt were written by the same person,
 * so the unit suite is a closed loop: it proves the halves agree and structurally
 * cannot catch a layout the real manuals use and ours does not. That is exactly
 * the problem step 12.5 named for Duffel — but the analogy needed correcting
 * before it produced a design, because the *unverified thing* is different.
 *
 * Duffel's is a field name: a fact about a vendor, so a live key is the only
 * possible arbiter. This adapter's is **recall**, which splits in two.
 * Fabrication is already dead — `anchor.ts` holds the page text and a snippet
 * either occurs on its page or does not, no corpus required. A **miss** is what
 * is left, it is silent, and it is the exact outcome §5a exists to prevent.
 *
 * So the arbiter is `coverage.ts`: a deliberately stupid, high-recall date sweep
 * that knows nothing about the prompt and cannot be tuned into agreement with it.
 * Point this at a real manual and read the unclaimed list. Most lines on it are
 * not misses — a manual is full of dates that are not deadlines — and the number
 * is not the output. **The output is the list**, and one line reading
 * `p14 "Rigging orders due January 27"` with nothing claiming it is worth more
 * than every other line on the page.
 *
 * Nothing is committed. A real exhibitor manual is somebody's copyrighted
 * document, so captures land in the gitignored `fixtures/live-manuals/`, on the
 * same footing as `fixtures/live-salesforce/` and for a stronger reason: that
 * directory is redacted personal data, this one is a third party's document.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getActor } from '@/lib/auth/actor';
import { zonedDateInput } from '@/lib/datetime/zoned';
import { planCandidates } from '@/lib/manual/candidates';
import { reportCoverage, type DateMention } from '@/lib/manual/coverage';
import { readManual, renderForModel } from '@/lib/manual/pdf';
import { selectDeadlineExtractor } from '@/lib/manual/provider';
import { extractManual, listExtractions } from '@/lib/manual/store';

const OUT_DIR = path.resolve(import.meta.dirname, '../fixtures/live-manuals');

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function rule(label: string) {
  console.log(`\n${label}\n${'─'.repeat(Math.max(label.length, 60))}`);
}

/** Group a mention list by page, because that is how somebody checks it. */
function printMentions(mentions: DateMention[]) {
  let page = -1;
  for (const m of mentions) {
    if (m.page !== page) {
      page = m.page;
      console.log(`\n  page ${page}`);
    }
    const line = m.line.length > 96 ? `${m.line.slice(0, 93)}…` : m.line;
    console.log(`    ${m.text.padEnd(22)} ${line}`);
  }
}

async function probe(file: string) {
  const opensOn = flag('opens');
  if (!opensOn) {
    console.error(
      'pnpm manual:probe <file.pdf> --opens YYYY-MM-DD [--closes YYYY-MM-DD] [--tz IANA] [--name …]\n\n' +
        'The show’s opening date is required and is deliberately not guessed: it is what\n' +
        'places a bare "the 4th" in a year and what decides whether a date is plausibly a\n' +
        'deadline at all. A wrong one makes the report wrong in the flattering direction.',
    );
    process.exitCode = 1;
    return;
  }
  const closesOn = flag('closes') ?? opensOn;
  const timezone = flag('tz') ?? 'America/Chicago';
  const showName = flag('name') ?? path.basename(file, '.pdf');

  const bytes = new Uint8Array(await readFile(file));
  const doc = await readManual(bytes);

  console.log(`\n${path.basename(file)} — ${doc.pageCount} pages, ${(bytes.byteLength / 1024).toFixed(0)} KB`);
  if (doc.unreadablePages.length) {
    console.log(
      `  ${doc.unreadablePages.length} page(s) carry no text and were not read: ` +
        `${doc.unreadablePages.join(', ')}. That is not "no deadlines on them".`,
    );
  }

  const extractor = selectDeadlineExtractor();
  console.log(`  reading with ${extractor.name}…`);
  const reply = await extractor.extract({
    document: renderForModel(doc.pages),
    context: { showName, opensOn, closesOn, timezone },
  });

  const plan = planCandidates(doc.pages, reply.candidates, { opensOn });
  const coverage = reportCoverage(
    doc.pages,
    [
      ...plan.accepted.map((a) => ({ page: a.page, snippet: a.snippet })),
      ...plan.duplicates.map((d) => ({ page: d.candidate.page, snippet: d.candidate.snippet })),
    ],
    doc.unreadablePages,
  );

  rule(`Proposed ${reply.candidates.length} · accepted ${plan.accepted.length} · rejected ${plan.rejected.length} · duplicate ${plan.duplicates.length}`);
  if (reply.truncated) {
    console.log(
      '  ⚠ The model ran out of output room. This reading is INCOMPLETE, and a half-read\n' +
        '    manual reports fewer deadlines with exactly the confidence of a full one.',
    );
  }

  for (const a of plan.accepted) {
    const money = a.penaltyEstimate ? `$${a.penaltyEstimate}` : a.penaltyNote ? '(note only)' : '—';
    console.log(
      `\n  ${a.dueDate} ${a.dueTime}${a.timeAssumed ? ' (assumed)' : ''}  ${a.kind.padEnd(20)} ${money}`,
    );
    console.log(`    ${a.title}`);
    console.log(`    p${a.page}: "${a.snippet.replace(/\n/g, ' ')}"`);
    if (a.droppedPenalty) {
      console.log(`    dropped $${a.droppedPenalty} — not printed in the evidence above`);
    }
    if (a.kindCorrectedFrom) console.log(`    kind was "${a.kindCorrectedFrom}"`);
  }

  if (plan.rejected.length) {
    rule('Refused');
    for (const r of plan.rejected) {
      console.log(`  p${r.candidate.page} ${r.reason}: ${r.candidate.title}`);
      console.log(`    ${r.detail}`);
    }
  }

  rule(
    `Coverage — ${coverage.claimed.length} of ${coverage.mentions.length} date-shaped strings claimed`,
  );
  console.log(
    '  Everything below is a date the extractor did not account for. Most are not\n' +
      '  deadlines — show dates, footers, revision stamps, fractions. Read the list; the\n' +
      '  count is not the output. A line here that IS a deadline is a miss, and a miss is\n' +
      '  the failure no fixture in this repo can catch.',
  );
  printMentions(coverage.unclaimed);

  await mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${Date.now()}-${path.basename(file, '.pdf')}.json`);
  await writeFile(
    out,
    JSON.stringify(
      { file: path.basename(file), showName, opensOn, closesOn, timezone, reply, plan, coverage },
      null,
      2,
    ),
  );
  console.log(`\nCaptured to ${path.relative(process.cwd(), out)} (gitignored).`);
}

async function run() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  if (process.argv.includes('--probe')) {
    if (!args[0]) {
      console.error('pnpm manual:probe <file.pdf> --opens YYYY-MM-DD');
      process.exitCode = 1;
      return;
    }
    await probe(args[0]);
    return;
  }

  const actor = await getActor();
  const db = getDb();
  const [showId, file] = args;

  if (!showId) {
    const shows = await db.query.shows.findMany({ where: eq(s.shows.orgId, actor.orgId) });
    console.log('\npnpm manual <show id> <file.pdf>\n');
    for (const show of shows) {
      const runs = await listExtractions(actor, show.id, db);
      const read = runs.length ? `${runs.length} reading(s)` : 'never read';
      console.log(`  ${show.id}  ${show.name.padEnd(34)} ${read}`);
    }
    return;
  }

  if (!file) {
    const runs = await listExtractions(actor, showId, db);
    if (!runs.length) {
      console.log('\nNo manual has been read for this show.');
      return;
    }
    for (const r of runs) {
      console.log(
        `\n  ${zonedDateInput(r.createdAt, 'UTC')}  ${r.filename}  (${r.model})\n` +
          `    ${r.pageCount} pages · proposed ${r.proposed} · accepted ${r.accepted} · ` +
          `rejected ${r.rejected} · duplicate ${r.duplicates}` +
          (r.truncated ? ' · TRUNCATED' : ''),
      );
      for (const p of r.problems ?? []) console.log(`      p${p.page} ${p.reason}: ${p.title}`);
    }
    return;
  }

  const bytes = new Uint8Array(await readFile(file));
  const report = await extractManual(actor, showId, path.basename(file), bytes);

  console.log(
    `\n${report.filename} — ${report.pageCount} pages, read with ${report.model}\n` +
      `  proposed ${report.plan.considered} · accepted ${report.plan.accepted.length} · ` +
      `rejected ${report.plan.rejected.length} · duplicate ${report.plan.duplicates.length}`,
  );
  console.log(
    `\n  ${report.createdDeadlineIds.length} deadline(s) added to the register, all unconfirmed.\n` +
      '  Until somebody confirms each one, the engine chases it as a date and never quotes\n' +
      '  its penalty as an amount. That is §5a working, not a limitation.',
  );
  rule(`Coverage — ${report.coverage.unclaimed.length} date-shaped strings nothing claimed`);
  printMentions(report.coverage.unclaimed);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
