import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { canSeeCost } from '@/lib/cost/access';
import { getCostPortfolio } from '@/lib/cost/store';
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
  money,
} from '../_components/ui';
import { plural } from '../_components/text';
import { COVERAGE_LABEL, COVERAGE_TONE } from './_present';

/**
 * True cost, across the calendar. SCOPE §8a, and the third north-star job.
 *
 * The claim this page makes good on is that a show's cost is a query rather than
 * a week of spreadsheet archaeology — because this app booked the flights, holds
 * the hotel rows and tracked the crates. That part is genuinely nearly free, and
 * it is not the interesting half.
 *
 * The interesting half is the coverage column. Most companies produce this
 * number and it is wrong — it misses shipping entirely and undercounts travel —
 * and a product that produced a *confidently* wrong one would be worse than the
 * spreadsheet, because a computed figure carries authority the spreadsheet never
 * had. So no total on this page is presented as a total unless everything that
 * exists carries a figure and nothing structural is absent. Everywhere else the
 * word is "at least", and the reason is on the row.
 */

export const metadata = { title: 'True cost' };
export const dynamic = 'force-dynamic';

export default async function CostPortfolioPage() {
  const actor = await getActor();
  if (!canSeeCost(actor)) {
    return (
      <div className="space-y-6">
        <PageHeader title="True cost" />
        <Empty>
          A show’s cost is every colleague’s fare, room and freight bill in one figure, so only
          a Travel Manager or an Admin can see it. Your own spend is on your itinerary and your
          own travel requests.
        </Empty>
      </div>
    );
  }

  const portfolio = await getCostPortfolio(actor);

  return (
    <div className="space-y-6">
      <PageHeader
        title="True cost"
        blurb={
          <>
            Every committed show, nearest first. Most of a show’s spend is committed before it
            opens and its invoices land after it closes, so the show you are spending on now is
            the one nearest today, either side. Nobody assembles these figures — the flights,
            hotels and crates were all recorded here. The last two columns say what each total
            is still missing.
          </>
        }
      />

      {portfolio.shows.length === 0 ? (
        <Empty>
          No committed shows yet. Shows still being considered are left out rather than listed
          at $0, because a zero here would read as a cheap show rather than as one nobody has
          committed to.
        </Empty>
      ) : (
        <>
          <Card title="Across the calendar">
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
              <Stat
                label="Recorded"
                value={money(portfolio.totalCents)}
                note={`${money(portfolio.paidCents)} of it actually paid.`}
              />
              <Stat
                label="Totals with something missing"
                value={`${portfolio.incomplete} of ${portfolio.shows.length}`}
                tone={portfolio.incomplete > 0 ? 'warn' : 'good'}
                note="Something is missing from these, and the row says what."
              />
              <Stat
                label="Nothing recorded"
                value={portfolio.unrecorded}
                tone={portfolio.unrecorded > 0 ? 'bad' : 'neutral'}
                note="Not cheap shows. Shows nobody has entered an invoice for."
              />
              <Stat
                label="Funded by credits"
                value={money(portfolio.creditFundedCents)}
                note="Charged to no show here — the money was spent on an earlier ticket."
              />
            </div>
          </Card>

          <Card title="By show">
            <Table>
              <thead>
                <tr>
                  <Th>Show</Th>
                  <Th numeric>Recorded</Th>
                  <Th numeric>Paid</Th>
                  <Th numeric>Committed</Th>
                  <Th>Coverage</Th>
                  <Th>Nothing recorded for</Th>
                </tr>
              </thead>
              <tbody>
                {portfolio.shows.map((cost) => (
                  <tr key={cost.showId}>
                    <Td>
                      <Link
                        href={`/shows/${cost.showId}/cost`}
                        className="font-medium hover:underline"
                      >
                        {cost.showName}
                      </Link>
                      <span className="block text-xs text-text-muted">
                        {portfolio.statuses.get(cost.showId)}
                      </span>
                    </Td>
                    <Td numeric>
                      {cost.isFloor && <span className="text-text-muted">≥ </span>}
                      {money(cost.totalCents)}
                    </Td>
                    <Td numeric>{money(cost.paidCents)}</Td>
                    <Td numeric>{money(cost.committedCents)}</Td>
                    <Td>
                      <Badge tone={COVERAGE_TONE[cost.coverage.verdict]}>
                        {COVERAGE_LABEL[cost.coverage.verdict]}
                      </Badge>
                      {cost.coverage.gaps.length > 0 && (
                        <span className="block text-xs text-text-muted">
                          {plural(cost.coverage.gaps.length, 'named gap', 'named gaps')}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-xs text-text-muted">
                        {cost.coverage.silent.length === 0
                          ? '—'
                          : cost.coverage.silent.join(', ')}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-3 text-xs text-text-muted">
              “Committed” is money recorded and not yet paid, which before a show is most of it.
              Staff time is counted in days on each show’s own tab and never given a dollar
              value, because no hourly cost for anybody is recorded in this workspace.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
