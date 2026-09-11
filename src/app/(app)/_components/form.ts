/**
 * The one shape a server action returns to a form, and the three helpers every
 * `actions.ts` had defined privately.
 *
 * This file exists because the type was re-declared in five places and drifted
 * into three incompatible shapes: `{ error }`, `{ error, ok }`, and
 * `{ error, saved }`. `saved` versus `ok` is a success message that renders on
 * one screen and silently does not on another — a divergence nothing could
 * catch, because each file's form and action agreed with each other. It also
 * forced a bad import: lodging pulled `FormState` from the *team* tab's action
 * module for a type that belongs to neither.
 *
 * Deliberately dependency-free — no `next/cache`, no store imports — because
 * client components import the type, and a `'use server'` module is the wrong
 * place for a shared type to live.
 *
 * `refresh` is *not* here, on purpose. Every tab's revalidation set is different
 * and the differences are load-bearing: lodging revalidates the deadline
 * register because a room block cutoff owns a row in it, and team revalidates
 * lodging because un-staffing somebody moves a room assignment. A shared
 * `refresh` would have to take the paths anyway, which is `revalidatePath`.
 */

export type FormState = {
  error?: string;
  ok?: string;
  /**
   * What the person had typed when the action refused, so the form can put it
   * back.
   *
   * React 19 resets an uncontrolled form once a form action completes, and it
   * does not care whether the action succeeded. Until this field existed, a
   * refusal therefore destroyed the submission: on a form with no
   * `defaultValue` every field blanked, and on one *with* a `defaultValue` —
   * the travel policy editor — each field silently reverted to the **stored**
   * value while the error named a different field. The second is the dangerous
   * one: fix the field the message names, submit again, and you save the old
   * number you thought you had changed, into a versioned policy row.
   *
   * Set only on refusal. A success deliberately leaves it undefined, so adding
   * a cost center still clears the form for the next one.
   *
   * `File` values are dropped — a file input's value cannot be restored by any
   * page, and a `File` has no business in a serialized action result.
   */
  values?: Record<string, string>;
};

/**
 * The submission, as strings, for `FormState.values`.
 *
 * A checkbox that was left unchecked is simply absent from `FormData`, which is
 * what `Form` relies on to restore one: presence of the key *is* the checked
 * state. Repeated names keep the last value, which is right for every form here
 * and would need `getAll` if that ever stops being true.
 */
export function submittedValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
  return out;
}

type ErrorClass = new (...args: never[]) => Error;

/**
 * Turn the errors a store is *expected* to throw into something the form can
 * render, and let everything else crash.
 *
 * The distinction is the point: a `TeamError` is an answer for the person at
 * the keyboard, and a `TypeError` is a bug that must not be laundered into a
 * polite red sentence under an input.
 */
export function formErrorFrom(
  expected: readonly ErrorClass[],
  opts: {
    /**
     * Also render a plain `Error` that carries a message. Only the travel
     * actions want this: the booking agent throws bare `Error`s for a good
     * number of real, explainable conditions — an unconfirmed parse, a traveler
     * with no date of birth, a request that is not awaiting approval — and
     * those are answers for the user. It is opt-in because it also swallows the
     * next genuine bug that happens to have a message.
     */
    messagedErrorsAreAnswers?: boolean;
  } = {},
) {
  /**
   * `form` is optional only so a caller with nothing to give back still
   * compiles; every action in this app passes it, and one that does not is a
   * form that loses its input on a refusal.
   */
  return function asFormError(err: unknown, form?: FormData): FormState {
    const values = form ? submittedValues(form) : undefined;
    if (expected.some((E) => err instanceof E)) {
      return { error: (err as Error).message, values };
    }
    if (opts.messagedErrorsAreAnswers && err instanceof Error && err.message) {
      return { error: err.message, values };
    }
    throw err;
  };
}

/** A trimmed field, or `null` when it was left blank. Never `''`. */
export function optional(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A required field as a string; validation belongs to the store, not here. */
export function str(form: FormData, key: string): string {
  return String(form.get(key) ?? '');
}
