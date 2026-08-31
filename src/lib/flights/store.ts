import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { travelerScope } from '@/lib/shows/visibility';
import { resolveTravelPolicy } from '@/lib/travel/policy-store';
import type { FlightStatusProvider } from '@/lib/integrations/flightstatus/types';
import { isNoRecord } from '@/lib/integrations/flightstatus/types';
import { buildBoardRow, orderBoard, summarizeBoard, type BoardRow, type BoardSummary } from './board';
import { planFlightAlert, type PlannedFlightAlert } from './alerts';
import {
  expectedCheckIntervalMinutes,
  reconcile,
  type BufferContext,
  type TrackedFlight,
} from './status';

type Db = ReturnType<typeof getDb>;
type FlightRow = typeof s.flights.$inferSelect;

/**
 * The rows half of flight tracking. Org-scoped at the source, like every store
 * since step 8, and it decides nothing — every judgment it applies came from
 * `status.ts`, `alerts.ts` or `board.ts` above it.
 */

export function tracked(f: FlightRow): TrackedFlight {
  return {
    id: f.id,
    airlineCode: f.airlineCode,
    flightNumber: f.flightNumber,
    originAirport: f.originAirport,
    destinationAirport: f.destinationAirport,
    originTimeZone: f.originTimeZone,
    destinationTimeZone: f.destinationTimeZone,
    scheduledDeparture: f.scheduledDeparture,
    scheduledArrival: f.scheduledArrival,
    estimatedDeparture: f.estimatedDeparture,
    estimatedArrival: f.estimatedArrival,
    providerScheduledDeparture: f.providerScheduledDeparture,
    providerScheduledArrival: f.providerScheduledArrival,
    scheduleChangedAt: f.scheduleChangedAt,
    status: f.status,
    delayMinutes: f.delayMinutes,
    departureGate: f.departureGate,
    divertedToAirport: f.divertedToAirport,
    lastCheckedAt: f.lastCheckedAt,
    statusProvider: f.statusProvider,
  };
}

/**
 * Which way this leg flies, and whether we actually know.
 *
 * A materialized booking records the direction; a hand-entered row does not, and
 * most rows in a real workspace are hand-entered for years. The fallback is the
 * only signal available — a leg that arrives before the show closes is going to
 * it — and it is wrong for a red-eye home on the final night. So it is reported
 * as inferred rather than known, and the alert says so in its own words. Same
 * shape as `conflicts.ts`'s `possible` vs `certain`.
 */
function directionOf(
  f: FlightRow,
  show: { endsOn: Date } | null,
): { isInbound: boolean; directionKnown: boolean } {
  if (f.legDirection === 'to_show') return { isInbound: true, directionKnown: true };
  if (f.legDirection === 'from_show') return { isInbound: false, directionKnown: true };
  if (!show) return { isInbound: false, directionKnown: true };
  return { isInbound: f.scheduledArrival.getTime() <= show.endsOn.getTime(), directionKnown: false };
}

/* ---------------------------------- read ----------------------------------- */

export type Board = {
  rows: BoardRow[];
  summary: BoardSummary;
  /** True when every reading on the board came from replayed payloads. */
  replayed: boolean;
};

type LoadedFlight = {
  flight: FlightRow;
  traveler: { id: string; fullName: string; costCenterId: string | null };
  show: { id: string; name: string; timezone: string; moveInAt: Date | null; endsOn: Date } | null;
};

async function loadFlights(actor: Actor, db: Db, showId?: string): Promise<LoadedFlight[]> {
  const scope = travelerScope(actor);

  const rows = await db
    .select({ flight: s.flights, traveler: s.users, show: s.shows })
    .from(s.flights)
    .innerJoin(s.users, eq(s.flights.userId, s.users.id))
    .leftJoin(s.shows, eq(s.flights.showId, s.shows.id))
    .where(
      and(
        // Org-scoped through the traveler, not through the show: a flight with
        // no show still belongs to somebody in this workspace, and scoping it
        // through a nullable join would drop exactly those rows.
        eq(s.users.orgId, actor.orgId),
        scope.kind === 'self' ? eq(s.flights.userId, scope.userId) : undefined,
        showId ? eq(s.flights.showId, showId) : undefined,
      ),
    )
    .orderBy(asc(s.flights.scheduledDeparture));

  return rows.map((r) => ({
    flight: r.flight,
    traveler: {
      id: r.traveler.id,
      fullName: r.traveler.fullName,
      costCenterId: r.traveler.costCenterId,
    },
    show: r.show
      ? {
          id: r.show.id,
          name: r.show.name,
          timezone: r.show.timezone,
          moveInAt: r.show.moveInAt,
          endsOn: r.show.endsOn,
        }
      : null,
  }));
}

/**
 * The arrival buffer each flight is judged against, resolved from the *org's
 * policy* rather than written down here.
 *
 * The number is 4 hours in the scope table and it is not a constant: it is a
 * versioned, layered policy value that a cost center or a show may tighten. If
 * this file held its own copy, an org that raised its buffer would keep being
 * told its flights were fine by the screen that exists to say otherwise. One
 * resolution per (cost center, show) pair, because the layering depends on both.
 */
async function bufferHoursFor(
  orgId: string,
  items: LoadedFlight[],
  db: Db,
): Promise<Map<string, number>> {
  const pairs = new Map<string, { costCenterId: string | null; showId: string | null }>();
  for (const i of items) {
    const key = `${i.traveler.costCenterId ?? ''}|${i.show?.id ?? ''}`;
    if (!pairs.has(key)) {
      pairs.set(key, { costCenterId: i.traveler.costCenterId, showId: i.show?.id ?? null });
    }
  }

  const out = new Map<string, number>();
  for (const [key, opts] of pairs) {
    try {
      const { policy } = await resolveTravelPolicy(orgId, opts, db);
      out.set(key, policy.arrivalBufferHoursBeforeMoveIn);
    } catch {
      // No live policy is a real state on a fresh workspace. The board still has
      // to render, and a flight is still late or not; what it cannot do is claim
      // a buffer nobody set, so the buffer verdict degrades to `clear` at zero
      // hours rather than the screen inventing four.
      out.set(key, 0);
    }
  }
  return out;
}

export async function getFlightBoard(
  actor: Actor,
  opts: { showId?: string; asOf?: Date; replayed?: boolean } = {},
  db: Db = getDb(),
): Promise<Board> {
  const asOf = opts.asOf ?? new Date();
  const items = await loadFlights(actor, db, opts.showId);
  const buffers = await bufferHoursFor(actor.orgId, items, db);

  const rows = items.map((i) => {
    const { isInbound, directionKnown } = directionOf(i.flight, i.show);
    const context: BufferContext = {
      moveInAt: i.show?.moveInAt ?? null,
      requiredHours: buffers.get(`${i.traveler.costCenterId ?? ''}|${i.show?.id ?? ''}`) ?? 0,
      isInbound,
      directionKnown,
    };
    return buildBoardRow(
      {
        flight: tracked(i.flight),
        travelerId: i.traveler.id,
        travelerName: i.traveler.fullName,
        showId: i.show?.id ?? null,
        showName: i.show?.name ?? null,
        showTimezone: i.show?.timezone ?? null,
        booked: {
          priceCents: i.flight.priceCents,
          seat: i.flight.seat,
          cabin: i.flight.cabin,
          bookingProvider: i.flight.bookingProvider,
          bookingReference: i.flight.bookingReference,
        },
        context,
      },
      asOf,
    );
  });

  const ordered = orderBoard(rows);
  return {
    rows: ordered,
    summary: summarizeBoard(ordered),
    replayed:
      opts.replayed ??
      (ordered.length > 0 && ordered.every((r) => r.flight.statusProvider === 'recorded')),
  };
}

/* ---------------------------- materialization ------------------------------ */

export type MaterializedSegment = {
  airlineCode: string;
  airlineName?: string;
  flightNumber: string;
  originAirport: string;
  destinationAirport: string;
  originTimeZone?: string | null;
  destinationTimeZone?: string | null;
  departsAt: Date;
  arrivesAt: Date;
  cabin?: string | null;
};

/**
 * Turn a purchased itinerary into flight rows.
 *
 * **Before step 13 nothing did this**, and the omission is the largest single
 * thing this step found. The booking spine bought tickets and recorded an
 * *order* — provider, order id, reference, ticket numbers, what it cost — which
 * is the right record for an audit and is not an itinerary. So every screen that
 * shows a person their flights, and every part of the product that asks "will
 * they be there", could see only the three flights somebody had typed in by
 * hand. The tracking feature would have shipped tracking nothing the app itself
 * had bought.
 *
 * Idempotent through `(booking_id, segment_index)`: a retried purchase, a
 * re-materialization, or a second pass over the same booking updates the rows it
 * already wrote. Slice 0 is the leg to the show, which is where `legDirection`
 * stops being a guess.
 */
export async function materializeFlights(
  input: {
    bookingId: string;
    provider: string;
    bookingReference: string | null;
    ticketNumbers: string[];
    showId: string | null;
    userId: string;
    costCenterId: string | null;
    priceCents: number | null;
    currency: string;
    /** Outer array is slices; slice 0 goes to the show. */
    slices: MaterializedSegment[][];
  },
  now: Date,
  db: Db = getDb(),
): Promise<number> {
  let index = 0;
  let written = 0;

  for (const [sliceIndex, slice] of input.slices.entries()) {
    for (const seg of slice) {
      const values = {
        showId: input.showId,
        userId: input.userId,
        airlineCode: seg.airlineCode,
        airlineName: seg.airlineName ?? null,
        flightNumber: seg.flightNumber,
        originAirport: seg.originAirport,
        destinationAirport: seg.destinationAirport,
        originTimeZone: seg.originTimeZone ?? null,
        destinationTimeZone: seg.destinationTimeZone ?? null,
        legDirection: (sliceIndex === 0 ? 'to_show' : 'from_show') as 'to_show' | 'from_show',
        scheduledDeparture: seg.departsAt,
        scheduledArrival: seg.arrivesAt,
        costCenterId: input.costCenterId,
        bookingId: input.bookingId,
        segmentIndex: index,
        bookingProvider: input.provider,
        bookingReference: input.bookingReference,
        // One ticket number per passenger per slice in practice; we book one
        // passenger per request, so the first is this traveler's or there is none.
        ticketNumber: input.ticketNumbers[0] ?? null,
        // The fare is for the itinerary, not for a leg. Putting the whole price
        // on every segment would make a two-leg trip cost double in any rollup
        // that sums this column, so only the first segment carries it.
        priceCents: index === 0 ? input.priceCents : null,
        currency: input.currency,
        cabin: seg.cabin ?? null,
        updatedAt: now,
      };

      await db
        .insert(s.flights)
        .values(values)
        .onConflictDoUpdate({
          target: [s.flights.bookingId, s.flights.segmentIndex],
          set: values,
        });
      written += 1;
      index += 1;
    }
  }

  return written;
}

/* ----------------------------------- sync ---------------------------------- */

export type SyncResult = {
  checked: number;
  changed: number;
  noRecord: number;
  planned: PlannedFlightAlert[];
  alertsWritten: number;
  /** Present when no provider is configured. Nothing was checked. */
  unavailable?: string;
};

/**
 * A flight is worth asking about when it is due a check and has not already
 * finished. `expectedCheckIntervalMinutes` is the same function the board reads
 * to decide what is stale, so the board can never call something fresh that this
 * is not refreshing.
 */
function dueForCheck(f: FlightRow, now: Date): boolean {
  if (f.status === 'landed' || f.status === 'cancelled') return false;
  // Nothing to learn about a flight that landed days ago and nobody updated.
  if (f.scheduledArrival.getTime() < now.getTime() - 24 * 3_600_000) return false;
  if (!f.lastCheckedAt) return true;
  const ageMinutes = (now.getTime() - f.lastCheckedAt.getTime()) / 60_000;
  return ageMinutes >= expectedCheckIntervalMinutes(tracked(f), now);
}

export async function syncFlightStatuses(
  orgId: string,
  provider: FlightStatusProvider,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<SyncResult> {
  const rows = await db
    .select({ flight: s.flights, traveler: s.users, show: s.shows })
    .from(s.flights)
    .innerJoin(s.users, eq(s.flights.userId, s.users.id))
    .leftJoin(s.shows, eq(s.flights.showId, s.shows.id))
    .where(eq(s.users.orgId, orgId))
    .orderBy(asc(s.flights.scheduledDeparture));

  const due = rows.filter((r) => dueForCheck(r.flight, now));

  let changed = 0;
  let noRecord = 0;
  const updated = new Map<string, FlightRow>();

  for (const { flight } of due) {
    const lookup = await provider.lookup({
      airlineCode: flight.airlineCode,
      flightNumber: flight.flightNumber,
      originAirport: flight.originAirport,
      destinationAirport: flight.destinationAirport,
      scheduledDeparture: flight.scheduledDeparture,
      scheduledArrival: flight.scheduledArrival,
    });

    if (isNoRecord(lookup)) {
      noRecord += 1;
      continue;
    }

    const { changes, patch } = reconcile(tracked(flight), lookup);
    if (!patch) continue;
    const [row] = await db
      .update(s.flights)
      .set({ ...patch, updatedAt: now })
      .where(eq(s.flights.id, flight.id))
      .returning();
    updated.set(flight.id, row);
    if (!changes.includes('none')) changed += 1;
  }

  // Alerts are planned against every flight, not only the ones that just moved:
  // a flight that has been sitting inside its buffer since yesterday is still
  // inside it, and an engine that only speaks on transitions goes silent the
  // moment the sweep that would have noticed is the one that failed.
  const all = rows.map((r) => ({ ...r, flight: updated.get(r.flight.id) ?? r.flight }));
  const buffers = await bufferHoursFor(
    orgId,
    all.map((r) => ({
      flight: r.flight,
      traveler: {
        id: r.traveler.id,
        fullName: r.traveler.fullName,
        costCenterId: r.traveler.costCenterId,
      },
      show: r.show
        ? {
            id: r.show.id,
            name: r.show.name,
            timezone: r.show.timezone,
            moveInAt: r.show.moveInAt,
            endsOn: r.show.endsOn,
          }
        : null,
    })),
    db,
  );

  const planned: PlannedFlightAlert[] = [];
  for (const r of all) {
    const { isInbound, directionKnown } = directionOf(r.flight, r.show);
    const alert = planFlightAlert(
      {
        flight: tracked(r.flight),
        travelerId: r.traveler.id,
        travelerName: r.traveler.fullName,
        showId: r.show?.id ?? null,
        showName: r.show?.name ?? null,
        context: {
          moveInAt: r.show?.moveInAt ?? null,
          requiredHours: buffers.get(`${r.traveler.costCenterId ?? ''}|${r.show?.id ?? ''}`) ?? 0,
          isInbound,
          directionKnown,
        },
      },
      now,
    );
    if (alert) planned.push(alert);
  }

  const alertsWritten = await writeFlightAlerts(orgId, planned, now, db);
  return { checked: due.length, changed, noRecord, planned, alertsWritten };
}

/**
 * The traveler always hears about their own flight; the show runners hear about
 * it too, and only when there is a show. A cancelled personal-trip flight is not
 * the travel manager's evening.
 */
async function writeFlightAlerts(
  orgId: string,
  planned: PlannedFlightAlert[],
  now: Date,
  db: Db,
): Promise<number> {
  if (planned.length === 0) return 0;

  const runners = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  let written = 0;
  for (const alert of planned) {
    const recipients = new Set<string>([alert.travelerId]);
    if (alert.showId) for (const r of runners) recipients.add(r.id);

    for (const userId of recipients) {
      const inserted = await db
        .insert(s.alerts)
        .values({
          orgId,
          showId: alert.showId,
          userId,
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          dedupeKey: `${alert.dedupeKey}:${userId}`,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: s.alerts.id });
      written += inserted.length;
    }
  }
  return written;
}
