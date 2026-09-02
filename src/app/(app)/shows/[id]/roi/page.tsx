import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { canSeeRoi } from '@/lib/roi/access';
import { getShowRoi, listShowOpportunities } from '@/lib/roi/store';
import { figureLabel } from '@/lib/roi/rollup';
import { Badge, Card, Empty, Table, Td, Th, money, showDate } from '../../../_components/ui';
import { plural } from '../../../_components/text';
import { loadShow } from '../detail';
import {
  Figure,
  MATURITY_LABEL,
  MATURITY_TONE,
  MatchTable,
  ReplayBanner,
  RoiGaps,
} from '../../../roi/_present';

/**
 * One show's answer to "was it worth it?". §8.
 *
 * Both halves of the question arrive here already refusing to lie, and this page
 * exists to put them beside each other without letting the division launder
 * either one. The order is deliberate: the figures that *can* be quoted, then
 * the ones that cannot and why, then the opportunities themselves — because the
 * only honest way to publish an attributed pipeline figure is to let somebody
 * open it and disagree with a row.
 */

export const metadata = { title: 'ROI' };
export const dynamic = 'force-dynamic';

export default async function ShowRoiTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();

  if (!canSeeRoi(actor)) {
    return (
      <Empty>
        An ROI figure has a cost figure inside it, so it is Travel Manager and Admin only. The
        lead count behind it is on the Leads tab and is not restricted — a thin count has to be
        visible to the person who could fix it.
      </Empty>
    );
  }

  const [{ detail }, roi, opportunities] = await Promise.all([
    loadShow(id),
    getShowRoi(actor, id),
    listShowOpportunities(actor, id),
  ]);

  return (
    <div className="space-y-6">
      {roi.attribution.replayed && <ReplayBanner />}

      <Card title="Was it worth it?">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="tabular text-3xl font-semibold tracking-tight">
            {roi.cost.isFloor && <span className="text-text-muted">≥ </span>}
            {money(roi.cost.totalCents)}
          </span>
          <span className="text-text-muted">against</span>
          <span className="tabular text-3xl font-semibold tracking-tight">
            {money(roi.pipelineCents)}
          </span>
          <Badge tone={MATURITY_TONE[roi.maturity]}>{MATURITY_LABEL[roi.maturity]}</Badge>
        </div>
        <p className="mt-2 text-sm text-text-muted">
          {roi.leads.headline} {plural(roi.meetingsHeld, 'meeting', 'meetings')} held.{' '}
          {money(roi.otherModelCents)} of pipeline under the{' '}
          {roi.settings.model === 'sourced' ? 'influenced' : 'sourced'} model, shown beside this
          one rather than instead of it — the two ways of crediting a deal to a show give
          different answers, and both are worth seeing.
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {figureLabel(roi.settings)} · as of {showDate(roi.asOf, detail.show.timezone)}
        </p>
      </Card>

      <Card
        title="The figures"
        subtitle="A number, or the reason there is not one — written out rather than left as a dash, because the reason is the part you can do something about."
      >
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Cost per lead" value={roi.costPerLead} />
          <Figure label="Cost per meeting held" value={roi.costPerMeeting} />
          <Figure label="Cost per opportunity" value={roi.costPerOpportunity} />
          <Figure
            label="Pipeline multiple"
            value={roi.pipelineMultiple}
            note="Pipeline ÷ cost. The single number people quote, and the easiest one to flatter."
          />
          <Figure
            label="Closed-won attributed"
            value={roi.closedWon}
            note={`${roi.attribution.wonCount} won, ${roi.attribution.lostCount} lost, ${money(roi.attribution.openCents)} still open.`}
          />
        </div>
      </Card>

      <Card
        title="What the figures above are missing"
        subtitle="Listed rather than quietly averaged out. An incomplete cost pushes these figures down and an incomplete lead count pushes them up, and nobody knows by how much either way."
      >
        <RoiGaps gaps={roi.gaps} />
      </Card>

      <Card
        title="Where the leads went"
        subtitle="What we held back and what the CRM did not recognise, counted separately. There is deliberately no single “match rate” here, because only one of the two is ours to fix."
      >
        <MatchTable roi={roi} />
        <p className="mt-3 text-xs text-text-muted">
          Every lead on this show is on its{' '}
          <Link href={`/shows/${id}/leads`} className="underline">
            Leads tab
          </Link>
          , where any lead we are holding back says what would fix it: recording what the person
          was told at the booth. Whoever had the conversation can answer that in seconds and
          almost nobody can answer it a week later, which is why it is asked on the lead itself.
        </p>
      </Card>

      <Card
        title="Every opportunity behind that figure"
        subtitle="Every deal counted towards the figure above, listed so you can disagree with any one of them."
      >
        {opportunities.length === 0 ? (
          <p className="text-sm text-text-muted">
            No deal is linked to a lead from this show. Check the table above before reading that
            as a result: if no sync has looked yet, this is empty because nobody asked.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Opportunity</Th>
                <Th>Stage</Th>
                <Th numeric>Amount</Th>
                <Th>Why it counts, or does not</Th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o) => (
                <tr key={o.externalId}>
                  <Td>
                    {o.name}
                    {o.replayed && (
                      <span className="block text-xs text-text-muted">replayed, not from a CRM</span>
                    )}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        o.stageKind === 'won' ? 'good' : o.stageKind === 'lost' ? 'bad' : 'info'
                      }
                    >
                      {o.stage}
                    </Badge>
                  </Td>
                  <Td numeric>{o.amountCents === null ? '—' : money(o.amountCents)}</Td>
                  <Td>
                    <span className="text-xs">
                      <Badge tone={o.verdictKind === 'sourced' ? 'good' : 'neutral'}>
                        {o.verdictKind}
                      </Badge>{' '}
                      <span className="text-text-muted">{o.verdict}</span>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
