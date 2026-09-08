'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { MoneyParseError } from '@/lib/money/decimal';
import { PolicyEditError, toPolicyRow } from '@/lib/travel/policy-edit';
import { saveOrgPolicy } from '@/lib/travel/policy-store';
import { type FormState, formErrorFrom, optional, str } from '../../_components/form';

const asFormError = formErrorFrom([PolicyEditError, MoneyParseError, ForbiddenError]);

export async function savePolicy(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  try {
    const { version, warnings } = await saveOrgPolicy(
      actor,
      toPolicyRow({
        label: optional(form, 'label'),
        maxAirfareDomestic: optional(form, 'maxAirfareDomestic'),
        maxAirfareInternational: optional(form, 'maxAirfareInternational'),
        autoApproveUnder: optional(form, 'autoApproveUnder'),
        denyOver: optional(form, 'denyOver'),
        maxCabinDomestic: optional(form, 'maxCabinDomestic'),
        maxCabinInternational: optional(form, 'maxCabinInternational'),
        premiumCabinAllowedOverHours: optional(form, 'premiumCabinAllowedOverHours'),
        minAdvanceBookingDays: optional(form, 'minAdvanceBookingDays'),
        maxStops: optional(form, 'maxStops'),
        minConnectionMinutes: optional(form, 'minConnectionMinutes'),
        arrivalBufferHoursBeforeMoveIn: optional(form, 'arrivalBufferHoursBeforeMoveIn'),
        nonRefundableAllowedUnder: optional(form, 'nonRefundableAllowedUnder'),
        maxAcceptableRefundPenalty: optional(form, 'maxAcceptableRefundPenalty'),
        preferredAirlines: optional(form, 'preferredAirlines'),
        blockedAirlines: optional(form, 'blockedAirlines'),
        preferredCarrierAllowance: optional(form, 'preferredCarrierAllowance'),
        personalCarrierAllowance: optional(form, 'personalCarrierAllowance'),
        maxHotelNightlyRate: optional(form, 'maxHotelNightlyRate'),
        perShowTravelBudget: optional(form, 'perShowTravelBudget'),
        requireCreditFirst: form.get('requireCreditFirst') === 'on',
      }),
    );
    revalidatePath('/settings/travel-policy');
    return {
      ok:
        `Saved as version ${version}. Earlier versions are kept — every booking already made ` +
        'was judged against the numbers that were live at the time.' +
        (warnings.length
          ? ` Worth a look: ${warnings.map((w) => w.message).join(' ')}`
          : ''),
    };
  } catch (err) {
    return asFormError(err);
  }
}
