import Link from 'next/link';
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
import { GoToShow } from '../_components/go-to-show';
import {
  CONSIGNMENT_LABEL,
  ScanCell,
  SEVERITY_TONE,
  STATUS_TONE,
  WindowCell,
  local,
} from './_present';

/**
 * The shipping board — every crate this workspace has, worst first.
 *
 * Not sorted by delivery date, which is what a shipping screen does by default
 * and which puts the crate arriving tomorrow above the crate that has not moved
 * in five days. The second one is the emergency; the first is a lorry doing its
 * job. `board.ts` holds the ordering and the argument.
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
            Every crate, ordered by what is wrong with it rather than by when it is due. A
            delivery date only means something against the receiving window it has to land in —
            and on a show floor that window has two edges, because freight that arrives before
            the dock opens is refused rather than early.
          </>
        }
        // Gated on the permission that renders the form: a Member who followed this
        // would land on a Logistics tab with nothing on it to fill in.
        action={
          canManageShipments(actor) ? (
            <GoToShow
              actor={actor}
              tab="logistics"
              hash="new-freight"
              label="Add freight"
              hint={
                <>
                  A crate belongs to a show, so a tracking number is entered on that show’s
                  Logistics tab — beside the timeline it will produce.
                </>
              }
            />
          ) : undefined
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

      {board.rows.length === 0 ? (
        <Empty>
          No shipments. Use <strong>Add freight</strong> above — a crate belongs to a show, so it
          is entered on that show’s Logistics tab, which is also where its event timeline lives.
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
