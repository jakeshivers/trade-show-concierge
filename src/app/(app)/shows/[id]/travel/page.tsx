import Link from 'next/link';
import { getFlightBoard } from '@/lib/flights/store';
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
  const { actor, detail } = await loadShow(id);
  const { show, requests, lodgings, travelNarrowed } = detail;
  // The board's model rather than the detail loader's raw rows: what a flight is
  // *doing* — late, re-timed, inside the buffer it was approved under — is one
  // computation, and a second one written for a tab would be the copy that
  // disagrees. Same rule as `offerStanding` being shared with the agent.
  const board = await getFlightBoard(actor, { showId: id });

  return (
    <div className="space-y-6">
      {travelNarrowed && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-text-muted">
          Showing your travel only. Seeing everyone&rsquo;s is a travel manager capability.
        </p>
      )}

      <Card title="Flights">
        {board.rows.length === 0 ? (
          <Empty>No flights recorded for this show.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {board.rows.map((row) => (
              <li
                key={row.flight.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-1.5 last:border-0"
              >
                <span className="font-medium">
                  {row.flight.airlineCode} {row.flight.flightNumber}
                </span>
                <span>
                  {row.flight.originAirport} → {row.flight.destinationAirport}
                </span>
                <span className="text-text-muted">
                  {showDateTime(row.flight.scheduledDeparture, row.flight.originTimeZone ?? show.timezone)}
                </span>
                <Badge tone={FLIGHT_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>
                {/* The figure this tab exists to surface: not that a flight is
                    late, but that it no longer lands in time to be useful. */}
                {row.buffer.brokenSincePurchase && (
                  <Badge tone="warn">
                    lands {row.buffer.hoursBefore!.toFixed(1)}h before move-in — needs{' '}
                    {row.buffer.requiredHours}h
                  </Badge>
                )}
                {row.buffer.standing === 'after_move_in' && (
                  <Badge tone="bad">lands after move-in</Badge>
                )}
                {row.freshness.kind === 'never_checked' && <Badge>status never checked</Badge>}
                <span className="ml-auto text-xs text-text-muted">
                  {row.travelerName} · {money(row.booked.priceCents)}
                  {row.booked.seat && ` · seat ${row.booked.seat}`}
                  {!row.booked.bookingProvider && ' · manually entered'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-text-muted">
          Live status, and the arrival buffer re-checked against it, on the{' '}
          <Link href="/flights" className="underline">
            flight board
          </Link>
          .
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
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-1.5 last:border-0"
              >
                <Badge>{request.status}</Badge>
                <Link href={`/travel/${request.id}`} className="hover:underline">
                  {request.originAirport} → {request.destinationAirport}
                </Link>
                <span className="text-text-muted">
                  {showDateTime(request.earliestDeparture, show.timezone)}
                </span>
                <span className="ml-auto text-xs text-text-muted">{traveler.fullName}</span>
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
              <li key={lodging.id} className="border-b border-border pb-3 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{lodging.hotelName}</span>
                  {lodging.confirmationCode && (
                    <span className="text-xs text-text-muted">#{lodging.confirmationCode}</span>
                  )}
                  <span className="ml-auto text-xs text-text-muted">
                    {money(lodging.nightlyRateCents)}/night
                  </span>
                </div>
                <div className="mt-1 text-xs text-text-muted">
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
  active: 'info',
  delayed: 'warn',
  diverted: 'bad',
  cancelled: 'bad',
  landed: 'good',
  unknown: 'warn',
};
