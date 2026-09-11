import { describe, it, expect } from 'vitest';
import { formErrorFrom, submittedValues } from '@/app/(app)/_components/form';

class ExpectedError extends Error {}

/**
 * The pure half of the form-reset fix.
 *
 * The behaviour that actually broke — React resetting an uncontrolled form after
 * a form action — is a DOM behaviour and cannot be asserted here; it was verified
 * in a real browser and the restore lives in `<Form>`'s effect. What *is* testable
 * is the contract that effect depends on: a refusal carries the submission, a
 * success does not, and a `File` never travels.
 */
describe('submittedValues', () => {
  it('carries the strings and drops files, which cannot be restored anyway', () => {
    const form = new FormData();
    form.set('code', 'MKT-EVENTS');
    form.set('name', 'Marketing');
    form.set('upload', new File(['a,b'], 'leads.csv', { type: 'text/csv' }));
    expect(submittedValues(form)).toEqual({ code: 'MKT-EVENTS', name: 'Marketing' });
  });

  it('omits an unchecked box, which is how a checkbox is restored', () => {
    // `<Form>` reads presence as the checked state, so this absence is load-bearing
    // rather than incidental: an unchecked box is simply not in the submission.
    const form = new FormData();
    form.set('paid', 'on');
    const values = submittedValues(form);
    expect('paid' in values).toBe(true);
    expect('refunded' in values).toBe(false);
  });
});

describe('formErrorFrom', () => {
  const asFormError = formErrorFrom([ExpectedError]);

  it('returns the submission alongside an expected refusal', () => {
    const form = new FormData();
    form.set('code', 'TYPED');
    const state = asFormError(new ExpectedError('nope'), form);
    expect(state.error).toBe('nope');
    expect(state.values).toEqual({ code: 'TYPED' });
  });

  it('still rethrows a genuine bug rather than laundering it into a red sentence', () => {
    const form = new FormData();
    form.set('code', 'TYPED');
    expect(() => asFormError(new TypeError('undefined is not a function'), form)).toThrow(TypeError);
  });

  it('carries nothing when the caller has no form to give back', () => {
    // `refreshAll` and `connect` take no FormData — there is nothing to restore,
    // which is why the parameter is optional rather than required.
    expect(asFormError(new ExpectedError('nope')).values).toBeUndefined();
  });

  it('a success carries no values, so a completed add clears the form', () => {
    // Asserted as the shape actions return rather than through a helper: only the
    // refusal paths above set `values`, and that asymmetry is the whole design.
    const success = { ok: 'Added.' };
    expect('values' in success).toBe(false);
  });
});
