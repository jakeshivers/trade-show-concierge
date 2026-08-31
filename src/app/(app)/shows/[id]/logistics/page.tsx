import { Badge, Card, Empty, money, showDateTime } from '../../../_components/ui';
import { loadShow } from '../detail';

/**
 * Logistics — the crate and the capital assets it carries.
 *
 * Shipping tracking is step 14 and chain of custody is step 15; what exists today
 * is the reservation side, which is also the part a clone carries forward. The
 * shipments list is here so the gap is visible rather than implied.
 */
export default async function LogisticsTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { detail } = await loadShow(id);
  const { show, shipments, reservations } = detail;

  return (
    <div className="space-y-6">
      <Card title="Shipments">
        {shipments.length === 0 ? (
          <Empty>
            No shipments. Carrier tracking arrives at step 14 — and a cloned show never brings
            shipments with it, because a copied tracking number describes a crate that already
            went somewhere else.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {shipments.map((shipment) => (
              <li
                key={shipment.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-1.5 last:border-0"
              >
                <span className="font-medium">{shipment.description}</span>
                <Badge>{shipment.direction}</Badge>
                <Badge>{shipment.status}</Badge>
                <span className="text-text-muted">{shipment.carrier.toUpperCase()}</span>
                {shipment.trackingNumber && (
                  <span className="font-mono text-xs">{shipment.trackingNumber}</span>
                )}
                <span className="ml-auto text-xs text-text-muted">
                  must arrive {showDateTime(shipment.mustArriveBy, show.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Reserved assets">
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
