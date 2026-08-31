/**
 * Chain of custody, as pure functions. SCOPE.md §5h.
 *
 * `asset_reservations` has been "a log, not a flag" in the schema comment since
 * step 1, and for fifteen steps it was a flag with extra columns: a row with a
 * window and nothing ever written into `checked_out_at` or `returned_at`. This
 * file is the model that makes the log mean something, and it holds three
 * arguments.
 *
 * **Reserved is not available, and available is not serviceable.** §5e found
 * that an assigned booth shift is not a covered one, because the person may not
 * be able to stand there. An asset has the same gap and one more beyond it: a
 * reservation is a claim on a thing that may already be committed elsewhere, and
 * a thing that is committed to nobody may still be a touchscreen with a cracked
 * panel. `assets.condition` is a fact recorded on the *last* return and every
 * screen renders it as a label; nothing joins it to the reservation three weeks
 * out that it invalidates. So availability is a verdict with three refusals in
 * it, not a boolean.
 *
 * **The reservation window is not the show window, and it is longer at both
 * ends.** Freight leaves for an advance warehouse one to three weeks before
 * move-in (§5g) and comes back weeks after move-out. This is the exact inverse
 * of §5e's correction about people: comparing *show dates* over-reported a
 * person's double-booking, because Monday–Tuesday and Thursday–Friday is an
 * ordinary week; comparing show dates **under**-reports an asset's, because the
 * booth is physically gone for a month around a three-day show. Whichever way it
 * errs, the fix is the same — compare the window that describes the thing.
 *
 * **"In what condition" is only answerable as a delta.** `assets.condition` is
 * mutable, so by the time anybody asks whether Automate cracked the panel, the
 * column reads `needs_repair` and cannot say when it started. The reservation
 * records the condition at both ends and the log reads on its own.
 */

export type AssetCondition = 'good' | 'damaged' | 'needs_repair' | 'retired';
export type AssetKind = 'booth' | 'display' | 'furniture' | 'av_equipment' | 'crate' | 'other';

export type TrackedAsset = {
  id: string;
  name: string;
  kind: AssetKind;
  assetTag: string | null;
  condition: AssetCondition;
  storageLocation: string | null;
  purchaseValueCents: number | null;
};

export type Reservation = {
  id: string;
  assetId: string;
  showId: string;
  reservedFrom: Date;
  reservedTo: Date;
  checkedOutAt: Date | null;
  checkedOutById: string | null;
  conditionOnCheckout: AssetCondition | null;
  returnedAt: Date | null;
  returnedById: string | null;
  conditionOnReturn: AssetCondition | null;
};

/**
 * Paperwork lags a truck. Three days after the window closes is somebody who has
 * not filed the return; thirty is an asset nobody can name the location of, which
 * is the sentence the schema comment has carried since step 1.
 */
export const RETURN_GRACE_HOURS = 72;
export const MISSING_AFTER_HOURS = 30 * 24;

/**
 * A crate does not teleport. Between one show's `reserved_to` and the next
 * show's `reserved_from` there has to be enough time to get it home, open it,
 * look at it and send it out again — and five days is the optimistic figure for
 * cross-country LTL freight alone.
 */
export const TURNAROUND_HOURS = 120;

export type CustodyStanding =
  /** The window has not opened. Nothing is owed yet. */
  | 'planned'
  /** The window is open and nobody has taken it. The show may be shipping without it. */
  | 'due_out'
  /** Signed out, inside its window. The ordinary state. */
  | 'out'
  /** Signed out, past the window and the grace. Somebody has it and has not said so. */
  | 'overdue'
  /** Signed out and a month past. This is the one the schema comment is about. */
  | 'missing'
  /** The window closed and it was never collected. The show happened without it. */
  | 'never_collected'
  | 'returned';

export type Custody = {
  standing: CustodyStanding;
  /** Hours past `reserved_to`, negative while the window is still open. */
  hoursPastDue: number;
  /**
   * How the condition moved across this reservation. `null` when either end is
   * unrecorded — which is not "unchanged", and the screens must not draw it as
   * such.
   */
  conditionChange: 'unchanged' | 'worsened' | 'improved' | null;
};

const HOUR = 3_600_000;

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR;
}

const CONDITION_RANK: Record<AssetCondition, number> = {
  good: 0,
  needs_repair: 1,
  damaged: 2,
  retired: 3,
};

function conditionChange(r: Reservation): Custody['conditionChange'] {
  if (!r.conditionOnCheckout || !r.conditionOnReturn) return null;
  const delta = CONDITION_RANK[r.conditionOnReturn] - CONDITION_RANK[r.conditionOnCheckout];
  if (delta === 0) return 'unchanged';
  return delta > 0 ? 'worsened' : 'improved';
}

export function custodyOf(r: Reservation, asOf: Date): Custody {
  const hoursPastDue = hoursBetween(r.reservedTo, asOf);
  const change = conditionChange(r);

  if (r.returnedAt) return { standing: 'returned', hoursPastDue, conditionChange: change };

  if (r.checkedOutAt) {
    if (hoursPastDue > MISSING_AFTER_HOURS) {
      return { standing: 'missing', hoursPastDue, conditionChange: change };
    }
    if (hoursPastDue > RETURN_GRACE_HOURS) {
      return { standing: 'overdue', hoursPastDue, conditionChange: change };
    }
    return { standing: 'out', hoursPastDue, conditionChange: change };
  }

  // Never checked out. Past the window, that is not "still planned" — the show
  // came and went and the thing stayed in the warehouse, which is a fact worth
  // one alert and is invisible on a screen that renders a reservation as a row.
  if (hoursPastDue > 0) {
    return { standing: 'never_collected', hoursPastDue, conditionChange: change };
  }
  if (asOf >= r.reservedFrom) {
    return { standing: 'due_out', hoursPastDue, conditionChange: change };
  }
  return { standing: 'planned', hoursPastDue, conditionChange: change };
}

/** A reservation that still ties the asset up: taken, or owed, or open. */
export function isLive(r: Reservation, asOf: Date): boolean {
  const standing = custodyOf(r, asOf).standing;
  return standing !== 'returned' && standing !== 'never_collected';
}

/* -------------------------------- condition -------------------------------- */

export type Serviceability =
  | { kind: 'serviceable' }
  | { kind: 'unserviceable'; condition: AssetCondition; why: string };

/**
 * Only `good` is serviceable, and the two failure conditions are deliberately
 * not collapsed. "Damaged" is a thing that cannot go on a floor; "needs repair"
 * is a thing that will embarrass you on one. Both block, for different reasons a
 * person acts on differently — the same argument that keeps `secondhand` apart
 * from `unconfirmed` in §5e.
 */
export function serviceabilityOf(asset: Pick<TrackedAsset, 'condition'>): Serviceability {
  switch (asset.condition) {
    case 'good':
      return { kind: 'serviceable' };
    case 'needs_repair':
      return {
        kind: 'unserviceable',
        condition: 'needs_repair',
        why: 'flagged for repair on its last return',
      };
    case 'damaged':
      return { kind: 'unserviceable', condition: 'damaged', why: 'damaged' };
    case 'retired':
      return { kind: 'unserviceable', condition: 'retired', why: 'retired from service' };
  }
}

/* ------------------------------- availability ------------------------------ */

export type Availability =
  | { kind: 'available' }
  | { kind: 'unserviceable'; condition: AssetCondition; why: string }
  | { kind: 'committed'; toShowIds: string[] }
  | { kind: 'tight_turnaround'; toShowIds: string[]; gapHours: number };

export function overlaps(
  a: { from: Date; to: Date },
  b: { from: Date; to: Date },
): boolean {
  return a.from < b.to && b.from < a.to;
}

/** Hours of clear air between two windows; negative when they overlap. */
export function gapHours(a: { from: Date; to: Date }, b: { from: Date; to: Date }): number {
  const [first, second] = a.from <= b.from ? [a, b] : [b, a];
  return hoursBetween(first.to, second.from);
}

/**
 * Whether this asset can be promised to a window, given everything already
 * promised. `others` must exclude the reservation being judged, if there is one.
 */
export function availabilityFor(
  asset: Pick<TrackedAsset, 'condition'>,
  others: Reservation[],
  window: { from: Date; to: Date },
): Availability {
  const service = serviceabilityOf(asset);
  if (service.kind === 'unserviceable') {
    return { kind: 'unserviceable', condition: service.condition, why: service.why };
  }

  const clashing = others.filter((o) =>
    overlaps(window, { from: o.reservedFrom, to: o.reservedTo }),
  );
  if (clashing.length > 0) {
    return { kind: 'committed', toShowIds: [...new Set(clashing.map((c) => c.showId))] };
  }

  let tightest: { showIds: string[]; gap: number } | null = null;
  for (const o of others) {
    const gap = gapHours(window, { from: o.reservedFrom, to: o.reservedTo });
    if (gap >= TURNAROUND_HOURS) continue;
    if (!tightest || gap < tightest.gap) tightest = { showIds: [o.showId], gap };
    else if (gap === tightest.gap) tightest.showIds.push(o.showId);
  }
  if (tightest) {
    return {
      kind: 'tight_turnaround',
      toShowIds: [...new Set(tightest.showIds)],
      gapHours: tightest.gap,
    };
  }

  return { kind: 'available' };
}

/* ---------------------------- freight coverage ----------------------------- */

/**
 * Where assets and shipping meet, and the reason step 16 comes after step 14.
 *
 * A reservation window is a claim about when the thing is unavailable, and the
 * freight rows are the record of when it is actually gone. If the crate has to
 * be at an advance warehouse on the 3rd and the reservation opens on the 9th,
 * the reservation is a fiction — the asset left six days before anybody had it
 * booked, and the six days it was double-promised are exactly the days that
 * would not show up in `availabilityFor`.
 *
 * The verdict is `unverified` rather than `covers` when there is no freight to
 * compare against, for the reason §5f gives about an unchecked flight: not
 * knowing is not the same as fine, and a green tick on an unverifiable claim is
 * worse than a blank.
 */
export type FreightBounds = {
  /** When the outbound crate must be at the dock — the asset is gone before this. */
  outboundBy: Date | null;
  /** When the return crate is expected home, or move-out if nothing came back. */
  homeBy: Date | null;
};

export type CoverageVerdict =
  | { kind: 'unverified'; why: string }
  | { kind: 'covers' }
  | { kind: 'short'; opensLateHours: number | null; closesEarlyHours: number | null };

export function freightCoverage(
  r: Pick<Reservation, 'reservedFrom' | 'reservedTo'>,
  bounds: FreightBounds,
): CoverageVerdict {
  if (!bounds.outboundBy && !bounds.homeBy) {
    return {
      kind: 'unverified',
      why: 'no freight recorded for this show, so there is nothing to check the window against',
    };
  }

  const opensLate =
    bounds.outboundBy && r.reservedFrom > bounds.outboundBy
      ? hoursBetween(bounds.outboundBy, r.reservedFrom)
      : null;
  const closesEarly =
    bounds.homeBy && r.reservedTo < bounds.homeBy
      ? hoursBetween(r.reservedTo, bounds.homeBy)
      : null;

  if (opensLate === null && closesEarly === null) return { kind: 'covers' };
  return { kind: 'short', opensLateHours: opensLate, closesEarlyHours: closesEarly };
}
