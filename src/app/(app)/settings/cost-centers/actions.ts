'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import {
  CostCenterError,
  createCostCenter,
  renameCostCenter,
  setCostCenterActive,
} from '@/lib/costcenters/store';
import { type FormState, formErrorFrom, str } from '../../_components/form';

const asFormError = formErrorFrom([CostCenterError, ForbiddenError, NotFoundError]);

// Every form that files money reads this list, so they all have to redraw.
function refresh() {
  revalidatePath('/settings/cost-centers');
  revalidatePath('/', 'layout');
}

export async function addCostCenter(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await createCostCenter(actor, { code: str(form, 'code'), name: str(form, 'name') });
  } catch (err) {
    return asFormError(err);
  }
  refresh();
  return { ok: 'Added. It can now be picked wherever this app files money.' };
}

export async function rename(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    await renameCostCenter(actor, str(form, 'id'), str(form, 'name'));
  } catch (err) {
    return asFormError(err);
  }
  refresh();
  return { ok: 'Renamed.' };
}

export async function toggle(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const active = form.get('active') === 'true';
  try {
    await setCostCenterActive(actor, str(form, 'id'), active);
  } catch (err) {
    return asFormError(err);
  }
  refresh();
  return {
    ok: active
      ? 'Switched on.'
      : 'Switched off. Rows already filed against it keep it — nothing was reassigned.',
  };
}
