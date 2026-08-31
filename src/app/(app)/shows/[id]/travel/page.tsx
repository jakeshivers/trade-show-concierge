import Link from 'next/link';
import { Badge, Card, Empty, money, showDateTime, type Tone } from '../../../_components/ui';
import { loadShow } from '../detail';

/**
 * Travel — flights, requests, and lodging for this show.
 *
 * The only tab where §3's visibility line actually bites: a Member sees their own
 * rows and a Travel Manager sees everyone's. The narrowing happens in the query
 * (`travelerScope` in `src/lib/shows/store.ts`), so what a Member's browser
 * receives does not contain a colleague's fare at all. The banner says so, because
 * an empty-looking page that is actually a filtered page reads as a bug.
 */
export default async function TravelTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { detail } = await loadShow(id);
  const { show, flights, requests, lodgings, travelNarrowed } = detail;

  return (
    <div className="space-y-6">
      {travelNarrowed && (
        <p className="rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          Showing your travel only. Seeing everyone&rsquo;s is a travel manager capability.
        </p>
      )}

      <Card title="Flights">
        {flights.length === 0 ? (
          <Empty>No flights recorded for this show.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {flights.map(({ flight, traveler }) => (
              <li
                key={flight.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800"
              >
                <span className="font-medium">
                  {flight.airlineCode} {flight.flightNumber}
                </span>
                <span>
                  {flight.originAirport} → {flight.destinationAirport}
                </span>
                <span className="text-zinc-500">
                  {showDateTime(flight.scheduledDeparture, show.timezone)}
                </span>
                <Badge tone={FLIGHT_TONE[flight.status] ?? 'neutral'}>{flight.status}</Badge>
                {!flight.bookingProvider && <Badge>manually entered</Badge>}
                <span className="ml-auto text-xs text-zinc-500">
                  {traveler.fullName} · {money(flight.priceCents)}
                  {flight.seat && ` · seat ${flight.seat}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          Live status and delay alerts against move-in are step 13.
        </p>
      </Card>

      <Card title="Travel requests">
        {requests.length === 0 ? (
          <Empty>
            No requests for this show.{' '}
            <Link href="/travel/new" className="underline">
              Open one
            </Link>{' '}
            and the agent searches, rules on it against policy, and either books it or sends it for
            approval.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {requests.map(({ request, traveler }) => (
              <li
                key={request.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800"
              >
                <Badge>{request.status}</Badge>
                <Link href={`/travel/${request.id}`} className="hover:underline">
                  {request.originAirport} → {request.destinationAirport}
                </Link>
                <span className="text-zinc-500">
                  {showDateTime(request.earliestDeparture, show.timezone)}
                </span>
                <span className="ml-auto text-xs text-zinc-500">{traveler.fullName}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Lodging">
        {lodgings.length === 0 ? (
          <Empty>No hotel recorded. Lodging is tracked, not booked — SCOPE.md §5.</Empty>
        ) : (
          <ul className="space-y-3">
            {lodgings.map(({ lodging, guests }) => (
              <li key={lodging.id} className="border-b border-zinc-100 pb-3 last:border-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{lodging.hotelName}</span>
                  {lodging.confirmationCode && (
                    <span className="text-xs text-zinc-500">#{lodging.confirmationCode}</span>
                  )}
                  <span className="ml-auto text-xs text-zinc-500">
                    {money(lodging.nightlyRateCents)}/night
                  </span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {showDateTime(lodging.checkIn, show.timezone)} →{' '}
                  {showDateTime(lodging.checkOut, show.timezone)}
                  {lodging.roomBlockCutoff && (
                    <> · block releases {showDateTime(lodging.roomBlockCutoff, show.timezone)}</>
                  )}
                </div>
                <div className="mt-1 text-xs">
                  {guests.length > 0
                    ? guests.map((g) => g.user.fullName).join(', ')
                    : 'No room assignments visible to you.'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const FLIGHT_TONE: Record<string, Tone> = {
  scheduled: 'neutral',
  on_time: 'good',
  delayed: 'warn',
  cancelled: 'bad',
  landed: 'good',
};
