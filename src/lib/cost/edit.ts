import { decimalStringToCents } from '@/lib/money/decimal';
import { CATEGORY_LABEL, CATEGORY_ORDER, type CostCategory } from './rollup';

/**
 * Filing what a show actually cost.
 *
 * ## Why this did not exist until now
 *
 * `/cost` and the show's Cost tab have read the `expenses` table since step 17
 * and **nothing has ever written it** — the only inserts are in `scripts/seed.ts`.
 * So the rollup's headline was structurally permanent: every real workspace read
 * *"At least $X — most costs missing"*, the page correctly explained that a blank
 * line is not a zero and that booth space is the one to check first, and there
 * was no way to check it. §5j's argument that a cost figure must say what it is
 * missing was working exactly as designed on top of a gap nobody could close.
 *
 * ## What is validated
 *
 * **The amount goes through `money/decimal.ts`**, never `parseFloat` — the money
 * ground rule, and the reason it exists is on this screen: a booth space invoice
 * is usually the largest number in the workspace.
 *
 * **A cost center is required at creation and is never backfilled.** That is §4
 * verbatim, and expenses are where it bites hardest: a dimension added later
 * permanently orphans everything filed before it, so a row that cannot say which
 * budget it lands in is refused rather than saved and chased.
 *
 * **The category is free text, offered as a list.** `bucketExpense` maps text to
 * a line and drops nothing — anything unrecognised lands in `other` rather than
 * disappearing — so the select is a convenience rather than a constraint, and
 * typing "drayage" is meant to work: `isDrayageCategory` is what turns the
 * estimate beside the total into a comparison once the real bill lands, and
 * "estimated $2,400, billed $3,900" is the most useful thing that feature
 * produces.
 *
 * **`paid` is a tense marker and defaults to false**, because `expenses.paid` is
 * the only tense in the money and committed is not paid. Defaulting the other
 * way would report money out of the door that is still owed.
 */

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpenseError';
  }
}

export type ExpenseEdit = {
  category: string;
  description: string;
  amountCents: number;
  costCenterId: string;
  paid: boolean;
  incurredOn: Date | null;
};

/** Offered in the form. Every one of these round-trips through `bucketExpense`. */
export const SUGGESTED_CATEGORIES: { value: string; label: string }[] = [
  ...CATEGORY_ORDER.filter((c) => c !== 'other').map((c: CostCategory) => ({
    value: c,
    label: CATEGORY_LABEL[c],
  })),
  { value: 'drayage', label: 'Drayage / material handling' },
  { value: 'other', label: CATEGORY_LABEL.other },
];

export function validateExpense(input: {
  category: string;
  description: string;
  amount: string;
  costCenterId: string | null;
  paid: boolean;
  incurredOn: string | null;
}): ExpenseEdit {
  const category = input.category.trim();
  if (!category) {
    throw new ExpenseError('Pick what kind of cost this is — it decides which line it lands on.');
  }

  const description = input.description.trim();
  if (description.length < 2) {
    throw new ExpenseError(
      'Say what this is for. A year from now this line is the only record of what the money ' +
        'bought, and "invoice" does not argue for or against doing the show again.',
    );
  }

  // Through the money primitive, never parseFloat. SCOPE.md's ground rule.
  const amountCents = decimalStringToCents(input.amount.trim().replace(/[$,]/g, ''));
  if (amountCents <= 0) {
    throw new ExpenseError(
      'An amount above zero is needed. A zero-dollar line reads as "this was free", which is ' +
        'the one thing a missing invoice must never look like.',
    );
  }

  // §4, and never backfilled.
  if (!input.costCenterId) {
    throw new ExpenseError(
      'Every financial row carries a cost center from the moment it is created. Assigning one ' +
        'later means every row filed before today is permanently unattributable.',
    );
  }

  let incurredOn: Date | null = null;
  if (input.incurredOn?.trim()) {
    const at = new Date(`${input.incurredOn.trim()}T12:00:00Z`);
    if (Number.isNaN(at.getTime())) {
      throw new ExpenseError(`"${input.incurredOn}" is not a date.`);
    }
    // Midday, not midnight: an invoice date is a calendar date, and `new Date()`
    // on a bare one lands at UTC midnight — the previous day in every American
    // zone. Q3's rule from the Salesforce adapter, in the other direction.
    incurredOn = at;
  }

  return {
    category,
    description,
    amountCents,
    costCenterId: input.costCenterId,
    paid: input.paid,
    incurredOn,
  };
}
