/**
 * Document extraction, behind an interface. The seventh integration, and the
 * second to use a language model — but a different job from the assistant's, and
 * deliberately a different interface rather than a widened one.
 *
 * `llm/types.ts` performs one exchange with a transcript and a tool list. This
 * performs one exchange with a document and **no tools at all**. Folding them
 * together would put a tool list within reach of a code path whose input is an
 * uploaded file from outside the company; the way not to have that problem is to
 * be structurally unable to, which is the same argument `crm/types.ts` makes for
 * having exactly one write method.
 *
 * ## What it may and may not return
 *
 * It returns **candidates** — proposals, raw and unvalidated. It does not create
 * deadlines, does not resolve dates into instants, does not decide what a penalty
 * is worth, and cannot write anything. `manual/candidates.ts` validates and
 * `manual/store.ts` writes, both outside any adapter, for the reason §6a gives
 * about the booking agent: the model proposes, it never authorizes.
 *
 * Every candidate must carry a page and a verbatim snippet, and that is a
 * requirement of *this interface* rather than of one provider, because it is what
 * makes the output checkable at all (`manual/anchor.ts`).
 *
 * ## There is deliberately no `recorded` provider here
 *
 * Five integrations in this codebase have one, under a single rule: replay a
 * *shape*, assert nothing about this workspace. Extraction has no shape
 * separable from its claim. A canned candidate is the sentence "this manual says
 * the advance order deadline is February 3" about a document the fixture has
 * never seen, arriving on the screen where somebody confirms it into a quoted
 * penalty — §8a's fabricated bill wearing the costume of a test double. It is
 * step 21's argument about a replayed *delivery*, one layer along: there is no
 * honest fixture of an assertion.
 *
 * So `provider.ts` has no fallback and no zero-key mode: Anthropic with a key,
 * otherwise an error naming the variable. The unit suite tests the pure halves —
 * the page reader, the anchor verifier, the candidate planner, the coverage
 * sweep — against a mock extractor and a synthetic document, and `pnpm test`
 * still needs no keys.
 */

/** One proposed deadline, exactly as the model offered it. Nothing is trusted. */
export type DeadlineCandidate = {
  title: string;
  /** The model's guess at `DeadlineKind`. Validated, never trusted. */
  kind: string;
  /** `YYYY-MM-DD` as printed in the manual, read in the show's own zone. */
  dueDate: string;
  /**
   * `HH:MM`, 24-hour, in the show's zone. Null when the manual prints only a
   * date — and null is a real answer here rather than a default, because §5a's
   * whole point is that a 4:00pm warehouse cutoff rounded to 5pm is a drayage
   * penalty. `candidates.ts` refuses to invent one.
   */
  dueTime: string | null;
  /** A decimal string as printed. Never a number — SCOPE.md's money rule. */
  penaltyEstimate: string | null;
  /** What the manual says about the penalty, in its own words. */
  penaltyNote: string | null;
  /** 1-indexed, as a person reading the PDF counts. */
  page: number;
  /** Verbatim from the page. The claim, and the thing that makes it checkable. */
  snippet: string;
};

export type ExtractionRequest = {
  /** Numbered page text, produced by `manual/pdf.ts`. Never the PDF itself. */
  document: string;
  /** The show's name and dates, so a bare "the 4th" can be placed in a year. */
  context: {
    showName: string;
    opensOn: string;
    closesOn: string;
    timezone: string;
  };
};

export type ExtractionReply = {
  provider: string;
  model: string;
  candidates: DeadlineCandidate[];
  /**
   * True when the model ran out of output room. The caller must not present a
   * truncated extraction as a complete one — a manual read half way through
   * reports fewer deadlines with exactly the confidence of a full read, which is
   * the silent miss this feature exists to prevent.
   */
  truncated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
};

export interface DeadlineExtractor {
  readonly name: string;
  isConfigured(): boolean;
  extract(request: ExtractionRequest): Promise<ExtractionReply>;
}

export class ExtractorNotConfiguredError extends Error {
  constructor(provider: string, envVars: string[]) {
    super(
      `${provider} is not configured. Reading a service manual needs ${envVars.join(', ')}. ` +
        'There is no replayed extractor to fall back to, deliberately: a canned deadline is a ' +
        'claim about a document nothing has read, landing on the screen where somebody ' +
        'confirms it into a quoted penalty.',
    );
    this.name = 'ExtractorNotConfiguredError';
  }
}
