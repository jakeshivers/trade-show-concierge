import {
  availabilityFor,
  custodyOf,
  freightCoverage,
  serviceabilityOf,
  type Availability,
  type CoverageVerdict,
  type Custody,
  type FreightBounds,
  type Reservation,
  type Serviceability,
  type TrackedAsset,
} from './custody';
import { planReservationAlert, type AlertableReservation, type PlannedAssetAlert } from './alerts';

/**
 * The asset register's ordering and its summary. Pure.
 *
 * Same argument as `shipping/board.ts` and `flights/board.ts`: sorted by date,
 * the row at the top is whichever reservation opens soonest, which is a booth
 * doing exactly what it is supposed to. The rows worth the top of a screen are
 * the ones that are wrong — gone and not come back, promised twice, promised
 * broken — and the date only breaks ties.
 *
 * The one figure with no counterpart on the other two boards is `atLarge`: the
 * value of capital currently signed out. A flight that landed is over and a
 * received crate is done, but an asset is a thing we own that is not where we
 * keep it, every day, as a normal state of affairs. Counting the money that is
 * out of the building is what turns "the log" into something a finance
 * conversation can start from — and it is the figure that made `never_returned`
 * worth an alert rather than a column.
 */

export type AssetRow = {
  asset: TrackedAsset;
  costCenterCode: string | null;
  /** Null when the asset is not reserved for anything live. */
  reservation: Reservation | null;
  showId: string | null;
  showName: string | null;
  showTimezone: string | null;
  holderId: string | null;
  holderName: string | null;
  custody: Custody | null;
  serviceability: Serviceability;
  /** Whether the reservation window covers the show's actual freight. */
  coverage: CoverageVerdict | null;
  alert: PlannedAssetAlert | null;
};

export type AssetBoardSummary = {
  assets: number;
  /** Signed out and not checked in. Not a problem — just not here. */
  out: number;
  /** Past the window and the grace. */
  overdue: number;
  /** A month past. Insurance, not a reminder. */
  missing: number;
  /** Reserved for something upcoming and not fit to go. */
  unserviceable: number;
  /** Window closed, never signed out. The show went without it, or somebody took it quietly. */
  neverCollected: number;
  /** Capital currently outside the building, in cents. */
  atLargeCents: number;
  /** Purchase value we cannot account for at all, in cents. */
  missingCents: number;
};

const STANDING_RANK: Record<string, number> = {
  missing: 0,
  overdue: 1,
  never_collected: 2,
  due_out: 3,
  out: 4,
  planned: 5,
  returned: 6,
};

function rank(row: AssetRow): number {
  // Unserviceable-but-reserved outranks everything except a lost asset: it is
  // the only one still cheap to fix, and the only one nothing else on any
  // screen puts together.
  if (row.custody && row.custody.standing === 'missing') return -3;
  if (row.alert?.reason === 'unserviceable_reservation') return -2;
  if (row.custody && row.custody.standing === 'overdue') return -1;
  if (!row.custody) return serviceabilityOf(row.asset).kind === 'unserviceable' ? 6.5 : 7;
  return STANDING_RANK[row.custody.standing] ?? 8;
}

export function buildAssetRow(
  item: {
    asset: TrackedAsset;
    costCenterCode: string | null;
    reservation: Reservation | null;
    showId: string | null;
    showName: string | null;
    showTimezone: string | null;
    moveInAt: Date | null;
    holderId: string | null;
    holderName: string | null;
    freight?: FreightBounds;
  },
  asOf: Date,
): AssetRow {
  const base = {
    asset: item.asset,
    costCenterCode: item.costCenterCode,
    reservation: item.reservation,
    showId: item.showId,
    showName: item.showName,
    showTimezone: item.showTimezone,
    holderId: item.holderId,
    holderName: item.holderName,
    serviceability: serviceabilityOf(item.asset),
  };

  if (!item.reservation) {
    return { ...base, custody: null, coverage: null, alert: null };
  }

  const alertable: AlertableReservation = {
    asset: item.asset,
    reservation: item.reservation,
    showId: item.showId!,
    showName: item.showName ?? 'a show',
    moveInAt: item.moveInAt,
    holderId: item.holderId,
    holderName: item.holderName,
    freight: item.freight,
  };

  return {
    ...base,
    custody: custodyOf(item.reservation, asOf),
    coverage: item.freight ? freightCoverage(item.reservation, item.freight) : null,
    alert: planReservationAlert(alertable, asOf),
  };
}

export function orderAssets(rows: AssetRow[]): AssetRow[] {
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const at = a.reservation?.reservedTo.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bt = b.reservation?.reservedTo.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.asset.name.localeCompare(b.asset.name);
  });
}

export function summarizeAssets(rows: AssetRow[]): AssetBoardSummary {
  const s: AssetBoardSummary = {
    assets: 0,
    out: 0,
    overdue: 0,
    missing: 0,
    unserviceable: 0,
    neverCollected: 0,
    atLargeCents: 0,
    missingCents: 0,
  };
  const counted = new Set<string>();
  for (const r of rows) {
    if (!counted.has(r.asset.id)) {
      counted.add(r.asset.id);
      s.assets += 1;
    }
    const value = r.asset.purchaseValueCents ?? 0;
    const standing = r.custody?.standing;
    if (standing === 'out') {
      s.out += 1;
      s.atLargeCents += value;
    }
    if (standing === 'overdue') {
      s.overdue += 1;
      s.atLargeCents += value;
    }
    if (standing === 'missing') {
      s.missing += 1;
      s.missingCents += value;
    }
    if (standing === 'never_collected') s.neverCollected += 1;
    if (r.alert?.reason === 'unserviceable_reservation') s.unserviceable += 1;
  }
  return s;
}

/** For a picker: what can honestly be offered for this window, and why not. */
export type AssetOption = {
  asset: TrackedAsset;
  availability: Availability;
};

export function offerAssets(
  assets: TrackedAsset[],
  reservationsByAsset: Map<string, Reservation[]>,
  window: { from: Date; to: Date },
): AssetOption[] {
  return assets
    .map((asset) => ({
      asset,
      availability: availabilityFor(asset, reservationsByAsset.get(asset.id) ?? [], window),
    }))
    .sort((a, b) => {
      const order = (o: AssetOption) =>
        o.availability.kind === 'available'
          ? 0
          : o.availability.kind === 'tight_turnaround'
            ? 1
            : o.availability.kind === 'committed'
              ? 2
              : 3;
      const d = order(a) - order(b);
      return d !== 0 ? d : a.asset.name.localeCompare(b.asset.name);
    });
}
