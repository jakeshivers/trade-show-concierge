import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getShipmentBoard, getShipmentTimeline } from '@/lib/shipping/store';
import { getShowDrayage } from '@/lib/drayage/store';
import { canEditRateCard } from '@/lib/drayage/access';
import type { HandlingKind } from '@/lib/drayage/estimate';
import {
  DrayageEstimateCard,
  HandlingControl,
  RateCardForm,
  RateCardStanding,
} from './drayage-forms';
import { canManageShipments } from '@/lib/shipping/access';
import { selectTrackingProviderOrNull } from '@/lib/shipping/provider';
import type { ShipmentRow } from '@/lib/shipping/board';
import { Badge, Card, Empty, money } from '../../../_components/ui';
import {
  CONSIGNMENT_LABEL,
  ScanCell,
  SEVERITY_TONE,
  STATUS_TONE,
  WindowCell,
  local,
} from '../../../shipping/_present';
import {
  getAssetRegister,
  availableAssetsFor,
  getCollateral,
  getShowCollateral,
} from '@/lib/assets/store';
import { canReserveAssets } from '@/lib/assets/access';
import {
  ConditionBadge,
  CustodyBadge,
  SEVERITY_TONE as ASSET_SEVERITY_TONE,
  StockCell,
  local as assetLocal,
} from '../../../assets/_present';
import {
  AllocateForm,
  CountBackForm,
  PackForm,
  ReleaseForm,
  ReserveForm,
  RewindowForm,
  SignInForm,
  SignOutForm,
  UnallocateForm,
} from '../../../assets/forms';
import { loadShow } from '../detail';
import {
  DeleteShipmentForm,
  EditShipmentForm,
  ManualScanForm,
  NewShipmentForm,
  ReceiptForm,
} from './forms';

/**
 * Logistics — the crate, its timeline, and what is inside it.
 *
 * Three models on one page, deliberately: freight, the capital assets it carries,
 * and the collateral. They are the same question asked at three scales — where is
 * it, and can it be there — and the joins between them are the point. A
 * reservation window that does not cover the freight is a booth on a truck while
 * the register says it is on a shelf; a crate delivered to a dock is not a booth
 * at the stand; a shelf full of datasheets is not 400 datasheets you can pack.
 *
 * The page leads with the receiving window rather than with the delivery date,
 * because the date on its own is not an answer: the same Tuesday means "held for
 * you" at an advance warehouse and "refused at a shut dock" at show-site
 * receiving, and which one it is, is the thing worth knowing.
 */
export default async function LogisticsTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, detail } = await loadShow(id);
  const { show } = detail;
  const asOf = new Date();

  const board = await getShipmentBoard(actor, { showId: id, asOf });
  // After the board and on the same page as the crates, because the estimate is
  // a function of them: a rate card on a screen away from the freight it prices
  // is a number nobody can check.
  const drayage = await getShowDrayage(actor, id);
  const mayEditRates = canEditRateCard(actor);
  const handlingOf = new Map(drayage.freight.map((f) => [f.id, f.handling] as const));
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

  // The reservation window is what an asset is offered against, so the picker
  // needs one before it can honestly say what is free. The show's own dates are
  // the wrong answer and are deliberately not used: a booth is gone for a
  // fortnight around a three-day show, so offering against show dates would
  // report a crate as available on exactly the days it is on a truck. Bracketing
  // move-in and move-out by a week is the closest honest guess for the *picker*
  // — and the window itself is still typed, then checked against the freight.
  const [assets, allocations, collateral] = await Promise.all([
    getAssetRegister(actor, { showId: id, asOf }),
    getShowCollateral(actor, id),
    getCollateral(actor),
  ]);
  const mayReserve = canReserveAssets(actor);
  const options = mayReserve
    ? await availableAssetsFor(
        actor,
        {
          from: new Date((show.moveInAt ?? show.startsOn).getTime() - 7 * 86_400_000),
          to: new Date((show.moveOutAt ?? show.endsOn).getTime() + 7 * 86_400_000),
        },
        id,
      )
    : [];

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
                handling={handlingOf.get(row.shipment.id) ?? 'unknown'}
                asOf={asOf}
                mayManage={mayManage}
                people={people}
                costCenters={costCenters}
              />
            ))}
          </ul>
        )}

        {mayManage && (
          <div id="new-freight" className="mt-5 scroll-mt-6 border-t border-border pt-4">
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
        title="Drayage"
        subtitle={
          'What the general contractor charges to move freight between the dock and the booth. ' +
          'It is billed by weight, per crate, off a rate card published in this show’s own ' +
          'manual — and on most shows it costs more than the freight did.'
        }
      >
        {drayage.card && mayEditRates && (
          <RateCardStanding showId={id} card={drayage.card} />
        )}
        <DrayageEstimateCard estimate={drayage.estimate} />
        {mayEditRates ? (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="mb-3 text-sm font-medium">
              {drayage.card ? 'The rate card' : 'Enter this show’s rate card'}
            </h3>
            <RateCardForm showId={id} card={drayage.card} />
          </div>
        ) : (
          <p className="mt-3 border-t border-border pt-3 text-xs text-text-muted">
            Anybody can say how a crate is packed, on the shipment above. The rates themselves
            belong to whoever runs the show — they are the multiplier on every crate here.
          </p>
        )}
      </Card>

      <Card
        title="Reserved assets"
        subtitle="Chain of custody: who took it, when it came back, and in what condition. The window is when the asset is unavailable — which is longer than the show at both ends, because the crate leaves before move-in and comes home after move-out."
      >
        {assets.rows.length === 0 ? (
          <Empty>Nothing reserved for this show.</Empty>
        ) : (
          <ul className="space-y-3">
            {assets.rows.map((row) => (
              <li key={row.reservation!.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{row.asset.name}</span>
                  {row.asset.assetTag && (
                    <span className="font-mono text-xs">{row.asset.assetTag}</span>
                  )}
                  <ConditionBadge
                    serviceability={row.serviceability}
                    condition={row.asset.condition}
                  />
                  <CustodyBadge row={row} />
                  <span className="text-xs text-text-muted">
                    {money(row.asset.purchaseValueCents)}
                  </span>
                  <span className="ml-auto flex items-center gap-3 text-xs">
                    {mayReserve && (
                      <RewindowForm showId={id} timezone={show.timezone} row={row} />
                    )}
                    {mayReserve && (
                      <ReleaseForm showId={id} reservationId={row.reservation!.id} />
                    )}
                  </span>
                </div>

                <div className="mt-2 grid gap-3 text-xs sm:grid-cols-3">
                  <div>
                    <div className="uppercase tracking-wider text-text-muted">Unavailable</div>
                    <div className="mt-0.5">
                      {assetLocal(row.reservation!.reservedFrom, show.timezone)} →{' '}
                      {assetLocal(row.reservation!.reservedTo, show.timezone)}
                    </div>
                    {/* Where assets meet freight, and the only place either knows. */}
                    {row.coverage?.kind === 'short' && (
                      <div className="mt-0.5 text-warn">
                        shorter than the freight booked for this show
                      </div>
                    )}
                    {row.coverage?.kind === 'unverified' && (
                      <div className="mt-0.5 text-text-muted">
                        no freight recorded, so nothing checks this window
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="uppercase tracking-wider text-text-muted">Signed out</div>
                    <div className="mt-0.5">
                      {row.reservation!.checkedOutAt
                        ? `${assetLocal(row.reservation!.checkedOutAt, show.timezone)}${
                            row.holderName ? ` · ${row.holderName}` : ''
                          }`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="uppercase tracking-wider text-text-muted">Back</div>
                    <div className="mt-0.5">
                      {row.reservation!.returnedAt ? (
                        <>
                          {assetLocal(row.reservation!.returnedAt, show.timezone)}
                          {row.reservation!.conditionOnReturn && (
                            <> · {row.reservation!.conditionOnReturn.replace('_', ' ')}</>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </div>
                  </div>
                </div>

                {row.alert && (
                  <p className="mt-2 text-xs text-text-muted">
                    <Badge tone={ASSET_SEVERITY_TONE[row.alert.severity]}>
                      {row.alert.severity}
                    </Badge>{' '}
                    {row.alert.body}
                  </p>
                )}

                <div className="mt-2">
                  {/* Anybody, both of them. See `assets/access.ts`. */}
                  {(row.custody?.standing === 'planned' || row.custody?.standing === 'due_out') && (
                    <SignOutForm showId={id} reservationId={row.reservation!.id} />
                  )}
                  {(row.custody?.standing === 'out' ||
                    row.custody?.standing === 'overdue' ||
                    row.custody?.standing === 'missing') && <SignInForm showId={id} row={row} />}
                </div>
              </li>
            ))}
          </ul>
        )}

        {mayReserve && (
          <div className="mt-5 border-t border-border pt-4">
            <ReserveForm showId={id} timezone={show.timezone} options={options} />
          </div>
        )}
      </Card>

      <Card
        title="Collateral"
        subtitle="Promised, packed, counted back. An allocation is a claim on stock; the movement happens when somebody picks it off the shelf. A blank return count is not a zero — it means nobody looked."
      >
        {allocations.length === 0 ? (
          <Empty>Nothing allocated to this show.</Empty>
        ) : (
          <ul className="space-y-2">
            {allocations.map((a) => (
              <li key={a.allocation.id} className="border-b border-border pb-2 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{a.itemName}</span>
                  <span className="tabular text-sm">{a.allocation.quantityAllocated}</span>
                  <Badge
                    tone={
                      a.standing === 'reconciled'
                        ? 'good'
                        : a.standing === 'issued'
                          ? 'info'
                          : 'neutral'
                    }
                  >
                    {a.standing === 'planned'
                      ? 'promised, still on the shelf'
                      : a.standing === 'issued'
                        ? 'in a crate, not counted back'
                        : `counted back · ${a.allocation.quantityReturned} returned, ${
                            a.allocation.quantityAllocated - (a.allocation.quantityReturned ?? 0)
                          } consumed`}
                  </Badge>
                  <StockCell standing={a.itemStanding} />
                  <span className="ml-auto flex items-center gap-3 text-xs">
                    {a.standing === 'planned' && <PackForm showId={id} allocationId={a.allocation.id} />}
                    {mayReserve && a.standing !== 'issued' && (
                      <UnallocateForm showId={id} allocationId={a.allocation.id} />
                    )}
                  </span>
                </div>
                {a.standing === 'issued' && (
                  <div className="mt-1">
                    <CountBackForm showId={id} row={a} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {mayReserve && collateral.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <AllocateForm showId={id} items={collateral} />
          </div>
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
  handling,
  asOf,
  mayManage,
  people,
  costCenters,
}: {
  showId: string;
  timezone: string;
  row: ShipmentRow;
  events: (typeof s.shipmentEvents.$inferSelect)[];
  handling: HandlingKind;
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
        {/*
          Anybody may set this, and it sits on the crate rather than on the rate
          card for the reason `drayage/access.ts` gives: crated or pad-wrapped is
          knowable only by somebody standing next to it in the warehouse at 6am,
          and a gate here would leave every row at "nobody has said" forever.
        */}
        <div>
          <div className="uppercase tracking-wider text-text-muted">Packing</div>
          <div className="mt-0.5">
            <HandlingControl showId={showId} shipmentId={c.id} handling={handling} />
            {handling === 'unknown' && (
              <p className="mt-1 text-text-muted">
                Not crated is surcharged 25–35%. Until somebody says, the drayage estimate
                assumes none of this freight is.
              </p>
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
