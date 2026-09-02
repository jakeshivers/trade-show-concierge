import {
  BASIS_LABEL,
  type LawfulBasis,
  type Marketability,
  type RetentionStanding,
} from '@/lib/leads/consent';
import type { CoverageStanding, LeadCoverage } from '@/lib/leads/coverage';
import { names, plural } from '../_components/text';
import { Badge, type Tone } from '../_components/ui';

/**
 * The lead vocabulary both lead screens render through — the portfolio and the
 * show's own tab.
 *
 * `cost/_present.tsx`'s reason, on the return side of the same equation. The
 * thing the two screens must not disagree about is the *word in front of the
 * number*: a count is "at least" whenever anybody on the booth recorded nothing,
 * and a screen quietly saying "34 leads" undoes §8c's entire mitigation, which
 * is that a thin number is visibly thin. So the headline sentence is computed
 * once, in `coverage.ts`, and both screens print it.
 */

export const COVERAGE_TONE: Record<CoverageStanding, Tone> = {
  sound: 'good',
  partial: 'warn',
  none: 'bad',
  unknown: 'warn',
  not_yet: 'neutral',
};

/*
 * What the badge says, in words somebody who has not read `coverage.ts` can act
 * on. `partial` used to read **"a floor"** — a term of art from the docs, sat
 * next to a headline that already says "At least 7, from 2 of 4 people on the
 * booth". It named the *shape* of the number to a reader who wanted to know what
 * was wrong with it. "Undercounted" is the same fact and is a sentence: the real
 * number is higher, and two people can tell you by how much. `UI-REWORK.md` §13's
 * rule — a doc comment explains the design, page copy explains the act.
 */
export const COVERAGE_LABEL: Record<CoverageStanding, string> = {
  sound: 'complete count',
  partial: 'undercounted',
  none: 'nothing recorded',
  unknown: 'no booth roster',
  not_yet: 'not open yet',
};

export const BASIS_TONE: Record<LawfulBasis, Tone> = {
  consent: 'good',
  legitimate_interest: 'info',
  unknown: 'warn',
};

const RETENTION_TONE: Record<RetentionStanding, Tone> = {
  live: 'neutral',
  due_soon: 'warn',
  overdue: 'bad',
  erased: 'neutral',
};

const RETENTION_LABEL: Record<RetentionStanding, string> = {
  live: '',
  due_soon: 'erase soon',
  overdue: 'past its erasure date',
  erased: 'erased',
};

/** The one sentence, and the coverage badge beside it. Never a bare number. */
export function CoverageHeadline({ coverage }: { coverage: LeadCoverage }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="text-lg font-semibold tracking-tight">{coverage.headline}</span>
      <Badge tone={COVERAGE_TONE[coverage.standing]}>
        {COVERAGE_LABEL[coverage.standing]}
      </Badge>
    </div>
  );
}

export function BasisBadge({ basis }: { basis: LawfulBasis }) {
  return <Badge tone={BASIS_TONE[basis]}>{BASIS_LABEL[basis]}</Badge>;
}

export function RetentionBadge({ standing }: { standing: RetentionStanding }) {
  if (standing === 'live') return null;
  return <Badge tone={RETENTION_TONE[standing]}>{RETENTION_LABEL[standing]}</Badge>;
}

/**
 * Whether this row may leave the building, and why not.
 *
 * On the screen rather than at the point of export, because the moment somebody
 * can still fix it is the moment they are looking at the lead — and by the time
 * §19's exporter asks, the person who stood at the booth and knows what was said
 * has gone home. The reason and the fix are both shown: "no lawful basis" is a
 * verdict, and "record what the person was told" is a thing to do.
 */
export function OutboundBadge({ outbound }: { outbound: Marketability }) {
  if (outbound.usable) return <Badge tone="good">ok for marketing</Badge>;
  return (
    <>
      <Badge tone="warn">do not use for marketing</Badge>
      <div className="mt-0.5 text-xs text-text-muted">{outbound.reason}</div>
      {outbound.fix && <div className="text-xs text-text-muted">{outbound.fix}</div>}
    </>
  );
}

/**
 * What is wrong with a show's leads, under the headline, or nothing.
 *
 * Every line here is read by somebody deciding what to do next, so every line
 * says what is true **and what fixing it looks like**. They used to be written
 * in the codebase's own voice — "this is the number a rep can still change while
 * they are standing there" is a sentence from `SCOPE.md` §8c explaining *why the
 * feature exists*, which is not the same thing as telling a show lead to go and
 * ask two colleagues to type their leads in. The `lead(s)` and `row(s)` were the
 * tell: nobody had read them as sentences. `UI-REWORK.md` §13.
 */
export function CoverageNotes({ coverage }: { coverage: LeadCoverage }) {
  const notes: string[] = [];
  if (coverage.standing === 'partial' || coverage.standing === 'none') {
    if (coverage.silent.length > 0) {
      notes.push(
        `${names(coverage.silent)} ${coverage.silent.length === 1 ? 'has' : 'have'} not entered ` +
          'any leads. ' +
          (coverage.hasClosed
            ? 'The show is over, so the real number is higher than this and there is no longer ' +
              'a way to find out by how much. Worth knowing before this show is compared with ' +
              'another one.'
            : 'Asking them to add what they have is the quickest way to make this number right.'),
      );
    }
  }
  if (coverage.standing === 'unknown') {
    notes.push(
      'Nobody is scheduled on a booth shift for this show, so there is no way to tell whether ' +
        'this is everything. Add shifts on the Team tab and the count starts checking itself.',
    );
  }
  if (coverage.duplicateCount > 0) {
    notes.push(
      `${plural(coverage.duplicateCount, 'lead looks', 'leads look')} like the same person ` +
        `captured twice, so ${coverage.duplicateCount === 1 ? 'it is' : 'they are'} left out ` +
        'of the count. Counting them would make the show look cheaper per lead than it was.',
    );
  }
  if (coverage.basis.unknown > 0) {
    notes.push(
      `${plural(coverage.basis.unknown, 'lead has', 'leads have')} no record of what the person ` +
        'was told about being contacted. You can still follow up on the conversation they ' +
        `started, but ${coverage.basis.unknown === 1 ? 'it will' : 'they will'} not be sent to ` +
        'marketing or a CRM. Open the lead to record it.',
    );
  }
  if (coverage.retentionOverdue > 0) {
    notes.push(
      `${plural(coverage.retentionOverdue, 'lead still holds', 'leads still hold')} personal ` +
        'details past the date we said we would erase them. The nightly clean-up erases them ' +
        '— check the Alerts page if it has not been running.',
    );
  }
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-text-muted">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
