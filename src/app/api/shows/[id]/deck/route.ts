import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { buildDeck } from '@/lib/deck/build';
import { canExportDeck } from '@/lib/deck/access';
import { planShowDeck } from '@/lib/deck/store';

/**
 * The executive brief, as a download.
 *
 * A **route** rather than a server action, because an action returns a value to
 * a React tree and this returns a 300KB binary with a filename. It is a `GET`
 * so the browser handles it as a navigation and the file lands in Downloads
 * with no client JavaScript — the same reason the day-of screen is the only
 * client component in the app.
 *
 * `dynamic = 'force-dynamic'` and the Node runtime are both load-bearing: the
 * deck is resolved per actor and pptxgenjs is a Node library. Nothing here is
 * cacheable — two people on the same show get different decks.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const actor = await getActor();
    if (!canExportDeck(actor)) return new Response('Not permitted.', { status: 403 });

    const deck = await planShowDeck(actor, id);
    const file = await buildDeck(deck);

    return new Response(new Uint8Array(file), {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        // Quoted, because a show name contains spaces and commas.
        'content-disposition': `attachment; filename="${deck.fileName}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof NotFoundError) return new Response('No such show.', { status: 404 });
    if (err instanceof ForbiddenError) return new Response(err.message, { status: 403 });
    throw err;
  }
}
