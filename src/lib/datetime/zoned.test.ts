import { describe, it, expect } from 'vitest';
import { zonedToInstant, hasExplicitOffset, ZonedTimeError } from './zoned';

describe('zonedToInstant', () => {
  it('interprets a naive time in the given zone', () => {
    // 08:15 in San Francisco on 29 Mar 2026 is PDT (UTC-7) => 15:15 UTC.
    expect(zonedToInstant('2026-03-29T08:15:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-29T15:15:00.000Z',
    );
  });

  it('produces the true flight duration across zones', () => {
    // The bug this module exists for: SFO 08:15 -> DTW 16:05 is 4h50m, not 7h50m.
    const dep = zonedToInstant('2026-03-29T08:15:00', 'America/Los_Angeles');
    const arr = zonedToInstant('2026-03-29T16:05:00', 'America/Detroit');
    expect((arr.getTime() - dep.getTime()) / 3_600_000).toBeCloseTo(4.833, 2);
  });

  it('respects DST on either side of a transition', () => {
    // US DST began 8 Mar 2026: PST (UTC-8) before, PDT (UTC-7) after.
    expect(zonedToInstant('2026-03-01T12:00:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-01T20:00:00.000Z',
    );
    expect(zonedToInstant('2026-03-15T12:00:00', 'America/Los_Angeles').toISOString()).toBe(
      '2026-03-15T19:00:00.000Z',
    );
  });

  it('handles a zone on the other side of UTC', () => {
    expect(zonedToInstant('2026-03-30T10:55:00', 'Europe/London').toISOString()).toBe(
      '2026-03-30T09:55:00.000Z',
    );
  });

  it('passes through strings that already carry an offset', () => {
    expect(hasExplicitOffset('2026-03-01T12:28:03.000Z')).toBe(true);
    expect(hasExplicitOffset('2026-03-29T08:15:00')).toBe(false);
    expect(zonedToInstant('2026-03-01T12:28:03.000Z', 'America/Denver').toISOString()).toBe(
      '2026-03-01T12:28:03.000Z',
    );
  });

  it('throws on malformed input rather than yielding Invalid Date', () => {
    expect(() => zonedToInstant('not-a-date', 'UTC')).toThrow(ZonedTimeError);
    expect(() => zonedToInstant('2026-03-29T08:15:00', 'Mars/Olympus')).toThrow(ZonedTimeError);
  });
});
