import Link from 'next/link';
import { canCloneShow, canDecideShow } from '@/lib/shows/visibility';
import { Tabs } from '../../_components/tabs';
import { loadShow } from './detail';
import {
  Badge,
  STATUS_TONE,
  dateRange,
  daysUntil,
  place,
  statusLabel,
} from '../../_components/ui';

/**
 * Show detail — the header and its tabs.
 *
 * The tabs are real routes rather than client state so a link to a show's
 * deadlines is a link to a show's deadlines. Steps 9–12 made each of them
 * editable in turn; Logistics is the last one still read-only, and says so where
 * its controls would be. None of them promise an action that does not exist yet.
 */

const TABS = [
  { segment: '', label: 'Overview' },
  { segment: 'readiness', label: 'Readiness' },
  { segment: 'team', label: 'Team' },
  { segment: 'lodging', label: 'Lodging' },
  { segment: 'travel', label: 'Travel' },
  { segment: 'logistics', label: 'Logistics' },
];

export default async function ShowLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { actor, detail } = await loadShow(id);
  const { show } = detail;
  const days = daysUntil(show.startsOn);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/shows" className="text-xs text-zinc-500 hover:underline">
          ← All shows
        </Link>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{show.name}</h1>
          <Badge tone={STATUS_TONE[show.status]}>{statusLabel(show.status)}</Badge>
          {canCloneShow(actor) && (
            <Link
              href={`/shows/${show.id}/clone`}
              className="ml-auto text-sm underline hover:no-underline"
            >
              Clone
            </Link>
          )}
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {dateRange(show.startsOn, show.endsOn, show.timezone)} · {place(show)}
          {show.venueName && ` · ${show.venueName}`}
          {days > 0 && show.status !== 'cancelled' && ` · in ${days} days`}
        </p>
        {show.status === 'prospect' && (
          <p className="text-sm text-sky-800 dark:text-sky-300">
            This is a proposal.{' '}
            {canDecideShow(actor)
              ? 'Commit or decline it on the Overview tab.'
              : 'An admin decides whether it goes on the calendar.'}
          </p>
        )}
      </header>

      <Tabs
        items={TABS.map((tab) => ({
          href: `/shows/${show.id}${tab.segment ? `/${tab.segment}` : ''}`,
          label: tab.label,
        }))}
      />

      {children}
    </div>
  );
}
