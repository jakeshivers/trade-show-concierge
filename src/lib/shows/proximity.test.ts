import { describe, it, expect } from 'vitest';
import { byMostRecentlyOpened, distanceToNow, hasOpened } from './proximity';

const NOW = new Date('2026-09-02T12:00:00Z');
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const show = (from: number, to: number) => ({ startsOn: at(from), endsOn: at(to) });

describe('how far a show is from now', () => {
  // The reason this is not a subtraction: a show is an interval, and one that is
  // running is not "three days away" in either direction.
  it('is zero for the whole run of a show that is on now', () => {
    expect(distanceToNow(show(-1, 2), NOW)).toBe(0);
    expect(distanceToNow(show(0, 0), NOW)).toBe(0);
  });

  it('measures to the nearest edge, in either direction', () => {
    expect(distanceToNow(show(3, 6), NOW)).toBe(3 * 86_400_000);
    expect(distanceToNow(show(-9, -6), NOW)).toBe(6 * 86_400_000);
  });

  it('puts a show that ended yesterday ahead of one opening next month', () => {
    expect(distanceToNow(show(-4, -1), NOW)).toBeLessThan(distanceToNow(show(30, 33), NOW));
  });
});

describe('the retrospective order', () => {
  it('runs the clock backwards over shows that have opened', () => {
    const rows = [show(-400, -397), show(-10, -8), show(-60, -58)];
    const sorted = [...rows].sort((a, b) => byMostRecentlyOpened(a, b, NOW));
    expect(sorted.map((s) => s.startsOn.getTime())).toEqual([
      at(-10).getTime(),
      at(-60).getTime(),
      at(-400).getTime(),
    ]);
  });

  /**
   * A show that has not opened has nothing to report rather than a bad result,
   * so it sorts after every show being judged — and inside that tail the order
   * flips back to soonest-first, because those rows are prospective again.
   */
  it('puts unopened shows after every opened one, soonest of them first', () => {
    const rows = [show(60, 62), show(5, 7), show(-3, -1)];
    const sorted = [...rows].sort((a, b) => byMostRecentlyOpened(a, b, NOW));
    expect(sorted.map((s) => s.startsOn.getTime())).toEqual([
      at(-3).getTime(),
      at(5).getTime(),
      at(60).getTime(),
    ]);
  });

  it('counts a show running now as opened', () => {
    expect(hasOpened(show(-1, 2), NOW)).toBe(true);
    expect(hasOpened(show(1, 4), NOW)).toBe(false);
  });
});
