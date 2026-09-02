import { extractText, getDocumentProxy } from 'unpdf';

/**
 * The only file in this product that touches a PDF.
 *
 * It reads a document into numbered pages of plain text and decides nothing
 * else. That narrowness is the whole design, and it is worth stating why before
 * anybody widens it.
 *
 * **§5a's rule is that a human confirms every extracted deadline before it is
 * quoted in dollars. A person can only confirm against something.** The obvious
 * build sends the PDF straight to the model — it sees tables, it sees layout, it
 * reports "page 14 says the advance order deadline is February 3". But that
 * citation is model output. A hallucinated page-and-quote reads exactly like a
 * real one, the confirm screen renders it identically, and somebody confirms
 * against it — which *launders* a guess into a figure the alert engine will quote
 * as established. That is the failure `store.ts`'s "moving a confirmed date
 * withdraws the confirmation" exists to prevent, arriving through the front door.
 *
 * So the text is extracted **here**, on our side, and the model is only ever sent
 * what this file produced. Every candidate it returns must carry a verbatim
 * snippet and a page number, and `anchor.ts` checks that the snippet actually
 * occurs on that page in the text below. A snippet that does not is rejected
 * before a person ever sees it. The model cannot pass that check by being
 * confident.
 *
 * What this costs is real and is named rather than hidden. A table is flattened
 * into lines, so a deadline living in a grid arrives with its columns run
 * together. And a scanned page carries **no text at all** — `unpdf` will return
 * an empty string for it, and the honest report is *this page could not be read*
 * rather than a guess about what was on it. `PageText.empty` carries that
 * distinction up so the extraction run can say how much of the document it never
 * saw. A document that is entirely empty is a scan, and this refuses it rather
 * than handing the model nothing and reporting that nothing was found.
 *
 * On the dependency: `unpdf` is MIT with zero runtime dependencies. `pdf-parse`
 * was the other candidate and pulls `@napi-rs/canvas`, a native binding — §9
 * requires `pnpm db:reset && pnpm test` to work on a clean clone, and a
 * platform-specific build step is how that stops being true on somebody else's
 * machine. SCOPE.md §5a, "Two risks settled before step 22 was written".
 */

export class ManualReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualReadError';
  }
}

export type PageText = {
  /** 1-indexed, as a person reading the PDF counts. Never 0-indexed anywhere. */
  page: number;
  text: string;
  /**
   * True when the page yielded no extractable text. Almost always a scan or a
   * page that is entirely an image. Kept as its own fact because "we read this
   * page and it held no deadlines" and "we could not read this page" are
   * different things to tell somebody, and only one of them is a finding.
   */
  empty: boolean;
};

export type ManualDocument = {
  pages: PageText[];
  pageCount: number;
  /** Pages that carried no text. The extraction run reports these by number. */
  unreadablePages: number[];
};

/**
 * Collapse runs of whitespace without joining separate lines into one.
 *
 * A PDF's text layer arrives with the spacing the typesetter left behind, and
 * two extractions of the same page can differ in it. Every comparison in this
 * feature — the anchor check, the coverage sweep — normalizes through this one
 * function so they cannot disagree about what "the same text" means.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Non-breaking and thin spaces are common in typeset PDFs and are invisible
    // in every error message a person would read while wondering why a snippet
    // did not match.
    .replace(/[    ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readManual(bytes: Uint8Array): Promise<ManualDocument> {
  let raw: string[];
  let total: number;
  try {
    const doc = await getDocumentProxy(bytes);
    const result = await extractText(doc, { mergePages: false });
    raw = result.text;
    total = result.totalPages;
  } catch (err) {
    // A password-protected or corrupt file lands here. Naming the file's own
    // failure beats "extraction found no deadlines", which is what a caught-and-
    // ignored error would have produced — the silent miss this feature exists to
    // prevent, manufactured by our own error handling.
    throw new ManualReadError(
      `This PDF could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        'Nothing was extracted from it, which is deliberately not the same answer as ' +
        'finding no deadlines in it.',
    );
  }

  const pages: PageText[] = raw.map((text, i) => {
    const normalized = normalizeWhitespace(text);
    return { page: i + 1, text: normalized, empty: normalized.length === 0 };
  });

  const unreadablePages = pages.filter((p) => p.empty).map((p) => p.page);

  if (unreadablePages.length === pages.length) {
    throw new ManualReadError(
      `All ${pages.length} pages of this PDF carry no text layer, which almost always means ` +
        'it is a scan. Nothing here reads an image, and reporting "no deadlines found" for a ' +
        'document nobody could read would be the silent miss this feature exists to prevent.',
    );
  }

  return { pages, pageCount: total, unreadablePages };
}

/**
 * The pages as the model receives them: numbered, and nothing else added.
 *
 * The page markers are the model's only way to cite, and `anchor.ts` checks the
 * citation against this same array, so the numbering here is load-bearing rather
 * than cosmetic. Empty pages are included **as empty**, so a model asked about a
 * 40-page document is never quietly handed 31 pages and left to number them
 * itself.
 */
export function renderForModel(pages: PageText[]): string {
  return pages
    .map((p) => `--- page ${p.page} ---\n${p.empty ? '(no text on this page)' : p.text}`)
    .join('\n\n');
}
