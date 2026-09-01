import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { authenticateScheduler } from '@/lib/schedule/principal';
import { runNightly } from '@/lib/schedule/nightly';

/**
 * `POST /api/cron/nightly` — the seam a scheduler calls. SCOPE.md §10.21.
 *
 * The second route in this product that authenticates without `getActor()`, and
 * the more consequential of the two: the intake endpoint appends a lead, and
 * this one erases every lead past its retention date. `schedule/principal.ts`
 * carries the argument for why the credential resolves to something that is not
 * an `Actor`, and why a missing `CRON_SECRET` is a refusal rather than an open
 * door.
 *
 * **It runs every org, and takes no org parameter.** A body field naming one
 * would make this an enumeration surface — a caller with the secret could
 * discover which workspaces exist by which ones answered — and, worse, a
 * scheduler configured with the wrong id would silently sweep nobody while
 * reporting 200 every night. There is nothing here for a caller to get wrong
 * except the secret.
 *
 * **A failing org does not stop the others.** Each is its own run row with its
 * own `ok`, so one workspace's broken provider cannot leave another's crates
 * unswept — and the response lists every org's outcome rather than a count, so a
 * scheduler's own log is enough to see a workspace that has been failing for a
 * week.
 *
 * GET is deliberately not implemented. Some hosted schedulers issue one, and a
 * job that erases personal data must not be reachable by anything a browser does
 * by following a link.
 */

export const dynamic = 'force-dynamic';
/** Sweeps talk to providers for every leg and every crate. */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const auth = authenticateScheduler(request.headers.get('authorization'));
  if ('refusal' in auth) {
    return NextResponse.json({ error: auth.refusal.message }, { status: auth.refusal.status });
  }

  const db = getDb();
  const orgs = await db.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations);

  const results = [];
  for (const org of orgs) {
    try {
      const run = await runNightly(org.id, { trigger: 'schedule' }, db);
      results.push({
        org: org.name,
        ok: run.ok,
        runId: run.runId,
        summary: run.summary,
      });
    } catch (err) {
      // `runNightly` records its own failures; this catches the case where it
      // could not even open a row, which is a database problem and is worth
      // answering with rather than a 500 that says nothing about the others.
      results.push({ org: org.name, ok: false, runId: null, summary: [(err as Error).message] });
    }
  }

  const ok = results.every((r) => r.ok);
  return NextResponse.json({ ok, orgs: results }, { status: ok ? 200 : 207 });
}
