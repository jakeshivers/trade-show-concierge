'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { LeadError } from '@/lib/leads/edit';
import { CsvError, type ColumnMapping, type LeadField } from '@/lib/leads/parse';
import {
  captureLead,
  commitImport,
  previewImport,
  markDuplicate,
  recordMeeting,
  redactLead,
  updateLead,
  sweepLeadRetention,
  unmarkDuplicate,
} from '@/lib/leads/store';
import { addTarget, removeTarget, TargetError } from '@/lib/dayof/store';
import { type FormState, formErrorFrom, optional, str } from '../../../_components/form';
import { plural } from '../../../_components/text';

/**
 * The Leads tab's writes.
 *
 * Two of these say something a form action usually does not, and both are
 * deliberate.
 *
 * `capture` returns the *duplicate* as a success-shaped message rather than an
 * error. "Already captured — Priya got it an hour ago" is the answer somebody
 * needs; a red box saying "conflict" reads as the app losing their work, and the
 * next thing they do is type it again with a different spelling.
 *
 * `erase` is the only irreversible write on any tab in this product, so its
 * confirmation sentence says what survives: the person is gone and the lead
 * count does not move. A control that implied the row vanished would leave
 * somebody wondering why last year's total is unchanged, and eventually
 * "fixing" it.
 */

const EXPECTED = [LeadError, CsvError, TargetError, ForbiddenError, NotFoundError];
const asFormError = formErrorFrom(EXPECTED);

function refresh(showId: string) {
  revalidatePath(`/shows/${showId}/leads`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/leads');
  revalidatePath('/alerts');
  revalidatePath(`/day-of/${showId}`);
}

export async function capture(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    const result = await captureLead(actor, showId, {
      fullName: str(form, 'fullName'),
      email: optional(form, 'email'),
      phone: optional(form, 'phone'),
      company: optional(form, 'company'),
      title: optional(form, 'title'),
      notes: optional(form, 'notes'),
      interests: optional(form, 'interests')?.split(',') ?? null,
      externalRef: optional(form, 'externalRef'),
      basis: optional(form, 'basis'),
      consentNotice: optional(form, 'consentNotice'),
    });
    refresh(showId);
    if (!result.lead && result.match) {
      return { ok: `Not added — ${result.match.reason}` };
    }
    if (result.match?.kind === 'possible') {
      return { ok: `Added. Note: ${result.match.reason}` };
    }
    return { ok: 'Captured.' };
  } catch (err) {
    return asFormError(err, form);
  }
}

export async function addMeeting(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const when = optional(form, 'when');
  const outcome = str(form, 'outcome');
  const instant = when ? new Date(when) : null;
  try {
    await recordMeeting(actor, showId, {
      subject: str(form, 'subject'),
      company: optional(form, 'company'),
      isExistingCustomer: form.get('isExistingCustomer') === 'on',
      scheduledAt: instant,
      occurredAt: outcome === 'held' ? instant : null,
      noShowAt: outcome === 'no_show' ? instant : null,
      leadId: optional(form, 'leadId'),
      ownerId: optional(form, 'ownerId'),
      notes: optional(form, 'notes'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Recorded.' };
}

export async function erase(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await redactLead(actor, str(form, 'leadId'), str(form, 'reason'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Erased. The name, email, phone and notes are gone; the show still counts the lead, so no ROI figure moved.',
  };
}

export async function runRetention(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const result = await sweepLeadRetention(actor.orgId, new Date());
  refresh(showId);
  return {
    ok:
      result.erased === 0
        ? 'Nothing was past its date. Nothing was erased.'
        : `${plural(result.erased, 'lead', 'leads')} erased across the workspace. Every lead ` +
          'count is unchanged.',
  };
}

/**
 * Correcting one already captured.
 *
 * `externalRef` is deliberately absent: it is the rail a scanner retries
 * against, so the store carries the stored one through rather than reading a
 * field this form does not have.
 */
export async function editLead(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    const result = await updateLead(actor, str(form, 'leadId'), {
      fullName: str(form, 'fullName'),
      email: optional(form, 'email'),
      phone: optional(form, 'phone'),
      company: optional(form, 'company'),
      title: optional(form, 'title'),
      notes: optional(form, 'notes'),
      interests: optional(form, 'interests')?.split(',') ?? null,
      externalRef: null,
      basis: optional(form, 'basis'),
      consentNotice: optional(form, 'consentNotice'),
    });
    refresh(showId);
    if (!result.lead && result.match) {
      return { ok: `Not saved — ${result.match.reason}` };
    }
    return { ok: 'Saved.' };
  } catch (err) {
    return asFormError(err, form);
  }
}

/**
 * Settling a possible duplicate.
 *
 * Both directions exist because this is a judgement about two strangers who
 * share a name, and the person who made it may have been wrong. Nothing is
 * merged or deleted either way — the row keeps its own consent record and its
 * own retention clock and simply stops being counted twice.
 */
export async function markAsDuplicate(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await markDuplicate(actor, str(form, 'leadId'), str(form, 'ofLeadId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return {
    ok: 'Counted once. Neither row was deleted — the later one keeps its own consent record and retention date, and simply stops being counted.',
  };
}

export async function unmarkAsDuplicate(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await unmarkDuplicate(actor, str(form, 'leadId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Counted again — two people after all.' };
}

/* --------------------------------- importing ------------------------------- */

/**
 * The import is two actions because the mapping is confirmed by a person.
 *
 * The file's text is carried back to the browser in a hidden field between the
 * two steps rather than parked in a server session. That keeps the whole
 * exchange stateless, which matters more here than it looks: a half-finished
 * import sitting in server memory is personal data with no retention date on it,
 * which is precisely the thing this feature exists to not do.
 */

export type ImportPreviewState = FormState & {
  text?: string;
  filename?: string;
  headers?: string[];
  mapping?: ColumnMapping;
  counts?: { rowsRead: number; accepted: number; rejected: number; duplicates: number };
  problems?: { row: number; reason: string }[];
  basisUnmapped?: boolean;
};

/** Bigger than any real badge export, small enough to round-trip through a form. */
const MAX_CSV_BYTES = 2_000_000;

export async function preview(
  _prev: ImportPreviewState,
  form: FormData,
): Promise<ImportPreviewState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const carried = optional(form, 'text');
  const file = form.get('file');

  let text: string;
  let filename: string | null = optional(form, 'filename');
  if (carried) {
    text = carried;
  } else if (file instanceof File && file.size > 0) {
    if (file.size > MAX_CSV_BYTES) {
      return { error: 'That file is larger than 2 MB. Split it, or import it in batches.' };
    }
    text = await file.text();
    filename = file.name;
  } else {
    return { error: 'Choose a CSV file.' };
  }

  // A re-preview carries the mapping the person edited; the first pass has none
  // and `previewImport` infers one.
  const edited: ColumnMapping = {};
  let hasEdits = false;
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('map:')) continue;
    hasEdits = true;
    edited[key.slice(4)] = (value as string) ? ((value as string) as LeadField) : null;
  }

  try {
    const result = await previewImport(actor, {
      showId,
      text,
      mapping: hasEdits ? edited : undefined,
    });
    return {
      text,
      filename: filename ?? undefined,
      headers: result.headers,
      mapping: result.mapping,
      counts: {
        rowsRead: result.plan.rowsRead,
        accepted: result.plan.accepted.length,
        rejected: result.plan.rejected.length,
        duplicates: result.plan.duplicates.length,
      },
      problems: [...result.plan.rejected, ...result.plan.duplicates],
      basisUnmapped: result.plan.basisUnmapped,
    };
  } catch (err) {
    return asFormError(err, form);
  }
}

export async function commit(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  const text = str(form, 'text');
  const mapping: ColumnMapping = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('map:')) continue;
    mapping[key.slice(4)] = (value as string) ? ((value as string) as LeadField) : null;
  }
  try {
    const planned = await previewImport(actor, { showId, text, mapping });
    const result = await commitImport(actor, {
      showId,
      plan: planned.plan,
      mapping,
      filename: optional(form, 'filename'),
    });
    refresh(showId);
    return {
      ok:
        `${plural(result.written, 'lead', 'leads')} imported. ${planned.plan.rejected.length} ` +
        `rejected, ${planned.plan.duplicates.length} already here — all of them listed on the ` +
        'import record below.' +
        (planned.plan.basisUnmapped
          ? ' No column said why we may follow up, so these are recorded without that.'
          : ''),
    };
  } catch (err) {
    return asFormError(err, form);
  }
}

/* ------------------------------ target accounts ----------------------------- */

/**
 * Who we came to this show to meet.
 *
 * Editing this list is `canManageTargets` — an approver — for the reason every
 * other list that moves a denominator is: adding a must-meet account at hour six
 * of day two changes every "targets met" figure the show will ever report.
 * Reading it is everybody's, and has to be, because the whole feature is a
 * sentence a booth staffer reads while a stranger is standing in front of them.
 *
 * The list is edited here, on the show's Leads tab, rather than on the day-of
 * screen — that screen is for people who are standing up, and the decision about
 * which accounts justify a booth was made months earlier by somebody sitting
 * down.
 */
export async function addTargetAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await addTarget(actor, showId, {
      companyName: str(form, 'companyName'),
      aliases: (optional(form, 'aliases') ?? '').split(',').map((a) => a.trim()).filter(Boolean),
      priority: (optional(form, 'priority') ?? 'target') as 'must_meet' | 'target' | 'watch',
      reason: optional(form, 'reason'),
      ownerId: optional(form, 'ownerId'),
    });
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Target account added.' };
}

export async function removeTargetAccount(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const showId = str(form, 'showId');
  try {
    await removeTarget(actor, str(form, 'targetId'));
  } catch (err) {
    return asFormError(err, form);
  }
  refresh(showId);
  return { ok: 'Removed.' };
}
