import { describe, it, expect } from 'vitest';
import type { DeadlineCandidate } from '@/lib/integrations/extract/types';
import { verifyAnchor, MIN_SNIPPET } from './anchor';
import { amountAppearsIn, planCandidates, ASSUMED_TIME } from './candidates';
import { findDateMentions, reportCoverage } from './coverage';
import { buildPdf, SYNTHETIC_MANUAL, SYNTHETIC_MANUAL_PAGES } from './fixtures';
import { normalizeWhitespace, readManual, renderForModel, ManualReadError } from './pdf';

/**
 * The half of step 22 that is verifiable without a real manual.
 *
 * `fixtures.ts` says what this suite cannot do — recall against an unseen layout
 * — and `pnpm manual:probe` is the thing that measures it. Everything below is
 * about the checks that make an extracted row safe to *confirm*, which is where
 * the money is.
 */

const OPENS = '2027-03-15';

async function pages() {
  return (await readManual(SYNTHETIC_MANUAL())).pages;
}

function candidate(over: Partial<DeadlineCandidate> = {}): DeadlineCandidate {
  return {
    title: 'Advance order discount deadline',
    kind: 'advance_order',
    dueDate: '2027-02-03',
    dueTime: '17:00',
    penaltyEstimate: null,
    penaltyNote: null,
    page: 1,
    snippet: 'Advance order discount deadline: February 3, 2027',
    ...over,
  };
}

describe('reading a PDF', () => {
  it('numbers pages the way a person reading the document does', async () => {
    const doc = await readManual(SYNTHETIC_MANUAL());
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    expect(doc.pages[0].text).toContain('EXHIBITOR SERVICE MANUAL');
    expect(doc.pages[3].text).toContain('badge registration');
  });

  it('refuses a document with no text layer rather than reporting no deadlines', async () => {
    // A scan. `unpdf` returns empty strings, and the tempting behaviour is to
    // carry on and find nothing — which is the silent miss §5a exists to
    // prevent, manufactured by our own error handling.
    const blank = buildPdf([[], []]);
    await expect(readManual(blank)).rejects.toBeInstanceOf(ManualReadError);
  });

  it('names an unreadable file instead of extracting nothing from it', async () => {
    await expect(readManual(new TextEncoder().encode('not a pdf'))).rejects.toBeInstanceOf(
      ManualReadError,
    );
  });

  it('gives the model page markers, including for pages it could not read', () => {
    const rendered = renderForModel([
      { page: 1, text: 'Deadline: February 3', empty: false },
      { page: 2, text: '', empty: true },
    ]);
    expect(rendered).toContain('--- page 1 ---');
    // A 40-page document must never arrive as 31 pages for the model to number
    // itself, or every citation past the first gap is off by the gap.
    expect(rendered).toContain('--- page 2 ---');
    expect(rendered).toContain('(no text on this page)');
  });

  it('normalizes whitespace without joining separate lines', () => {
    expect(normalizeWhitespace('a   b\n\n\n\nc  ')).toBe('a b\n\nc');
  });
});

describe('the anchor check', () => {
  it('accepts a snippet that is on the page it cites', async () => {
    const v = verifyAnchor(await pages(), 1, 'Advance order discount deadline: February 3, 2027');
    expect(v.ok).toBe(true);
  });

  it('rejects a snippet that is nowhere in the document', async () => {
    // The failure this whole feature is built around: a plausible sentence with a
    // moved number. It reads exactly like a real citation on the confirm screen.
    const v = verifyAnchor(await pages(), 1, 'Advance order discount deadline: February 9, 2027');
    expect(v).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects a real snippet cited on the wrong page, and says which', async () => {
    const v = verifyAnchor(await pages(), 1, 'Rigging labor must be ordered by January 27, 2027.');
    expect(v).toMatchObject({ ok: false, reason: 'wrong_page' });
    if (!v.ok) expect(v.detail).toContain('page 3');
  });

  it('rejects a fragment too short to be evidence', async () => {
    const v = verifyAnchor(await pages(), 1, 'Feb 3');
    expect(v).toMatchObject({ ok: false, reason: 'too_short' });
    expect(MIN_SNIPPET).toBeGreaterThan('Feb 3'.length);
  });

  it('rejects a page the document does not have', async () => {
    const v = verifyAnchor(await pages(), 99, 'Advance order discount deadline: February 3, 2027');
    expect(v).toMatchObject({ ok: false, reason: 'no_such_page' });
  });
});

describe('planning candidates', () => {
  it('accounts for every candidate it was given', async () => {
    const p = await pages();
    const plan = planCandidates(
      p,
      [
        candidate(),
        candidate({ dueDate: 'the fourth' }),
        candidate({ snippet: 'A sentence that is not in this manual at all' }),
        candidate(),
      ],
      { opensOn: OPENS },
    );
    // leads/parse.ts's rule: accepted + rejected + duplicate is the row count.
    expect(plan.considered).toBe(4);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected).toHaveLength(2);
    expect(plan.duplicates).toHaveLength(1);
  });

  it('drops a penalty amount that is not in the evidence, and keeps the words', async () => {
    // The sharpest refusal here. The anchor proves the *deadline* was read off
    // the page and proves nothing about a figure quoted beside it — and the
    // figure is the half that becomes a bill.
    const plan = planCandidates(
      await pages(),
      [
        candidate({
          penaltyEstimate: '3125.00',
          penaltyNote: 'Orders after this date are surcharged 30%.',
        }),
      ],
      { opensOn: OPENS },
    );
    expect(plan.accepted[0].penaltyEstimate).toBeNull();
    expect(plan.accepted[0].droppedPenalty).toBe('3125.00');
    expect(plan.accepted[0].penaltyNote).toContain('30%');
  });

  it('keeps a penalty amount that is printed in the snippet', async () => {
    const plan = planCandidates(
      await pages(),
      [
        candidate({
          page: 2,
          snippet: 'A $450.00 late processing fee applies to on-site electrical orders.',
          penaltyEstimate: '450.00',
        }),
      ],
      { opensOn: OPENS },
    );
    expect(plan.accepted[0].penaltyEstimate).toBe('450.00');
    expect(plan.accepted[0].droppedPenalty).toBeNull();
  });

  it('compares an amount on its digits, so typography does not drop a real figure', () => {
    expect(amountAppearsIn('3125.00', 'a $3,125 surcharge applies')).toBe(true);
    expect(amountAppearsIn('450.00', 'A $450.00 late processing fee')).toBe(true);
    expect(amountAppearsIn('3125.00', 'a 30% surcharge applies')).toBe(false);
  });

  it('flags an assumed time instead of quietly filing end of day', async () => {
    const plan = planCandidates(await pages(), [candidate({ dueTime: null })], { opensOn: OPENS });
    expect(plan.accepted[0].dueTime).toBe(ASSUMED_TIME);
    expect(plan.accepted[0].timeAssumed).toBe(true);
  });

  it('does not flag a time the manual actually printed', async () => {
    const plan = planCandidates(
      await pages(),
      [
        candidate({
          page: 1,
          snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027',
          dueDate: '2027-01-20',
          dueTime: '16:00',
        }),
      ],
      { opensOn: OPENS },
    );
    expect(plan.accepted[0].timeAssumed).toBe(false);
  });

  it('corrects an unknown kind rather than discarding a real date over a label', async () => {
    const plan = planCandidates(await pages(), [candidate({ kind: 'carpet_and_drape' })], {
      opensOn: OPENS,
    });
    expect(plan.accepted[0].kind).toBe('other');
    expect(plan.accepted[0].kindCorrectedFrom).toBe('carpet_and_drape');
  });

  it('rejects a copyright year that a citation happens to verify', async () => {
    // The snippet is genuinely on page 1, so the anchor passes. It is 1998.
    const plan = planCandidates(
      await pages(),
      [
        candidate({
          title: 'Copyright',
          dueDate: '1998-01-01',
          snippet: 'Document revised 03/2019. (c) 1998 Acme Convention Services.',
        }),
      ],
      { opensOn: OPENS },
    );
    expect(plan.rejected[0].reason).toBe('implausible_date');
  });

  it('treats a cutoff printed twice as one deadline and keeps the second in the count', async () => {
    const p = await pages();
    const plan = planCandidates(
      p,
      [
        candidate({
          title: 'Advance warehouse receiving',
          dueDate: '2027-01-20',
          page: 1,
          snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027',
        }),
        candidate({
          title: 'Advance warehouse receiving',
          dueDate: '2027-01-20',
          page: 3,
          snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027.',
        }),
      ],
      { opensOn: OPENS },
    );
    expect(plan.accepted).toHaveLength(1);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].firstSeenOnPage).toBe(1);
  });
});

describe('the coverage sweep', () => {
  it('finds date-shaped text the extractor knows nothing about', async () => {
    const mentions = findDateMentions(await pages());
    const texts = mentions.map((m) => m.text);
    expect(texts).toContain('February 3, 2027');
    expect(texts).toContain('January 27, 2027');
    // The footer is date-shaped and is not a deadline. The sweep is supposed to
    // report it — triage is the reader's job, and a sweep that pre-judged would
    // be as opinionated as the thing it audits.
    expect(texts).toContain('03/2019');
  });

  it('carries the whole line, so a mention can be triaged without the PDF', async () => {
    const mentions = findDateMentions(await pages());
    const rigging = mentions.find((m) => m.text === 'January 27, 2027');
    expect(rigging?.line).toContain('Rigging labor');
  });

  it('reports a real deadline that nothing claimed', async () => {
    const p = await pages();
    // The extractor found the advance order deadline and missed rigging labor —
    // the silent failure. Nothing in `anchor.ts` can see it; this is what does.
    const report = reportCoverage(
      p,
      [{ page: 1, snippet: 'Advance order discount deadline: February 3, 2027' }],
      [],
    );
    expect(report.claimed.map((m) => m.text)).toContain('February 3, 2027');
    expect(report.unclaimed.map((m) => m.text)).toContain('January 27, 2027');
    expect(report.claimed.length + report.unclaimed.length).toBe(report.mentions.length);
  });

  it('counts a deduplicated reading as read, which the probe caught and no test did', async () => {
    const p = await pages();
    // The same cutoff is on pages 1 and 3; `candidates.ts` keeps one row. Scoring
    // only survivors put every repeated deadline on the unclaimed list, and an
    // arbiter that cries wolf on a well-organised manual is one nobody reads.
    const report = reportCoverage(
      p,
      [
        { page: 1, snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027' },
        { page: 3, snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027.' },
      ],
      [],
    );
    expect(report.unclaimed.filter((m) => m.text.includes('January 20'))).toHaveLength(0);
  });

  it('does not let a claim on one page excuse the same date on another', async () => {
    const p = await pages();
    const report = reportCoverage(
      p,
      [{ page: 1, snippet: 'Advance warehouse receiving closes 4:00 PM on January 20, 2027' }],
      [],
    );
    // The identical cutoff is printed again on page 3. Two printings are two
    // chances to be read and two chances to be missed.
    const onThree = report.unclaimed.filter((m) => m.page === 3 && m.text.includes('January 20'));
    expect(onThree).toHaveLength(1);
  });
});

describe('the synthetic corpus itself', () => {
  it('is what it says it is: written by us, and proving only that we agree', () => {
    // Guards the header's claim rather than the code — if somebody adds a page,
    // the fixture's own description of its coverage has to keep up.
    expect(SYNTHETIC_MANUAL_PAGES).toHaveLength(4);
  });
});
