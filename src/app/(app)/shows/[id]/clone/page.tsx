import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/auth/actor';
import { loadCloneSource, NotFoundError } from '@/lib/shows/store';
import { canCloneShow } from '@/lib/shows/visibility';
import { instantToZoned, shiftDaysPreservingLocalTime } from '@/lib/datetime/zoned';
import { Card, PageHeader, dateRange } from '../../../_components/ui';
import { CloneForm } from './form';

/**
 * Clone a show into next year.
 *
 * The screen's job is to be honest about what a clone is: a *draft*, landing as a
 * prospect, with predicted dates and no confirmations. The list of what it will
 * never carry is on the page rather than in a tooltip, because the failure mode is
 * somebody assuming last year's hotel and crate came along.
 */
export default async function CloneShowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();

  if (!canCloneShow(actor)) {
    return (
      <p className="text-sm text-text-muted">
        Cloning a show is a travel manager or admin capability.
      </p>
    );
  }

  let source;
  try {
    source = await loadCloneSource(actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { show } = source;

  // A year later, same weekday — the default a trade show calendar actually uses.
  const suggestedStart = instantToZoned(
    shiftDaysPreservingLocalTime(show.startsOn, 364, show.timezone),
    show.timezone,
  ).slice(0, 10);
  const suggestedName = show.name.replace(/\b(20\d{2})\b/, (y) => String(Number(y) + 1));

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/shows/${show.id}`} className="text-xs text-text-muted hover:underline">
          ← {show.name}
        </Link>
        <PageHeader
          title="Clone this show"
          blurb={
            <>
              Source: {show.name}, {dateRange(show.startsOn, show.endsOn, show.timezone)}. The
              clone lands as a <strong>prospect</strong> — cloning drafts a show, it does not
              commit to one.
            </>
          }
        />
      </div>

      <Card>
        <CloneForm
          sourceId={show.id}
          suggestedName={suggestedName === show.name ? `${show.name} (copy)` : suggestedName}
          suggestedStart={suggestedStart}
          counts={{
            tasks: source.tasks.length,
            deadlines: source.deadlines.length,
            team: source.attendees.length,
            assets: source.reservations.length,
          }}
        />
      </Card>

      <Card title="What a clone never carries">
        <ul className="list-disc space-y-1 pl-5">
          <li>Flights and travel requests — last year&rsquo;s itineraries, not this year&rsquo;s.</li>
          <li>Lodging and confirmation codes — a copied confirmation code confirms nothing.</li>
          <li>Shipments and tracking numbers — a copy would be a shipment that never shipped.</li>
          <li>Expenses, leads, meetings, and outcomes — the record of what happened, once.</li>
          <li>
            The booth number. Halls reassign them, and a crate labelled with last year&rsquo;s
            booth goes to a stranger.
          </li>
        </ul>
      </Card>
    </div>
  );
}
