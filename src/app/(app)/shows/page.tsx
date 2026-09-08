import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { listShows, type ShowListEntry } from '@/lib/shows/store';
import { canCloneShow } from '@/lib/shows/visibility';
import {
  Badge,
  Empty,
  LinkButton,
  PageHeader,
  STATUS_TONE,
  dateRange,
  daysUntil,
  money,
  place,
  readinessLabel,
  readinessTone,
  statusLabel,
} from '../_components/ui';
import { plural } from '../_components/text';

/**
 * The show calendar.
 *
 * Grouped by where a show sits in its life rather than sorted by date alone: a
 * prospect awaiting a decision and a show three weeks out are different kinds of
 * work, and a single chronological list buries the first behind the second.
 */

export const metadata = { title: 'Shows' };

const BUCKETS = [
  {
    key: 'prospects',
    heading: 'Awaiting a decision',
    blurb: 'Proposed shows. An admin commits or declines each one, with a written reason.',
    has: (s: ShowListEntry) => s.status === 'prospect',
  },
  {
    key: 'active',
    heading: 'On the calendar',
    blurb: null,
    has: (s: ShowListEntry) =>
      ['committed', 'planning', 'ready', 'live'].includes(s.status),
  },
  {
    key: 'past',
    heading: 'Complete',
    blurb: null,
    has: (s: ShowListEntry) => s.status === 'complete',
  },
  {
    key: 'declined',
    heading: 'Declined',
    blurb: 'Kept, not deleted — the record of what we passed on and why.',
    has: (s: ShowListEntry) => s.status === 'cancelled',
  },
] as const;

export default async function ShowsPage() {
  const actor = await getActor();
  const shows = await listShows(actor);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Shows"
        blurb={
          <>
            The whole workspace calendar. Anyone can propose a show; travel and lodging
            details on each one are scoped to you unless you approve travel.
          </>
        }
        action={<LinkButton href="/shows/new">Propose a show</LinkButton>}
      />

      {shows.length === 0 && (
        <Empty>
          No shows yet. Everything here hangs off one — deadlines, freight, the roster, leads
          and what it all cost. Use <strong>Propose a show</strong> above; proposing is not
          committing to it.
        </Empty>
      )}

      {BUCKETS.map((bucket) => {
        const rows = shows.filter(bucket.has);
        if (rows.length === 0) return null;
        return (
          <section key={bucket.key} className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
                {bucket.heading}
              </h2>
              {bucket.blurb && <p className="mt-1 text-xs text-text-muted">{bucket.blurb}</p>}
            </div>
            <div className="space-y-2">
              {rows.map((show) => (
                <ShowRow key={show.id} show={show} canClone={canCloneShow(actor)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ShowRow({ show, canClone }: { show: ShowListEntry; canClone: boolean }) {
  const days = daysUntil(show.startsOn);
  const decided = show.status !== 'prospect' && show.status !== 'cancelled';

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={`/shows/${show.id}`} className="font-medium hover:underline">
          {show.name}
        </Link>
        <Badge tone={STATUS_TONE[show.status]}>{statusLabel(show.status)}</Badge>
        {show.mine && <Badge tone="info">You&rsquo;re on this</Badge>}
        {decided && days > 0 && (
          <span className="text-xs text-text-muted">in {plural(days, 'day', 'days')}</span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-muted">
        <span>{dateRange(show.startsOn, show.endsOn, show.timezone)}</span>
        <span>{place(show)}</span>
        {show.boothNumber && <span>Booth {show.boothNumber}</span>}
        <span>Budget {money(show.budgetCents)}</span>
        <span>
          {show.attendeeCount} {show.attendeeCount === 1 ? 'attendee' : 'attendees'}
        </span>
        {decided && (
          <span className="flex items-center gap-1.5">
            <Badge tone={readinessTone(show.readiness.score)}>
              {readinessLabel(show.readiness.score)}
            </Badge>
            {show.readiness.overdue > 0 && (
              <Badge tone="bad">{show.readiness.overdue} overdue</Badge>
            )}
            {show.readiness.blocked > 0 && (
              <Badge tone="warn">{show.readiness.blocked} blocked</Badge>
            )}
          </span>
        )}
        {canClone && (
          <Link
            href={`/shows/${show.id}/clone`}
            className="ml-auto text-xs underline hover:no-underline"
          >
            Clone for next year
          </Link>
        )}
      </div>
    </div>
  );
}
