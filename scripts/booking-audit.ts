/**
 * Print the audit trail for a travel request.
 *
 *   pnpm booking:audit <request-id | idempotency-key>
 *   pnpm booking:audit --list
 *
 * Phase A has no screens, so this is how rail 3 gets *surfaced* rather than
 * merely stored. Run `pnpm booking:dry-run` first if the database has no
 * requests in it yet.
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import { getAuditTrail, renderAuditTrail } from '../src/lib/travel/audit';
import { purchasingHistory, purchasingStatus } from '../src/lib/travel/kill-switch';

const db = getDb();

async function list() {
  const rows = await db
    .select({
      id: s.travelRequests.id,
      key: s.travelRequests.idempotencyKey,
      status: s.travelRequests.status,
      route: s.travelRequests.originAirport,
      to: s.travelRequests.destinationAirport,
      at: s.travelRequests.createdAt,
    })
    .from(s.travelRequests)
    .orderBy(desc(s.travelRequests.createdAt))
    .limit(50);

  if (!rows.length) {
    console.log('No travel requests yet. Run `pnpm booking:dry-run` to create some.');
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.route}→${r.to}  ${r.status.padEnd(17)} ${r.key}`,
    );
  }
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === '--list') {
    await list();
    return;
  }

  // A human has the idempotency key far more often than the uuid, so accept both.
  const byKey = await db.query.travelRequests.findFirst({
    where: eq(s.travelRequests.idempotencyKey, arg),
  });
  const id = byKey?.id ?? arg;

  const trail = await getAuditTrail(id, db);
  console.log(renderAuditTrail(trail));

  const status = await purchasingStatus(trail.request.orgId, db);
  const history = await purchasingHistory(trail.request.orgId, db);
  console.log('');
  console.log(
    `Purchasing  ${status.halted ? 'HALTED' : 'active'}` +
      (status.since ? ` since ${status.since.toISOString()}` : ' (never toggled)') +
      (status.reason ? ` — ${status.reason}` : ''),
  );
  for (const h of history.slice(0, 5)) {
    console.log(
      `  ${h.createdAt.toISOString()}  ${h.purchasingHalted ? 'halted ' : 'resumed'}  ${h.reason}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
