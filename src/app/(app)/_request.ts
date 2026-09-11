import { cache } from 'react';
import { getActor, NotAuthenticatedError, type Actor } from '@/lib/auth/actor';
import { getAlertFeed } from '@/lib/alerts/store';

/**
 * The two facts every render of the shell needs, resolved once per request.
 *
 * The layout and the overview both want the actor, and as of the alert count in
 * the sidebar they both want the feed as well — so without this a single request
 * for `/` runs two actor lookups and two feed queries to render one page.
 *
 * They are **zero-argument** functions on purpose. `cache()` keys on argument
 * identity, and `getAlertFeed(actor)` called from two Server Components is two
 * different `actor` objects and therefore two misses; taking no arguments makes
 * the memo unconditional, which is what "once per request" actually means. Same
 * pattern as `shows/[id]/detail.ts`, one layer out.
 *
 * This lives here rather than in `src/lib` because `cache()` is a request
 * lifetime, and the CLI scripts that share those store functions have no request.
 */

export const currentActor = cache(getActor);

/**
 * `getActorOrNull`'s contract, over the memo.
 *
 * Not `getActorOrNull` itself: that function calls `getActor` internally, so
 * wrapping it would leave the shell's lookup outside the memo and defeat the
 * whole point. Only *absence* is softened here, exactly as it is there — a
 * provisioning failure or a refused login method still throws, because those are
 * answers and swallowing them shows a stranger a signed-out visitor's page.
 */
export async function currentActorOrNull(): Promise<Actor | null> {
  try {
    return await currentActor();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return null;
    throw err;
  }
}

/**
 * The feed the sidebar counts and the overview links to.
 *
 * `feed.summary.outstanding` is the one number both read. What counts as
 * outstanding is `standingOf`'s decision in `alerts/feed.ts` — a `count()` in
 * SQL beside it would agree today and be the `SOURCE_LABEL` bug tomorrow.
 */
export const currentFeed = cache(async () => getAlertFeed(await currentActor()));
