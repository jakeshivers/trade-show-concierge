import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as sc from '@/db/schema';
import { getActor } from '@/lib/auth/actor';
import { getShipmentBoard, showsMissingReturnLeg } from '@/lib/shipping/store';
import { selectTrackingProviderOrNull } from '@/lib/shipping/provider';
import { canManageShipments } from '@/lib/shipping/access';
import type { ShipmentRow } from '@/lib/shipping/board';
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from '../_components/ui';
import { TrackPackageForm, type PickableShow } from './forms';
import {
  CONSIGNMENT_LABEL,
  ScanCell,
  SEVERITY_TONE,
  STATUS_TONE,
  WindowCell,
  local,
} from './_present';

/**
 * The shipping board — every crate still owed to somebody, soonest deadline first.
 *
 * It was worst-first, on the argument that a shipping screen sorted by date puts
 * the crate arriving tomorrow above the crate that has not moved in five days.
 * The horizon answered that rather than refuting it: once settled freight stops
 * appearing, every row is a crate somebody still has to get to a dock, and among
 * those the deadline is the order the work happens in. It also lands better here
 * than on the flight board — an overdue crate has the *earliest* deadline on the
 * page, so ascending order puts the emergency first without any ranking at all.
 *
 * The horizon is deliberately not the flight board's clock. A crate whose cutoff
 * was last Tuesday and which nobody has confirmed is not finished, it is the
 * most urgent thing here — so a crate leaves when it is **settled**, which means
 * a person confirmed it at the booth or somebody cancelled the row. Silence and
 * non-arrival do not expire. `board.ts` and `store.ts` hold the argument.
 *
 * Three things this screen refuses to do. It does not treat `delivered` as done
 * — the carrier signed for a dock, and drayage still has to move it to the booth
 * — so a delivered crate stays a live row until a person says it arrived. It
 * does not report a late estimate as the only way to be outside the window: a
 * crate expected before show-site receiving opens is just as refused, and reads
 * as comfortably early on any screen that only knows about deadlines. And it
 * never renders "in transit" for a row nobody has checked.
 */

export const metadata = { title: 'Shipping' };
export const dynamic = 'force-dynamic';

export default async function ShippingBoardPage() {
  const actor = await getActor();
  const asOf = new Date();
  const board = await getShipmentBoard(actor, { asOf });
  const gaps = await showsMissingReturnLeg(actor.orgId, asOf);
  const status = selectTrackingProviderOrNull();
  const mayManage = canManageShipments(actor);

  // The board's own write needs two things the board itself never had: which
  // shows exist, and the cost centers §4 makes mandatory on every financial row.
  // Both are loaded only for somebody who may actually add freight.
  const db = getDb();
  const [pickable, costCenters] = mayManage
    ? await Promise.all([
        db
          .select({
            id: sc.shows.id,
            name: sc.shows.name,
            timezone: sc.shows.timezone,
            moveInAt: sc.shows.moveInAt,
            startsOn: sc.shows.startsOn,
            endsOn: sc.shows.endsOn,
          })
          .from(sc.shows)
          .where(eq(sc.shows.orgId, actor.orgId))
          .orderBy(asc(sc.shows.startsOn)),
        db
          .select({ id: sc.costCenters.id, code: sc.costCenters.code, name: sc.costCenters.name })
          .from(sc.costCenters)
          .where(eq(sc.costCenters.orgId, actor.orgId))
          .orderBy(asc(sc.costCenters.code)),
      ])
    : [[], []];

  // Nearest to now first — /day-of's picker rule. Somebody holding a tracking
  // number is almost never thinking about next April.
  const shows: PickableShow[] = [...pickable]
    .sort((a, b) => distance(a, asOf) - distance(b, asOf))
    .map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, moveInAt: s.moveInAt }));
  const replayed =
    ('choice' in status && status.choice.replayed) ||
    board.rows.some((r) => r.shipment.trackingProvider === 'recorded');

  const alerts = [...board.rows.map((r) => r.alert).filter((a) => a !== null), ...gaps];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Shipping"
        blurb={
          <>
            Every crate still owed to somebody, nearest deadline first — which puts anything
            overdue at the top on its own. A delivery date only means something against the
            receiving window it has to land in, and on a show floor that window has two edges,
            because freight that arrives before the dock opens is refused rather than early.
          </>
        }
      />

      {!('choice' in status) && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          No tracking provider is configured, so nothing on this page has been checked with a
          carrier. {status.unavailable}
        </p>
      )}
      {replayed && (
        <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          Some or all scans on this page are replayed from recorded payloads
          (<code>SHIPMENT_TRACKING_PROVIDER=recorded</code>) rather than reported by a carrier.
          No carrier was asked about a crate whose timeline is marked <code>recorded</code>.
        </p>
      )}

      {mayManage && shows.length > 0 && costCenters.length > 0 && (
        <Card
          title="Track a package or a crate"
          subtitle="A UPS carton to somebody’s hotel and a pallet to the advance warehouse are the same row in this table. Weight, pieces and declared value live on the show’s Logistics tab, because a parcel has none of them."
        >
          <TrackPackageForm shows={shows} costCenters={costCenters} />
        </Card>
      )}

      {board.rows.length === 0 ? (
        <Empty>
          No shipments yet. Anything with a tracking number belongs here — a pallet to the
          advance warehouse, and equally the two boxes somebody FedEx’d to their hotel.
        </Empty>
      ) : (
        <>
          <Card title="Across the workspace">
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Tracked" value={board.summary.tracked} />
              <Stat
                label="Outside the window"
                value={board.summary.missingWindow}
                tone={board.summary.missingWindow > 0 ? 'bad' : 'neutral'}
                note="Late, or expected before the dock opens. Both are refused freight."
              />
              <Stat
                label="Gone quiet"
                value={board.summary.stalled}
                tone={board.summary.stalled > 0 ? 'warn' : 'neutral'}
                note="No scan for longer than freight normally goes silent."
              />
              {/* The figure with no counterpart on the flight board. A landed
                  flight is over; a delivered crate is halfway. */}
              <Stat
                label="On a dock, not at the booth"
                value={board.summary.unreceived}
                tone={board.summary.unreceived > 0 ? 'warn' : 'neutral'}
                note="Delivered is the carrier's word. Received is a person's."
              />
              <Stat
                label="Nobody owns"
                value={board.summary.unowned}
                tone={board.summary.unowned > 0 ? 'warn' : 'neutral'}
                note="An alert addressed to an owner reaches nobody on these."
              />
            </div>
          </Card>

          <Card title="Crates">
            {/* Said rather than left to be noticed, the way the flight board
                says it. The rule is different here on purpose and the sentence
                has to carry the difference: freight leaves when somebody closes
                it, never because its date went by. */}
            <p className="mb-3 text-xs text-text-muted">
              A crate stays here until somebody confirms it reached the booth. Nothing drops off
              for being old — a crate that missed its window last week is the most urgent row on
              this page, not a finished one. A show’s own Logistics tab keeps its whole record,
              arrived freight included.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Crate</Th>
                  <Th>Show</Th>
                  <Th>Consigned to</Th>
                  <Th>Due (show local)</Th>
                  <Th>Status</Th>
                  <Th>Window</Th>
                  <Th>Last scan</Th>
                  <Th>Owner</Th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((row) => (
                  <Crate key={row.shipment.id} row={row} asOf={asOf} />
                ))}
              </tbody>
            </Table>
          </Card>

          {alerts.length > 0 && (
            <Card title="What the engine would say">
              <ul className="space-y-3">
                {alerts.map((a) => (
                  <li
                    key={a.dedupeKey}
                    className="border-b border-border pb-3 last:border-0"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                      <span className="font-medium">{a.title}</span>
                      {a.shipmentId === null && <Badge tone="info">no shipment row</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-text-muted">{a.body}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-text-muted">
                These are written to the alerts table by the sweep, keyed to the receiving
                deadline and the standing they report rather than to the carrier’s estimate —
                so an estimate that drifts a few hours either way is not a fresh piece of news.
                One of them has no shipment behind it at all: it fires on the{' '}
                <em>absence</em> of a return leg, which is the failure that surfaces a quarter
                late. They are on the <a className="underline hover:no-underline" href="/alerts">alerts
                feed</a> for the people they are addressed to, and a crate arriving is what takes
                one down — nobody clears it by hand.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Crate({ row, asOf }: { row: ShipmentRow; asOf: Date }) {
  const c = row.shipment;
  return (
    <tr>
      <Td>
        <Link href={`/shows/${row.showId}/logistics`} className="font-medium hover:underline">
          {c.description}
        </Link>
        {c.trackingNumber && (
          <span className="block font-mono text-xs text-text-muted">
            {c.carrier.toUpperCase()} {c.trackingNumber}
          </span>
        )}
      </Td>
      <Td>
        <Link href={`/shows/${row.showId}`} className="hover:underline">
          {row.showName}
        </Link>
      </Td>
      <Td>
        {CONSIGNMENT_LABEL[c.consignment] ?? c.consignment}
        <span className="block text-xs text-text-muted">{c.direction}</span>
      </Td>
      <Td>
        {local(c.mustArriveBy, row.showTimezone)}
        {c.receivingOpensAt && (
          <span className="block text-xs text-text-muted">
            opens {local(c.receivingOpensAt, row.showTimezone)}
          </span>
        )}
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[row.status]}>{row.status.replace(/_/g, ' ')}</Badge>
        {/* The distinction this screen exists to make visible. */}
        {c.deliveredAt && !c.receivedAt && (
          <span className="block text-xs text-warn">not confirmed at the booth</span>
        )}
      </Td>
      <Td>
        <WindowCell row={row} />
      </Td>
      <Td>
        <ScanCell row={row} asOf={asOf} />
        {c.trackingProvider && (
          <span className="block text-xs text-text-muted">{c.trackingProvider}</span>
        )}
      </Td>
      <Td>
        {row.ownerName ?? <span className="text-warn">unowned</span>}
      </Td>
    </tr>
  );
}

/** Milliseconds from now to the nearest edge of a show; zero while it is running. */
function distance(show: { startsOn: Date; endsOn: Date }, asOf: Date): number {
  const now = asOf.getTime();
  if (now < show.startsOn.getTime()) return show.startsOn.getTime() - now;
  if (now > show.endsOn.getTime()) return now - show.endsOn.getTime();
  return 0;
}
