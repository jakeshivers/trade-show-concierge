'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { MoneyParseError } from '@/lib/money/decimal';
import { ExpenseError } from '@/lib/cost/edit';
import { addExpense, deleteExpense } from '@/lib/cost/store';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';

const asFormError = formErrorFrom([ExpenseError, MoneyParseError, ForbiddenError, NotFoundError]);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/cost`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath(`/shows/${showId}/roi`);
  // The portfolio and the ROI board both re-rank on this number.
  revalidatePath('/cost');
  revalidatePath('/roi');
}

export async function fileExpense(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addExpense(actor, showId, {
      category: str(form, 'category'),
      description: str(form, 'description'),
      amount: str(form, 'amount'),
      costCenterId: optional(form, 'costCenterId'),
      paid: form.get('paid') === 'on',
      incurredOn: optional(form, 'incurredOn'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Filed. The line above has moved, and so has this show on /cost.' };
}

export async function removeExpense(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    const showId = await deleteExpense(actor, str(form, 'expenseId'));
    refresh(showId);
  } catch (err) {
    return asFormError(err, form);
  }
  return { ok: 'Removed.' };
}
