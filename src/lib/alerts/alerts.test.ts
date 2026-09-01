import { describe, it, expect } from 'vitest';
import {
  STALE_AFTER_HOURS,
  groupFeed,
  linkFor,
  orderFeed,
  standingDays,
  standingOf,
  summarizeFeed,
  type FeedAlert,
} from './feed';
import { canAcknowledge, canRunSweeps, canSeeAlerts } from './access';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of the feed — no database, fixed clock.
 *
 * The assertions worth reading are about the three things a row does *not* say
 * on its own: that its claim is only as fresh as the last sweep, that being
 * acknowledged is not being fixed, and that eleven correct rows about one
 * re-timed flight are one piece of news.
 */

const NOW = new Date('2026-04-01T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const daysAgo = (n: number) => hoursAgo(n * 24);

const alert = (over: Partial<FeedAlert> = {}): FeedAlert => ({
  id: over.id ?? 'a1',
  source: 'shipping',
  kind: 'condition',
  severity: 'warning',
  title: 'No movement for 5 days',
  body: 'The carrier is still promising Thursday.',
  showId: 'show-1',
  userId: 'user-1',
  showName: 'Automate 2026',
  dedupeKey: 'k1',
  createdAt: hoursAgo(2),
  lastSeenAt: hoursAgo(2),
  occurrences: 1,
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedByName: null,
  ...over,
});

describe('standing', () => {
  it('calls a recent single sighting new, and a repeated one repeating', () => {
    expect(standingOf(alert(), NOW)).toBe('new');
    expect(standingOf(alert({ occurrences: 6 }), NOW)).toBe('repeating');
  });

  it('reports an unswept condition as unchecked rather than as still true', () => {
    // The rule `flights/status.ts` argues for, one layer up: an alert nobody has
    // re-run is a claim about a moment that has passed, and a feed that renders
    // it as current is the board that goes stale while looking fresh.
    const stale = alert({ lastSeenAt: hoursAgo(STALE_AFTER_HOURS + 1) });
    expect(standingOf(stale, NOW)).toBe('unchecked');
  });

  it('never calls a notice unchecked, because there is nothing to re-check', () => {
    const ticketed = alert({
      kind: 'notice',
      source: 'booking',
      lastSeenAt: daysAgo(40),
      createdAt: daysAgo(40),
    });
    expect(standingOf(ticketed, NOW)).toBe('new');
  });

  it('keeps acknowledged apart from resolved, and resolved wins', () => {
    expect(standingOf(alert({ acknowledgedAt: hoursAgo(1) }), NOW)).toBe('acknowledged');
    expect(
      standingOf(alert({ acknowledgedAt: hoursAgo(1), resolvedAt: hoursAgo(1) }), NOW),
    ).toBe('resolved');
  });

  it('measures age from when it was first said, not from the last sweep', () => {
    // `createdAt` is deliberately never moved by a repeat sighting: "since when"
    // is the question a nine-day-old critical alert answers.
    const old = alert({ createdAt: daysAgo(9), lastSeenAt: hoursAgo(1), occurrences: 9 });
    expect(standingDays(old, NOW)).toBe(9);
  });
});

describe('ordering', () => {
  it('puts live work above acknowledged, and acknowledged above ended', () => {
    const live = alert({ id: 'live', severity: 'info' });
    const seen = alert({ id: 'seen', severity: 'critical', acknowledgedAt: hoursAgo(1) });
    const done = alert({ id: 'done', severity: 'critical', resolvedAt: hoursAgo(1) });
    expect(orderFeed([done, seen, live], NOW).map((a) => a.id)).toEqual([
      'live',
      'seen',
      'done',
    ]);
  });

  it('ranks a long-standing critical above tonight’s', () => {
    const tonight = alert({ id: 'new', severity: 'critical', createdAt: hoursAgo(1) });
    const old = alert({ id: 'old', severity: 'critical', createdAt: daysAgo(20) });
    expect(orderFeed([tonight, old], NOW).map((a) => a.id)).toEqual(['old', 'new']);
  });
});

describe('grouping', () => {
  it('collapses one sentence said by many rows, and keeps the rows', () => {
    const legs = Array.from({ length: 11 }, (_, i) =>
      alert({
        id: `leg-${i}`,
        source: 'flight',
        title: 'The airline moved DL 1422 SFO→DTW by +125 min',
        body: `traveler ${i}`,
        dedupeKey: `k-${i}`,
      }),
    );
    const [group] = groupFeed(legs, NOW);
    expect(group.rest).toHaveLength(10);
    expect(group.lead.title).toContain('DL 1422');
  });

  it('does not collapse a resolved copy into a live one', () => {
    // Otherwise one crate arriving would take nine others off the screen.
    const live = alert({ id: '1', dedupeKey: 'k1' });
    const over = alert({ id: '2', dedupeKey: 'k2', resolvedAt: hoursAgo(1) });
    expect(groupFeed([live, over], NOW)).toHaveLength(2);
  });

  it('names every show a group spans', () => {
    const a = alert({ id: '1', showName: 'Automate 2026', dedupeKey: 'k1' });
    const b = alert({ id: '2', showName: 'MedTech Summit', dedupeKey: 'k2' });
    const [group] = groupFeed([a, b], NOW);
    expect(group.showNames).toEqual(['Automate 2026', 'MedTech Summit']);
  });
});

describe('summary', () => {
  it('counts unchecked inside outstanding, because it is not good news', () => {
    const s = summarizeFeed(
      [
        alert({ id: '1', severity: 'critical' }),
        alert({ id: '2', lastSeenAt: hoursAgo(STALE_AFTER_HOURS + 5) }),
        alert({ id: '3', acknowledgedAt: hoursAgo(1) }),
        alert({ id: '4', resolvedAt: hoursAgo(1) }),
      ],
      NOW,
    );
    expect(s.outstanding).toBe(2);
    expect(s.unchecked).toBe(1);
    expect(s.critical).toBe(1);
    expect(s.acknowledged).toBe(1);
    expect(s.resolved).toBe(1);
  });
});

describe('links', () => {
  it('sends each source where the thing can actually be dealt with', () => {
    expect(linkFor(alert({ source: 'deadline' }))).toBe('/shows/show-1/readiness');
    expect(linkFor(alert({ source: 'shipping' }))).toBe('/shows/show-1/logistics');
    expect(linkFor(alert({ source: 'flight' }))).toBe('/flights');
    expect(linkFor(alert({ source: 'credit', showId: null }))).toBe('/travel');
  });

  it('falls back to a board when the alert has no show', () => {
    // A credit expiry and an asset sitting in the warehouse both belong to the
    // org rather than to a show, and `show_id` is null on them by construction.
    expect(linkFor(alert({ source: 'asset', showId: null, showName: null }))).toBe('/assets');
  });
});

describe('access', () => {
  const actor = (over: Partial<Actor> = {}): Actor => ({
    userId: 'u1',
    orgId: 'o1',
    email: 'a@example.com',
    fullName: 'A',
    role: 'member',
    costCenterId: null,
    ...over,
  });

  it('lets anybody read their feed and re-run the engines', () => {
    expect(canSeeAlerts()).toBe(true);
    expect(canRunSweeps()).toBe(true);
  });

  it('lets only the addressee acknowledge — including against an admin', () => {
    expect(canAcknowledge(actor(), 'u1')).toBe(true);
    expect(canAcknowledge(actor({ role: 'admin' }), 'u2')).toBe(false);
  });
});
