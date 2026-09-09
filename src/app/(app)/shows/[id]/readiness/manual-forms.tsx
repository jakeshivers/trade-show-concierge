'use client';

import { useActionState } from 'react';
import { readManualIntoRegister, type ManualFormState } from './manual-actions';
import { Badge } from '../../../_components/ui';
import { Form, Message, Submit } from '../../../_components/form-ui';
import type { ExtractionReport, ExtractionRun } from '@/lib/manual/store';

/**
 * Reading the exhibitor manual, and showing what the reading did *not* do.
 *
 * The card leads with the refusals rather than the count, which is the same
 * choice `/cost` and `/leads` made and is sharper here. Thirty deadlines
 * appearing in a register is the most reassuring thing this product can put on a
 * screen, and the reassurance is unearned until somebody has checked them — so
 * what the reader is shown first is that every row is unconfirmed, and what they
 * are shown last is the list of dates in their manual that nothing claimed.
 */

export function ReadManualForm({ showId, configured }: { showId: string; configured: boolean }) {
  const [state, action, pending] = useActionState<ManualFormState, FormData>(
    readManualIntoRegister,
    {},
  );

  if (!configured) {
    return (
      <p className="text-sm text-text-muted">
        Reading a manual needs <code>ANTHROPIC_API_KEY</code>. There is deliberately no
        offline stand-in: a canned deadline would be a claim about a document nothing has
        read, on the screen where somebody confirms it into a figure the alert engine
        quotes in dollars.
      </p>
    );
  }

  return (
    <>
      <Form action={action} state={state} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="showId" value={showId} />
        <input
          type="file"
          name="manual"
          accept="application/pdf"
          required
          className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-panel file:px-3 file:py-1.5 file:text-sm file:text-text"
        />
        <Submit pending={pending} busy="Reading…">Read it</Submit>
      </Form>

      <p className="mt-2 text-xs text-text-muted">
        The pages are read here and only their <em>text</em> is sent to the model, so every
        date it proposes arrives with a page number and a quote that has already been checked
        against that page. A quote that is not there never becomes a row.
      </p>

      <Message state={state} />
      {state.report ? <ExtractionResult report={state.report} /> : null}
    </>
  );
}

function ExtractionResult({ report }: { report: ExtractionReport }) {
  const { plan, coverage } = report;

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{report.filename}</span>
        <span className="text-text-muted">
          {report.pageCount} pages · read with {report.model}
        </span>
        <Badge tone="neutral">{plan.considered} proposed</Badge>
        <Badge tone="good">{plan.accepted.length} added</Badge>
        {plan.rejected.length ? <Badge tone="warn">{plan.rejected.length} refused</Badge> : null}
        {plan.duplicates.length ? (
          <Badge tone="neutral">{plan.duplicates.length} already read</Badge>
        ) : null}
      </div>

      {report.truncated ? (
        <p className="rounded-md border border-border bg-panel p-3 text-sm">
          <strong>This reading is incomplete.</strong> The model ran out of room before it
          finished the document, so what is below is a prefix of the manual rather than the
          manual. A half-read manual reports fewer deadlines with exactly the confidence of a
          complete one, which is why this says so rather than showing you a number.
        </p>
      ) : null}

      {report.unreadablePages.length ? (
        <p className="text-sm text-text-muted">
          {report.unreadablePages.length} page(s) carried no text and were not read:{' '}
          {report.unreadablePages.join(', ')}. That is not the same as having no deadlines on
          them — a scanned page is a page nobody has read.
        </p>
      ) : null}

      {plan.rejected.length ? (
        <div>
          <h4 className="text-sm font-medium">What it refused, and why</h4>
          <ul className="mt-1 space-y-1 text-xs text-text-muted">
            {plan.rejected.map((r, i) => (
              <li key={i}>
                <span className="text-text">p{r.candidate.page}</span> {r.candidate.title || '—'}{' '}
                <em>{r.reason.replace(/_/g, ' ')}</em> — {r.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h4 className="text-sm font-medium">
          Dates in this manual that nothing claimed ({coverage.unclaimed.length} of{' '}
          {coverage.mentions.length})
        </h4>
        <p className="mt-1 text-xs text-text-muted">
          This list is produced by a deliberately stupid search for anything date-shaped, which
          knows nothing about what was extracted. Most lines on it are not deadlines — show
          dates, footers, revision stamps. It is here because a deadline that was missed is the
          one failure nothing else in this feature can see, and reading the list is the only
          way to find it.
        </p>
        {coverage.unclaimed.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            Every date-shaped string in the document was accounted for.
          </p>
        ) : (
          <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto text-xs">
            {coverage.unclaimed.map((m, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-10 shrink-0 text-text-muted">p{m.page}</span>
                <span className="w-40 shrink-0 font-medium">{m.text}</span>
                <span className="text-text-muted">{m.line}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Every reading of a manual for this show. Append-only, newest first. */
export function ExtractionHistory({ runs }: { runs: ExtractionRun[] }) {
  if (!runs.length) return null;
  return (
    <div className="mt-4 border-t border-border pt-4">
      <h4 className="text-sm font-medium">Readings</h4>
      <ul className="mt-1 space-y-1 text-xs text-text-muted">
        {runs.map((r) => (
          <li key={r.id}>
            <span className="text-text">{r.filename}</span> — {r.pageCount} pages, {r.model}:{' '}
            {r.proposed} proposed, {r.accepted} added, {r.rejected} refused, {r.duplicates}{' '}
            already read
            {r.truncated ? ' · incomplete' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
