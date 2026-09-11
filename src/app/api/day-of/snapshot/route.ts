import { NextResponse, type NextRequest } from 'next/server';
import { getActor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { buildSnapshot } from '@/lib/dayof/store';

/**
 * `GET /api/day-of/snapshot?show=<id>` — the whole day-of screen, as JSON.
 *
 * This is the one place in the app where a screen's data leaves the server as
 * data rather than as HTML, and it is not a preference. Every other page here is
 * a Server Component: it queries, renders, and is useless the moment there is no
 * network, because the *rendering* is on the far side of the connection that has
 * gone. A screen that has to work in a hall with no signal has to hold its own
 * data, which means the data has to be fetchable, cacheable and re-readable by
 * the device — §2's "offline is an architecture decision, not a screen", in the
 * one file where the architecture is visible.
 *
 * It authenticates with `getActor()` like every other route except the intake
 * endpoint, and the snapshot it returns is stamped with that actor's id. The
 * device compares that stamp before rendering anything from its cache, because a
 * cached screen outlives a session and a phone at a booth gets handed around.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const showId = request.nextUrl.searchParams.get('show');
  if (!showId) {
    return NextResponse.json({ error: 'No show id. Pass ?show=<id>.' }, { status: 400 });
  }
  const actor = await getActor();
  try {
    const snapshot = await buildSnapshot(actor, showId, new Date());
    return NextResponse.json(snapshot, {
      // Never a shared cache. This response is one person's view of one show,
      // and the only cache it belongs in is the one on their own device, which
      // the client writes deliberately rather than a proxy writing by accident.
      headers: { 'cache-control': 'no-store, private' },
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'No such show in this workspace.' }, { status: 404 });
    }
    throw err;
  }
}
