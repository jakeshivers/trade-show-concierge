import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth/actor';
import { getShowDetail, NotFoundError } from '@/lib/shows/store';

/**
 * One show detail read per request, shared by the layout and whichever tab is
 * rendering. `cache` dedupes within a single render pass, so the tabs cost one
 * query between them rather than one each.
 *
 * `notFound()` here rather than in each caller: a show id that resolves to
 * nothing — wrong workspace, deleted row — is a 404 everywhere, and leaving that
 * to five pages means four of them eventually get it wrong.
 */
export const loadShow = cache(async (id: string) => {
  const actor = await getActor();
  try {
    return { actor, detail: await getShowDetail(actor, id) };
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
});
