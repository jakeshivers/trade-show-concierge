import { BASIS_LABEL, type LawfulBasis, type RetentionStanding } from '@/lib/leads/consent';
import type { CoverageStanding, LeadCoverage } from '@/lib/leads/coverage';
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

export const COVERAGE_LABEL: Record<CoverageStanding, string> = {
  sound: 'everyone on the booth',
  partial: 'a floor',
  none: 'nothing recorded',
  unknown: 'coverage unknown',
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

/** What is wrong with a show's leads, under the headline, or nothing. */
export function CoverageNotes({ coverage }: { coverage: LeadCoverage }) {
  const notes: string[] = [];
  if (coverage.standing === 'partial' || coverage.standing === 'none') {
    if (coverage.silent.length > 0) {
      notes.push(
        `Nothing from ${coverage.silent.map((s) => s.fullName).join(', ')}. ` +
          'This is the number a rep can still change while they are standing there.',
      );
    }
  }
  if (coverage.standing === 'unknown') {
    notes.push(
      'Nobody is rostered on a booth shift for this show, so there is nothing to measure the count against. It is not zero coverage; it is unmeasured.',
    );
  }
  if (coverage.duplicateCount > 0) {
    notes.push(
      `${coverage.duplicateCount} row(s) duplicate another lead and are held out of the count — duplicates make a show look cheaper per lead than it was.`,
    );
  }
  if (coverage.basis.unknown > 0) {
    notes.push(
      `${coverage.basis.unknown} lead(s) carry no lawful basis. They are lawfully held for the follow-up the person started and are withheld from anything outbound.`,
    );
  }
  if (coverage.retentionOverdue > 0) {
    notes.push(
      `${coverage.retentionOverdue} lead(s) still hold personal data past the date we said we would erase it.`,
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
