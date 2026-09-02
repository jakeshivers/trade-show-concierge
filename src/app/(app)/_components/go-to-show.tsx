import Link from 'next/link';
import { listShows } from '@/lib/shows/store';
import { distanceToNow } from '@/lib/shows/proximity';
import type { Actor } from '@/lib/auth/actor';
import { cn } from './cn';
import { dateRange, place } from './ui';

/**
 * The call to action on a portfolio board.
 *
 * Every board in this product reads across the whole calendar and every *write*
 * lives on one show's tab, because a crate, a task, a lead and a roll call all
 * belong to a show and none of them can be created without one. That is the
 * right model and it left the boards with no visible way in: `/shipping` told
 * you freight is added on a show's Logistics tab only when there was no freight
 * at all, so the moment the board had a single row the sentence disappeared and
 * with it the only instruction on the page.
 *
 * So the CTA is a *chooser* rather than a button. It refuses to guess the show —
 * picking "the next one" would file a crate against the wrong show as readily as
 * the right one, and there is nothing on a board that says which show the person
 * is thinking about. `<details>` keeps it a server component: no client
 * JavaScript, and the list is real rows rather than a menu that has to be
 * fetched.
 *
 * Shows are ordered by proximity to *now* — the day-of picker's rule — because a
 * board is read while something is happening, and the show somebody is entering
 * freight against is almost never the one that starts alphabetically first.
 */

export type ShowTab =
  | 'readiness'
  | 'team'
  | 'travel'
  | 'lodging'
  | 'logistics'
  | 'cost'
  | 'leads'
  | 'roi'
  | 'safety';

export async function GoToShow({
  actor,
  tab,
  label,
  hint,
  hash,
  asOf = new Date(),
}: {
  actor: Actor;
  /** Which tab the write actually lives on. */
  tab: ShowTab;
  /** The verb, in the words the destination uses. */
  label: string;
  /** One line under the list saying what happens next, if it is not obvious. */
  hint?: React.ReactNode;
  /** Anchor on the destination tab, so the form is on screen rather than below the fold. */
  hash?: string;
  asOf?: Date;
}) {
  const shows = await listShows(actor, asOf);
  if (shows.length === 0) return null;

  const ordered = [...shows].sort((a, b) => distanceToNow(a, asOf) - distanceToNow(b, asOf));

  return (
    <details className="group relative">
      <summary
        className={cn(
          'inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-1.5',
          'bg-brand text-sm font-medium text-brand-fg shadow-sm transition-colors hover:bg-brand-hover',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        {label}
        <span aria-hidden className="text-xs opacity-80 group-open:hidden">▾</span>
        <span aria-hidden className="hidden text-xs opacity-80 group-open:inline">▴</span>
      </summary>
      <div
        className={cn(
          'absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden',
          'rounded-lg border border-border bg-panel shadow-lg',
        )}
      >
        <p className="border-b border-border bg-muted px-3 py-2 text-xs text-text-muted">
          Which show?
        </p>
        <ul className="max-h-80 overflow-y-auto">
          {ordered.map((show) => (
            <li key={show.id} className="border-b border-border last:border-0">
              <Link
                href={`/shows/${show.id}/${tab}${hash ? `#${hash}` : ''}`}
                className="block px-3 py-2 hover:bg-muted"
              >
                <span className="block text-sm font-medium">{show.name}</span>
                <span className="block text-xs text-text-muted">
                  {dateRange(show.startsOn, show.endsOn, show.timezone)} · {place(show)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {hint && <p className="border-t border-border px-3 py-2 text-xs text-text-muted">{hint}</p>}
      </div>
    </details>
  );
}

