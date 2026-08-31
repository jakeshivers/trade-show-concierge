import { optionalDecimalToCents } from '@/lib/money/decimal';

/**
 * The deadline register, as pure functions: what a row must contain, and what a
 * change of state must carry with it.
 *
 * Shaped like `readiness/edit.ts` on purpose — validation here, rows in
 * `store.ts` — but two of the rules are specific to this register, and both come
 * from the same place: **a deadline row is a claim about money.** §5a's whole
 * argument is that "$2,800 surcharge if missed" gets acted on where "electrical
 * order due Feb 3" does not, which means a wrong date or a wrong figure here is
 * not a cosmetic defect, it is a bill.
 *
 * 1. **A deadline carries a local time, not just a date.** A checklist task can
 *    be due "the 4th" and land at 5pm local (`readiness/edit.ts` does exactly
 *    that). A warehouse that closes at 4:00pm on the 4th does not, and a register
 *    that rounds every deadline to 5pm is an hour late on the one row where an
 *    hour is a drayage penalty. So `dueTime` is required alongside `dueDate`, and
 *    both are read in the show's zone.
 * 2. **`not_applicable` is an edit wearing a status.** Marking the rigging
 *    deadline not-applicable removes its penalty estimate from the show's
 *    exposure and stops it alerting — which makes it the fastest way to make a
 *    show look safe. Same trap step 10 found in `skipped`, and the same
 *    resolution: a written reason, plus the authority to change the plan
 *    (`access.ts`). That the identical rule fell out of two unrelated features is
 *    the reason to trust it.
 */

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

export type DeadlineKind =
  | 'advance_order'
  | 'electrical'
  | 'furniture_carpet'
  | 'av_rigging'
  | 'labor'
  | 'warehouse_cutoff'
  | 'direct_to_show'
  | 'booth_registration'
  | 'staff_registration'
  | 'room_block'
  | 'sponsorship_artwork'
  | 'other';

export const DEADLINE_KINDS: DeadlineKind[] = [
  'advance_order',
  'electrical',
  'furniture_carpet',
  'av_rigging',
  'labor',
  'warehouse_cutoff',
  'direct_to_show',
  'booth_registration',
  'staff_registration',
  'room_block',
  'sponsorship_artwork',
  'other',
];

export type DeadlineStatus = 'open' | 'complete' | 'not_applicable';

export const DEADLINE_STATUSES: DeadlineStatus[] = ['open', 'complete', 'not_applicable'];

/** Long enough to name the reason, short enough not to train people to pad it. */
export const MIN_REASON = 12;

export type DeadlineDraft = {
  title: string;
  kind: string;
  /** `YYYY-MM-DD`, read in the show's zone. */
  dueDate: string;
  /** `HH:MM`, read in the show's zone. Required — see the header. */
  dueTime: string;
  /** A decimal string as typed, e.g. "3125.00". Never a float. */
  penaltyEstimate?: string | null;
  penaltyNote?: string | null;
  ownerId?: string | null;
  sourceUrl?: string | null;
};

export type ValidatedDeadline = {
  title: string;
  kind: DeadlineKind;
  dueDate: string;
  dueTime: string;
  penaltyEstimateCents: number | null;
  penaltyNote: string | null;
  ownerId: string | null;
  sourceUrl: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateDeadline(draft: DeadlineDraft): ValidatedDeadline {
  const title = draft.title.trim();
  if (title.length < 3) throw new DeadlineError('A deadline needs a title.');
  if (title.length > 200) throw new DeadlineError('Deadline titles are capped at 200 characters.');

  if (!DEADLINE_KINDS.includes(draft.kind as DeadlineKind)) {
    throw new DeadlineError(`"${draft.kind}" is not a deadline kind.`);
  }

  const dueDate = draft.dueDate?.trim() ?? '';
  if (!DATE.test(dueDate)) throw new DeadlineError('A deadline needs a date, as YYYY-MM-DD.');

  const dueTime = draft.dueTime?.trim() ?? '';
  if (!TIME.test(dueTime)) {
    throw new DeadlineError(
      'A deadline needs a time of day, as HH:MM in the show’s own time zone. The manual ' +
        'states one, and a register that assumes 5pm is an hour late on every 4pm cutoff.',
    );
  }

  // Cents, via the shared decimal parser — a penalty estimate typed as "3125.10"
  // through `parseFloat` is exactly the rounding the money ground rule forbids.
  // A currency symbol and thousands separators are stripped first because people
  // type them; nothing else is guessed at.
  const typedAmount = draft.penaltyEstimate?.replace(/[$,\s]/g, '') || null;
  let penaltyEstimateCents: number | null;
  try {
    penaltyEstimateCents = optionalDecimalToCents(typedAmount);
  } catch {
    throw new DeadlineError('A penalty estimate must be an amount like 3125.00, or blank.');
  }
  if (penaltyEstimateCents !== null && penaltyEstimateCents < 0) {
    throw new DeadlineError('A penalty estimate cannot be negative.');
  }

  const sourceUrl = draft.sourceUrl?.trim() || null;
  if (sourceUrl !== null && !/^https?:\/\//i.test(sourceUrl)) {
    throw new DeadlineError('A source link must be an http(s) URL, or blank.');
  }

  return {
    title,
    kind: draft.kind as DeadlineKind,
    dueDate,
    dueTime,
    penaltyEstimateCents,
    penaltyNote: draft.penaltyNote?.trim() || null,
    ownerId: draft.ownerId?.trim() || null,
    sourceUrl,
  };
}

export type DeadlineStatusChange = {
  status: DeadlineStatus;
  note: string | null;
  completedAt: Date | null;
  completedById: string | null;
};

/**
 * Resolve a state change into exactly the columns it writes.
 *
 * Leaving `complete` clears `completedAt` and its author, for the reason
 * `readiness/edit.ts` gives: a deadline re-opened in March still carrying
 * "completed in January" is a stale fact that later gets aggregated into a claim
 * about how much we avoided.
 */
export function planDeadlineStatus(
  next: string,
  note: string | null | undefined,
  actorId: string,
  now: Date,
): DeadlineStatusChange {
  if (!DEADLINE_STATUSES.includes(next as DeadlineStatus)) {
    throw new DeadlineError(`"${next}" is not a deadline status.`);
  }
  const status = next as DeadlineStatus;
  const trimmed = note?.trim() || null;

  if (status === 'not_applicable' && (trimmed === null || trimmed.length < MIN_REASON)) {
    throw new DeadlineError(
      `Say why this deadline does not apply — at least ${MIN_REASON} characters. Marking it ` +
        'not applicable takes its penalty out of the show’s exposure and stops it alerting, ' +
        'so it has to be a decision somebody made rather than a way to clear the register.',
    );
  }

  return {
    status,
    note: status === 'not_applicable' ? trimmed : null,
    completedAt: status === 'complete' ? now : null,
    completedById: status === 'complete' ? actorId : null,
  };
}
