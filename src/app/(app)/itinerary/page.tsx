import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getItinerary } from '@/lib/shows/store';
import { getFlightBoard } from '@/lib/flights/store';
import type { BoardRow } from '@/lib/flights/board';
import {
  Badge,
  Card,
  Empty,
  LinkButton,
  PageHeader,
  dateRange,
  daysUntil,
  money,
  place,
  showDateTime,
} from '../_components/ui';

/**
 * My Itinerary — the Member's home screen.
 *
 * SCOPE.md §1: "for a Member, this app should be almost invisible. Submit a
 * request, get a ticket, see your itinerary." So this page answers exactly three
 * questions — where am I going, how am I getting there, where am I sleeping —
 * and it is the actor's own rows always, for every role. A travel manager looking
 * at somebody else's travel does that from the show.
 */

export const metadata = { title: 'My itinerary' };

export default async function ItineraryPage() {
  const actor = await getActor();
  const trips = await getItinerary(actor);
  // The actor's own legs, through the same model the board uses. A traveler
  // reading "on time" on their itinerary while the flight board says the
  // arrival buffer is gone would be two screens disagreeing about one flight,
  // and the one they happened to open would decide what they believed.
  const board = await getFlightBoard(actor);
  const legs = new Map<string, BoardRow>(board.rows.map((r) => [r.flight.id, r]));
  const upcoming = trips.filter((t) => daysUntil(t.show.endsOn) >= 0);
  const past = trips.filter((t) => daysUntil(t.show.endsOn) < 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="My itinerary"
        blurb={
          <>
            Every show you are staffed on, with your flights, your room, and your shifts.
          </>
        }
        action={<LinkButton href="/travel/new" variant="primary">Request travel</LinkButton>}
      />

      {upcoming.length === 0 && (
        <Empty>
          You are not staffed on any upcoming show. Show leads add attendees from the show&rsquo;s
          Team tab.
        </Empty>
      )}

      {upcoming.map((trip) => (
        <Trip key={trip.show.id} trip={trip} legs={legs} />
      ))}

      {past.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">Past</h2>
          {past.map((trip) => (
            <Trip key={trip.show.id} trip={trip} legs={legs} />
          ))}
        </section>
      )}
    </div>
  );
}

type Trip = Awaited<ReturnType<typeof getItinerary>>[number];

function Trip({ trip, legs }: { trip: Trip; legs: Map<string, BoardRow> }) {
  const { show, attendee, flights, lodging, shifts, requests } = trip;
  const tz = show.timezone;
  const days = daysUntil(show.startsOn);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={`/shows/${show.id}`} className="text-base font-medium hover:underline">
          {show.name}
        </Link>
        <Badge tone={attendee.status === 'confirmed' ? 'good' : 'info'}>{attendee.status}</Badge>
        <span className="text-text-muted">{attendee.role}</span>
        {days > 0 && <span className="ml-auto text-xs text-text-muted">in {days} days</span>}
      </div>
      <p className="mt-1 text-sm text-text-muted">
        {dateRange(show.startsOn, show.endsOn, tz)} · {place(show)}
        {show.venueName && ` · ${show.venueName}`}
        {show.boothNumber && ` · booth ${show.boothNumber}`}
      </p>

      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <Section title="Flights">
          {flights.length === 0 ? (
            <Empty>
              Nothing booked. A ticketed request files its itinerary here automatically; a
              flight booked elsewhere is recorded on the show&rsquo;s Travel tab.
            </Empty>
          ) : (
            <ul className="space-y-1">
              {flights.map((f) => {
                const leg = legs.get(f.id);
                return (
                  <li key={f.id}>
                    <span className="font-medium">
                      {f.airlineCode} {f.flightNumber}
                    </span>{' '}
                    {f.originAirport} → {f.destinationAirport}{' '}
                    {leg && leg.status !== 'scheduled' && (
                      <Badge tone={LEG_TONE[leg.status] ?? 'neutral'}>{leg.status}</Badge>
                    )}
                    <span className="block text-xs text-text-muted">
                      {showDateTime(f.scheduledDeparture, f.originTimeZone ?? tz)}
                      {f.seat && ` · seat ${f.seat}`}
                      {f.bookingReference && ` · ${f.bookingReference}`}
                    </span>
                    {/* The airline moved the flight itself — beside the times the
                        ticket was bought against, never over them. */}
                    {leg?.flight.scheduleChangedAt && leg.flight.providerScheduledDeparture && (
                      <span className="block text-xs text-warn">
                        The airline has re-timed this flight to{' '}
                        {showDateTime(
                          leg.flight.providerScheduledDeparture,
                          f.originTimeZone ?? tz,
                        )}
                        .
                      </span>
                    )}
                    {leg &&
                      (leg.buffer.standing === 'after_move_in' ||
                        leg.buffer.brokenSincePurchase) && (
                        <span className="block text-xs text-warn">
                          {leg.buffer.standing === 'after_move_in'
                            ? 'This now lands after move-in has started.'
                            : `This now lands ${leg.buffer.hoursBefore!.toFixed(1)}h before move-in, ` +
                              `inside the ${leg.buffer.requiredHours}h it was booked against.`}
                        </span>
                      )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Where you're staying">
          {lodging.length === 0 ? (
            <Empty>No room assigned yet.</Empty>
          ) : (
            <ul className="space-y-1">
              {lodging.map((l) => (
                <li key={l.id}>
                  <span className="font-medium">{l.hotelName}</span>
                  <span className="block text-xs text-text-muted">
                    {showDateTime(l.checkIn, tz)} → {showDateTime(l.checkOut, tz)}
                    {l.confirmationCode && ` · #${l.confirmationCode}`}
                    {l.nightlyRateCents != null && ` · ${money(l.nightlyRateCents)}/night`}
                  </span>
                  {l.address && <span className="block text-xs text-text-muted">{l.address}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Your booth shifts">
          {shifts.length === 0 ? (
            <Empty>No shifts assigned. Shifts are set on the show&rsquo;s Team tab.</Empty>
          ) : (
            <ul className="space-y-1 text-xs text-text-muted">
              {shifts.map((sh) => (
                <li key={sh.id}>
                  {showDateTime(sh.startsAt, tz)} → {showDateTime(sh.endsAt, tz)}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Your travel requests">
          {requests.length === 0 ? (
            <Empty>None open.</Empty>
          ) : (
            <ul className="space-y-1">
              {requests.map((r) => (
                <li key={r.id}>
                  <Badge>{r.status}</Badge>{' '}
                  <span className="text-xs">
                    {r.originAirport} → {r.destinationAirport}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Card>
  );
}

const LEG_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  active: 'info',
  landed: 'good',
  delayed: 'warn',
  diverted: 'bad',
  cancelled: 'bad',
  unknown: 'warn',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      <div className="text-sm">{children}</div>
    </div>
  );
}
