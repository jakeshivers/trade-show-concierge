'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { ZonedTimeError } from '@/lib/datetime/zoned';
import { MoneyParseError } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import { addShipment, confirmReceipt, undoReceipt } from '@/lib/shipping/store';
import type { Consignment } from '@/lib/shipping/status';
import { type FormState, formErrorFrom, optional, str } from '../_components/form';

/**
 * The board's writes.
 *
 * It exists because of a question this product could not answer on its own
 * screen: *how do I add a UPS tracking number?* Every write in shipping lived on
 * a show's Logistics tab behind a full freight form — carrier, consignment, the
 * two edges of a receiving window, pieces, weight, declared value, freight cost
 * — which is the right form for a pallet and absurd for the two boxes of
 * datasheets somebody overnighted to their hotel. Most of the tracking numbers a
 * show generates are the second kind.
 *
 * So this is deliberately the *same* store call with a smaller form in front of
 * it. It is not a leaner insert: `addShipment` is what checks the permission,
 * validates through `edit.ts`, resolves the dates against the show's own zone
 * and decides that a row with a number is `label_created` rather than
 * `in_transit`. A second write path here would be the offline queue's rule
 * broken — an easier road to the same table, with the rules left off it.
 */

const EXPECTED = [TeamError, ForbiddenError, NotFoundError, ZonedTimeError, MoneyParseError];
const asFormError = formErrorFrom(EXPECTED);

export async function trackPackage(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const consignment = str(form, 'consignment') as Consignment;
  const trackingNumber = optional(form, 'trackingNumber');

  try {
    await addShipment(actor, showId, {
      description: str(form, 'description'),
      // Derived rather than asked. The consignment already decides it for three
      // of the four values, and a Direction control that is wrong in three cases
      // out of four is a field whose only job is to be corrected by an error
      // message. A box mailed home from the booth is a `direct` return and is
      // rare enough to belong on the full form, where both are visible together.
      direction: consignment === 'office' ? 'return' : 'outbound',
      consignment,
      carrier: str(form, 'carrier'),
      trackingNumber,
      mustArriveOn: optional(form, 'mustArriveOn'),
      mustArriveAt: optional(form, 'mustArriveAt'),
      receivingOpensOn: optional(form, 'receivingOpensOn'),
      receivingOpensAt: optional(form, 'receivingOpensAt'),
      costCenterId: str(form, 'costCenterId'),
    });
  } catch (err) {
    return asFormError(err);
  }

  revalidatePath('/shipping');
  revalidatePath(`/shows/${showId}/logistics`);
  revalidatePath(`/shows/${showId}`);

  return {
    ok: trackingNumber
      ? 'Tracking. Nothing has moved until a carrier scans it — the row reads label created, ' +
        'not in transit, and the sweep is what changes that. Weight, pieces and freight cost ' +
        'are on the show’s Logistics tab if this one needs them.'
      : 'Added as a plan. With no tracking number this is not a package yet, and the board will ' +
        'say so as its date gets close.',
  };
}

/**
 * Confirming a crate reached the booth, from the board that says it has not.
 *
 * This control already existed on the show's Logistics tab and the board only
 * *reported* its absence — a row reading `delivered / not confirmed at the booth`
 * with nothing on it to press, which is the one sentence on this screen that
 * means somebody has to go and look at a booth. Acting on it meant navigating to
 * the show, then Logistics, then finding the crate again.
 *
 * That is §12's finding with its cause removed rather than repeated. The chooser
 * (`go-to-show.tsx`) exists because a board write like *add freight* has no
 * single target and must refuse to guess the show. This one has no such
 * ambiguity: the row **is** the target, it carries the shipment id, and a button
 * on it can only mean that crate. Where the target is unambiguous, sending
 * somebody through a chooser is not caution, it is three clicks.
 *
 * It is deliberately the same `confirmReceipt` call the tab makes — the gate
 * (`canConfirmReceipt`, which is anybody, for the reason `access.ts` argues at
 * length), the `received_by_id` stamp and the timeline entry all come from the
 * store rather than from whichever screen was in front of the person. What
 * differs is only which paths are revalidated, because the board has to redraw
 * itself and the tab does not know it exists.
 */
export async function confirmArrival(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await confirmReceipt(actor, str(form, 'shipmentId'));
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/shipping');
  revalidatePath(`/shows/${showId}/logistics`);
  revalidatePath(`/shows/${showId}`);
  return { ok: 'Confirmed at the booth.' };
}

/** The undo, because a row confirmed by mistake is otherwise permanent. */
export async function withdrawArrival(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await undoReceipt(actor, str(form, 'shipmentId'));
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/shipping');
  revalidatePath(`/shows/${showId}/logistics`);
  revalidatePath(`/shows/${showId}`);
  return { ok: 'Withdrawn. The carrier still says it was delivered.' };
}
