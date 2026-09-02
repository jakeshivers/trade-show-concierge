import { DEADLINE_KINDS, type DeadlineKind } from '@/lib/deadlines/edit';
import type { DeadlineCandidate } from '@/lib/integrations/extract/types';
import { verifyAnchor } from './anchor';
import type { PageText } from './pdf';

/**
 * What survives contact with the document, and why the rest did not.
 *
 * Pure, and the file where step 22's argument lives. Everything a model proposed
 * arrives here and leaves as exactly one of three things — **accepted, rejected,
 * or duplicate — and the three always sum to what came in.** That is
 * `leads/parse.ts`'s rule, inherited on purpose: an extraction that quietly drops
 * a row reports a smaller register with precisely the confidence of a complete
 * one, which is the silent miss §5a exists to prevent, manufactured by our own
 * planner.
 *
 * ## The six refusals
 *
 * 1. **The snippet must occur on the page it cites** (`anchor.ts`). This is the
 *    one that makes confirmation mean anything.
 * 2. **A penalty amount must occur inside the verified snippet, or the number is
 *    dropped and only the words are kept.** This one is not obvious and is the
 *    sharpest thing this file does. The anchor proves the *deadline* was read off
 *    the page; it proves nothing about a figure quoted beside it, so an amount
 *    can be invented while the snippet verifies perfectly. And the amount is the
 *    half that becomes a bill — §5a's whole thesis is that "$2,800 surcharge if
 *    missed" gets acted on where a date does not. So the digits have to be *in
 *    the evidence*. When they are not, `penaltyNote` survives and the figure does
 *    not: "25–40% surcharge" is a true thing the manual said, and a dollar amount
 *    nobody printed is a fabricated bill.
 * 3. **A time of day is never invented.** §5a required a time on every row
 *    because a warehouse closing at 4:00pm rounded to 5pm is a drayage penalty.
 *    That rule was about not *rounding* a printed hour, and it inverts badly here
 *    — most manuals print no hour at all, so a helpful default would file an
 *    assumption in the column the rule exists to protect. An extracted row with
 *    no printed time is created at end of day and **flagged as assumed**, which
 *    is what `store.ts` refuses to confirm until somebody has looked. The row
 *    still alerts, because a date chase is exactly what an unconfirmed deadline
 *    gets anyway.
 * 4. **A wrong kind is corrected, not rejected.** The taxonomy is ours and a
 *    misfiled row is a labelling mistake; discarding a real February cutoff over
 *    it would be trading a date for a category. It lands as `other`, which is a
 *    visible answer.
 * 5. **A date outside a plausible window is rejected**, because a manual is full
 *    of dates that are not deadlines and the ones far from the show are almost
 *    always a copyright line or a "revised 03/2019" footer. The window is wide
 *    and one-sided on purpose — post-show return and reconciliation deadlines are
 *    real.
 * 6. **A repeat is a duplicate rather than a second deadline.** Manuals print the
 *    same cutoff in a summary table and again in the section it belongs to, and
 *    two register rows for one cutoff means two owners, two alert threads and one
 *    of them going quiet when the other is completed. It is kept in the
 *    accounting rather than thrown away, so "the model found 31" and "the
 *    register grew by 24" can be reconciled by reading rather than by guessing.
 */

export type RejectReason =
  | 'no_anchor'
  | 'bad_date'
  | 'implausible_date'
  | 'bad_time'
  | 'no_title';

export type AcceptedCandidate = {
  title: string;
  kind: DeadlineKind;
  dueDate: string;
  dueTime: string;
  /** True when the manual printed no hour and `dueTime` is end-of-day. */
  timeAssumed: boolean;
  penaltyEstimate: string | null;
  penaltyNote: string | null;
  page: number;
  snippet: string;
  /** Set when the model's `kind` was not one of ours and landed as `other`. */
  kindCorrectedFrom: string | null;
  /** Set when an amount was proposed and was not in the evidence. */
  droppedPenalty: string | null;
};

export type RejectedCandidate = {
  candidate: DeadlineCandidate;
  reason: RejectReason;
  detail: string;
};

export type DuplicateCandidate = {
  candidate: DeadlineCandidate;
  /** The page the surviving row was read from. */
  firstSeenOnPage: number;
};

export type CandidatePlan = {
  accepted: AcceptedCandidate[];
  rejected: RejectedCandidate[];
  duplicates: DuplicateCandidate[];
  /** accepted + rejected + duplicates. Always equal to what came in. */
  considered: number;
};

/** End of the local day, used only where the manual printed no time at all. */
export const ASSUMED_TIME = '23:59';

/**
 * How far from the show a date may fall and still be a deadline. Generous
 * backwards — room-block and sponsorship cutoffs land months out — and generous
 * forwards, because return freight and reconciliation deadlines are real.
 */
const MONTHS_BEFORE = 18;
const MONTHS_AFTER = 6;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(iso: string): boolean {
  if (!DATE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

function addMonths(iso: string, months: number): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1 + months, d);
}

/**
 * Is this amount actually in the evidence?
 *
 * Compared on digits only, because a manual prints "$3,125.00" and a model
 * returns "3125.00" and those are the same claim. Anything looser would defeat
 * the check; anything stricter would fail on typography and quietly drop real
 * figures, which is the same silent miss pointing the other way.
 */
export function amountAppearsIn(amount: string, snippet: string): boolean {
  const digits = amount.replace(/[^\d]/g, '').replace(/0+$/, '') || amount.replace(/[^\d]/g, '');
  if (!digits) return false;
  const inSnippet = snippet.replace(/[^\d]/g, '');
  const whole = amount.replace(/[^\d.]/g, '').split('.')[0].replace(/^0+/, '');
  // The whole-dollar digits are what a manual prints; a trailing ".00" the model
  // added is not evidence of anything and its absence is not a fabrication.
  return inSnippet.includes(whole || digits);
}

export function planCandidates(
  pages: PageText[],
  candidates: DeadlineCandidate[],
  show: { opensOn: string },
): CandidatePlan {
  const accepted: AcceptedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const duplicates: DuplicateCandidate[] = [];

  const earliest = addMonths(show.opensOn, -MONTHS_BEFORE);
  const latest = addMonths(show.opensOn, MONTHS_AFTER);
  const seen = new Map<string, number>();

  for (const c of candidates) {
    const title = c.title.trim();
    if (title.length < 3) {
      rejected.push({
        candidate: c,
        reason: 'no_title',
        detail: 'A deadline with no title cannot be owned, chased or confirmed.',
      });
      continue;
    }

    if (!isRealDate(c.dueDate)) {
      rejected.push({
        candidate: c,
        reason: 'bad_date',
        detail: `"${c.dueDate}" is not a date. Nothing here guesses at what was meant.`,
      });
      continue;
    }

    const at = Date.parse(`${c.dueDate}T00:00:00Z`);
    if (at < earliest || at > latest) {
      rejected.push({
        candidate: c,
        reason: 'implausible_date',
        detail:
          `${c.dueDate} is outside ${MONTHS_BEFORE} months before and ${MONTHS_AFTER} months ` +
          `after the show opens on ${show.opensOn}. A manual is full of dates that are not ` +
          'deadlines, and the distant ones are almost always a copyright line or a revision ' +
          'footer.',
      });
      continue;
    }

    if (c.dueTime !== null && !TIME.test(c.dueTime)) {
      rejected.push({
        candidate: c,
        reason: 'bad_time',
        detail:
          `"${c.dueTime}" is not a time of day. An hour on this register is a drayage ` +
          'penalty, so a malformed one is not rounded to something plausible.',
      });
      continue;
    }

    const anchor = verifyAnchor(pages, c.page, c.snippet);
    if (!anchor.ok) {
      rejected.push({ candidate: c, reason: 'no_anchor', detail: anchor.detail });
      continue;
    }

    const key = `${c.dueDate}|${title.toLowerCase()}`;
    const firstSeenOnPage = seen.get(key);
    if (firstSeenOnPage !== undefined) {
      duplicates.push({ candidate: c, firstSeenOnPage });
      continue;
    }
    seen.set(key, c.page);

    const knownKind = DEADLINE_KINDS.includes(c.kind as DeadlineKind);
    const proposedAmount = c.penaltyEstimate?.trim() || null;
    const amountIsEvidenced = proposedAmount !== null && amountAppearsIn(proposedAmount, anchor.snippet);

    accepted.push({
      title,
      kind: knownKind ? (c.kind as DeadlineKind) : 'other',
      dueDate: c.dueDate,
      dueTime: c.dueTime ?? ASSUMED_TIME,
      timeAssumed: c.dueTime === null,
      penaltyEstimate: amountIsEvidenced ? proposedAmount : null,
      penaltyNote: c.penaltyNote?.trim() || null,
      page: anchor.page,
      snippet: anchor.snippet,
      kindCorrectedFrom: knownKind ? null : c.kind || '(blank)',
      droppedPenalty: proposedAmount !== null && !amountIsEvidenced ? proposedAmount : null,
    });
  }

  return {
    accepted,
    rejected,
    duplicates,
    considered: accepted.length + rejected.length + duplicates.length,
  };
}
