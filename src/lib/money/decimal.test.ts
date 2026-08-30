import { describe, it, expect } from 'vitest';
import { decimalStringToCents, centsToDecimalString, MoneyParseError, optionalDecimalToCents } from './decimal';

describe('decimalStringToCents', () => {
  it('parses the amounts travel APIs actually send', () => {
    expect(decimalStringToCents('8618.36')).toBe(861_836);
    expect(decimalStringToCents('420.00')).toBe(42_000);
    expect(decimalStringToCents('0.99')).toBe(99);
  });

  it('avoids the float error that motivates this function', () => {
    // parseFloat('8618.36') * 100 === 861835.9999999999
    expect(decimalStringToCents('8618.36')).not.toBe(Math.round(parseFloat('8618.36') * 100) - 1);
    expect(decimalStringToCents('1.10')).toBe(110);
    expect(decimalStringToCents('19.99')).toBe(1_999);
  });

  it('handles missing and short fractions', () => {
    expect(decimalStringToCents('500')).toBe(50_000);
    expect(decimalStringToCents('500.5')).toBe(50_050);
  });

  it('rounds half-up beyond two places', () => {
    expect(decimalStringToCents('1.005')).toBe(101);
    expect(decimalStringToCents('1.004')).toBe(100);
  });

  it('handles negatives', () => {
    expect(decimalStringToCents('-42.50')).toBe(-4_250);
  });

  it('throws rather than silently returning NaN', () => {
    expect(() => decimalStringToCents('not money')).toThrow(MoneyParseError);
    expect(() => decimalStringToCents('')).toThrow(MoneyParseError);
    expect(() => decimalStringToCents('1,000.00')).toThrow(MoneyParseError);
  });

  it('passes null through', () => {
    expect(optionalDecimalToCents(null)).toBeNull();
    expect(optionalDecimalToCents('12.34')).toBe(1_234);
  });

  it('round-trips', () => {
    for (const s of ['0.00', '1.05', '8618.36', '99999.99']) {
      expect(centsToDecimalString(decimalStringToCents(s))).toBe(s);
    }
  });
});
