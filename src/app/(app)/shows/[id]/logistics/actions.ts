'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { MoneyParseError } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import {
  addShipment,
  confirmReceipt,
  deleteShipment,
  editShipment,
  recordScan,
  undoReceipt,
} from '@/lib/shipping/store';
import type { Consignment } from '@/lib/shipping/status';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

/**
 * Logistics' writes.
 *
 * `confirmArrival` is the one worth reading. It is the only write on this screen
 * that anybody may make — not because the permission was hard to decide, but
 * because it is the only *fact* on the page. Everything else is a plan.
 */

const EXPECTED = [TeamError, ForbiddenError, NotFoundError, ZonedTimeError, MoneyParseError];
const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/logistics`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/shipping');
}

function draftFrom(form: FormData) {
  return {
    description: str(form, 'description'),
    direction: (str(form, 'direction') === 'return' ? 'return' : 'outbound') as 'outbound' | 'return',
    consignment: str(form, 'consignment') as Consignment,
    carrier: str(form, 'carrier'),
    trackingNumber: optional(form, 'trackingNumber'),
    ownerId: optional(form, 'ownerId'),
    mustArriveOn: optional(form, 'mustArriveOn'),
    mustArriveAt: optional(form, 'mustArriveAt'),
    receivingOpensOn: optional(form, 'receivingOpensOn'),
    receivingOpensAt: optional(form, 'receivingOpensAt'),
    pieces: optional(form, 'pieces'),
    weightLb: optional(form, 'weightLb'),
    declaredValue: optional(form, 'declaredValue'),
    cost: optional(form, 'cost'),
    costCenterId: str(form, 'costCenterId'),
    notes: optional(form, 'notes'),
  };
}

export async function createShipment(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const hasNumber = Boolean(optional(form, 'trackingNumber'));
  try {
    await addShipment(actor, showId, draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {
    ok: hasNumber
      ? 'Added. Nothing has moved until a carrier scans it — the row says label created, not in transit, and the sweep is what changes that.'
      : 'Added as a plan. With no tracking number this is not a crate yet, and the board will say so as its deadline gets close.',
  };
}

export async function updateShipment(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await editShipment(actor, str(form, 'shipmentId'), draftFrom(form));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return {
    ok: 'Updated. Changing the tracking number clears the timeline and the carrier’s original promise — the old label’s scans describe freight that is not this freight.',
  };
}

export async function removeShipment(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await deleteShipment(actor, str(form, 'shipmentId'), optional(form, 'acknowledged') === 'yes');
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Deleted here — the freight is still with the carrier.' };
}

/**
 * The one control on this page a Member can use, and the one that means the crate
 * is actually at the booth rather than on a dock somewhere.
 */
export async function confirmArrival(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await confirmReceipt(actor, str(form, 'shipmentId'));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Confirmed. This is the only thing on the page that means the crate is here.' };
}

export async function withdrawArrival(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await undoReceipt(actor, str(form, 'shipmentId'));
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Withdrawn.' };
}

/** For the carriers no tracker covers — freight forwarders are a phone call. */
export async function addTimelineEntry(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const on = optional(form, 'occurredOn');
  const at = optional(form, 'occurredAt') ?? '12:00';
  if (!on) return { error: 'A timeline entry needs a date.' };
  try {
    await recordScan(actor, str(form, 'shipmentId'), {
      occurredAt: new Date(`${on}T${at}:00Z`),
      status: str(form, 'status'),
      message: str(form, 'message'),
      location: optional(form, 'location'),
    });
  } catch (err) {
    return asFormError(err);
  }
  refresh(showId);
  return { ok: 'Recorded, and marked as entered by hand rather than reported by a carrier.' };
}
