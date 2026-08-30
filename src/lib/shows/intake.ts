/**
 * Show intake — the "should we do this show?" loop, as pure functions.
 *
 * SCOPE.md §5: a proposal becomes a `prospect`, and an admin then commits or
 * declines it. The point is not the status column; it is that **the decline is
 * recorded with its reasoning**. "We passed on Pack Expo because the booth cost
 * doubled and last year sourced $180k" is the sentence that makes next year's
 * calendar a decision instead of a habit — and it is unrecoverable if declining
 * a show means deleting the row.
 */

export type ShowStatus =
  | 'prospect'
  | 'committed'
  | 'planning'
  | 'ready'
  | 'live'
  | 'complete'
  | 'cancelled';

export type IntakeDraft = {
  name: string;
  startsOn: string;
  endsOn: string;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  venueName?: string | null;
  website?: string | null;
  airportCode?: string | null;
  timezone: string;
  budgetCents?: number | null;
  goals?: string | null;
  rationale: string;
};

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeError';
  }
}

/** A rationale short enough to be reflexive is not a rationale. Matches break-glass. */
export const MIN_RATIONALE = 20;

/**
 * Dates stay as `YYYY-MM-DD` strings through validation. Turning them into
 * instants needs the show's zone, and a `new Date('2026-05-04')` here would set
 * the show's start to whatever midnight UTC happens to be locally — the exact
 * mistake `src/lib/datetime/zoned.ts` exists to stop. The store resolves them.
 */
export type ValidatedIntake = IntakeDraft;

export function validateIntake(draft: IntakeDraft): ValidatedIntake {
  const name = draft.name.trim();
  if (name.length < 2) throw new IntakeError('The show needs a name.');

  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(draft.startsOn) || !isDate(draft.endsOn)) {
    throw new IntakeError('Start and end dates are required, as YYYY-MM-DD.');
  }

  const rationale = draft.rationale.trim();
  if (rationale.length < MIN_RATIONALE) {
    throw new IntakeError(
      `Say why this show is worth considering — at least ${MIN_RATIONALE} characters. ` +
        'It is the note the decision gets read against a year from now.',
    );
  }

  const airport = draft.airportCode?.trim().toUpperCase() || null;
  if (airport !== null && !/^[A-Z]{3}$/.test(airport)) {
    throw new IntakeError('Airport code must be a three-letter IATA code, or blank.');
  }

  if (draft.budgetCents != null && (!Number.isInteger(draft.budgetCents) || draft.budgetCents < 0)) {
    throw new IntakeError('Budget must be a whole, non-negative amount.');
  }

  // Dates are resolved against the show's own zone by the caller, which owns the
  // clock; here we only check ordering, which is zone-independent for whole days.
  if (draft.endsOn < draft.startsOn) {
    throw new IntakeError('The show cannot end before it starts.');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone }).format(new Date());
  } catch {
    throw new IntakeError(`"${draft.timezone}" is not a known IANA time zone.`);
  }

  return {
    ...draft,
    name,
    rationale,
    airportCode: airport,
  };
}

export type Decision = 'committed' | 'declined';

/**
 * Only a prospect is decidable.
 *
 * Committing a show that is already in planning is a no-op dressed as a decision,
 * and "declining" a live show is a cancellation — a different act, with sunk cost
 * and refunds attached, which this loop is not. So the guard is narrow on purpose
 * and says which case it is refusing.
 */
export function assertDecidable(status: ShowStatus, decision: Decision): void {
  if (status === 'prospect') return;
  if (status === 'cancelled') {
    throw new IntakeError('This show was already declined.');
  }
  if (decision === 'committed') {
    throw new IntakeError(`This show is already committed — it is ${status}.`);
  }
  throw new IntakeError(
    `Only a prospect can be declined. This show is ${status}; cancelling committed work ` +
      'is a different decision, with contracts and refunds attached.',
  );
}

export function statusAfter(decision: Decision): ShowStatus {
  return decision === 'committed' ? 'committed' : 'cancelled';
}
