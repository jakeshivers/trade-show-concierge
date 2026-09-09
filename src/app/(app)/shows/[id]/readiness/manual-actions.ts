'use server';

import { revalidatePath } from 'next/cache';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { DeadlineError } from '@/lib/deadlines/edit';
import { ManualReadError } from '@/lib/manual/pdf';
import { extractManual, type ExtractionReport } from '@/lib/manual/store';
import { NotFoundError } from '@/lib/shows/store';
import { formErrorFrom, type FormState } from '../../../_components/form';

/**
 * Reading a manual, as a server action.
 *
 * The report is carried back in the form state rather than written to a screen of
 * its own, and that is deliberate: the coverage list is about *this reading* and
 * stops being true the moment anybody edits the register. A page that could be
 * refreshed into showing yesterday's coverage beside today's rows would be the
 * unchecked-flight failure with a friendlier cause. What persists is the run
 * record — which is on the page, from the database — and the rows themselves.
 */

export type ManualFormState = FormState & { report?: ExtractionReport };

const asFormError = formErrorFrom([
  ManualReadError,
  DeadlineError,
  ForbiddenError,
  NotFoundError,
]);

export async function readManualIntoRegister(
  _prev: ManualFormState,
  form: FormData,
): Promise<ManualFormState> {
  const actor = await getActor();
  const showId = String(form.get('showId') ?? '');
  const file = form.get('manual');

  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a PDF of the exhibitor service manual.' };
  }
  if (file.type && file.type !== 'application/pdf') {
    return {
      error:
        `That is a ${file.type} file. Nothing here reads a Word document or a spreadsheet, ` +
        'and guessing at one would be worse than refusing it.',
    };
  }

  let report: ExtractionReport;
  try {
    report = await extractManual(
      actor,
      showId,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
  } catch (err) {
    // An unconfigured extractor throws a bare Error naming the variable, and that
    // sentence is the useful one — `travel/actions.ts` carries the same extra
    // branch for the same reason.
    return asFormError(err, form);
  }

  revalidatePath(`/shows/${showId}/readiness`);
  revalidatePath(`/shows/${showId}`);
  revalidatePath('/readiness');

  const n = report.createdDeadlineIds.length;
  return {
    ok:
      `Read ${report.pageCount} pages and added ${n} ${n === 1 ? 'deadline' : 'deadlines'}, ` +
      'all unconfirmed. Check each one against the page it came from.',
    report,
  };
}
