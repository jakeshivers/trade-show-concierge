import { describe, it, expect } from 'vitest';
import {
  assessCoverage,
  bucketExpense,
  rollUpShowCost,
  summarizePortfolio,
  type CostInputs,
} from './rollup';
import { canSeeCost } from './access';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of the true-cost rollup — no database, fixed clock.
 *
 * Addition is not what these test. Every assertion here is about a number that
 * would read perfectly well and be wrong: a dry run counted as spend, a
 * credit-funded ticket counted twice across two shows, a print run and the
 * datasheets it printed added together, a show with no invoice entered looking
 * like the cheapest one on the calendar.
 */

const NOW = new Date('2026-06-01T12:00:00Z');

const inputs = (over: Partial<CostInputs> = {}): CostInputs => ({
  show: {
    id: 'show-1',
    name: 'Automate 2026',
    startsOn: new Date('2026-06-10T00:00:00Z'),
    endsOn: new Date('2026-06-13T00:00:00Z'),
  },
  expenses: [],
  bookings: [],
  drayage: null,
  enteredFlights: [],
  lodgings: [],
  shipments: [],
  collateral: [],
  attendees: [],
  ...over,
});

describe('expense buckets', () => {
  it('maps free text onto §8a’s lines and never drops a row', () => {
    expect(bucketExpense('Booth space')).toBe('space');
    expect(bucketExpense('Electrical, carpet, rigging')).toBe('services');
    expect(bucketExpense('Drayage')).toBe('services');
    expect(bucketExpense('Datasheet reprint')).toBe('collateral');
    // Unrecognised is `other`, not discarded: a cost line that silently loses
    // rows is worse than an untidy one.
    expect(bucketExpense('Client dinner, Tuesday')).toBe('other');
  });
});

describe('travel', () => {
  it('refuses to count a dry run as spend, and says so', () => {
    // `bookings.live` is the provider's word and exists for this rollup: a
    // Duffel test key issues orders that look real in every respect.
    const cost = rollUpShowCost(
      inputs({
        bookings: [
          { chargedCents: 43_055, creditAppliedCents: null, live: false, cancelledAt: null },
        ],
      }),
      NOW,
    );
    const travel = cost.lines.find((l) => l.category === 'travel')!;
    expect(travel.cents).toBe(0);
    expect(travel.gaps.some((g) => g.what.includes('dry run'))).toBe(true);
  });

  it('counts cash, and reports credit beside the total rather than inside it', () => {
    const cost = rollUpShowCost(
      inputs({
        bookings: [
          { chargedCents: 12_000, creditAppliedCents: 30_000, live: true, cancelledAt: null },
        ],
      }),
      NOW,
    );
    expect(cost.totalCents).toBe(12_000);
    // The other $300 was spent last year on a ticket somebody cancelled, and the
    // show it was bought for already carries it.
    expect(cost.creditFundedCents).toBe(30_000);
  });

  it('drops a cancelled booking entirely', () => {
    const cost = rollUpShowCost(
      inputs({
        bookings: [
          { chargedCents: 50_000, creditAppliedCents: null, live: true, cancelledAt: NOW },
        ],
      }),
      NOW,
    );
    expect(cost.totalCents).toBe(0);
  });

  it('names a confirmed attendee with no travel without calling it an error', () => {
    const cost = rollUpShowCost(
      inputs({
        attendees: [{ confirmed: true, arrivesOn: null, departsOn: null, hasTravel: false }],
      }),
      NOW,
    );
    const travel = cost.lines.find((l) => l.category === 'travel')!;
    expect(travel.gaps[0].what).toContain('may have driven');
  });
});

describe('lodging', () => {
  it('counts nights × rate per reservation and names the room-block undercount', () => {
    const cost = rollUpShowCost(
      inputs({ lodgings: [{ nightlyRateCents: 28_900, nights: 3, guests: 4 }] }),
      NOW,
    );
    expect(cost.totalCents).toBe(86_700);
    const lodging = cost.lines.find((l) => l.category === 'lodging')!;
    expect(lodging.gaps.some((g) => g.kind === 'assumption')).toBe(true);
  });

  it('treats a hotel row with no rate as unpriced rather than as free', () => {
    const cost = rollUpShowCost(
      inputs({ lodgings: [{ nightlyRateCents: null, nights: 3, guests: 1 }] }),
      NOW,
    );
    expect(cost.totalCents).toBe(0);
    expect(cost.lines.find((l) => l.category === 'lodging')!.gaps[0].kind).toBe('unpriced');
  });
});

describe('shipping', () => {
  const outbound = { costCents: 182_000, direction: 'outbound' };

  it('says nothing about a missing return leg before the show has happened', () => {
    // Nobody books the leg home in February, and a gap that fires on every
    // future show is one nobody reads on the show that actually lost a booth.
    const cost = rollUpShowCost(inputs({ shipments: [outbound] }), NOW);
    expect(cost.lines.find((l) => l.category === 'shipping')!.gaps).toHaveLength(0);
  });

  it('reports it once the show has moved out', () => {
    const after = new Date('2026-07-01T12:00:00Z');
    const cost = rollUpShowCost(inputs({ shipments: [outbound] }), after);
    const shipping = cost.lines.find((l) => l.category === 'shipping')!;
    expect(shipping.gaps.some((g) => g.what.includes('coming back'))).toBe(true);
  });
});

describe('collateral', () => {
  it('values consumption outside the total, because the stock was paid for once', () => {
    const cost = rollUpShowCost(
      inputs({ collateral: [{ issued: 400, unitCostCents: 210 }] }),
      NOW,
    );
    expect(cost.consumedCents).toBe(84_000);
    expect(cost.totalCents).toBe(0);
  });

  it('flags a print run and stock issued as possibly the same money', () => {
    const cost = rollUpShowCost(
      inputs({
        expenses: [{ category: 'Collateral', amountCents: 184_000, paid: false }],
        collateral: [{ issued: 400, unitCostCents: 210 }],
      }),
      NOW,
    );
    const line = cost.lines.find((l) => l.category === 'collateral')!;
    expect(line.cents).toBe(184_000);
    expect(line.gaps.some((g) => g.kind === 'double_count')).toBe(true);
  });

  it('does not charge an allocation nobody has picked yet', () => {
    const cost = rollUpShowCost(inputs({ collateral: [{ issued: 0, unitCostCents: 210 }] }), NOW);
    expect(cost.consumedCents).toBe(0);
  });
});

describe('tense and staff time', () => {
  it('keeps committed apart from paid', () => {
    const cost = rollUpShowCost(
      inputs({
        expenses: [
          { category: 'Booth space', amountCents: 560_000, paid: true },
          { category: 'Booth services', amountCents: 104_000, paid: false },
        ],
      }),
      NOW,
    );
    expect(cost.paidCents).toBe(560_000);
    expect(cost.committedCents).toBe(104_000);
  });

  it('counts attendee-days and never prices them', () => {
    const cost = rollUpShowCost(
      inputs({
        attendees: [
          {
            confirmed: true,
            arrivesOn: new Date('2026-06-09T00:00:00Z'),
            departsOn: new Date('2026-06-13T00:00:00Z'),
            hasTravel: true,
          },
          // No window recorded, so the show's own length is the fallback — the
          // same guess `team/conflicts.ts` makes, and named as one.
          { confirmed: true, arrivesOn: null, departsOn: null, hasTravel: true },
        ],
      }),
      NOW,
    );
    expect(cost.attendeeDays).toBe(5 + 4);
    expect(Object.keys(cost)).not.toContain('staffCostCents');
  });

  it('reports no attendee-days at all when nobody has confirmed', () => {
    // Not zero: nobody has answered yet, which is a different fact.
    expect(rollUpShowCost(inputs(), NOW).attendeeDays).toBeNull();
  });

  it('does not count a `confirmed` nobody answered for themselves', () => {
    const cost = rollUpShowCost(
      inputs({
        attendees: [{ confirmed: false, arrivesOn: null, departsOn: null, hasTravel: false }],
      }),
      NOW,
    );
    expect(cost.attendeeDays).toBeNull();
  });
});

describe('coverage', () => {
  it('calls a total a floor unless everything that exists carries a figure', () => {
    const complete = rollUpShowCost(
      inputs({
        expenses: [
          { category: 'Booth space', amountCents: 560_000, paid: true },
          { category: 'Client dinner', amountCents: 40_000, paid: true },
        ],
      }),
      NOW,
    );
    expect(complete.coverage.verdict).toBe('complete');
    expect(complete.isFloor).toBe(false);
  });

  it('treats a missing booth fee as decisive', () => {
    // Every trade show has one, it is usually the largest single line, and it is
    // invoiced months ahead. Its absence is an un-entered invoice.
    const cost = rollUpShowCost(inputs({ shipments: [{ costCents: 1000, direction: 'outbound' }] }), NOW);
    expect(cost.coverage.verdict).toBe('thin');
    expect(cost.coverage.silent).toContain('space');
  });

  it('does not flag a category the show has nothing in', () => {
    const cost = rollUpShowCost(
      inputs({ expenses: [{ category: 'Booth space', amountCents: 560_000, paid: true }] }),
      NOW,
    );
    // No freight rows at all, so shipping is not a hole — flagging it would
    // teach a reader to ignore the flag on the show that is missing one.
    expect(assessCoverage(cost.lines, inputs()).silent).toContain('shipping');
    expect(cost.coverage.verdict).not.toBe('thin');
  });

  it('reports a show with nothing recorded as empty rather than as cheap', () => {
    const cost = rollUpShowCost(inputs(), NOW);
    expect(cost.coverage.verdict).toBe('empty');
    expect(cost.totalCents).toBe(0);
  });
});

describe('portfolio', () => {
  /**
   * Nearest show first, biggest figure breaking the tie. Both shows here share
   * the same dates, so this still asserts the size ordering it always did — the
   * clock cannot separate them.
   */
  it('ranks by size between two shows the same distance away, and counts the floors', () => {
    const big = rollUpShowCost(
      inputs({ expenses: [{ category: 'Booth space', amountCents: 560_000, paid: true }] }),
      NOW,
    );
    const small = rollUpShowCost(
      inputs({
        show: { ...inputs().show, id: 'show-2', name: 'MedTech' },
        shipments: [{ costCents: 1_000, direction: 'outbound' }],
      }),
      NOW,
    );
    const p = summarizePortfolio([small, big], NOW);
    expect(p.shows[0].showName).toBe('Automate 2026');
    expect(p.incomplete).toBe(1);
    expect(p.totalCents).toBe(561_000);
  });

  /**
   * And the clock outranks the money, which is the change. Cost is the one page
   * that is neither purely prospective nor purely retrospective — most of a
   * show's spend is committed before it opens and the invoices land after it
   * closes — so the order is proximity in either direction, and a small show
   * running this week outranks a large one next year.
   */
  it('puts the nearest show first even when a distant one costs more', () => {
    const near = rollUpShowCost(
      inputs({
        show: { ...inputs().show, id: 'near', name: 'Near', startsOn: NOW, endsOn: NOW },
        shipments: [{ costCents: 1_000, direction: 'outbound' }],
      }),
      NOW,
    );
    const distantAndHuge = rollUpShowCost(
      inputs({
        show: {
          ...inputs().show,
          id: 'far',
          name: 'Far',
          startsOn: new Date(NOW.getTime() + 300 * 86_400_000),
          endsOn: new Date(NOW.getTime() + 303 * 86_400_000),
        },
        expenses: [{ category: 'Booth space', amountCents: 9_999_00, paid: true }],
      }),
      NOW,
    );
    const p = summarizePortfolio([distantAndHuge, near], NOW);
    expect(p.shows.map((s) => s.showName)).toEqual(['Near', 'Far']);
  });
});

describe('access', () => {
  const actor = (role: Actor['role']): Actor => ({
    userId: 'u1',
    orgId: 'o1',
    email: 'a@example.com',
    fullName: 'A',
    role,
    costCenterId: null,
  });

  it('is Travel Manager and Admin, the same audience as “see all users’ travel”', () => {
    expect(canSeeCost(actor('member'))).toBe(false);
    expect(canSeeCost(actor('travel_manager'))).toBe(true);
    expect(canSeeCost(actor('admin'))).toBe(true);
  });
});
