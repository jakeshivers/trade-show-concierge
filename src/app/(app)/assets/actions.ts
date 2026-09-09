'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { MoneyParseError } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import {
  allocateCollateral,
  checkInAsset,
  checkOutAsset,
  countBackAllocation,
  createAsset,
  createCollateralItem,
  deleteAllocation,
  deleteAsset,
  deleteCollateralItem,
  editAsset,
  editCollateralItem,
  editReservation,
  issueAllocation,
  recordMovement,
  releaseReservation,
  reserveAsset,
} from '@/lib/assets/store';
import type { AssetCondition, AssetKind } from '@/lib/assets/custody';
import type { EntryKind } from '@/lib/assets/inventory';
import { type FormState, formErrorFrom, optional, str } from '../_components/form';

/**
 * The asset register's writes, shared by `/assets` and the show's Logistics tab.
 *
 * Both screens revalidate both places, because the two views of one reservation
 * are the thing most likely to disagree: signing the booth out from the show tab
 * and leaving the workspace register saying it is on a shelf is exactly the
 * failure the whole feature exists to prevent.
 *
 * `signOut`, `signIn` and the two count controls are the ones anybody may use.
 * They are also the only *facts* here; everything else is a plan.
 */

const EXPECTED = [TeamError, ForbiddenError, NotFoundError, ZonedTimeError, MoneyParseError];
const asFormError = formErrorFrom(EXPECTED);

function refresh(showId?: string | null) {
  revalidatePath('/assets');
  if (showId) {
    revalidatePath(`/shows/${showId}/logistics`);
    revalidatePath(`/shows/${showId}`);
  }
}

/* --------------------------------- assets ---------------------------------- */

function assetDraftFrom(form: FormData) {
  return {
    name: str(form, 'name'),
    kind: str(form, 'kind') as AssetKind,
    assetTag: optional(form, 'assetTag'),
    condition: (optional(form, 'condition') ?? 'good') as AssetCondition,
    storageLocation: optional(form, 'storageLocation'),
    purchaseValue: optional(form, 'purchaseValue'),
    costCenterId: optional(form, 'costCenterId'),
    weightLb: optional(form, 'weightLb'),
    dimensions: optional(form, 'dimensions'),
    notes: optional(form, 'notes'),
  };
}

export async function addAsset(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await createAsset(actor, assetDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Added. Its condition changes on a check-in, not on this form — that is where the fact comes from.' };
}

export async function updateAsset(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await editAsset(actor, str(form, 'assetId'), assetDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Updated.' };
}

export async function removeAsset(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await deleteAsset(actor, str(form, 'assetId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Deleted, along with its reservations. Nothing outside this app changed.' };
}

/* ------------------------------- reservations ------------------------------- */

function reservationDraftFrom(form: FormData) {
  return {
    assetId: str(form, 'assetId'),
    reservedFromDate: str(form, 'reservedFromDate'),
    reservedFromTime: optional(form, 'reservedFromTime'),
    reservedToDate: str(form, 'reservedToDate'),
    reservedToTime: optional(form, 'reservedToTime'),
    notes: optional(form, 'notes'),
  };
}

export async function reserve(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await reserveAsset(actor, showId, reservationDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Reserved. The window is when the asset is unavailable, not when the show runs — the freight leaves before move-in and comes home after move-out, and the register checks the two against each other.',
  };
}

export async function rewindow(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editReservation(actor, str(form, 'reservationId'), reservationDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Re-windowed. Any alert already sent about the old dates is void — it was a claim about a window that no longer exists.' };
}

export async function release(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await releaseReservation(actor, str(form, 'reservationId'), optional(form, 'acknowledged') === 'yes');
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Released here. Nothing outside this app was cancelled.' };
}

/** Anybody. The person wheeling the crate onto the truck is whoever is there. */
export async function signOut(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = optional(form, 'showId');
  try {
    await checkOutAsset(actor, str(form, 'reservationId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Signed out, with the condition it left in recorded — which is the only thing that makes “what condition did it come back in” an answerable question.',
  };
}

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = optional(form, 'showId');
  try {
    await checkInAsset(actor, str(form, 'reservationId'), {
      conditionOnReturn: (optional(form, 'conditionOnReturn') ?? '') as AssetCondition | '',
      conditionOnCheckout: (optional(form, 'conditionOnCheckout') ?? null) as AssetCondition | null,
      note: optional(form, 'note'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Checked in. The asset’s condition now says what the person who unpacked it said.' };
}

/* -------------------------------- collateral -------------------------------- */

function collateralDraftFrom(form: FormData) {
  return {
    name: str(form, 'name'),
    sku: optional(form, 'sku'),
    lowStockThreshold: str(form, 'lowStockThreshold'),
    unitCost: optional(form, 'unitCost'),
    costCenterId: optional(form, 'costCenterId'),
    storageLocation: optional(form, 'storageLocation'),
  };
}

export async function addCollateral(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await createCollateralItem(actor, collateralDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Added with nothing on hand. Stock arrives through a movement, so the ledger has a first entry rather than a number that came from nowhere.' };
}

export async function updateCollateral(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await editCollateralItem(actor, str(form, 'itemId'), collateralDraftFrom(form));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Updated. The quantity is not on this form — it moves only through the ledger.' };
}

export async function removeCollateral(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await deleteCollateralItem(actor, str(form, 'itemId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Deleted, with its ledger.' };
}

/** The only thing that moves a quantity, and it always carries a reason. */
export async function moveStock(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await recordMovement(actor, str(form, 'itemId'), {
      kind: str(form, 'kind') as EntryKind,
      quantity: str(form, 'quantity'),
      reason: optional(form, 'reason'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh();
  return { ok: 'Recorded as a signed delta. The on-hand figure is the sum of the ledger, never a number typed over it.' };
}

export async function allocate(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await allocateCollateral(actor, showId, {
      itemId: str(form, 'itemId'),
      quantity: str(form, 'quantity'),
      notes: optional(form, 'notes'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Promised. Nothing has left the shelf — but it is no longer available either, which is the difference the low-stock figure is judged on.',
  };
}

export async function packAllocation(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = optional(form, 'showId');
  try {
    await issueAllocation(actor, str(form, 'allocationId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Packed, and off the shelf. It is owed a count when it comes back.' };
}

export async function countBack(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = optional(form, 'showId');
  const raw = optional(form, 'counted');
  if (raw === null) {
    return {
      error:
        'Type a number, even if it is zero. A blank is not a count — it means nobody looked, and the app must not read that as “none came back”.',
    };
  }
  try {
    await countBackAllocation(actor, str(form, 'allocationId'), Number(raw));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Counted. What did not come back is consumed, and the ledger now says so.' };
}

export async function unallocate(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = optional(form, 'showId');
  try {
    await deleteAllocation(actor, str(form, 'allocationId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Removed.' };
}
