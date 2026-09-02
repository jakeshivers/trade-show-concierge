import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedDateInput, zonedToInstant } from '@/lib/datetime/zoned';
import { optionalDecimalToCents } from '@/lib/money/decimal';
import { NotFoundError } from '@/lib/shows/store';
import type { DeadlineExtractor } from '@/lib/integrations/extract/types';
import { canExtractManual } from './access';
import { planCandidates, type CandidatePlan } from './candidates';
import { reportCoverage, type CoverageReport } from './coverage';
import { readManual, renderForModel } from './pdf';
import { selectDeadlineExtractor } from './provider';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of manual extraction. Org-scoped through the show, the way
 * `shipping/store.ts` is, and the only file here that writes anything.
 *
 * Everything it decides was decided by a pure function above it: `pdf.ts` read
 * the pages, `anchor.ts` checked the citations, `candidates.ts` accepted and
 * refused, `coverage.ts` measured what nobody claimed. This assembles them, in
 * one transaction-shaped pass, and writes the run **before** it writes any
 * deadlines — so a run that fails half way leaves a record saying so rather than
 * leaving a register that grew by an unexplained twelve rows.
 */

/** A manual is a big document; anything past this is not one. */
export const MAX_MANUAL_BYTES = 32 * 1024 * 1024;

export type ExtractionReport = {
  extractionId: string;
  filename: string;
  pageCount: number;
  unreadablePages: number[];
  provider: string;
  model: string;
  truncated: boolean;
  plan: CandidatePlan;
  coverage: CoverageReport;
  /** Ids of the rows created, in the order they were accepted. */
  createdDeadlineIds: string[];
};

export async function extractManual(
  actor: Actor,
  showId: string,
  filename: string,
  bytes: Uint8Array,
  extractor: DeadlineExtractor = selectDeadlineExtractor(),
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<ExtractionReport> {
  if (!canExtractManual(actor)) throw new ForbiddenError('read a service manual into the register');

  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();

  if (bytes.byteLength > MAX_MANUAL_BYTES) {
    throw new Error(
      `That file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the limit is ` +
        `${MAX_MANUAL_BYTES / 1024 / 1024} MB.`,
    );
  }

  // Reading the PDF comes first and can throw — an unreadable or scanned file is
  // named as such rather than becoming an extraction that found nothing.
  const doc = await readManual(bytes);

  // The show's dates as a person in that city reads them. The model needs them
  // to place a bare "the 4th" in a year, and `candidates.ts` needs `opensOn` to
  // judge whether a date is plausibly a deadline at all — so both read the same
  // local calendar the register itself is kept in, rather than a UTC instant that
  // is a day out for every show west of Greenwich.
  const opensOn = zonedDateInput(show.startsOn, show.timezone);
  const closesOn = zonedDateInput(show.endsOn, show.timezone);

  const reply = await extractor.extract({
    document: renderForModel(doc.pages),
    context: {
      showName: show.name,
      opensOn,
      closesOn,
      timezone: show.timezone,
    },
  });

  const plan = planCandidates(doc.pages, reply.candidates, { opensOn });
  const coverage = reportCoverage(
    doc.pages,
    // Accepted *and* duplicate: a cutoff printed twice was read twice, and only
    // one row survives. Scoring the survivors alone puts every well-organised
    // manual's repeated deadlines on the unclaimed list. `coverage.ts`'s header
    // has the long version.
    [
      ...plan.accepted.map((a) => ({ page: a.page, snippet: a.snippet })),
      ...plan.duplicates.map((d) => ({ page: d.candidate.page, snippet: d.candidate.snippet })),
    ],
    doc.unreadablePages,
  );

  const [run] = await db
    .insert(s.manualExtractions)
    .values({
      orgId: actor.orgId,
      showId,
      extractedById: actor.userId,
      filename,
      fileBytes: bytes.byteLength,
      pageCount: doc.pageCount,
      unreadablePages: doc.unreadablePages,
      provider: reply.provider,
      model: reply.model,
      proposed: reply.candidates.length,
      accepted: plan.accepted.length,
      rejected: plan.rejected.length,
      duplicates: plan.duplicates.length,
      truncated: reply.truncated,
      problems: [
        ...plan.rejected.map((r) => ({
          page: r.candidate.page,
          title: r.candidate.title,
          reason: r.reason,
          detail: r.detail,
        })),
        ...plan.duplicates.map((d) => ({
          page: d.candidate.page,
          title: d.candidate.title,
          reason: 'duplicate',
          detail: `Already read from page ${d.firstSeenOnPage} on the same date.`,
        })),
      ],
      createdAt: now,
    })
    .returning({ id: s.manualExtractions.id });

  const createdDeadlineIds: string[] = [];
  for (const a of plan.accepted) {
    const [row] = await db
      .insert(s.showDeadlines)
      .values({
        showId,
        kind: a.kind,
        title: a.title,
        dueAt: zonedToInstant(`${a.dueDate}T${a.dueTime}:00`, show.timezone),
        // The amount survived `candidates.ts` only because its digits were in the
        // verified snippet. It is still not quoted anywhere until a person
        // confirms the row — the step 11 engine chases an unconfirmed deadline as
        // a *date* and never as a figure, which is exactly the rule §5a wrote for
        // this feature before it existed.
        penaltyEstimateCents: optionalDecimalToCents(a.penaltyEstimate),
        penaltyNote: a.penaltyNote,
        ownerId: null,
        extractedFromDocument: true,
        extractionId: run.id,
        sourcePage: a.page,
        sourceSnippet: a.snippet,
        dueTimeAssumed: a.timeAssumed,
        confirmedAt: null,
        updatedAt: now,
      })
      .returning({ id: s.showDeadlines.id });
    createdDeadlineIds.push(row.id);
  }

  return {
    extractionId: run.id,
    filename,
    pageCount: doc.pageCount,
    unreadablePages: doc.unreadablePages,
    provider: reply.provider,
    model: reply.model,
    truncated: reply.truncated,
    plan,
    coverage,
    createdDeadlineIds,
  };
}

export type ExtractionRun = typeof s.manualExtractions.$inferSelect;

/** Every reading of a manual for this show, newest first. Append-only. */
export async function listExtractions(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<ExtractionRun[]> {
  return db
    .select()
    .from(s.manualExtractions)
    .where(and(eq(s.manualExtractions.showId, showId), eq(s.manualExtractions.orgId, actor.orgId)))
    .orderBy(desc(s.manualExtractions.createdAt));
}
