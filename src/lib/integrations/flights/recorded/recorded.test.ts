import { describe, it, expect } from 'vitest';
import { RecordedFlightProvider } from './provider';

/**
 * The replay's one job that is not "hand back the payload": put the recorded
 * itinerary **inside the window that was asked for**.
 *
 * This exists because it did not, for forty minutes a day, and nothing noticed
 * for twenty-five steps. `rebase` shifts the fixture onto the *UTC day* of
 * `earliestDeparture` and keeps the fixture's naive local departure time — which
 * is exactly right for durations, overnight arrivals and local clock times, and
 * says nothing about the resulting instant. The international fixture leaves SFO
 * at 16:20 local, so it rebases to **23:20Z**; any search whose earliest
 * departure falls later than that on the same UTC day gets an offer departing
 * before the window opens, denied on `departure_window`, and the request comes
 * back `no_options`.
 *
 * Both `pnpm test` and `pnpm booking:dry-run` build their window from
 * `now + 45 days`, so between 23:20Z and midnight UTC the escalation scenario is
 * unreachable and eight tests fail — and pass every other hour of the day. A
 * replay that only works at certain times of day is not a replay, and a suite
 * that is green depending on when you run it is worse than one that is red.
 *
 * The clock is pinned here for that reason: the bug is a function of the time of
 * day, so a test that reads the wall clock would reproduce it about 3% of the
 * time.
 */
const DAY = 86_400_000;

async function windowFor(nowIso: string, origin: string, destination: string) {
  const now = new Date(nowIso);
  const earliestDeparture = new Date(now.getTime() + 45 * DAY);
  const latestArrival = new Date(earliestDeparture.getTime() + 2 * DAY);
  const provider = new RecordedFlightProvider({ now: () => now });
  const result = await provider.search({
    constraints: { originAirport: origin, destinationAirport: destination, earliestDeparture, latestArrival },
  } as never);
  return { earliestDeparture, latestArrival, offers: result.offers };
}

describe('a replayed offer lands inside the requested window', () => {
  // 23:20Z is the international fixture's own rebased departure. The hour on
  // either side of it is the whole bug, so it is the whole table.
  const hours = [
    '2026-09-02T00:00:00Z',
    '2026-09-02T12:00:00Z',
    '2026-09-02T22:00:00Z',
    '2026-09-02T23:19:00Z',
    '2026-09-02T23:21:00Z',
    '2026-09-02T23:49:00Z',
    '2026-09-02T23:59:59Z',
  ];

  it.each(hours)('SFO → LHR searched at %s', async (nowIso) => {
    const { earliestDeparture, latestArrival, offers } = await windowFor(nowIso, 'SFO', 'LHR');
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      const segments = offer.slices[0].segments;
      const departs = segments[0].departsAt;
      const arrives = segments[segments.length - 1].arrivesAt;
      expect(
        departs.getTime(),
        `${offer.id} departs ${departs.toISOString()}, before the window opens at ${earliestDeparture.toISOString()}`,
      ).toBeGreaterThanOrEqual(earliestDeparture.getTime());
      expect(
        arrives.getTime(),
        `${offer.id} arrives ${arrives.toISOString()}, after the window closes at ${latestArrival.toISOString()}`,
      ).toBeLessThanOrEqual(latestArrival.getTime());
    }
  });

  it('shifts by whole days, so local clock times survive', async () => {
    // The property `rebase` exists to protect: whatever day it lands on, the
    // fixture's 16:20 local departure is still 16:20 local.
    const { offers } = await windowFor('2026-09-02T23:49:00Z', 'SFO', 'LHR');
    const departs = offers[0].slices[0].segments[0].departsAt;
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(departs);
    expect(local).toBe('16:20');
  });
});
