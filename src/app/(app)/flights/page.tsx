import { RefreshButton } from '../alerts/forms';
import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { BOARD_HORIZON_HOURS, getFlightBoard } from '@/lib/flights/store';
import { selectStatusProviderOrNull } from '@/lib/flights/provider';
import type { BoardRow } from '@/lib/flights/board';
import {
  Badge,
  Card,
  Empty,
  LinkButton,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
  type Tone,
} from '../_components/ui';

/**
 * The flight board — every leg still ahead of somebody, soonest first.
 *
 * It was sorted worst-first for twelve steps, and the horizon is what changed
 * the answer rather than an argument against it: once a landed leg stops
 * appearing, everything here is a flight somebody still has to catch, and among
 * those the clock is the order the work happens in. What the old ranking was
 * protecting is kept and moved to where it belongs — trouble is in the summary
 * above, in the tone on the row, and in the alerts card, none of which depend on
 * somebody scanning down a table to find it. `board.ts` holds the ordering and
 * the full reasoning.
 *
 * Two things this screen refuses to do, both of which a flight board does by
 * default. It does not report delays as such: a delay that does not touch the
 * arrival buffer is weather, it is counted in its own quiet figure, and it does
 * not colour a row. And it never renders "on time" for a row nobody has checked
 * — an unchecked flight past its departure reads `unknown`, and the age of the
 * last reading is in the table beside the status rather than left to be assumed.
 */

export const metadata = { title: 'Flight board' };
export const dynamic = 'force-dynamic';

export default async function FlightBoardPage() {
  const actor = await getActor();
  const board = await getFlightBoard(actor);
  const status = selectStatusProviderOrNull();
  // Replayed if the configured provider replays *or* if any reading on the page
  // came from one. A workspace seeded against `recorded` and then pointed at a
  // real key still has replayed readings on it until the next sweep, and the
  // banner has to be about the rows, not about the environment variable.
  const replayed =
    ('choice' in status && status.choice.replayed) ||
    board.rows.some((r) => r.flight.statusProvider === 'recorded');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flight board"
        blurb={
          <>
            Every leg still ahead of somebody, soonest first. Anything wrong is flagged on the
            row and counted above. A delay only matters here against the show somebody is flying
            to: every leg is re-checked against the arrival buffer the trip was approved under,
            not just once when it was booked.
          </>
        }
        action={
          // Two acts, and the board needed both. "Request travel" is where a leg
          // comes from — nothing here types a flight in. "Re-check" is the one
          // this page was missing: it renders `unchecked` on any row nobody has
          // asked a carrier about recently, and until now the only button that
          // could clear that lived on /alerts. A screen that reports staleness
          // and cannot clear it teaches people to stop believing the freshness.
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton />
            <LinkButton href="/travel/new" variant="primary">
              Request travel
            </LinkButton>
          </div>
        }
      />

      {!('choice' in status) && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          No status provider is configured, so nothing on this page has been checked with a
          carrier. {status.unavailable}
        </p>
      )}
      {replayed && (
        <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          Some or all status readings on this page are replayed from recorded payloads
          (<code>FLIGHT_STATUS_PROVIDER=recorded</code>) rather than reported by a carrier. The
          provider column says which. No airline was asked about a flight marked{' '}
          <code>recorded</code>.
        </p>
      )}

      {board.rows.length === 0 ? (
        <Empty>
          No flights. Legs appear here when the booking agent tickets a request, or when
          somebody records a flight they booked elsewhere.
        </Empty>
      ) : (
        <>
          <Card title="Across the workspace">
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Tracked" value={board.summary.tracked} />
              <Stat
                label="Buffer at risk"
                value={board.summary.bufferAtRisk}
                tone={board.summary.bufferAtRisk > 0 ? 'bad' : 'neutral'}
                note="Lands inside — or past — the buffer the trip was approved under."
              />
              <Stat
                label="Cancelled or diverted"
                value={board.summary.disrupted}
                tone={board.summary.disrupted > 0 ? 'bad' : 'neutral'}
              />
              {/* Counted apart from the figure above on purpose: fold weather into
                  the number that means trouble and the number stops meaning it. */}
              <Stat
                label="Late, buffer holds"
                value={board.summary.delayedButClear}
                note="Late, but still landing in time for the show. Nothing to do."
              />
              <Stat
                label="Status unknown"
                value={board.summary.unknown + board.summary.neverChecked}
                tone={board.summary.unknown > 0 ? 'warn' : 'neutral'}
                note="Not the same as on time. Nobody has been able to check these."
              />
            </div>
          </Card>

          <Card title="Legs">
            {/* Said rather than left to be noticed. A board is an operations
                screen and a leg that landed yesterday cannot be acted on, but a
                screen that quietly drops rows is one nobody can trust the counts
                on. The record itself is not gone, and this says where it is. */}
            <p className="mb-3 text-xs text-text-muted">
              Legs that landed more than {BOARD_HORIZON_HOURS} hours ago are not here — nothing
              on this page can change how one of those turned out. A show’s own Travel tab keeps
              its whole history, past shows included.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Flight</Th>
                  <Th>Route</Th>
                  <Th>Traveler</Th>
                  <Th>Departs (local)</Th>
                  <Th>Status</Th>
                  <Th>Lands before move-in</Th>
                  <Th>Last checked</Th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((row) => (
                  <Leg key={row.flight.id} row={row} />
                ))}
              </tbody>
            </Table>
          </Card>

          {board.rows.some((r) => r.alert) && (
            <Card title="What the engine would say">
              <ul className="space-y-3">
                {board.rows
                  .filter((r) => r.alert)
                  .map((r) => (
                    <li key={r.flight.id} className="border-b border-border pb-3 last:border-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge tone={SEVERITY_TONE[r.alert!.severity]}>{r.alert!.severity}</Badge>
                        <span className="font-medium">{r.alert!.title}</span>
                      </div>
                      <p className="mt-1 text-sm text-text-muted">{r.alert!.body}</p>
                    </li>
                  ))}
              </ul>
              <p className="mt-3 text-xs text-text-muted">
                These are written to the alerts table by the nightly sweep, keyed to the standing
                they report rather than to the arrival estimate — so an estimate drifting four
                minutes either way all evening is not four pieces of news. Each traveler reads their
                own on the <a className="underline hover:no-underline" href="/alerts">alerts
                feed</a>; a delay that comes back inside the buffer resolves itself there.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Leg({ row }: { row: BoardRow }) {
  const f = row.flight;
  const zone = f.originTimeZone ?? row.showTimezone;
  return (
    <tr>
      <Td>
        <span className="font-medium">
          {f.airlineCode} {f.flightNumber}
        </span>
      </Td>
      <Td>
        {f.originAirport} → {f.destinationAirport}
        {f.divertedToAirport && f.divertedToAirport !== f.destinationAirport && (
          <span className="block text-xs text-bad">now landing {f.divertedToAirport}</span>
        )}
      </Td>
      <Td>
        {row.travelerName}
        {row.showId && row.showName && (
          <Link
            href={`/shows/${row.showId}`}
            className="block text-xs text-text-muted hover:underline"
          >
            {row.showName}
          </Link>
        )}
      </Td>
      <Td>
        {local(f.scheduledDeparture, zone)}
        {/* The airline's own re-timing, beside the plan rather than over it. */}
        {f.scheduleChangedAt && f.providerScheduledDeparture && (
          <span className="block text-xs text-warn">
            carrier now says {local(f.providerScheduledDeparture, zone)}
          </span>
        )}
        <span className="block text-xs text-text-muted">
          {zone ? zoneLabel(zone) : 'zone unknown — shown in UTC'}
        </span>
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
        {row.status === 'delayed' && (
          <span className="block text-xs text-text-muted">{f.delayMinutes} min late</span>
        )}
      </Td>
      <Td numeric>
        {row.buffer.standing === 'not_applicable' ? (
          <span className="text-text-muted">—</span>
        ) : row.buffer.standing === 'no_arrival' ? (
          <span className="text-bad">no arrival</span>
        ) : (
          <>
            <span
              className={
                row.buffer.standing === 'after_move_in'
                  ? 'text-bad'
                  : row.buffer.brokenSincePurchase
                    ? 'text-warn'
                    : ''
              }
            >
              {gap(row.buffer.hoursBefore!)}
            </span>
            <span className="block text-xs text-text-muted">
              needs {row.buffer.requiredHours}h
              {row.buffer.brokenSincePurchase && ' · buffer gone'}
            </span>
          </>
        )}
      </Td>
      <Td>
        {row.freshness.kind === 'never_checked' ? (
          <span className="text-warn">never</span>
        ) : (
          <span className={row.freshness.kind === 'stale' ? 'text-warn' : 'text-text-muted'}>
            {row.freshness.ageMinutes} min ago
            {row.freshness.kind === 'stale' && ' · stale'}
          </span>
        )}
        {f.statusProvider && (
          <span className="block text-xs text-text-muted">{f.statusProvider}</span>
        )}
      </Td>
    </tr>
  );
}

/**
 * Hours near the deadline, days further out. "615.8h before move-in" is a
 * precision nobody asked for on a flight three weeks early, and it makes the
 * column that matters — the 2.4h one — harder to spot.
 */
function gap(hours: number): string {
  const abs = Math.abs(hours);
  if (abs >= 48) return `${(hours / 24).toFixed(0)}d`;
  return `${hours.toFixed(1)}h`;
}

function local(d: Date, zone: string | null): string {
  return d.toLocaleString('en-US', {
    timeZone: zone ?? 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function zoneLabel(zone: string): string {
  return zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
}

const STATUS_TONE: Record<BoardRow['status'], Tone> = {
  scheduled: 'neutral',
  active: 'info',
  landed: 'good',
  delayed: 'warn',
  diverted: 'bad',
  cancelled: 'bad',
  unknown: 'warn',
};

const SEVERITY_TONE: Record<'info' | 'warning' | 'critical', Tone> = {
  info: 'info',
  warning: 'warn',
  critical: 'bad',
};
