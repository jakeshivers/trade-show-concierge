import { getActor } from '@/lib/auth/actor';
import { DayOf } from './_client';
import { RegisterServiceWorker } from '../_register';

/**
 * The day-of screen's server half, which deliberately fetches nothing.
 *
 * Every other detail page in this app queries here and renders the result. This
 * one passes an id and a name, and the reason is the service worker sitting
 * underneath it: whatever HTML this returns is **cached and served again
 * tomorrow**. Data rendered into it would be a second copy of the show's facts,
 * with no instant attached, that the freshness line at the top of the screen
 * knows nothing about — two sources, one of them invisible, disagreeing on a
 * morning when somebody is deciding whether the booth is going to arrive.
 *
 * So there is exactly one copy of the data on the device, in IndexedDB, stamped
 * with the moment it was taken. What is in the document is the shell and an
 * identity: the identity is what lets the client refuse to render a cached
 * snapshot belonging to whoever held the phone last.
 */
export default async function DayOfShow({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  return (
    <>
      <RegisterServiceWorker />
      <DayOf showId={id} actorId={actor.userId} actorName={actor.fullName} />
    </>
  );
}
