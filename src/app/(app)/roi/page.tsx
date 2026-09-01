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
          An ROI figure has a cost figure inside it, and a show’s cost is every colleague’s fare
          in one number — so this is Travel Manager and Admin only, the same audience §3 gives
          “see all users’ travel”. The lead count behind it is not restricted: it is on every
          show’s Leads tab, because a thin count has to be visible to the person who could fix it.
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
            Cost against pipeline, per show. The cost half is ours and needs nobody to assemble
            it; the return half needs a CRM. Every figure carries its attribution window, and a
            figure that cannot honestly be quoted says so instead of appearing anyway.{' '}
            <span className="text-text-muted">{figureLabel(portfolio.settings)}.</span>
          </>
        }
      />

      {portfolio.replayed && <ReplayBanner />}

      {!lastRun && (
        <Empty>
          No CRM sync has ever run in this workspace, so no lead has been offered to a CRM and
          every pipeline figure below is an <strong>absence</strong> rather than a finding. That
          distinction is the point: “this show produced no pipeline” and “nobody has looked” are
          opposite answers, and only one of them is a reason to stop doing a show. Connect a CRM
          under <Link href="/settings/crm" className="underline">Settings → CRM</Link>.
        </Empty>
      )}

      <Card title="Across the calendar">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Recorded cost" value={money(portfolio.totalCostCents)} />
          <Stat
            label="Sourced pipeline"
            value={money(portfolio.sourcedPipelineCents)}
            note="One opportunity, one show. This figure sums honestly."
          />
          <Stat
            label="Influenced (distinct)"
            value={money(portfolio.distinctInfluencedCents)}
            note="The per-show influenced figures deliberately do not add up to this — the same deal is influenced by several shows."
          />
          <Stat
            label="Too recent to score"
            value={`${portfolio.immature} of ${portfolio.shows.length}`}
            tone={portfolio.immature > 0 ? 'info' : 'neutral'}
            note="Figures shown, verdicts withheld. A show scored the week it ends always looks like a loss."
          />
          <Stat
            label="Portfolio multiple"
            value={
              portfolio.portfolioMultiple.ok
                ? `${portfolio.portfolioMultiple.multiple.toFixed(1)}×`
                : 'Withheld'
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
          No committed shows. Prospects are absent rather than shown at zero, for the reason a
          cost table omits them: a zero reads as a result instead of as an absence.
        </Empty>
      ) : (
        <Card
          title="By show"
          subtitle="Biggest cost first. Ranking by multiple would put every recent show last, which is a reporting artifact rather than a finding — and somebody would cancel one over it."
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
                        {roi.gaps.length} thing{roi.gaps.length === 1 ? '' : 's'} the figures are
                        missing
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
                        withheld
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
            A “withheld” multiple is not a missing feature. Every one of them has a reason on the
            show’s own tab — a cost that is a floor, a lead count that is a floor, a pipeline that
            was replayed rather than read, or a show that has not been closed long enough for its
            pipeline to have appeared. §8e: a show’s ROI is not final for six to twelve months.
          </p>
        </Card>
      )}

      {lastRun && (
        <Card title="Last CRM sync">
          <p className="text-sm">
            {lastRun.provider}
            {lastRun.replayed && ' (replayed)'} · {lastRun.matched} matched, {lastRun.unmatched}{' '}
            not found, {lastRun.withheld} withheld · {lastRun.opportunitiesRead} opportunities
            read · {lastRun.attributionsWritten} attributions written back
          </p>
          {lastRun.failedReason && (
            <p className="mt-1 text-sm text-bad">The run failed: {lastRun.failedReason}</p>
          )}
          <p className="mt-2 text-xs text-text-muted">
            Matched + not found + withheld always equals the leads considered. “Withheld” is this
            app refusing — no lawful basis was recorded at the booth, so nothing about that person
            is sent anywhere — and it is kept apart from “not found”, which is the CRM’s answer.
            Collapsing the two would make a deliberate refusal look like a vendor’s data problem.{' '}
            <Link href="/settings/crm" className="underline">
              Settings → CRM
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
