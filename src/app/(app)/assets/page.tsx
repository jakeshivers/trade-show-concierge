import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor } from '@/lib/auth/actor';
import { getAssetRegister, getCollateral } from '@/lib/assets/store';
import { canManageAssets } from '@/lib/assets/access';
import { planClashAlert } from '@/lib/assets/alerts';
import { TURNAROUND_HOURS } from '@/lib/assets/custody';
import type { AssetRow } from '@/lib/assets/board';
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
  money,
} from '../_components/ui';
import { ConditionBadge, CustodyBadge, SEVERITY_TONE, StockCell, local } from './_present';
import {
  DeleteAssetForm,
  DeleteCollateralForm,
  EditAssetForm,
  EditCollateralForm,
  MoveStockForm,
  NewAssetForm,
  NewCollateralForm,
  SignInForm,
  SignOutForm,
} from './forms';

/**
 * The asset register — everything the company owns that goes to a show, and
 * where it actually is.
 *
 * Ordered by the next date each row demands something, the same as the shipping
 * and flight boards. An asset row has two candidate clocks and the key is
 * whichever is still ahead of it: a booth that has not left is due *out*, one
 * already at a show is due *back*. An asset with nothing booked has no date and
 * sorts last, so the idle warehouse stays visible without displacing this week's
 * work. Returned reservations older than a month come off the workspace view
 * entirely — the asset keeps its row, and one show's own tab still shows every
 * reservation, which is where the custody log is read.
 *
 * It used to be ranked by what is wrong rather than by what is due, on the
 * argument that a reservation is a promise about the future, so a register
 * sorted by date is a list of promises with the broken ones buried in the
 * middle. That was true of a register carrying every trip an asset ever made;
 * with completed ones gone, the clock is the order the work happens in, and what
 * the ranking protected is in the figures above, the tone on each row and the
 * alerts, none of which have to be scanned for. `board.ts` holds the ordering.
 *
 * Three things this screen refuses to do. It never shows a reservation as a
 * filled slot without saying whether the thing can actually go — an asset
 * flagged for repair and promised to a show in six weeks is the failure nothing
 * else in the product joins up. It never shows collateral's on-hand figure
 * alone, because the number that decides whether the crate can be packed is what
 * is *free*. And it never reads a blank return count as zero.
 */

export const metadata = { title: 'Assets' };
export const dynamic = 'force-dynamic';

export default async function AssetRegisterPage() {
  const actor = await getActor();
  const asOf = new Date();
  const [register, collateral] = await Promise.all([
    getAssetRegister(actor, { asOf }),
    getCollateral(actor),
  ]);
  const mayManage = canManageAssets(actor);
  const db = getDb();
  const costCenters = await db
    .select({ id: s.costCenters.id, code: s.costCenters.code, name: s.costCenters.name })
    .from(s.costCenters)
    .where(eq(s.costCenters.orgId, actor.orgId))
    .orderBy(asc(s.costCenters.code));

  const { summary } = register;
  const alerts = [
    ...register.rows.map((r) => r.alert).filter((a) => a !== null),
    ...register.clashes.map(planClashAlert),
    ...collateral.map((c) => c.alert).filter((a) => a !== null),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assets & collateral"
        blurb={
          <>
            Capital that leaves the building, and the print and swag that goes with it. Booking
            an asset to a show does not mean it can go, so this page counts what is actually
            available, what is out, and what nobody can find — the expensive things go missing
            between shows, and quietly. Ordered by the next date each one is due out or back;
            anything with nothing booked sits at the end.
          </>
        }
        action={
          // Gated on the same permission that renders the forms further down: a
          // call to action that scrolls to nothing is worse than none at all.
          mayManage ? (
            <div className="flex gap-2">
              <LinkButton href="#new-asset">Add an asset</LinkButton>
              <LinkButton href="#new-collateral">Add collateral</LinkButton>
            </div>
          ) : undefined
        }
      />

      <Card>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Outside the building"
            value={money(summary.atLargeCents)}
            note={`${summary.out} signed out, ${summary.overdue} past due`}
            tone={summary.overdue > 0 ? 'warn' : 'neutral'}
          />
          <Stat
            label="Unaccounted for"
            value={money(summary.missingCents)}
            note={
              summary.missing > 0
                ? `${summary.missing} missing long enough to be an insurance claim rather than a reminder`
                : 'nothing lost'
            }
            tone={summary.missing > 0 ? 'bad' : 'good'}
          />
          <Stat
            label="Promised but not fit to go"
            value={summary.unserviceable}
            note="Booked to an upcoming show, and last returned damaged or in for repair."
            tone={summary.unserviceable > 0 ? 'warn' : 'neutral'}
          />
          <Stat
            label="Reserved and never taken"
            value={summary.neverCollected}
            note="Booked, and never signed out. The show went without it, or somebody took it and did not say."
            tone={summary.neverCollected > 0 ? 'warn' : 'neutral'}
          />
        </div>
      </Card>

      {register.clashes.length > 0 && (
        <Card
          title="One thing, two shows"
          subtitle={`Compared on reservation windows, not show dates — the booth is gone for a fortnight around a three-day show. A turnaround under ${TURNAROUND_HOURS}h is flagged as possible rather than certain, because two shows on one floor really can share a crate.`}
        >
          <ul className="space-y-3">
            {register.clashes.map((c) => (
              <li key={`${c.a.reservationId}-${c.b.reservationId}`} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={c.certainty === 'certain' ? 'bad' : 'warn'}>{c.certainty}</Badge>
                  <span className="font-medium">{c.assetName}</span>
                  <span className="text-text-muted">
                    {c.a.showName} ↔ {c.b.showName}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-text-muted">{c.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Assets"
        subtitle="One row per live reservation, plus a row for anything reserved to nothing. An asset promised to two shows appears twice, which is how the double-booking is visible here and not only in the list above."
      >
        {register.rows.length === 0 ? (
          <Empty>
            No reservations. An asset is promised to a show from that show&rsquo;s Logistics tab,
            and appears here for the window it is unavailable — which starts before move-in and
            ends after the crate is home.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Asset</Th>
                  <Th>Condition</Th>
                  <Th>Show</Th>
                  <Th>Unavailable</Th>
                  <Th>Custody</Th>
                  <Th numeric>Value</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {register.rows.map((row) => (
                  <AssetLine
                    key={`${row.asset.id}-${row.reservation?.id ?? 'free'}`}
                    row={row}
                    mayManage={mayManage}
                    costCenters={costCenters}
                  />
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {mayManage && (
          <div className="mt-5 border-t border-border pt-4">
            <div id="new-asset" className="scroll-mt-6">
              <NewAssetForm costCenters={costCenters} />
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Collateral"
        subtitle="On hand is not available. Stock promised to a show that has not packed yet is off the table, and a low-stock figure judged on the shelf reads fine right up to the morning somebody opens the cupboard."
      >
        {collateral.length === 0 ? (
          <Empty>
            Nothing on the shelf yet. Add a print run or giveaway above and the count here becomes
            what is free — on hand minus whatever is already promised to a show.
          </Empty>
        ) : (
          <ul className="space-y-3">
            {collateral.map((c) => (
              <li key={c.item.id} className="border-b border-border pb-3 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{c.item.name}</span>
                  {c.item.sku && <span className="font-mono text-xs">{c.item.sku}</span>}
                  <StockCell standing={c.standing} />
                  {c.costCenterCode && <Badge>{c.costCenterCode}</Badge>}
                  <span className="ml-auto flex items-center gap-3 text-xs">
                    <MoveStockForm itemId={c.item.id} />
                    {mayManage && <EditCollateralForm row={c} costCenters={costCenters} />}
                    {mayManage && <DeleteCollateralForm itemId={c.item.id} />}
                  </span>
                </div>
                {c.alert && (
                  <p className="mt-1 text-xs text-text-muted">
                    <Badge tone={SEVERITY_TONE[c.alert.severity]}>{c.alert.severity}</Badge>{' '}
                    {c.alert.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {mayManage && (
          <div className="mt-5 border-t border-border pt-4">
            <div id="new-collateral" className="scroll-mt-6">
              <NewCollateralForm costCenters={costCenters} />
            </div>
          </div>
        )}
      </Card>

      <Card
        title="What the engine would say tonight"
        subtitle="These reach the alerts feed the next time it is re-checked. Two of them have nothing happening behind them — a window closing, and a fact staying true — which is why every asset is looked at rather than only the ones that changed."
      >
        {alerts.length === 0 ? (
          <Empty>Nothing. Which is the usual answer and the right one.</Empty>
        ) : (
          <ul className="space-y-3">
            {alerts.map((a) => (
              <li key={a.dedupeKey} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                  <span className="font-medium">{a.title}</span>
                  <span className="text-xs text-text-muted">
                    → {a.userId ? 'the person who signed it out' : 'whoever runs the show'}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-text-muted">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AssetLine({
  row,
  mayManage,
  costCenters,
}: {
  row: AssetRow;
  mayManage: boolean;
  costCenters: { id: string; code: string; name: string }[];
}) {
  const r = row.reservation;
  const standing = row.custody?.standing;
  const canSignOut = standing === 'planned' || standing === 'due_out';
  const canSignIn = standing === 'out' || standing === 'overdue' || standing === 'missing';

  return (
    <>
      <tr>
        <Td>
          <div className="font-medium">{row.asset.name}</div>
          <div className="text-xs text-text-muted">
            {row.asset.assetTag ?? 'no tag'} · {row.asset.storageLocation ?? 'location unknown'}
            {row.costCenterCode && ` · ${row.costCenterCode}`}
          </div>
        </Td>
        <Td>
          <ConditionBadge serviceability={row.serviceability} condition={row.asset.condition} />
        </Td>
        <Td>
          {row.showId ? (
            <Link href={`/shows/${row.showId}/logistics`} className="text-brand hover:underline">
              {row.showName}
            </Link>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </Td>
        <Td>
          {r ? (
            <span className="text-xs">
              {local(r.reservedFrom, row.showTimezone)} → {local(r.reservedTo, row.showTimezone)}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
          {row.coverage?.kind === 'short' && (
            <div className="text-xs text-warn">shorter than this show&rsquo;s freight</div>
          )}
          {row.coverage?.kind === 'unverified' && (
            <div className="text-xs text-text-muted">no freight to check it against</div>
          )}
        </Td>
        <Td>
          <CustodyBadge row={row} />
          {row.holderName && <div className="text-xs text-text-muted">{row.holderName}</div>}
        </Td>
        <Td numeric>{money(row.asset.purchaseValueCents)}</Td>
        <Td>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {mayManage && <EditAssetForm row={row} costCenters={costCenters} />}
            {mayManage && !r && <DeleteAssetForm assetId={row.asset.id} />}
          </div>
        </Td>
      </tr>
      {(canSignOut || canSignIn || row.alert) && (
        <tr>
          <Td className="pb-4" />
          <td colSpan={6} className="border-b border-border pb-4 pr-3 align-top">
            {row.alert && (
              <p className="mb-2 text-xs text-text-muted">
                <Badge tone={SEVERITY_TONE[row.alert.severity]}>{row.alert.severity}</Badge>{' '}
                {row.alert.body}
              </p>
            )}
            {/* Anybody. The person in the warehouse at 6am is not a Travel Manager. */}
            {canSignOut && <SignOutForm reservationId={r!.id} showId={row.showId ?? undefined} />}
            {canSignIn && <SignInForm row={row} showId={row.showId ?? undefined} />}
          </td>
        </tr>
      )}
    </>
  );
}
