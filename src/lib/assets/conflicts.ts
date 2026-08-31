import {
  TURNAROUND_HOURS,
  gapHours,
  overlaps,
  type Reservation,
  type TrackedAsset,
} from './custody';

/**
 * One thing, two shows. Pure.
 *
 * §5e's conflict model asks whether a *person* is promised to two places, and
 * the correction there was that comparing show dates over-reports: Monday–
 * Tuesday in Detroit and Thursday–Friday in Chicago is an ordinary week, and a
 * warning that fires on the ordinary week is one nobody reads.
 *
 * An asset inverts every clause of that. It cannot be in two places, it cannot
 * fly overnight, and the show dates **under**-report rather than over-report,
 * because the booth is on a truck for a fortnight around a three-day show. So
 * this file compares reservation windows — the ones §5h insists are longer than
 * the show at both ends — and adds a second finding that has no counterpart on
 * the people side at all:
 *
 * **Adjacent is not clear.** Two reservations that do not overlap can still be
 * impossible. `reserved_to` on the 8th and `reserved_from` on the 10th means the
 * crate has 48 hours to cross the country, be opened, be inspected and be
 * re-crated. That is a `possible` finding rather than a `certain` one — some
 * shows really are in the same convention centre a week apart, and the drayage
 * contractor really can hold freight on site — which is the same certainty
 * distinction §5e drew, reached from the opposite direction: there it was
 * uncertainty about the *data*, here it is uncertainty about the *world*.
 */

export type AssetClashSide = {
  reservationId: string;
  showId: string;
  showName: string;
  from: Date;
  to: Date;
};

export type AssetClash = {
  assetId: string;
  assetName: string;
  assetTag: string | null;
  kind: 'overlap' | 'turnaround';
  certainty: 'certain' | 'possible';
  /** Positive for an overlap, in hours. Zero for a turnaround finding. */
  overlapHours: number;
  /** Clear air between the two windows. Negative when they overlap. */
  gapHours: number;
  a: AssetClashSide;
  b: AssetClashSide;
  detail: string;
};

export type ReservedAsset = {
  asset: TrackedAsset;
  reservation: Reservation;
  showName: string;
};

const HOUR = 3_600_000;

function side(r: ReservedAsset): AssetClashSide {
  return {
    reservationId: r.reservation.id,
    showId: r.reservation.showId,
    showName: r.showName,
    from: r.reservation.reservedFrom,
    to: r.reservation.reservedTo,
  };
}

function windowOf(r: ReservedAsset) {
  return { from: r.reservation.reservedFrom, to: r.reservation.reservedTo };
}

/**
 * Every clash across the workspace, one row per pair.
 *
 * Ordered worst first: a certain overlap, then by how little air there is.
 */
export function findAssetClashes(rows: ReservedAsset[]): AssetClash[] {
  const byAsset = new Map<string, ReservedAsset[]>();
  for (const row of rows) {
    const list = byAsset.get(row.asset.id) ?? [];
    list.push(row);
    byAsset.set(row.asset.id, list);
  }

  const clashes: AssetClash[] = [];
  for (const list of byAsset.values()) {
    const sorted = [...list].sort(
      (x, y) => x.reservation.reservedFrom.getTime() - y.reservation.reservedFrom.getTime(),
    );
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        const clash = compare(a, b);
        if (clash) clashes.push(clash);
      }
    }
  }

  return clashes.sort((x, y) => {
    if (x.certainty !== y.certainty) return x.certainty === 'certain' ? -1 : 1;
    return x.gapHours - y.gapHours;
  });
}

function compare(a: ReservedAsset, b: ReservedAsset): AssetClash | null {
  const wa = windowOf(a);
  const wb = windowOf(b);
  const gap = gapHours(wa, wb);

  if (overlaps(wa, wb)) {
    const overlapMs =
      Math.min(wa.to.getTime(), wb.to.getTime()) - Math.max(wa.from.getTime(), wb.from.getTime());
    const hours = overlapMs / HOUR;
    return {
      assetId: a.asset.id,
      assetName: a.asset.name,
      assetTag: a.asset.assetTag,
      kind: 'overlap',
      certainty: 'certain',
      overlapHours: hours,
      gapHours: gap,
      a: side(a),
      b: side(b),
      detail:
        `${a.asset.name} is promised to ${a.showName} and ${b.showName} for the same ` +
        `${(hours / 24).toFixed(1)} days. One of them is going to find out on move-in morning.`,
    };
  }

  if (gap < TURNAROUND_HOURS) {
    return {
      assetId: a.asset.id,
      assetName: a.asset.name,
      assetTag: a.asset.assetTag,
      kind: 'turnaround',
      certainty: 'possible',
      overlapHours: 0,
      gapHours: gap,
      a: side(a),
      b: side(b),
      detail:
        `${a.asset.name} has ${gap.toFixed(0)} hours between ${a.showName} and ${b.showName} — ` +
        `less than the ${TURNAROUND_HOURS}h it takes to get freight home, opened, checked and ` +
        `back on a truck. Possible rather than certain: if both shows are on the same floor, or ` +
        `the crate never comes home between them, this is fine and worth recording as one window.`,
    };
  }

  return null;
}
