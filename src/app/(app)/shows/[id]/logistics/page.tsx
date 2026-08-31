import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getShipmentBoard, getShipmentTimeline } from '@/lib/shipping/store';
import { canManageShipments } from '@/lib/shipping/access';
import { selectTrackingProviderOrNull } from '@/lib/shipping/provider';
import type { ShipmentRow } from '@/lib/shipping/board';
import { Badge, Card, Empty, money, showDateTime } from '../../../_components/ui';
import {
  CONSIGNMENT_LABEL,
  ScanCell,
  SEVERITY_TONE,
  STATUS_TONE,
  WindowCell,
  local,
} from '../../../shipping/_present';
import { loadShow } from '../detail';
import {
  DeleteShipmentForm,
  EditShipmentForm,
  ManualScanForm,
  NewShipmentForm,
  ReceiptForm,
} from './forms';

/**
 * Logistics — the crate, its timeline, and the capital assets it carries.
 *
 * The last read-only tab is writable as of step 14. Chain of custody on the
 * reservations below is still step 16, and says so where the controls would be.
 *
 * The page leads with the receiving window rather than with the delivery date,
 * because the date on its own is not an answer: the same Tuesday means "held for
 * you" at an advance warehouse and "refused at a shut dock" at show-site
 * receiving, and which one it is, is the thing worth knowing.
 */
export default async function LogisticsTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, detail } = await loadShow(id);
  const { show, reservations } = detail;
  const asOf = new Date();

  const board = await getShipmentBoard(actor, { showId: id, asOf });
  const mayManage = canManageShipments(actor);
  const provider = selectTrackingProviderOrNull();
  const replayed =
    ('choice' in provider && provider.choice.replayed) ||
    board.rows.some((r) => r.shipment.trackingProvider === 'recorded');

  const db = getDb();
  const [people, costCenters] = await Promise.all([
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
    db
      .select({ id: s.costCenters.id, code: s.costCenters.code, name: s.costCenters.name })
      .from(s.costCenters)
      .where(eq(s.costCenters.orgId, actor.orgId))
      .orderBy(asc(s.costCenters.code)),
  ]);

  const timelines = new Map(
    await Promise.all(
      board.rows.map(async (r) => {
        const t = await getShipmentTimeline(actor, r.shipment.id, asOf, db);
        return [r.shipment.id, t.events] as const;
      }),
    ),
  );

  return (
    <div className="space-y-6">
      {replayed && (
        <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          Scans on this page are replayed from recorded payloads
          (<code>SHIPMENT_TRACKING_PROVIDER=recorded</code>) rather than reported by a carrier.
        </p>
      )}

      <Card
        title="Shipments"
        subtitle={
          'A crate has a window, not a deadline. An advance warehouse holds freight for weeks ' +
          'and closes on a published date; show-site receiving does not open until move-in, and ' +
          'anything that arrives before it is refused.'
        }
      >
        {board.rows.length === 0 ? (
          <Empty>
            No shipments. A cloned show never brings them, because a copied tracking number
            describes a crate that already went somewhere else.
          </Empty>
        ) : (
          <ul className="space-y-5">
            {board.rows.map((row) => (
              <Shipment
                key={row.shipment.id}
                showId={id}
                timezone={show.timezone}
                row={row}
                events={timelines.get(row.shipment.id) ?? []}
                asOf={asOf}
                mayManage={mayManage}
                people={people}
                costCenters={costCenters}
              />
            ))}
          </ul>
        )}

        {mayManage && (
          <div className="mt-5 border-t border-border pt-4">
            <NewShipmentForm
              showId={id}
              timezone={show.timezone}
              people={people}
              costCenters={costCenters}
            />
          </div>
        )}
      </Card>

      <Card
        title="Reserved assets"
        subtitle="Chain of custody — who took the booth, when it came back, in what condition — is step 16. What is here is the reservation."
      >
        {reservations.length === 0 ? (
          <Empty>Nothing reserved for this show.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {reservations.map(({ reservation, asset }) => (
              <li
                key={reservation.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-1.5 last:border-0"
              >
                <span className="font-medium">{asset.name}</span>
                {asset.assetTag && <span className="font-mono text-xs">{asset.assetTag}</span>}
                <Badge tone={asset.condition === 'needs_repair' ? 'warn' : 'neutral'}>
                  {asset.condition.replace('_', ' ')}
                </Badge>
                <span className="text-xs text-text-muted">
                  {money(asset.purchaseValueCents)} · {asset.storageLocation ?? 'location unknown'}
                </span>
                <span className="ml-auto text-xs text-text-muted">
                  {showDateTime(reservation.reservedFrom, show.timezone)} →{' '}
                  {showDateTime(reservation.reservedTo, show.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Shipment({
  showId,
  timezone,
  row,
  events,
  asOf,
  mayManage,
  people,
  costCenters,
}: {
  showId: string;
  timezone: string;
  row: ShipmentRow;
  events: (typeof s.shipmentEvents.$inferSelect)[];
  asOf: Date;
  mayManage: boolean;
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
}) {
  const c = row.shipment;
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{c.description}</span>
        <Badge tone={STATUS_TONE[row.status]}>{row.status.replace(/_/g, ' ')}</Badge>
        <Badge>{c.direction}</Badge>
        <Badge>{CONSIGNMENT_LABEL[c.consignment] ?? c.consignment}</Badge>
        <span className="text-text-muted">{c.carrier.toUpperCase()}</span>
        {c.trackingNumber ? (
          <span className="font-mono text-xs">{c.trackingNumber}</span>
        ) : (
          <span className="text-xs text-warn">no tracking number — this is a plan, not a crate</span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs">
          {mayManage && (
            <EditShipmentForm
              showId={showId}
              timezone={timezone}
              people={people}
              costCenters={costCenters}
              row={row}
            />
          )}
          {mayManage && <DeleteShipmentForm showId={showId} shipmentId={c.id} />}
        </span>
      </div>

      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-4">
        <div>
          <div className="uppercase tracking-wider text-text-muted">Receiving window</div>
          <div className="mt-0.5">
            {c.receivingOpensAt ? (
              <>
                {local(c.receivingOpensAt, timezone)} → {local(c.mustArriveBy, timezone)}
              </>
            ) : c.mustArriveBy ? (
              <>by {local(c.mustArriveBy, timezone)}</>
            ) : (
              <span className="text-text-muted">
                not read off the service manual yet
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-text-muted">Standing</div>
          <div className="mt-0.5">
            <WindowCell row={row} />
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-text-muted">Last scan</div>
          <div className="mt-0.5">
            <ScanCell row={row} asOf={asOf} />
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-text-muted">Owner</div>
          <div className="mt-0.5">
            {row.ownerName ?? (
              <span className="text-warn">nobody — alerts go to whoever runs the show</span>
            )}
          </div>
        </div>
      </div>

      {/* The distinction that is the whole point of the receipt control below. */}
      {c.deliveredAt && (
        <div className="mt-3 rounded-md bg-muted px-3 py-2">
          <p className="text-xs text-text-muted">
            {c.carrier.toUpperCase()} says it was delivered {local(c.deliveredAt, timezone)}. That is
            a dock, not the booth — drayage moves it the rest of the way, on its own schedule,
            which nothing in this app can see.
          </p>
          <div className="mt-2">
            <ReceiptForm showId={showId} row={row} />
          </div>
          {c.receivedAt && (
            <p className="mt-1 text-xs text-text-muted">
              Confirmed at the booth {local(c.receivedAt, timezone)}.
            </p>
          )}
        </div>
      )}

      {row.alert && (
        <div className="mt-3 flex flex-wrap items-baseline gap-2">
          <Badge tone={SEVERITY_TONE[row.alert.severity]}>{row.alert.severity}</Badge>
          <span className="text-sm font-medium">{row.alert.title}</span>
          <p className="w-full text-xs text-text-muted">{row.alert.body}</p>
        </div>
      )}

      <div className="mt-3">
        <div className="text-xs uppercase tracking-wider text-text-muted">Timeline</div>
        {events.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">
            No scans. {c.trackingNumber
              ? 'The carrier has not reported anything against this number yet, which for freight that has not been collected is the truthful answer rather than a gap.'
              : 'Nothing to scan against.'}
          </p>
        ) : (
          <ol className="mt-1 space-y-1">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-3 text-xs">
                <span className="tabular text-text-muted">{local(e.occurredAt, timezone)}</span>
                <span className="font-medium">{e.status.replace(/_/g, ' ')}</span>
                <span>{e.message}</span>
                {e.location && <span className="text-text-muted">{e.location}</span>}
                {/* A hand-typed entry must never read as a carrier's word. */}
                {e.source === 'manual' && <Badge>entered by hand</Badge>}
              </li>
            ))}
          </ol>
        )}
        {mayManage && <ManualScanForm showId={showId} shipmentId={c.id} />}
      </div>
    </li>
  );
}
