import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { listDayOfShows } from '@/lib/dayof/store';
import { Badge, Card, Empty, PageHeader, dateRange } from '../_components/ui';
import { RegisterServiceWorker } from './_register';

/**
 * Which show am I standing in?
 *
 * Ordered by proximity to *now* rather than by date, because that is the only
 * question this screen is ever asked. A show that is on the floor today comes
 * first; after that, the next one to open.
 *
 * It is a Server Component, unlike the show screen it links to, and the split is
 * deliberate: this page is a list of shows in a workspace, which is not what
 * anybody needs offline in a hall. What has to survive with no signal is the one
 * show you are standing in, and `sw.js` caches this page only as a fallback
 * destination for a navigation it cannot otherwise answer.
 */
export default async function DayOfPicker() {
  const actor = await getActor();
  const shows = await listDayOfShows(actor);

  return (
    <div className="space-y-6">
      <RegisterServiceWorker />
      <PageHeader
        title="Day of"
        blurb="The booth, your shift, the freight and lead capture — built to keep working when the hall wifi does not. Open the show you are at once while you still have a connection, and it will be there when you do not."
      />

      {shows.length === 0 ? (
        <Empty>No shows on the calendar to stand in yet.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shows.map((show) => (
            <Link key={show.id} href={`/day-of/${show.id}`} className="block">
              <Card
                title={show.name}
                subtitle={[show.city, show.boothNumber ? `Booth ${show.boothNumber}` : null]
                  .filter(Boolean)
                  .join(' · ')}
                className="h-full hover:border-border-strong"
              >
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  {show.onFloorNow && <Badge tone="good">on the floor now</Badge>}
                  <span>{dateRange(show.startsOn, show.endsOn, show.timezone)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <p className="text-xs text-text-muted">
        Add this to your home screen and it opens straight here. It stores captures on the device
        until there is a connection to record them with — until then they are on the phone and
        nowhere else, and every screen in this app says so rather than counting them.
      </p>
    </div>
  );
}
