import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getItinerary } from '@/lib/shows/store';
import {
  Badge,
  Card,
  Empty,
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
  const upcoming = trips.filter((t) => daysUntil(t.show.endsOn) >= 0);
  const past = trips.filter((t) => daysUntil(t.show.endsOn) < 0);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My itinerary</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every show you are staffed on, with your flights, your room, and your shifts.
        </p>
      </header>

      {upcoming.length === 0 && (
        <Empty>
          You are not staffed on any upcoming show. Show leads add attendees from the show&rsquo;s
          Team tab.
        </Empty>
      )}

      {upcoming.map((trip) => (
        <Trip key={trip.show.id} trip={trip} />
      ))}

      {past.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Past</h2>
          {past.map((trip) => (
            <Trip key={trip.show.id} trip={trip} />
          ))}
        </section>
      )}
    </div>
  );
}

type Trip = Awaited<ReturnType<typeof getItinerary>>[number];

function Trip({ trip }: { trip: Trip }) {
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
        <span className="text-zinc-500">{attendee.role}</span>
        {days > 0 && <span className="ml-auto text-xs text-zinc-500">in {days} days</span>}
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {dateRange(show.startsOn, show.endsOn, tz)} · {place(show)}
        {show.venueName && ` · ${show.venueName}`}
        {show.boothNumber && ` · booth ${show.boothNumber}`}
      </p>

      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <Section title="Flights">
          {flights.length === 0 ? (
            <Empty>Nothing booked. Requests go through the travel agent — step 9.</Empty>
          ) : (
            <ul className="space-y-1">
              {flights.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">
                    {f.airlineCode} {f.flightNumber}
                  </span>{' '}
                  {f.originAirport} → {f.destinationAirport}
                  <span className="block text-xs text-zinc-500">
                    {showDateTime(f.scheduledDeparture, tz)}
                    {f.seat && ` · seat ${f.seat}`}
                    {f.bookingReference && ` · ${f.bookingReference}`}
                  </span>
                </li>
              ))}
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
                  <span className="block text-xs text-zinc-500">
                    {showDateTime(l.checkIn, tz)} → {showDateTime(l.checkOut, tz)}
                    {l.confirmationCode && ` · #${l.confirmationCode}`}
                    {l.nightlyRateCents != null && ` · ${money(l.nightlyRateCents)}/night`}
                  </span>
                  {l.address && <span className="block text-xs text-zinc-500">{l.address}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Your booth shifts">
          {shifts.length === 0 ? (
            <Empty>No shifts assigned. Coverage planning is step 12.</Empty>
          ) : (
            <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      <div className="text-sm">{children}</div>
    </div>
  );
}
