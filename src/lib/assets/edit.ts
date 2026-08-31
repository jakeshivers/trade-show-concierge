import { TeamError } from '@/lib/team/edit';
import type { AssetCondition, AssetKind } from './custody';
import type { EntryKind } from './inventory';

/**
 * Assets and collateral, as pure validation. SCOPE.md §5h.
 *
 * Two rules here are not form-library rules and are the point of the file.
 *
 * **A return without a condition is how damage becomes nobody's fault.** The
 * chain of custody is only a chain if both ends are recorded; a check-in that
 * lets the condition field stay blank produces a log that says the asset came
 * back and cannot say in what state, which is precisely the question asked six
 * months later when the panel is cracked and three shows have had it since. So
 * condition on return is required, and a condition *worse* than the one it left
 * in needs a written note — the same written-reason rule §5d put on `skipped`
 * and §5a put on `not_applicable`, reached from a third direction: it is the
 * moment the record stops being routine.
 *
 * **A reservation window is not the show's window and must never be prefilled
 * from it.** §5g refused to default an advance-warehouse cutoff from move-in
 * because it is one to three weeks earlier and a wrong-by-a-fortnight date looks
 * right on every screen. The same argument applies here in both directions at
 * once, so the window is asked for, and the freight rows are what it gets
 * checked against afterwards (`freightCoverage`) rather than guessed from.
 */

export class AssetError extends TeamError {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

export const ASSET_KINDS: AssetKind[] = [
  'booth',
  'display',
  'furniture',
  'av_equipment',
  'crate',
  'other',
];

export const ASSET_CONDITIONS: AssetCondition[] = ['good', 'needs_repair', 'damaged', 'retired'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Warehouses run on business hours; a crate leaves in the morning and comes back late. */
export const DEFAULT_OUT_TIME = '08:00';
export const DEFAULT_BACK_TIME = '17:00';

export function requireLocal(date: string, time: string, what: string): string {
  const d = date.trim();
  const t = (time || '').trim() || DEFAULT_OUT_TIME;
  if (!DATE.test(d)) throw new AssetError(`${what} needs a date (YYYY-MM-DD).`);
  if (!TIME.test(t)) throw new AssetError(`${what} needs a 24-hour time (HH:MM).`);
  return `${d}T${t}`;
}

/* --------------------------------- assets ---------------------------------- */

export type AssetDraft = {
  name: string;
  kind: AssetKind;
  assetTag?: string | null;
  condition: AssetCondition;
  storageLocation?: string | null;
  /** A decimal string as typed, e.g. "8400.00". Never a float. */
  purchaseValue?: string | null;
  costCenterId?: string | null;
  weightLb?: string | null;
  dimensions?: string | null;
  notes?: string | null;
};

export type ValidatedAsset = {
  name: string;
  kind: AssetKind;
  assetTag: string | null;
  condition: AssetCondition;
  storageLocation: string | null;
  purchaseValueCents: number | null;
  costCenterId: string | null;
  weightLb: string | null;
  dimensions: string | null;
  notes: string | null;
};

function trimmed(v: string | null | undefined): string | null {
  const s = v?.trim() ?? '';
  return s === '' ? null : s;
}

function decimal(v: string | null | undefined, what: string): number | null {
  const s = trimmed(v);
  if (s === null) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new AssetError(`${what} must be a plain amount like 8400 or 8400.00.`);
  }
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function validateAsset(draft: AssetDraft): ValidatedAsset {
  const name = draft.name?.trim() ?? '';
  if (name.length < 2) throw new AssetError('An asset needs a name somebody would recognise on a crate.');
  if (!ASSET_KINDS.includes(draft.kind)) throw new AssetError('Unknown asset kind.');
  if (!ASSET_CONDITIONS.includes(draft.condition)) throw new AssetError('Unknown condition.');

  const weight = trimmed(draft.weightLb);
  if (weight !== null && !/^\d+(\.\d{1,2})?$/.test(weight)) {
    throw new AssetError('Weight must be a plain number of pounds, e.g. 1240 or 1240.50.');
  }

  return {
    name,
    kind: draft.kind,
    assetTag: trimmed(draft.assetTag),
    condition: draft.condition,
    storageLocation: trimmed(draft.storageLocation),
    purchaseValueCents: decimal(draft.purchaseValue, 'Purchase value'),
    costCenterId: trimmed(draft.costCenterId),
    weightLb: weight,
    dimensions: trimmed(draft.dimensions),
    notes: trimmed(draft.notes),
  };
}

/* ------------------------------ reservations -------------------------------- */

export type ReservationDraft = {
  assetId: string;
  reservedFromDate: string;
  reservedFromTime?: string | null;
  reservedToDate: string;
  reservedToTime?: string | null;
  notes?: string | null;
};

export type ValidatedReservation = {
  assetId: string;
  /** Naive local strings; `store.ts` resolves them against the show's zone. */
  reservedFromLocal: string;
  reservedToLocal: string;
  notes: string | null;
};

export function validateReservation(draft: ReservationDraft): ValidatedReservation {
  if (!draft.assetId?.trim()) throw new AssetError('Pick an asset.');
  const from = requireLocal(
    draft.reservedFromDate,
    draft.reservedFromTime || DEFAULT_OUT_TIME,
    'The date it leaves',
  );
  const to = requireLocal(
    draft.reservedToDate,
    draft.reservedToTime || DEFAULT_BACK_TIME,
    'The date it is back',
  );
  if (to <= from) throw new AssetError('It has to come back after it leaves.');
  return {
    assetId: draft.assetId.trim(),
    reservedFromLocal: from,
    reservedToLocal: to,
    notes: trimmed(draft.notes),
  };
}

/* --------------------------------- custody ---------------------------------- */

export type CheckInDraft = {
  conditionOnReturn: AssetCondition | '';
  conditionOnCheckout: AssetCondition | null;
  note?: string | null;
};

export type ValidatedCheckIn = {
  conditionOnReturn: AssetCondition;
  note: string | null;
};

const RANK: Record<AssetCondition, number> = { good: 0, needs_repair: 1, damaged: 2, retired: 3 };

export function validateCheckIn(draft: CheckInDraft): ValidatedCheckIn {
  const condition = draft.conditionOnReturn;
  if (!condition || !ASSET_CONDITIONS.includes(condition)) {
    throw new AssetError(
      'Say what condition it came back in. A check-in without one produces a log that says the ' +
        'asset returned and cannot say in what state, which is the only question anybody asks later.',
    );
  }
  const note = trimmed(draft.note);
  if (draft.conditionOnCheckout && RANK[condition] > RANK[draft.conditionOnCheckout] && !note) {
    throw new AssetError(
      `It went out ${draft.conditionOnCheckout.replace('_', ' ')} and is coming back ` +
        `${condition.replace('_', ' ')}. Write down what happened — this is the moment the record ` +
        'stops being routine, and a bare status change is unreadable six months from now.',
    );
  }
  return { conditionOnReturn: condition, note };
}

/**
 * Un-reserving cancels nothing outside this app — §5e's rule about un-staffing
 * somebody, applied to a thing. The freight is booked with a carrier and the
 * crate may already be on a truck.
 */
export type ReservationDetachment = {
  assetName: string;
  checkedOut: boolean;
  shipmentCount: number;
};

export function describeReservationRelease(d: ReservationDetachment): string | null {
  const parts: string[] = [];
  if (d.checkedOut) {
    parts.push(`${d.assetName} is signed out and physically gone; releasing the reservation does not bring it back`);
  }
  if (d.shipmentCount > 0) {
    parts.push(
      `${d.shipmentCount} shipment${d.shipmentCount === 1 ? '' : 's'} for this show ${
        d.shipmentCount === 1 ? 'is' : 'are'
      } booked with a carrier and will still run`,
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join('; and ')}. Nothing here is cancelled by this — the log simply stops recording it.`;
}

/* ------------------------------- collateral --------------------------------- */

export type CollateralDraft = {
  name: string;
  sku?: string | null;
  lowStockThreshold: string;
  unitCost?: string | null;
  costCenterId?: string | null;
  storageLocation?: string | null;
};

export type ValidatedCollateral = {
  name: string;
  sku: string | null;
  lowStockThreshold: number;
  unitCostCents: number | null;
  costCenterId: string | null;
  storageLocation: string | null;
};

function count(v: string | null | undefined, what: string): number {
  const s = trimmed(v) ?? '0';
  if (!/^\d+$/.test(s)) throw new AssetError(`${what} must be a whole number of items.`);
  return Number(s);
}

export function validateCollateral(draft: CollateralDraft): ValidatedCollateral {
  const name = draft.name?.trim() ?? '';
  if (name.length < 2) throw new AssetError('A collateral item needs a name.');
  return {
    name,
    sku: trimmed(draft.sku),
    lowStockThreshold: count(draft.lowStockThreshold, 'The low-stock threshold'),
    unitCostCents: decimal(draft.unitCost, 'Unit cost'),
    costCenterId: trimmed(draft.costCenterId),
    storageLocation: trimmed(draft.storageLocation),
  };
}

export type MovementDraft = {
  kind: EntryKind;
  quantity: string;
  reason?: string | null;
};

export type ValidatedMovement = {
  kind: EntryKind;
  /** Absolute, unsigned. `store.ts` applies the sign from the kind. */
  quantity: number;
  reason: string;
};

const MOVEMENT_KINDS: EntryKind[] = ['received', 'issued', 'returned', 'written_off', 'counted'];

export function validateMovement(draft: MovementDraft): ValidatedMovement {
  if (!MOVEMENT_KINDS.includes(draft.kind)) throw new AssetError('Unknown movement.');
  const quantity = count(draft.quantity, 'The quantity');
  if (quantity === 0 && draft.kind !== 'counted') {
    throw new AssetError('A movement of nothing is not a movement.');
  }
  const reason = trimmed(draft.reason);
  // The credit ledger's rule: a balance that moved without a stated reason is
  // not auditable, and an inventory ledger is a balance.
  if (!reason) throw new AssetError('Say why the quantity moved. A ledger entry without a reason is not auditable.');
  return { kind: draft.kind, quantity, reason };
}

export type AllocationDraft = {
  itemId: string;
  quantity: string;
  notes?: string | null;
};

export function validateAllocation(draft: AllocationDraft): {
  itemId: string;
  quantity: number;
  notes: string | null;
} {
  if (!draft.itemId?.trim()) throw new AssetError('Pick a collateral item.');
  const quantity = count(draft.quantity, 'The quantity');
  if (quantity === 0) throw new AssetError('Allocating nothing is not an allocation.');
  return { itemId: draft.itemId.trim(), quantity, notes: trimmed(draft.notes) };
}
