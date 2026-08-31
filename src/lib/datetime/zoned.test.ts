import { describe, it, expect } from 'vitest';
import {
  zonedToInstant,
  hasExplicitOffset,
  instantToZoned,
  shiftDaysPreservingLocalTime,
  calendarDaysBetween,
  ZonedTimeError,
  zonedDateInput,
  zonedDateTimeInput,
  zonedTimeInput,
} from './zoned';

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

describe('instantToZoned', () => {
  it('round-trips a naive local time', () => {
    const naive = '2026-11-04T17:00:00';
    const instant = zonedToInstant(naive, 'America/Detroit');
    expect(instantToZoned(instant, 'America/Detroit')).toBe(naive);
  });

  it('renders local midnight as 00, not 24', () => {
    const instant = zonedToInstant('2026-07-04T00:00:00', 'America/Chicago');
    expect(instantToZoned(instant, 'America/Chicago')).toBe('2026-07-04T00:00:00');
  });

  it('shows the same instant differently in two zones', () => {
    const instant = new Date('2026-03-01T12:00:00Z');
    expect(instantToZoned(instant, 'UTC')).toBe('2026-03-01T12:00:00');
    expect(instantToZoned(instant, 'America/Los_Angeles')).toBe('2026-03-01T04:00:00');
  });
});

describe('shiftDaysPreservingLocalTime', () => {
  it('keeps the wall clock across a spring-forward boundary', () => {
    // Naive arithmetic (+14 * 86_400_000 ms) lands this at 18:00.
    const before = zonedToInstant('2026-03-05T17:00:00', 'America/Detroit');
    const after = shiftDaysPreservingLocalTime(before, 14, 'America/Detroit');
    expect(instantToZoned(after, 'America/Detroit')).toBe('2026-03-19T17:00:00');
    expect(after.getTime() - before.getTime()).not.toBe(14 * 86_400_000);
  });

  it('keeps the wall clock across a fall-back boundary', () => {
    const before = zonedToInstant('2026-10-28T09:00:00', 'America/Detroit');
    const after = shiftDaysPreservingLocalTime(before, 14, 'America/Detroit');
    expect(instantToZoned(after, 'America/Detroit')).toBe('2026-11-11T09:00:00');
  });

  it('shifts backwards and across a year boundary', () => {
    const before = zonedToInstant('2027-01-05T08:30:00', 'Europe/London');
    const after = shiftDaysPreservingLocalTime(before, -10, 'Europe/London');
    expect(instantToZoned(after, 'Europe/London')).toBe('2026-12-26T08:30:00');
  });

  it('refuses a fractional shift rather than rounding it silently', () => {
    const t = zonedToInstant('2026-06-01T09:00:00', 'UTC');
    expect(() => shiftDaysPreservingLocalTime(t, 1.5, 'UTC')).toThrow(ZonedTimeError);
  });
});

describe('calendarDaysBetween', () => {
  it('counts calendar days, not elapsed 24-hour periods', () => {
    const from = zonedToInstant('2026-03-07T23:00:00', 'America/Detroit');
    const to = zonedToInstant('2026-03-08T01:00:00', 'America/Detroit');
    expect(calendarDaysBetween(from, to, 'America/Detroit')).toBe(1);
  });

  it('is the inverse of the shift', () => {
    const from = zonedToInstant('2026-06-08T09:00:00', 'America/Detroit');
    const to = shiftDaysPreservingLocalTime(from, 364, 'America/Detroit');
    expect(calendarDaysBetween(from, to, 'America/Detroit')).toBe(364);
  });
});

describe('form input formatting', () => {
  it('renders the date the show is in, not the one the server is in', () => {
    // 5pm in Los Angeles on the 3rd is already the 4th in UTC. Every one of the
    // four hand-rolled helpers this replaced existed because
    // `toISOString().slice(0, 10)` gets this wrong, and getting it wrong moves
    // a deadline a day each time the edit form is opened and saved.
    const due = zonedToInstant('2027-02-03T17:00:00', 'America/Los_Angeles');
    expect(due.toISOString().slice(0, 10)).toBe('2027-02-04');
    expect(zonedDateInput(due, 'America/Los_Angeles')).toBe('2027-02-03');
    expect(zonedTimeInput(due, 'America/Los_Angeles')).toBe('17:00');
    expect(zonedDateTimeInput(due, 'America/Los_Angeles')).toBe('2027-02-03T17:00');
  });

  it('renders midnight as 00:00, never 24:00', () => {
    // Intl under hour12:false emits hour "24" for midnight in some ICU builds,
    // and `<input type="time">` silently rejects it — the field comes up blank
    // and saving it back clears the time.
    const midnight = zonedToInstant('2027-05-01T00:00:00', 'America/Chicago');
    expect(zonedTimeInput(midnight, 'America/Chicago')).toBe('00:00');
    expect(zonedDateInput(midnight, 'America/Chicago')).toBe('2027-05-01');
  });

  it('reads one instant differently in two zones', () => {
    const t = zonedToInstant('2027-03-15T08:00:00', 'America/New_York');
    expect(zonedDateTimeInput(t, 'America/New_York')).toBe('2027-03-15T08:00');
    expect(zonedDateTimeInput(t, 'Asia/Tokyo')).toBe('2027-03-15T21:00');
  });

  it('is empty for a null instant rather than throwing or inventing today', () => {
    expect(zonedDateInput(null, 'UTC')).toBe('');
    expect(zonedTimeInput(undefined, 'UTC')).toBe('');
    expect(zonedDateTimeInput(null, 'UTC')).toBe('');
  });

  it('round-trips through zonedToInstant', () => {
    const t = zonedToInstant('2026-11-01T01:30:00', 'America/Denver');
    const back = zonedToInstant(`${zonedDateTimeInput(t, 'America/Denver')}:00`, 'America/Denver');
    expect(back.getTime()).toBe(t.getTime());
  });
});
