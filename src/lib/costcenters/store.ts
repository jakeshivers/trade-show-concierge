import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, isAdmin, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';

type Db = ReturnType<typeof getDb>;

/**
 * Cost centers — the dimension every financial row in this product is required
 * to carry, and which nothing in the app could create.
 *
 * §4's ground rule is *"every financial row carries a cost center at creation,
 * never backfilled"*, and it is enforced: an expense, a hotel, a side event, a
 * crate, an asset and a collateral item all refuse to be saved without one. The
 * consequence went unnoticed for twenty-four steps because `scripts/seed.ts`
 * inserts three of them — **a real organization has none, so every one of those
 * writes is impossible and no error explains why.** The list is simply empty and
 * the form cannot be submitted.
 *
 * Admin-only, and that is not the usual balance of this codebase. Confirming a
 * crate and capturing a lead are open to anybody because the person holding the
 * fact is whoever is standing there. A cost center is the opposite: it is the
 * shape of the budget, everything filed against it inherits that shape, and it
 * is the one dimension that cannot be corrected later without orphaning history.
 */

export class CostCenterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostCenterError';
  }
}

/**
 * Deactivated rather than deleted, and the reason is the ground rule again.
 *
 * Rows already filed against a cost center point at it, and `expenses`,
 * `lodgings` and `side_events` reference it with `restrict` or `set null`. A
 * delete would either be refused by the database or would quietly null the
 * dimension on historical rows — which is *precisely* the "backfilled to
 * nothing" state §4 exists to prevent, arriving from the other end. So it stops
 * being offered for new rows and every row that already carries it keeps it.
 */
export async function listCostCenters(actor: Actor, db: Db = getDb()) {
  return db
    .select({
      id: s.costCenters.id,
      code: s.costCenters.code,
      name: s.costCenters.name,
      active: s.costCenters.active,
      // What already points at it, so "can I turn this off" is answerable on
      // the page rather than by trying it.
      expenses: sql<number>`(select count(*) from ${s.expenses} where ${s.expenses.costCenterId} = ${s.costCenters.id})`,
      people: sql<number>`(select count(*) from ${s.users} where ${s.users.costCenterId} = ${s.costCenters.id})`,
    })
    .from(s.costCenters)
    .where(eq(s.costCenters.orgId, actor.orgId))
    .orderBy(asc(s.costCenters.code));
}

export async function createCostCenter(
  actor: Actor,
  input: { code: string; name: string },
  db: Db = getDb(),
): Promise<string> {
  if (!isAdmin(actor)) throw new ForbiddenError('create a cost center');

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(code)) {
    throw new CostCenterError(
      'A code is up to 16 characters, letters, digits and hyphens — it is what appears on an ' +
        'export a finance team reconciles against, so it has to survive a spreadsheet.',
    );
  }
  if (name.length < 2) {
    throw new CostCenterError('A name is needed. The code alone is not readable a year later.');
  }

  const clash = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.orgId, actor.orgId), eq(s.costCenters.code, code)),
  });
  if (clash) {
    throw new CostCenterError(
      `${code} already exists${clash.active ? '' : ' and is switched off — turn it back on rather than making a second one'}. ` +
        'Two cost centers with one code is a reconciliation nobody can do.',
    );
  }

  const [row] = await db
    .insert(s.costCenters)
    .values({ orgId: actor.orgId, code, name })
    .returning({ id: s.costCenters.id });
  return row.id;
}

export async function renameCostCenter(
  actor: Actor,
  id: string,
  name: string,
  db: Db = getDb(),
): Promise<void> {
  if (!isAdmin(actor)) throw new ForbiddenError('rename a cost center');
  const clean = name.trim();
  if (clean.length < 2) throw new CostCenterError('A name is needed.');

  const found = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.id, id), eq(s.costCenters.orgId, actor.orgId)),
  });
  if (!found) throw new NotFoundError();

  // The *code* is deliberately not editable. It is the join a finance export is
  // reconciled on, and changing it silently re-labels every historical row that
  // was already exported under the old one.
  await db.update(s.costCenters).set({ name: clean }).where(eq(s.costCenters.id, id));
}

export async function setCostCenterActive(
  actor: Actor,
  id: string,
  active: boolean,
  db: Db = getDb(),
): Promise<void> {
  if (!isAdmin(actor)) throw new ForbiddenError('switch a cost center off');

  const found = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.id, id), eq(s.costCenters.orgId, actor.orgId)),
  });
  if (!found) throw new NotFoundError();

  await db.update(s.costCenters).set({ active }).where(eq(s.costCenters.id, id));
}
