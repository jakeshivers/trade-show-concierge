import type { PageText } from './pdf';

/**
 * The arbiter. Deliberately stupid, and that is the entire point.
 *
 * ## What this is for
 *
 * `pnpm duffel:capture` exists because our Duffel fixtures were written from the
 * docs by the same person who wrote the code that reads them — a closed loop that
 * proves internal consistency and structurally cannot catch a wrong field name.
 * Step 22 has the same problem in a different shape, and the analogy had to be
 * corrected before it produced a design.
 *
 * Duffel's unverified thing is a **field name**: a fact about a vendor, knowable
 * only from the vendor, so a live key is the only possible arbiter. This
 * feature's unverified thing is **recall against a layout we have not seen**, and
 * that splits into two failures with opposite properties:
 *
 * - **Fabrication** — a deadline with no basis in the document. `anchor.ts` kills
 *   this with no corpus at all, because we hold the page text and a snippet
 *   either occurs on its page or does not.
 * - **A miss** — a deadline that is in the manual and never becomes a row.
 *   Silent, and the exact outcome §5a exists to prevent. **No synthetic corpus
 *   can catch it**, because the corpus and the prompt are written by the same
 *   person: the prompt gets tuned to the layout it was handed, and a real
 *   manual's layout is the thing nobody in this repo has seen.
 *
 * So the capture-equivalent targets misses, and the arbiter has to be something
 * that was not written to agree with our own model. This is that: a high-recall,
 * low-precision regex sweep for anything date-shaped, with no idea what a
 * deadline is, what the prompt says, or which rows were extracted. It cannot be
 * tuned into agreement because there is nothing in it to tune.
 *
 * ## How to read its output
 *
 * **Most unclaimed mentions are not misses**, and a report that pretended
 * otherwise would be ignored within a week. A manual is full of dates that are
 * not deadlines: the show's own dates, a copyright year, "revised 08/2026" in a
 * footer, a hotel's check-out time. The number that matters is not the count, it
 * is *reading the list* — one line saying `p14: "Rigging orders due January 27"`
 * with nothing claiming it is worth more than every other line on the page.
 *
 * That is why this reports **mentions with their surrounding line** rather than
 * bare dates. A date on its own cannot be triaged; a date in its sentence can be,
 * in about a second, by a person who has never seen this code.
 *
 * The patterns below are tuned for recall and against precision on purpose, and
 * the bare `1/27` shape is the clearest case: it matches "24/7" and every
 * fraction in the document. Tightening it would make the report shorter and would
 * make it capable of missing the one thing it exists to find.
 */

export type DateMention = {
  page: number;
  /** The date-shaped text exactly as it appears, before any interpretation. */
  text: string;
  /** The whole line it sits on, so the mention can be triaged without the PDF. */
  line: string;
};

export type CoverageReport = {
  mentions: DateMention[];
  claimed: DateMention[];
  /** Every date-shaped string no accepted candidate's snippet covers. */
  unclaimed: DateMention[];
  /** Pages with no text layer. Not zero-coverage — no coverage, and different. */
  unreadablePages: number[];
};

const MONTH =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

/**
 * Four shapes, in the order they resolve. Nothing here tries to *parse* a date —
 * interpreting "3/2/2027" needs a locale this file deliberately does not have,
 * and guessing one would make the arbiter as opinionated as the thing it audits.
 * It only has to notice that something date-shaped is present.
 */
const PATTERNS: RegExp[] = [
  // February 3, 2027 · Feb 3 2027 · Feb. 3
  new RegExp(`${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'gi'),
  // 3 February 2027
  new RegExp(`\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+\\d{4})?`, 'gi'),
  // 2027-02-03
  /\d{4}-\d{2}-\d{2}/g,
  // 2/3/2027 · 02-03-27. Three-part first, so it is not split by the two-part
  // patterns below.
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  // 03/2019 — a revision footer, and exactly the shape a reader should see and
  // dismiss in a second.
  /\b\d{1,2}\/\d{4}\b/g,
  // 1/27 — a bare month/day, which manuals really do print for deadlines. It is
  // the noisiest pattern here by a distance: "24/7", "25/40%" and every fraction
  // in the document match it. That is the right trade for an arbiter whose job
  // is recall — a line of noise costs a glance, and the mention it would
  // otherwise miss costs a surcharge. Every mention carries its line precisely so
  // this stays cheap to dismiss.
  /\b\d{1,2}\/\d{1,2}\b/g,
];

function lineContaining(pageText: string, index: number): string {
  const start = pageText.lastIndexOf('\n', index) + 1;
  const end = pageText.indexOf('\n', index);
  return pageText.slice(start, end === -1 ? undefined : end).trim();
}

/** Every date-shaped string in the document, with the line it sits on. */
export function findDateMentions(pages: PageText[]): DateMention[] {
  const out: DateMention[] = [];

  for (const page of pages) {
    if (page.empty) continue;
    // Overlapping matches are collapsed by span rather than by text: "February 3,
    // 2027" is found by the first pattern and "3, 2027"-ish fragments by others,
    // and reporting both would inflate the very number a reader is triaging.
    const taken: [number, number][] = [];

    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of page.text.matchAll(pattern)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        taken.push([start, end]);
        out.push({ page: page.page, text: m[0], line: lineContaining(page.text, start) });
      }
    }
  }

  return out.sort((a, b) => a.page - b.page || a.text.localeCompare(b.text));
}

/**
 * Which mentions did the extractor account for?
 *
 * A mention counts as claimed when some verified snippet **on that same page**
 * contains it. That linkage is honest rather than approximate: a verified snippet
 * is verbatim page text (`anchor.ts` proved it), so containment is a decidable
 * fact about two strings rather than a judgement about whether two dates are "the
 * same one".
 *
 * The page is part of the test on purpose. A snippet on page 9 does not excuse an
 * unclaimed date on page 14, even where the text is identical — a recurring
 * cutoff printed in two places is two chances to be read and two chances to be
 * missed.
 *
 * **A deduplicated candidate counts as read**, and getting that wrong was found
 * by running the probe rather than by writing a test. The question this file asks
 * is "did the extractor *see* this date", not "did a row get created from it" — a
 * manual prints its cutoffs in a summary table and again in the section they
 * belong to, `candidates.ts` correctly collapses the second into a duplicate, and
 * scoring only the surviving row made every repeated cutoff in the document
 * appear on the unclaimed list as a possible miss. A report that cries wolf on
 * every well-organised manual is a report nobody reads, which is the one failure
 * mode an arbiter cannot have. So callers pass what was **read**, accepted and
 * duplicate alike.
 */
export function reportCoverage(
  pages: PageText[],
  /** Every verified anchor the extractor produced — accepted *and* duplicate. */
  read: { page: number; snippet: string }[],
  unreadablePages: number[],
): CoverageReport {
  const mentions = findDateMentions(pages);
  const claimed: DateMention[] = [];
  const unclaimed: DateMention[] = [];

  for (const mention of mentions) {
    const covered = read.some((a) => a.page === mention.page && a.snippet.includes(mention.text));
    (covered ? claimed : unclaimed).push(mention);
  }

  return { mentions, claimed, unclaimed, unreadablePages };
}
