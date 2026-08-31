import { describe, it, expect } from 'vitest';
import { planClone, CloneError, type CloneSource } from './clone';
import { instantToZoned, zonedToInstant } from '@/lib/datetime/zoned';

/**
 * The clone planner is pure, so the interesting cases are cheap: what it carries,
 * what it refuses to carry, and what happens to a 5:00pm deadline when a year's
 * shift crosses two DST boundaries.
 */

const TZ = 'America/Detroit';
const at = (naive: string) => zonedToInstant(naive, TZ);

function source(overrides: Partial<CloneSource> = {}): CloneSource {
  return {
    show: {
      id: 'show-1',
      name: 'Automate 2026',
      timezone: TZ,
      startsOn: at('2026-06-08T09:00:00'),
      endsOn: at('2026-06-11T16:00:00'),
      moveInAt: at('2026-06-06T08:00:00'),
      moveOutAt: at('2026-06-11T17:00:00'),
      website: 'https://example.test',
      venueName: 'Huntington Place',
      venueAddress: '1 Washington Blvd',
      city: 'Detroit',
      region: 'MI',
      country: 'US',
      airportCode: 'DTW',
      boothNumber: '4218',
      boothSize: '20x20',
      budgetCents: 14_500_000,
      goals: '120 qualified leads',
    },
    tasks: [
      {
        title: 'Sign booth space contract',
        description: null,
        category: 'legal',
        assigneeId: 'user-shelley',
        dueOn: at('2026-04-20T17:00:00'),
        weight: 3,
        sortOrder: 0,
      },
    ],
    deadlines: [
      {
        kind: 'advance_order',
        title: 'Advance order deadline',
        dueAt: at('2026-05-13T17:00:00'),
        penaltyEstimateCents: 312_500,
        penaltyNote: '~30% surcharge',
        ownerId: 'user-marcus',
        sourceUrl: null,
      },
    ],
    attendees: [{ userId: 'user-priya', role: 'Technical demos' }],
    reservations: [
      {
        assetId: 'asset-booth',
        reservedFrom: at('2026-05-29T09:00:00'),
        reservedTo: at('2026-06-18T09:00:00'),
        notes: null,
      },
    ],
    ...overrides,
  };
}

const ALL = { tasks: true, deadlines: true, team: true, assets: true };

describe('planClone', () => {
  it('shifts the whole calendar by the gap between start dates', () => {
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: ALL,
    });

    expect(plan.shiftDays).toBe(364);
    expect(instantToZoned(plan.show.startsOn, TZ)).toBe('2027-06-07T09:00:00');
    expect(instantToZoned(plan.show.endsOn, TZ)).toBe('2027-06-10T16:00:00');
    expect(instantToZoned(plan.show.moveInAt!, TZ)).toBe('2027-06-05T08:00:00');
  });

  it('keeps a 5:00pm deadline at 5:00pm across the DST boundaries in between', () => {
    // The failure this guards: 364 days of milliseconds moves a deadline by an
    // hour whenever the two dates fall on opposite sides of a DST change. An
    // advance-order deadline an hour early is a surcharge nobody can appeal.
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: ALL,
    });

    expect(instantToZoned(plan.deadlines[0].dueAt, TZ)).toBe('2027-05-12T17:00:00');
    expect(instantToZoned(plan.tasks[0].dueOn!, TZ)).toBe('2027-04-19T17:00:00');
  });

  it('crosses a DST boundary within a short shift without moving the clock', () => {
    const winter = source({
      show: { ...source().show, startsOn: at('2026-03-01T09:00:00') },
      deadlines: [
        {
          kind: 'electrical',
          title: 'Electrical order',
          dueAt: at('2026-03-05T17:00:00'),
          penaltyEstimateCents: null,
          penaltyNote: null,
          ownerId: null,
          sourceUrl: null,
        },
      ],
    });

    // 2026-03-08 is the US spring-forward date; the shift steps over it.
    const plan = planClone(winter, {
      name: 'Automate spring',
      startsOn: at('2026-03-15T09:00:00'),
      include: ALL,
    });

    expect(plan.shiftDays).toBe(14);
    expect(instantToZoned(plan.deadlines[0].dueAt, TZ)).toBe('2026-03-19T17:00:00');
  });

  it('never carries a confirmation forward', () => {
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: ALL,
    });

    // A deadline arrives unconfirmed and a task arrives undone: last year's
    // exhibitor manual is not evidence about this year's.
    expect(plan.deadlines[0].confirmedAt).toBeNull();
    expect(plan.tasks[0].status).toBe('not_started');
    expect(plan.attendees[0].status).toBe('invited');
    expect(plan.show.status).toBe('prospect');
  });

  it('drops the booth number', () => {
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: ALL,
    });
    expect(plan.show.boothNumber).toBeNull();
    expect(plan.show.boothSize).toBe('20x20');
    expect(plan.show.venueName).toBe('Huntington Place');
  });

  it('honours the include flags and says what it left behind', () => {
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: { tasks: true, deadlines: false, team: false, assets: false },
    });

    expect(plan.deadlines).toHaveLength(0);
    expect(plan.attendees).toHaveLength(0);
    expect(plan.reservations).toHaveLength(0);
    expect(plan.dropped.some((d) => d.includes('service deadlines — not selected'))).toBe(true);
    expect(plan.carried.some((c) => c.includes('readiness tasks'))).toBe(true);
  });

  it('always lists what a clone structurally cannot carry', () => {
    const plan = planClone(source(), {
      name: 'Automate 2027',
      startsOn: at('2027-06-07T09:00:00'),
      include: ALL,
    });
    const dropped = plan.dropped.join(' ');
    for (const word of ['Flights', 'Lodging', 'Shipments', 'Expenses']) {
      expect(dropped).toContain(word);
    }
  });

  it('refuses a clone that is indistinguishable from its source', () => {
    expect(() =>
      planClone(source(), {
        name: 'Automate 2026',
        startsOn: at('2026-06-08T09:00:00'),
        include: ALL,
      }),
    ).toThrow(CloneError);
  });

  it('refuses an unnamed clone', () => {
    expect(() =>
      planClone(source(), { name: ' ', startsOn: at('2027-06-07T09:00:00'), include: ALL }),
    ).toThrow(CloneError);
  });

  it('clones backwards as readily as forwards', () => {
    const plan = planClone(source(), {
      name: 'Automate 2025 (reconstructed)',
      startsOn: at('2025-06-09T09:00:00'),
      include: ALL,
    });
    expect(plan.shiftDays).toBe(-364);
    expect(instantToZoned(plan.show.startsOn, TZ)).toBe('2025-06-09T09:00:00');
  });
});
