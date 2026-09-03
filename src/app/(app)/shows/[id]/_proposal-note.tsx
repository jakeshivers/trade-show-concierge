'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Where a prospect gets decided, said from wherever you are standing.
 *
 * The show header carries this on all ten tabs, and it used to be one sentence
 * for all of them: *"Commit or decline it on the Overview tab."* On the nine
 * other tabs that is true and was not a link, so acting on it meant reading a
 * sentence and then finding the tab it named. On the Overview tab itself it was
 * worse than unhelpful — it pointed somebody at the tab they were already on,
 * a few inches above the form it was talking about.
 *
 * A layout is a Server Component and cannot know which child route is rendering,
 * so this is the smallest client component that can: it reads the pathname, and
 * says *below* when the form really is below and links to it when it is not.
 */
export function ProposalNote({ showId, canDecide }: { showId: string; canDecide: boolean }) {
  const pathname = usePathname();
  const onOverview = pathname === `/shows/${showId}`;

  if (!canDecide) {
    return (
      <p className="text-sm text-info">
        This is a proposal. An admin decides whether it goes on the calendar.
      </p>
    );
  }

  return (
    <p className="text-sm text-info">
      This is a proposal.{' '}
      {onOverview ? (
        'Commit or decline it below, with a written reason.'
      ) : (
        <>
          <Link href={`/shows/${showId}`} className="underline hover:no-underline">
            Commit or decline it
          </Link>{' '}
          on the Overview tab, with a written reason.
        </>
      )}
    </p>
  );
}
