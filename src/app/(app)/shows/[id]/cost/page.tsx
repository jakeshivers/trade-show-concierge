import { getActor } from '@/lib/auth/actor';
import { canSeeCost } from '@/lib/cost/access';
import { getShowCost } from '@/lib/cost/store';
import { Card, Empty, money } from '../../../_components/ui';
import { CostHeadline, CostLines, CostMemos } from '../../../cost/_present';

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

  const cost = await getShowCost(actor, id);

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
        title="Beside the total, not in it"
        subtitle="Real figures that would each make the total wrong if they were added to it."
      >
        <CostMemos cost={cost} />
      </Card>
    </div>
  );
}
