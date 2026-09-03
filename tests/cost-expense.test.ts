import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { ExpenseError } from '@/lib/cost/edit';
import {
  addExpense,
  costCentersForExpense,
  deleteExpense,
  getShowCost,
  listShowExpenses,
} from '@/lib/cost/store';
import { listShows } from '@/lib/shows/store';

/**
 * The write the rollup never had.
 *
 * The claim worth asserting is not that an insert inserts — it is that filing an
 * invoice **moves the figure the screen argues about**. `/cost` has said "at
 * least $X, most costs missing" on every real workspace since step 17 because
 * nothing could write `expenses`, so what is tested here is the loop closing:
 * file a booth-space cost, and the line that was silent stops being silent.
 */

const db = getDb();
const ADMIN = 'shelley@northwindrobotics.test';
const MEMBER = 'priya@northwindrobotics.test';

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let admin: Actor;
let showId: string;
let costCenterId: string;
const scratch: string[] = [];

beforeAll(async () => {
  admin = await actorFor(ADMIN);
  const shows = await listShows(admin);
  showId = shows.find((sh) => sh.status === 'committed')!.id;
  costCenterId = (await costCentersForExpense(admin))[0].id;
});

afterAll(async () => {
  for (const id of scratch) await db.delete(s.expenses).where(eq(s.expenses.id, id));
});

describe('filing what a show cost', () => {
  it('closes a silent line — which is the whole point of the screen', async () => {
    const before = await getShowCost(admin, showId);
    const spaceWasSilent = before.coverage.silent.includes('space');

    const id = await addExpense(admin, showId, {
      category: 'space',
      description: '20x20 island space, invoice 4471',
      amount: '24500.00',
      costCenterId,
      paid: false,
      incurredOn: '2026-06-01',
    });
    scratch.push(id);

    const after = await getShowCost(admin, showId);
    expect(after.totalCents).toBe(before.totalCents + 2_450_000);
    if (spaceWasSilent) expect(after.coverage.silent).not.toContain('space');
    // Recorded and owed, not paid: `paid` is the only tense marker in the money.
    expect(after.paidCents).toBe(before.paidCents);
  });

  it('parses money as a decimal rather than a float', async () => {
    const id = await addExpense(admin, showId, {
      category: 'services',
      description: 'Electrical, 20A drop',
      amount: '1234.56',
      costCenterId,
      paid: true,
      incurredOn: null,
    });
    scratch.push(id);
    const rows = await listShowExpenses(admin, showId);
    expect(rows.find((r) => r.id === id)!.amountCents).toBe(123_456);
  });

  it('refuses a row with no cost center, because §4 is never backfilled', async () => {
    await expect(
      addExpense(admin, showId, {
        category: 'space',
        description: 'Booth space',
        amount: '100.00',
        costCenterId: null,
        paid: false,
        incurredOn: null,
      }),
    ).rejects.toThrow(ExpenseError);
  });

  it('refuses a zero-dollar line, which would read as "this was free"', async () => {
    await expect(
      addExpense(admin, showId, {
        category: 'space',
        description: 'Booth space',
        amount: '0.00',
        costCenterId,
        paid: false,
        incurredOn: null,
      }),
    ).rejects.toThrow(ExpenseError);
  });

  it('will not let a Member file or read one — the same audience that reads the total', async () => {
    const priya = await actorFor(MEMBER);
    await expect(
      addExpense(priya, showId, {
        category: 'space',
        description: 'Booth space',
        amount: '100.00',
        costCenterId,
        paid: false,
        incurredOn: null,
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(listShowExpenses(priya, showId)).rejects.toThrow(ForbiddenError);
    await actorFor(ADMIN);
  });

  it('removes a line filed with a slipped decimal point', async () => {
    const id = await addExpense(admin, showId, {
      category: 'other',
      description: 'Typo, filed as 304000',
      amount: '3040.00',
      costCenterId,
      paid: false,
      incurredOn: null,
    });
    const mid = await getShowCost(admin, showId);
    await deleteExpense(admin, id);
    const after = await getShowCost(admin, showId);
    expect(after.totalCents).toBe(mid.totalCents - 304_000);
  });
});
