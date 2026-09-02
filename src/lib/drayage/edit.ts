import { optionalDecimalToCents } from '@/lib/money/decimal';
import type { DrayageBasis } from './estimate';

/**
 * Validating a rate card, as pure functions.
 *
 * Shaped like `deadlines/edit.ts`, and carrying the same kind of rule for the
 * same kind of reason: **every field here is a multiplier on a real bill**, so a
 * value that is merely plausible is worse than a blank one. Three of the checks
 * are worth stating.
 *
 * 1. **A card must price something.** Both rates nullable is right — a manual may
 *    quote advance warehouse only — but *neither* set is a card that prices no
 *    crate at all, which would present as a configured show whose estimate is
 *    permanently withheld for a reason nobody can find.
 * 2. **`basis` is required and has no default.** Guessing round trip on an
 *    each-way card halves the figure; guessing each way on a round-trip card
 *    doubles it. There is no safe default, so there is no default.
 * 3. **A percentage is stored as a percentage, and blank is not zero.** A card
 *    silent on special handling has not told us the surcharge is nil; it has told
 *    us nothing, and `estimate.ts` reports uncrated freight under such a card as
 *    a gap rather than charging it at par.
 */

export class RateCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateCardError';
  }
}

export const DRAYAGE_BASES: DrayageBasis[] = ['round_trip', 'each_way'];

export const BASIS_LABEL: Record<DrayageBasis, string> = {
  round_trip: 'Round trip — charged on the way in, the return is included',
  each_way: 'Each way — inbound and outbound are billed separately',
};

/** Beyond this a typed rate is a decimal-point slip rather than an expensive show. */
const MAX_CWT_CENTS = 100_000;
const MAX_MINIMUM_LB = 5_000;

export type RateCardDraft = {
  contractor?: string | null;
  /** Decimal strings as typed, e.g. "142.50". Never floats. */
  advanceCwt?: string | null;
  showSiteCwt?: string | null;
  minimumLb: string;
  basis: string;
  specialHandlingPct?: string | null;
  overtimePct?: string | null;
  sourceNote?: string | null;
};

export type ValidatedRateCard = {
  contractor: string | null;
  advanceCwtCents: number | null;
  showSiteCwtCents: number | null;
  minimumLb: number;
  basis: DrayageBasis;
  specialHandlingPct: number | null;
  overtimePct: number | null;
  sourceNote: string | null;
};

function rate(typed: string | null | undefined, label: string): number | null {
  const cleaned = typed?.replace(/[$,\s]/g, '') || null;
  let cents: number | null;
  try {
    cents = optionalDecimalToCents(cleaned);
  } catch {
    throw new RateCardError(`The ${label} rate must be an amount like 142.50, or blank.`);
  }
  if (cents === null) return null;
  if (cents <= 0) throw new RateCardError(`The ${label} rate must be more than zero.`);
  if (cents > MAX_CWT_CENTS) {
    throw new RateCardError(
      `$${(cents / 100).toFixed(2)} per hundredweight is not a rate, it is a decimal point in ` +
        'the wrong place. Drayage runs roughly $80–$250 per CWT.',
    );
  }
  return cents;
}

function percent(typed: string | null | undefined, label: string): number | null {
  const trimmed = typed?.replace(/[%\s]/g, '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 200) {
    throw new RateCardError(`The ${label} surcharge must be a whole percentage from 0 to 200.`);
  }
  return n;
}

export function validateRateCard(draft: RateCardDraft): ValidatedRateCard {
  const advanceCwtCents = rate(draft.advanceCwt, 'advance warehouse');
  const showSiteCwtCents = rate(draft.showSiteCwt, 'direct to show site');

  if (advanceCwtCents === null && showSiteCwtCents === null) {
    throw new RateCardError(
      'A rate card needs at least one rate. With neither, the card prices no crate on the ' +
        'show and the estimate stays withheld for a reason nobody would be able to find.',
    );
  }

  if (!DRAYAGE_BASES.includes(draft.basis as DrayageBasis)) {
    throw new RateCardError(
      'Say whether this card charges round trip or each way. There is deliberately no ' +
        'default: reading a round-trip card as each-way doubles the biggest line on the show, ' +
        'and reading it the other way halves it. The manual states which.',
    );
  }

  const minimumLb = Number(draft.minimumLb?.trim());
  if (!Number.isInteger(minimumLb) || minimumLb <= 0 || minimumLb > MAX_MINIMUM_LB) {
    throw new RateCardError(
      `The minimum is a whole number of pounds, up to ${MAX_MINIMUM_LB}. It is almost always ` +
        '200, and it is what makes two small crates cost more than one big one.',
    );
  }

  return {
    contractor: draft.contractor?.trim() || null,
    advanceCwtCents,
    showSiteCwtCents,
    minimumLb,
    basis: draft.basis as DrayageBasis,
    specialHandlingPct: percent(draft.specialHandlingPct, 'special handling'),
    overtimePct: percent(draft.overtimePct, 'overtime'),
    sourceNote: draft.sourceNote?.trim() || null,
  };
}
