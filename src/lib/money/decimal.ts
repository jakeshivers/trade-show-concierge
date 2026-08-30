/**
 * Money parsing.
 *
 * Duffel (and most travel APIs) send amounts as decimal strings — "8618.36" —
 * because floats cannot represent money. Parsing with `parseFloat` and
 * multiplying by 100 reintroduces exactly the error the string was avoiding:
 * `parseFloat('8618.36') * 100` is 861835.9999999999.
 *
 * So we work on the string.
 */

export class MoneyParseError extends Error {
  constructor(input: string) {
    super(`Cannot parse "${input}" as a decimal money amount`);
    this.name = 'MoneyParseError';
  }
}

/** "8618.36" -> 861836. Rounds half-up beyond two decimal places. */
export function decimalStringToCents(input: string): number {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new MoneyParseError(input);

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = unsigned.split('.');

  // Pad to at least three places so we can inspect the rounding digit.
  const padded = (fraction + '000').slice(0, 3);
  const cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  const rounded = Number(padded[2]) >= 5 ? cents + 1 : cents;

  return negative ? -rounded : rounded;
}

/** Nullable passthrough, for the many optional amount fields. */
export function optionalDecimalToCents(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  return decimalStringToCents(input);
}

export function centsToDecimalString(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}
