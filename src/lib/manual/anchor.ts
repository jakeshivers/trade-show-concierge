import { normalizeWhitespace, type PageText } from './pdf';

/**
 * Does this candidate's quote actually appear where it says it does?
 *
 * This is the file that makes the whole feature safe to confirm, so the argument
 * is worth stating rather than assuming.
 *
 * Every other `recorded`/replay decision in this codebase obeys one rule:
 * describe a *shape*, assert nothing about this workspace. Extraction has no such
 * move available — its entire output is a set of assertions about one specific
 * document, landing on a screen where a person will tick them and thereby promote
 * them into figures the §5a engine quotes in dollars. There is no banner that
 * discharges that. §5j's ROI correction reached the same place: "a reader who has
 * learned to skim a banner has not learned to skim a multiple."
 *
 * What replaces the banner is a check the model cannot pass by being confident.
 * We hold the page text (`pdf.ts`), so a claim of the form *"page 14 says: the
 * advance order deadline is February 3"* is decidable: either that string occurs
 * on page 14 or it does not. One that does not is **dropped**, with the reason
 * recorded, before it reaches anybody.
 *
 * Two decisions inside that are not obvious:
 *
 * 1. **The match is on normalized whitespace and nothing looser.** Case is
 *    preserved and characters are not transposed. A fuzzy match would let a
 *    snippet that is *nearly* on the page through, and "nearly" is where an
 *    invented date lives — the model reproduces the surrounding sentence
 *    correctly and moves the number. `targets.ts` refused fuzzy matching for a
 *    kindred reason and it is sharper here: there the cost was telling a stranger
 *    the wrong thing about their company, here it is a bill.
 * 2. **A snippet found on a *different* page is still a failure.** It is tempting
 *    to accept it and correct the page number, since the text is real. But the
 *    page is half of what a person checks against — a confirm screen that says
 *    "page 14" and means page 41 has already stopped being verifiable, and a
 *    model that got the page wrong is a model whose reading of the row is in
 *    doubt. The finding is reported as `wrong_page` rather than `not_found`,
 *    because those two say different things about what went wrong.
 */

export type AnchorVerdict =
  | { ok: true; page: number; snippet: string }
  | { ok: false; reason: 'not_found' | 'wrong_page' | 'too_short' | 'no_such_page'; detail: string };

/**
 * Short enough to be a real line from a manual, long enough that matching it is
 * evidence. Ten characters is roughly "Feb 3, 2027" — below that a snippet can
 * match by coincidence on a page full of dates, which would make the check
 * *look* like it passed on precisely the documents where it matters most.
 */
export const MIN_SNIPPET = 12;

export function verifyAnchor(
  pages: PageText[],
  claimedPage: number,
  claimedSnippet: string,
): AnchorVerdict {
  const snippet = normalizeWhitespace(claimedSnippet);

  if (snippet.length < MIN_SNIPPET) {
    return {
      ok: false,
      reason: 'too_short',
      detail:
        `"${snippet}" is too short to be evidence — at least ${MIN_SNIPPET} characters. A ` +
        'fragment can match by coincidence on a page full of dates, which makes the check ' +
        'look satisfied exactly where it matters most.',
    };
  }

  const page = pages.find((p) => p.page === claimedPage);
  if (!page) {
    return {
      ok: false,
      reason: 'no_such_page',
      detail: `Cited page ${claimedPage}; this document has ${pages.length} pages.`,
    };
  }

  if (page.text.includes(snippet)) return { ok: true, page: claimedPage, snippet };

  const elsewhere = pages.find((p) => p.page !== claimedPage && p.text.includes(snippet));
  if (elsewhere) {
    return {
      ok: false,
      reason: 'wrong_page',
      detail:
        `Cited page ${claimedPage}, but this text is on page ${elsewhere.page}. The page is ` +
        'half of what a person confirms against, so a citation that points at the wrong one ' +
        'is not verifiable even though the words are real.',
    };
  }

  return {
    ok: false,
    reason: 'not_found',
    detail:
      `This text does not occur anywhere in the document. Nothing was extracted from it, ` +
      'so it was not read off the manual.',
  };
}
