import { describe, it, expect } from 'vitest';
import {
  allocate,
  daysUntil,
  expiryBucket,
  isSpendable,
  matchCreditsToOffer,
  projectBalance,
  statusFor,
  visibilityOf,
  type CreditRow,
} from './credits';

/**
 * The credit ledger's decisions, tested the way the policy engine is: pure
 * functions, no database, no clock. What a credit is worth against a given fare
 * is a rule, and rules should be readable without a fixture server.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-08-30T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

function credit(over: Partial<CreditRow> = {}): CreditRow {
  return {
    id: over.id ?? 'cr_1',
    orgId: 'org_1',
    userId: 'usr_1',
    providerCreditId: null,
    originBookingId: null,
    originFlightId: null,
    airlineCode: 'DL',
    recordLocator: null,
    ticketNumber: null,
    originalValueCents: 50_000,
    remainingValueCents: 50_000,
    currency: 'USD',
    issuedOn: inDays(-100),
    expiresOn: inDays(200),
    status: 'available',
    transferable: false,
    costCenterId: null,
    notes: null,
    ...over,
  } as CreditRow;
}

const ctx = (over: Partial<Parameters<typeof matchCreditsToOffer>[1]> = {}) => ({
  carriers: ['DL'],
  currency: 'USD',
  fareCents: 80_000,
  now: NOW,
  ...over,
});

describe('what counts as spendable', () => {
  it('counts a partially used credit — it is still money', () => {
    const partial = credit({ status: 'partially_used', remainingValueCents: 12_750 });
    expect(isSpendable(partial, NOW)).toBe(true);
  });

  it('does not count a credit expiring at this very instant', () => {
    // Not `>=`. Rounding expiry in our favour buys a ticket the counter rejects.
    expect(isSpendable(credit({ expiresOn: NOW }), NOW)).toBe(false);
    expect(isSpendable(credit({ expiresOn: new Date(NOW.getTime() + 1) }), NOW)).toBe(true);
  });

  it('does not count a credit with nothing left on it', () => {
    expect(isSpendable(credit({ remainingValueCents: 0 }), NOW)).toBe(false);
  });
});

describe('matching credits to one offer', () => {
  it('applies a credit whose carrier is actually on the itinerary', () => {
    const match = matchCreditsToOffer([credit()], ctx());
    expect(match.chosen).toHaveLength(1);
    expect(match.applicableCents).toBe(50_000);
  });

  it('refuses a credit from a carrier the traveler is not flying, and says so', () => {
    const match = matchCreditsToOffer([credit({ airlineCode: 'AA' })], ctx({ carriers: ['DL'] }));
    expect(match.chosen).toHaveLength(0);
    expect(match.rejected[0].reason).toContain('issued by AA');
  });

  it('refuses a credit held in another currency rather than inventing a rate', () => {
    const match = matchCreditsToOffer([credit({ currency: 'EUR' })], ctx({ currency: 'USD' }));
    expect(match.chosen).toHaveLength(0);
    expect(match.rejected[0].reason).toContain('held in EUR');
  });

  it('never claims more than the fare — a credit is not cash back', () => {
    const match = matchCreditsToOffer([credit({ remainingValueCents: 90_000 })], ctx({ fareCents: 40_000 }));
    expect(match.applicableCents).toBe(40_000);
  });

  it('takes one credit per ticket by default and explains the ones it left', () => {
    const match = matchCreditsToOffer(
      [credit({ id: 'a', remainingValueCents: 20_000 }), credit({ id: 'b', remainingValueCents: 35_000 })],
      ctx(),
    );
    expect(match.chosen.map((c) => c.id)).toEqual(['b']);
    expect(match.applicableCents).toBe(35_000);
    expect(match.rejected.map((r) => r.reason)).toContain(
      'only one credit may be applied per ticket by this carrier',
    );
  });

  it('combines when the carrier allows it', () => {
    const match = matchCreditsToOffer(
      [credit({ id: 'a', remainingValueCents: 20_000 }), credit({ id: 'b', remainingValueCents: 35_000 })],
      ctx({ allowCombining: true }),
    );
    expect(match.applicableCents).toBe(55_000);
  });

  it('prefers a smaller credit it can actually redeem over a larger one it cannot', () => {
    // Only one credit goes on a ticket. Picking the bigger unreachable one means
    // the request escalates and nothing is applied — strictly worse.
    const match = matchCreditsToOffer(
      [
        credit({ id: 'big-unreachable', remainingValueCents: 60_000 }),
        credit({ id: 'small-usable', remainingValueCents: 18_000, providerCreditId: 'acr_1' }),
      ],
      ctx(),
    );
    expect(match.chosen.map((c) => c.id)).toEqual(['small-usable']);
    expect(match.redeemableHere).toHaveLength(1);
  });

  it('prefers the credit closest to expiry when two are worth the same', () => {
    const match = matchCreditsToOffer(
      [
        credit({ id: 'later', expiresOn: inDays(300) }),
        credit({ id: 'sooner', expiresOn: inDays(20) }),
      ],
      ctx(),
    );
    expect(match.chosen[0].id).toBe('sooner');
  });

  it('separates credit the provider can redeem from credit needing a phone call', () => {
    const match = matchCreditsToOffer(
      [credit({ id: 'here', providerCreditId: 'acr_1' })],
      ctx(),
    );
    expect(match.redeemableHere.map((c) => c.id)).toEqual(['here']);
    expect(match.redeemableElsewhere).toHaveLength(0);

    const ours = matchCreditsToOffer([credit({ id: 'ours' })], ctx());
    expect(ours.redeemableHere).toHaveLength(0);
    expect(ours.redeemableElsewhere.map((c) => c.id)).toEqual(['ours']);
  });

  it('gives a reason for every credit it did not use', () => {
    const pool = [
      credit({ id: 'wrong-airline', airlineCode: 'UA' }),
      credit({ id: 'dead', expiresOn: inDays(-1) }),
      credit({ id: 'good' }),
    ];
    const match = matchCreditsToOffer(pool, ctx());
    const explained = new Set([...match.chosen, ...match.rejected.map((r) => r.credit)].map((c) => c.id));
    expect(explained).toEqual(new Set(['wrong-airline', 'dead', 'good']));
  });
});

describe('drawing an amount across credits', () => {
  it('never takes more from a credit than it holds', () => {
    const draws = allocate(
      [credit({ id: 'a', remainingValueCents: 30_000 }), credit({ id: 'b', remainingValueCents: 30_000 })],
      45_000,
    );
    expect(draws).toEqual([
      { credit: expect.objectContaining({ id: 'a' }), drawCents: 30_000 },
      { credit: expect.objectContaining({ id: 'b' }), drawCents: 15_000 },
    ]);
  });

  it('stops once the amount is covered', () => {
    const draws = allocate([credit({ id: 'a' }), credit({ id: 'b' })], 10_000);
    expect(draws).toHaveLength(1);
  });
});

describe('the balance is the entries', () => {
  it('projects a balance from signed deltas', () => {
    expect(projectBalance([{ deltaCents: 50_000 }, { deltaCents: -12_000 }, { deltaCents: 12_000 }])).toBe(
      50_000,
    );
  });

  it('derives a status so a spent credit can never read as available', () => {
    const c = credit();
    expect(statusFor(c, 0, inDays(100), NOW)).toBe('used');
    expect(statusFor(c, 20_000, inDays(100), NOW)).toBe('partially_used');
    expect(statusFor(c, 50_000, inDays(100), NOW)).toBe('available');
    // Expiry beats "still has money on it": the money is unreachable.
    expect(statusFor(c, 50_000, inDays(-1), NOW)).toBe('expired');
  });
});

describe('expiry alerting', () => {
  it('picks the tightest bucket a credit has crossed', () => {
    expect(expiryBucket(inDays(95), NOW)).toBe(null);
    expect(expiryBucket(inDays(80), NOW)).toBe(90);
    expect(expiryBucket(inDays(45), NOW)).toBe(60);
    expect(expiryBucket(inDays(3), NOW)).toBe(7);
  });

  it('says nothing about a credit that is already gone — the sweep owns that', () => {
    expect(expiryBucket(inDays(-2), NOW)).toBe(null);
  });

  it('counts whole days left', () => {
    expect(daysUntil(new Date(NOW.getTime() + 2.9 * DAY), NOW)).toBe(2);
  });
});

describe('visibility', () => {
  it('is decided by whether the provider has an id for it, nothing else', () => {
    expect(visibilityOf({ providerCreditId: 'acr_1' })).toBe('redeemable_here');
    expect(visibilityOf({ providerCreditId: null })).toBe('redeemable_elsewhere');
  });
});
