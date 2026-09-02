import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { canSeeRoi } from '@/lib/roi/access';
import { getRoiPortfolio, listSyncRuns } from '@/lib/roi/store';
import { figureLabel } from '@/lib/roi/rollup';
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
import { MATURITY_LABEL, MATURITY_TONE, ReplayBanner } from './_present';

/**
 * "Was it worth it?" — §8, the third north-star job, across the calendar.
 *
 * This is the page the whole product has been building toward, and the
 * interesting thing about it is how much of it is refusals. Both inputs already
 * decline to lie: `/cost` says "at least" when a figure is a floor, `/leads`
 * says "at least" when a count is one. Dividing one by the other is the first
 * arithmetic here where two honest numbers make a dishonest one, so the
 * dashboard's job is to obey those refusals rather than route around them — and
 * the ranking is by **cost**, not by multiple, because ranking by multiple puts
 * every recent show at the bottom for §8e's reason and somebody cancels one.
 */

export const metadata = { title: 'ROI' };
export const dynamic = 'force-dynamic';

export default async function RoiPortfolioPage() {
  const actor = await getActor();
  if (!canSeeRoi(actor)) {
    return (
      <div className="space-y-6">
        <PageHeader title="ROI" />
        <Empty>
          An ROI figure has a show’s cost inside it, and that is every colleague’s fare in one
          number — so only a Travel Manager or an Admin can see this. The lead count behind it is
          not restricted: it is on every show’s Leads tab, where the people who can improve it
          will see it.
        </Empty>
      </div>
    );
  }

  const [portfolio, runs] = await Promise.all([getRoiPortfolio(actor), listSyncRuns(actor, 5)]);
  const lastRun = runs[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="ROI"
        blurb={
          <>
            What each show cost, against the pipeline it produced, most recently closed first.
            The cost side is recorded here already; the pipeline side comes from a connected CRM.
            Where a figure would be misleading it says why instead of appearing anyway.{' '}
            <span className="text-text-muted">{figureLabel(portfolio.settings)}.</span>
          </>
        }
      />

      {portfolio.replayed && <ReplayBanner />}

      {!lastRun && (
        <Empty>
          No CRM sync has ever run here, so no lead has been offered to a CRM and every pipeline
          figure below is empty because <strong>nobody has looked</strong> — not because these
          shows produced nothing. Connect a CRM under{' '}
          <Link href="/settings/crm" className="underline">Settings → CRM</Link>.
        </Empty>
      )}

      <Card title="Across the calendar">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Recorded cost" value={money(portfolio.totalCostCents)} />
          <Stat
            label="Sourced pipeline"
            value={money(portfolio.sourcedPipelineCents)}
            note="Each deal is credited to one show only, so these add up to a real total."
          />
          <Stat
            label="Influenced (distinct)"
            value={money(portfolio.distinctInfluencedCents)}
            note="The per-show figures will not add up to this, because one deal can be influenced by several shows. This counts each deal once."
          />
          <Stat
            label="Too recent to score"
            value={`${portfolio.immature} of ${portfolio.shows.length}`}
            tone={portfolio.immature > 0 ? 'info' : 'neutral'}
            note="Their figures are shown; their verdicts are not. A show judged the week it ends always looks like a loss."
          />
          <Stat
            label="Portfolio multiple"
            value={
              portfolio.portfolioMultiple.ok
                ? `${portfolio.portfolioMultiple.multiple.toFixed(1)}×`
                : 'Not shown'
            }
            tone={portfolio.portfolioMultiple.ok ? 'good' : 'warn'}
            note={
              portfolio.portfolioMultiple.ok
                ? 'Across the shows old enough to score, and only those.'
                : portfolio.portfolioMultiple.reason
            }
          />
        </div>
      </Card>

      {portfolio.shows.length === 0 ? (
        <Empty>
          No committed shows yet. Shows still being considered are left out rather than listed
          at zero, because a zero would read as a result rather than as an absence.
        </Empty>
      ) : (
        <Card
          title="By show"
          subtitle="Biggest cost first. Sorting by multiple would put the most recent shows at the bottom every time, purely because their pipeline has not appeared yet."
        >
          <Table>
            <thead>
              <tr>
                <Th>Show</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Leads</Th>
                <Th numeric>Sourced</Th>
                <Th numeric>Multiple</Th>
                <Th>Standing</Th>
              </tr>
            </thead>
            <tbody>
              {portfolio.shows.map((roi) => (
                <tr key={roi.showId}>
                  <Td>
                    <Link href={`/shows/${roi.showId}/roi`} className="font-medium hover:underline">
                      {roi.showName}
                    </Link>
                    {roi.gaps.length > 0 && (
                      <span className="block text-xs text-text-muted">
                        {plural(roi.gaps.length, 'thing', 'things')} the figures are missing
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {roi.cost.isFloor && <span className="text-text-muted">≥ </span>}
                    {money(roi.cost.totalCents)}
                  </Td>
                  <Td numeric>
                    {roi.leads.isFloor && <span className="text-text-muted">≥ </span>}
                    {roi.leads.leadCount}
                  </Td>
                  <Td numeric>{money(roi.attribution.sourcedCents)}</Td>
                  <Td numeric>
                    {roi.pipelineMultiple.ok ? (
                      `${roi.pipelineMultiple.multiple.toFixed(1)}×`
                    ) : (
                      <span className="text-text-muted" title={roi.pipelineMultiple.reason}>
                        not shown
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={MATURITY_TONE[roi.maturity]}>{MATURITY_LABEL[roi.maturity]}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-text-muted">
            “Not shown” is a decision, not a missing feature — open the show and it says which
            one: an incomplete cost, an incomplete lead count, a pipeline that was replayed rather
            than read from a CRM, or a show too recent to judge. A show’s real return takes six to
            twelve months to arrive, so one scored the week it ends always looks like a loss.
          </p>
        </Card>
      )}

      {lastRun && (
        <Card title="Last CRM sync">
          <p className="text-sm">
            {lastRun.provider}
            {lastRun.replayed && ' (replayed)'} · {lastRun.matched} matched, {lastRun.unmatched}{' '}
            not found, {lastRun.withheld} not sent · {lastRun.opportunitiesRead} opportunities
            read · {lastRun.attributionsWritten} attributions written back
          </p>
          {lastRun.failedReason && (
            <p className="mt-1 text-sm text-bad">The run failed: {lastRun.failedReason}</p>
          )}
          <p className="mt-2 text-xs text-text-muted">
            Matched, not found and not sent always add up to the leads considered. “Not sent” is
            this app holding a lead back because nobody recorded what the person was told at the
            booth; “not found” is the CRM answering that it does not know them. They are counted
            separately because only one of them is fixable here.{' '}
            <Link href="/settings/crm" className="underline">
              Settings → CRM
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
