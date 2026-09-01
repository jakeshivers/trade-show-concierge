import Link from 'next/link';
import { canApprove } from '@/lib/auth/actor';
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
 * deadlines is a link to a show's deadlines. Steps 9–14 made each of them
 * editable in turn, step 16 gave Logistics its chain of custody, and step 18
 * added Leads and step 19 ROI — there is no read-only tab left. None of them promise an action
 * that does not exist yet, and Cost is not shown at all to somebody who may not
 * read it.
 */

const TABS = [
  { segment: '', label: 'Overview' },
  { segment: 'readiness', label: 'Readiness' },
  { segment: 'team', label: 'Team' },
  { segment: 'lodging', label: 'Lodging' },
  { segment: 'travel', label: 'Travel' },
  { segment: 'logistics', label: 'Logistics' },
  // Everybody, deliberately. The lead count is the show's scoreboard and §8c's
  // whole mitigation is that a thin one is visibly thin to the person who could
  // fix it; the personal detail behind it is narrowed in the query instead.
  { segment: 'leads', label: 'Leads' },
  // Not shown to a Member at all, rather than shown and refused. A tab that
  // exists and says no is an invitation to ask why; a show's cost is every
  // colleague's fare in one number, and §3 draws that line around travel.
  { segment: 'cost', label: 'Cost', approverOnly: true },
  // The ninth, and the last one, because it is the other eight added up. Not
  // rendered for a Member for Cost's reason — an ROI figure has a cost figure
  // inside it.
  { segment: 'roi', label: 'ROI', approverOnly: true },
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
        <Link href="/shows" className="text-xs text-text-muted hover:underline">
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
        <p className="text-sm text-text-muted">
          {dateRange(show.startsOn, show.endsOn, show.timezone)} · {place(show)}
          {show.venueName && ` · ${show.venueName}`}
          {days > 0 && show.status !== 'cancelled' && ` · in ${days} days`}
        </p>
        {show.status === 'prospect' && (
          <p className="text-sm text-info">
            This is a proposal.{' '}
            {canDecideShow(actor)
              ? 'Commit or decline it on the Overview tab.'
              : 'An admin decides whether it goes on the calendar.'}
          </p>
        )}
      </header>

      <Tabs
        items={TABS.filter((tab) => !tab.approverOnly || canApprove(actor)).map((tab) => ({
          href: `/shows/${show.id}${tab.segment ? `/${tab.segment}` : ''}`,
          label: tab.label,
        }))}
      />

      {children}
    </div>
  );
}
