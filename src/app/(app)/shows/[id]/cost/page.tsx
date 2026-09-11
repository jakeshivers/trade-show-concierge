import { getActor } from '@/lib/auth/actor';
import { canSeeCost } from '@/lib/cost/access';
import { costCentersForExpense, getShowCost, listShowExpenses } from '@/lib/cost/store';
import { Card, Empty, money } from '../../../_components/ui';
import { CostHeadline, CostLines, CostMemos } from '../../../cost/_present';
import { FileExpenseForm, RemoveExpenseForm } from './forms';

/**
 * One show's true cost. §8a.
 *
 * Everything here comes from rows some other tab already owns — the expense, the
 * booking, the hotel, the crate, the shelf — which is the whole argument: nobody
 * assembles this, and that is only true because jobs 1 and 2 were built first.
 *
 * It renders through `cost/_present.tsx` so this page and the portfolio cannot
 * disagree about the word in front of the number.
 */

export const metadata = { title: 'Cost' };
export const dynamic = 'force-dynamic';

export default async function ShowCostTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();

  if (!canSeeCost(actor)) {
    return (
      <Empty>
        A show’s cost is every colleague’s fare and room rate in one figure, so only a Travel
        Manager or an Admin can see it. Your own fare is on your itinerary.
      </Empty>
    );
  }

  const [cost, expenses, costCenters] = await Promise.all([
    getShowCost(actor, id),
    listShowExpenses(actor, id),
    costCentersForExpense(actor),
  ]);

  return (
    <div className="space-y-6">
      <Card title="What this show has cost so far">
        <CostHeadline cost={cost} />
        <p className="mt-2 text-sm text-text-muted">
          {money(cost.paidCents)} has actually been paid; {money(cost.committedCents)} is
          recorded and still owed.{' '}
          {cost.isFloor
            ? 'The real total is higher than this — the lines below say what is missing.'
            : 'Nothing is missing: every cost this show should have is recorded.'}
        </p>
      </Card>

      <Card
        title="The lines"
        subtitle="Booth and services from expenses; travel from what was actually charged; lodging, freight and print from the rows the other tabs already keep."
      >
        <CostLines lines={cost.lines} />
        {cost.coverage.silent.length > 0 && (
          <p className="mt-3 text-xs text-text-muted">
            Nothing at all is recorded for: {cost.coverage.silent.join(', ')}. A blank line is
            not a zero — it means nobody has entered that invoice yet. Booth space is the one to
            check first: every show has it, it is usually the largest number on this page, and it
            is billed months in advance.
          </p>
        )}
      </Card>

      <Card
        title="Invoices filed against this show"
        subtitle="What somebody typed in, as opposed to what the other tabs already know. Booth space, services and anything else with a bill behind it."
      >
        {expenses.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nothing filed yet. Until something is, the lines above are built only from what the
            travel, lodging, logistics and assets tabs already record — which is why the figure
            says <em>at least</em>.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {expenses.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{money(e.amountCents)}</span>
                <span>{e.description}</span>
                <span className="text-xs text-text-muted">
                  {e.category}
                  {e.costCenterName ? ` · ${e.costCenterName}` : ''}
                  {e.paid ? ' · paid' : ' · owed'}
                </span>
                <span className="ml-auto">
                  <RemoveExpenseForm expenseId={e.id} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-border pt-4">
          <FileExpenseForm showId={id} costCenters={costCenters} />
        </div>
      </Card>

      <Card
        title="Beside the total, not in it"
        subtitle="Real figures that would each make the total wrong if they were added to it."
      >
        <CostMemos cost={cost} />
      </Card>
    </div>
  );
}
