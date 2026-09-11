'use client';

import { useActionState } from 'react';
import { SUGGESTED_CATEGORIES } from '@/lib/cost/edit';
import { Field, Form, Input, Message, QuietSubmit, Select, Submit } from '../../../_components/form-ui';
import { fileExpense, removeExpense } from './actions';

/**
 * Filing what a show actually cost.
 *
 * The Cost tab has explained since step 17 that a blank line is not a zero and
 * that booth space is the one to check first — correctly, and with no way to act
 * on it, because nothing in this product has ever written the `expenses` table.
 *
 * The category is a **list of suggestions over a free-text column**, not an
 * enum. `bucketExpense` maps text onto a line and drops nothing, so the select
 * is a convenience; "drayage" is offered by name because filing the real bill is
 * what turns the estimate sitting beside the total into a comparison, and
 * "estimated $2,400, billed $3,900" is the most useful sentence that feature
 * produces.
 */
export function FileExpenseForm({
  showId,
  costCenters,
}: {
  showId: string;
  costCenters: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(fileExpense, {});
  return (
    <Form action={action} state={state} className="space-y-4">
      <input type="hidden" name="showId" value={showId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What kind of cost" hint="Decides which line it lands on above.">
          <Select name="category" density="comfortable" required>
            {SUGGESTED_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="Amount"
          hint="As invoiced. Parsed as a decimal, never a float."
        >
          <Input name="amount" density="comfortable" placeholder="24500.00" required />
        </Field>
      </div>

      <Field
        label="What it was for"
        hint="A year from now this is the only record of what the money bought."
      >
        <Input
          name="description"
          density="comfortable"
          placeholder="20x20 island space, invoice 4471"
          required
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cost center"
          hint="Required now, never backfilled — a dimension added later orphans everything filed before it."
        >
          <Select name="costCenterId" density="comfortable" required>
            <option value="">Pick one</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Invoice date" hint="Optional.">
          <Input type="date" name="incurredOn" density="comfortable" />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="paid" className="rounded border-border" />
        {/*
          Unchecked by default, because `expenses.paid` is the only tense marker
          in the money and committed is not paid. Defaulting the other way would
          report money out of the door that is still owed.
        */}
        Already paid (leave unticked if it is recorded and still owed)
      </label>

      <Submit pending={pending} busy="Filing…">File this cost</Submit>
      <Message state={state} />
    </Form>
  );
}

/** For the line filed with a slipped decimal point. */
export function RemoveExpenseForm({ expenseId }: { expenseId: string }) {
  const [state, action, pending] = useActionState(removeExpense, {});
  return (
    <Form action={action} state={state} className="inline">
      <input type="hidden" name="expenseId" value={expenseId} />
      <QuietSubmit pending={pending} busy="…">Remove</QuietSubmit>
      <Message state={state} />
    </Form>
  );
}
