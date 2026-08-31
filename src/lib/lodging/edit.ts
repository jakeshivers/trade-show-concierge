import { optionalDecimalToCents } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';

/**
 * Lodging, as pure functions.
 *
 * SCOPE.md §4 makes `room_block_cutoff` first-class and says why: *"missing the
 * room-block date is among the most common and expensive trade show mistakes."*
 * That sentence is a description of the deadline engine built at step 11, which
 * is the whole argument of `store.ts` next door — the cutoff does not get a
 * second clock of its own.
 *
 * What lives here is validation, and one rule the register does not have:
 *
 * **A cutoff after check-in is not a deadline, it is a typo.** The room block
 * exists to be booked against *before* people travel; a cutoff dated inside the
 * stay is either the wrong year (the commonest paste error when a hotel row is
 * copied off last year's show) or a misread of the manual. Either way the
 * deadline it would raise is one nobody can act on, and a register full of those
 * is how the register stops being read.
 *
 * Times are local to the show, for `deadlines/edit.ts`'s reason: a room block
 * that closes at 5:00pm Central closes at 5:00pm Central for a person in Berlin.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Hotels overwhelmingly check in mid-afternoon and out mid-morning. */
export const DEFAULT_CHECK_IN = '15:00';
export const DEFAULT_CHECK_OUT = '11:00';

export type LodgingDraft = {
  hotelName: string;
  address?: string | null;
  phone?: string | null;
  confirmationCode?: string | null;
  checkInOn?: string | null;
  checkInAt?: string | null;
  checkOutOn?: string | null;
  checkOutAt?: string | null;
  /** A decimal string as typed, e.g. "289.00". Never a float. */
  nightlyRate?: string | null;
  roomBlockCutoffOn?: string | null;
  roomBlockCutoffAt?: string | null;
  costCenterId: string;
  notes?: string | null;
};

export type ValidatedLodging = {
  hotelName: string;
  address: string | null;
  phone: string | null;
  confirmationCode: string | null;
  /** Naive local strings; `store.ts` resolves them against the show's zone. */
  checkInLocal: string | null;
  checkOutLocal: string | null;
  nightlyRateCents: number | null;
  roomBlockCutoffLocal: string | null;
  costCenterId: string;
  notes: string | null;
};

function localOrNull(
  date: string | null | undefined,
  time: string | null | undefined,
  fallbackTime: string,
  what: string,
): string | null {
  const d = date?.trim() ?? '';
  const t = (time?.trim() || fallbackTime).trim();
  if (!d) return null;
  if (!DATE.test(d)) throw new TeamError(`${what} needs a date, as YYYY-MM-DD.`);
  if (!TIME.test(t)) throw new TeamError(`${what} needs a time of day, as HH:MM.`);
  return `${d}T${t}:00`;
}

export function validateLodging(draft: LodgingDraft): ValidatedLodging {
  const hotelName = draft.hotelName.trim();
  if (hotelName.length < 2) throw new TeamError('A lodging row needs a hotel name.');
  if (hotelName.length > 200) throw new TeamError('Hotel names are capped at 200 characters.');

  const checkInLocal = localOrNull(draft.checkInOn, draft.checkInAt, DEFAULT_CHECK_IN, 'Check-in');
  const checkOutLocal = localOrNull(
    draft.checkOutOn,
    draft.checkOutAt,
    DEFAULT_CHECK_OUT,
    'Check-out',
  );
  if (checkInLocal && checkOutLocal && checkOutLocal <= checkInLocal) {
    throw new TeamError('Check-out has to be after check-in.');
  }

  const roomBlockCutoffLocal = localOrNull(
    draft.roomBlockCutoffOn,
    draft.roomBlockCutoffAt,
    '17:00',
    'The room block cutoff',
  );
  if (roomBlockCutoffLocal && checkInLocal && roomBlockCutoffLocal >= checkInLocal) {
    throw new TeamError(
      'The room block cutoff falls on or after check-in, which cannot be right — the cutoff is ' +
        'the date the discounted rooms stop being held, and it always precedes the stay. Check ' +
        'the year: a hotel row copied from last year’s show is the usual cause.',
    );
  }

  const nightlyRateCents = optionalDecimalToCents(draft.nightlyRate ?? null);
  if (nightlyRateCents !== null && nightlyRateCents < 0) {
    throw new TeamError('A nightly rate cannot be negative.');
  }

  const costCenterId = draft.costCenterId?.trim() ?? '';
  if (!costCenterId) {
    throw new TeamError(
      'Lodging needs a cost center. §4: every financial row carries one at creation, because a ' +
        'cost dimension added later permanently orphans the spend that came before it.',
    );
  }

  return {
    hotelName,
    address: draft.address?.trim() || null,
    phone: draft.phone?.trim() || null,
    confirmationCode: draft.confirmationCode?.trim() || null,
    checkInLocal,
    checkOutLocal,
    nightlyRateCents,
    roomBlockCutoffLocal,
    costCenterId,
    notes: draft.notes?.trim() || null,
  };
}

/** The title the derived deadline carries. Stable, so re-saving does not churn it. */
export function roomBlockDeadlineTitle(hotelName: string): string {
  return `Room block cutoff — ${hotelName}`;
}

export { TeamError as LodgingError };
