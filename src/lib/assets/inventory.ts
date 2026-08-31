/**
 * Collateral, as pure functions. SCOPE.md §5h.
 *
 * Three arguments, and the first is `coverage.ts`'s in a different unit.
 *
 * **On hand is not available.** 640 datasheets on the shelf with 400 promised to
 * a show next week is 240 available, and a low-stock threshold checked against
 * `quantity_on_hand` reports "fine" every single day until somebody opens the
 * cupboard to pack the crate and finds it short. This is §5e's `overstated`
 * shift exactly — a number that counts commitments as capacity — and it fails
 * the same way, by reassuring you about the one thing nobody looks at twice.
 *
 * **An uncounted return is not a zero return.** `quantity_returned` is nullable
 * and that nullability is load-bearing. "Nobody counted" and "counted, none came
 * back" are different facts: the second is 280 datasheets legitimately given
 * away at a booth, the first is a box that may still be sitting in Warehouse A.
 * Reading null as zero writes off stock we still own — and reading it as
 * "everything came back" ships a show short. So it is neither: it is an *open*
 * allocation, and the shows that ended with open allocations are a list.
 *
 * **An allocation is not a movement.** Promising 400 datasheets is a claim on
 * stock; the movement happens when they leave the shelf. The ledger in
 * `collateral_entries` records only the second, which is why `quantityOnHand` is
 * a projection of signed deltas — the ground rule the credit ledger has carried
 * since step 6, applied to things instead of money.
 */

export type CollateralItem = {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: number;
  lowStockThreshold: number;
  unitCostCents: number | null;
  storageLocation: string | null;
};

export type Allocation = {
  id: string;
  itemId: string;
  showId: string;
  quantityAllocated: number;
  issuedAt: Date | null;
  quantityReturned: number | null;
  returnedAt: Date | null;
};

export type AllocationStanding =
  /** Promised, still on the shelf. Reduces availability, not on-hand. */
  | 'planned'
  /** In the crate. Off the shelf, and owed a count when it comes back. */
  | 'issued'
  /** Counted back. The only state that closes the loop. */
  | 'reconciled';

export function allocationStanding(a: Allocation): AllocationStanding {
  if (a.returnedAt) return 'reconciled';
  return a.issuedAt ? 'issued' : 'planned';
}

export type StockStanding = {
  itemId: string;
  onHand: number;
  /** Promised to a show and not yet picked. Real, and invisible on the shelf. */
  committed: number;
  /** Off the shelf, in a crate somewhere, not yet counted back. */
  issued: number;
  /** `onHand - committed`. Negative means we have promised what we do not have. */
  available: number;
  threshold: number;
  level: 'ok' | 'low' | 'short';
  /** Shows that ended with stock nobody counted back. */
  openAllocations: number;
};

export function stockStanding(item: CollateralItem, allocations: Allocation[]): StockStanding {
  let committed = 0;
  let issued = 0;
  let open = 0;
  for (const a of allocations) {
    if (a.itemId !== item.id) continue;
    const standing = allocationStanding(a);
    if (standing === 'planned') committed += a.quantityAllocated;
    if (standing === 'issued') {
      issued += a.quantityAllocated;
      open += 1;
    }
  }
  const available = item.quantityOnHand - committed;
  return {
    itemId: item.id,
    onHand: item.quantityOnHand,
    committed,
    issued,
    available,
    threshold: item.lowStockThreshold,
    // Judged on `available`, never on `onHand`. See the header.
    level: available < 0 ? 'short' : available <= item.lowStockThreshold ? 'low' : 'ok',
    openAllocations: open,
  };
}

/* --------------------------------- ledger ---------------------------------- */

export type EntryKind = 'received' | 'issued' | 'returned' | 'written_off' | 'counted';

export type LedgerEntry = {
  kind: EntryKind;
  delta: number;
  quantityAfter: number;
  occurredAt: Date;
  reason: string;
};

/**
 * The projection, so a caller can check the column against the trail. A balance
 * that has drifted from its ledger is worth nothing, which is the sentence the
 * credit ground rule uses about money.
 */
export function projectQuantity(entries: LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + e.delta, 0);
}

/** The sign a kind is allowed to carry. `counted` is the only two-way one. */
export function signOf(kind: EntryKind): -1 | 0 | 1 {
  switch (kind) {
    case 'received':
    case 'returned':
      return 1;
    case 'issued':
    case 'written_off':
      return -1;
    case 'counted':
      return 0;
  }
}

/* ------------------------------- reconciling -------------------------------- */

export type ReconcileVerdict =
  | { kind: 'ok'; consumed: number; returned: number }
  | { kind: 'refused'; why: string };

/**
 * What a physical count of a returned box means.
 *
 * Refusing a count larger than what went out is not pedantry: it is the one
 * arithmetic mistake that silently *creates* inventory, and inventory created by
 * a typo is indistinguishable on every later screen from inventory we bought.
 */
export function reconcileAllocation(a: Allocation, counted: number): ReconcileVerdict {
  if (!Number.isInteger(counted) || counted < 0) {
    return { kind: 'refused', why: 'A count is a whole number of items, and never negative.' };
  }
  if (!a.issuedAt) {
    return {
      kind: 'refused',
      why: 'Nothing has left the shelf for this allocation yet, so there is nothing to count back.',
    };
  }
  if (counted > a.quantityAllocated) {
    return {
      kind: 'refused',
      why:
        `${counted} came back from an allocation of ${a.quantityAllocated}. Counting more in than ` +
        'went out invents stock, and invented stock is indistinguishable later from stock we bought.',
    };
  }
  return { kind: 'ok', consumed: a.quantityAllocated - counted, returned: counted };
}
