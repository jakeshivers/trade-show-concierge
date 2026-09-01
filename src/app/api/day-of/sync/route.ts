import { NextResponse, type NextRequest } from 'next/server';
import { getActor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { applyOutbox } from '@/lib/dayof/store';
import type { QueuedItem } from '@/lib/dayof/outbox';

/**
 * `POST /api/day-of/sync` — a device's queue, handed back to the database.
 *
 * Every item gets an outcome and the response is a list, never a single status.
 * A partial batch is the ordinary case, not an error: nine leads where the
 * seventh has a malformed email should write eight and say so, because the
 * alternative is eight real conversations bouncing back to a phone to protect
 * the atomicity of a batch that only exists because a hall had no wifi.
 *
 * The endpoint is **not** the intake endpoint and deliberately does not reuse
 * it. Intake authenticates a scanner with a key and writes leads attributed to
 * nobody; this authenticates a person, and the lead is attributed to them —
 * which is the entire input to §8c's coverage figure. A device sending through
 * an intake key would produce leads that make everybody's capture coverage look
 * worse, quietly, in the one number step 18 exists to protect.
 *
 * A 200 with an empty `outcomes` array is not possible: `applyOutbox` answers
 * every item it was sent, and `outbox.reconcile` on the device throws rather
 * than dropping anything it was not told about.
 */

export const dynamic = 'force-dynamic';

const MAX_ITEMS = 200;

type Body = { showId?: unknown; items?: unknown };

export async function POST(request: NextRequest) {
  const actor = await getActor();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'The request body is not JSON.' }, { status: 400 });
  }

  const showId = typeof body.showId === 'string' ? body.showId : null;
  if (!showId) return NextResponse.json({ error: 'No showId.' }, { status: 400 });
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: 'No items.' }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS) {
    // A bound rather than a refusal to think about it: a device that has been
    // offline for two days sends what it has, in pages, and every page is
    // answered in full.
    return NextResponse.json(
      { error: `Send at most ${MAX_ITEMS} items at a time.` },
      { status: 413 },
    );
  }

  const items = body.items as QueuedItem[];
  try {
    const outcomes = await applyOutbox(actor, showId, items, new Date());
    return NextResponse.json({ outcomes }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'No such show in this workspace.' }, { status: 404 });
    }
    throw err;
  }
}
