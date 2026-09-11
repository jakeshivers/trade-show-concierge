'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { MoneyParseError } from '@/lib/money/decimal';
import { RateCardError } from '@/lib/drayage/edit';
import type { HandlingKind } from '@/lib/drayage/estimate';
import {
  deleteRateCard,
  saveRateCard,
  setRateCardConfirmed,
  setShipmentHandling,
} from '@/lib/drayage/store';
import { NotFoundError } from '@/lib/shows/store';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

/**
 * The rate card's writes, and the one on a crate.
 *
 * They are in the same file and on opposite sides of the permission line, which
 * is the thing worth noticing: setting the rates is money and belongs to whoever
 * runs the show, while saying how a crate is packed is a fact only the person who
 * packed it holds. `lib/drayage/access.ts` is the control; the buttons are a
 * courtesy.
 *
 * The revalidation set is wider than this screen's, deliberately. A rate card
 * moves the largest line in the show's cost figure and the portfolio's, and a
 * stale `/cost` that disagrees with the tab somebody just edited is exactly the
 * two-screens-one-number failure `cost/store.ts` is written to avoid.
 */

const asFormError = formErrorFrom([
  RateCardError,
  MoneyParseError,
  ForbiddenError,
  NotFoundError,
]);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/logistics`);
  revalidatePath(`/shows/${showId}/cost`);
  revalidatePath('/cost');
}

export async function saveDrayageRateCard(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await saveRateCard(actor, showId, {
      contractor: optional(form, 'contractor'),
      advanceCwt: optional(form, 'advanceCwt'),
      showSiteCwt: optional(form, 'showSiteCwt'),
      minimumLb: str(form, 'minimumLb'),
      basis: str(form, 'basis'),
      specialHandlingPct: optional(form, 'specialHandlingPct'),
      overtimePct: optional(form, 'overtimePct'),
      sourceNote: optional(form, 'sourceNote'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Rate card saved, unconfirmed. Check it against this year’s manual before the estimate is quoted as a figure.',
  };
}

export async function confirmDrayageRateCard(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const confirmed = form.get('confirmed') === 'true';
  try {
    await setRateCardConfirmed(actor, showId, confirmed);
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: confirmed
      ? 'Confirmed against this year’s manual.'
      : 'Confirmation withdrawn. The estimate will say it came from an unchecked card.',
  };
}

export async function removeDrayageRateCard(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await deleteRateCard(actor, showId);
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Rate card removed. The drayage estimate is withheld rather than zero.' };
}

export async function recordCrateHandling(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await setShipmentHandling(actor, str(form, 'shipmentId'), str(form, 'handling') as HandlingKind);
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {};
}
