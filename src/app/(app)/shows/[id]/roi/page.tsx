import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { canSeeRoi } from '@/lib/roi/access';
import { getShowRoi, listShowOpportunities } from '@/lib/roi/store';
import { figureLabel } from '@/lib/roi/rollup';
import { Badge, Card, Empty, Table, Td, Th, money } from '../../../_components/ui';
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

  const roi = await getShowRoi(actor, id);
  const opportunities = await listShowOpportunities(actor, id);

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
          {roi.leads.headline} {roi.meetingsHeld} meeting
          {roi.meetingsHeld === 1 ? '' : 's'} held.{' '}
          {money(roi.otherModelCents)} of pipeline under the{' '}
          {roi.settings.model === 'sourced' ? 'influenced' : 'sourced'} model, reported beside it
          rather than instead of it — §8b says to show both and pick a default, not to pick one
          and pretend.
        </p>
        <p className="mt-1 text-xs text-text-muted">
          {figureLabel(roi.settings)} · as of {roi.asOf.toISOString().slice(0, 10)}
        </p>
      </Card>

      <Card
        title="The figures"
        subtitle="A number, or the reason there is not one. A withheld figure is shown as prominently as a quoted one, because the reason is the part somebody can act on."
      >
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Cost per lead" value={roi.costPerLead} />
          <Figure label="Cost per meeting held" value={roi.costPerMeeting} />
          <Figure label="Cost per opportunity" value={roi.costPerOpportunity} />
          <Figure
            label="Pipeline multiple"
            value={roi.pipelineMultiple}
            note="Pipeline ÷ cost. §8d’s single headline number, and the easiest one to fake."
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
        subtitle="Named rather than netted. Two floors in a quotient do not cancel — one pushes the answer up and the other down, and neither magnitude is known."
      >
        <RoiGaps gaps={roi.gaps} />
      </Card>

      <Card
        title="Where the leads went"
        subtitle="Our refusals and the CRM’s answers, kept apart. There is deliberately no single “match rate” here."
      >
        <MatchTable roi={roi} />
        <p className="mt-3 text-xs text-text-muted">
          Every lead on this show is on its{' '}
          <Link href={`/shows/${id}/leads`} className="underline">
            Leads tab
          </Link>
          , where a withheld one says what would fix it — recording what the person was actually
          told at the booth. That is fixable at the booth and effectively not fixable afterwards,
          which is why the verdict is rendered on the lead rather than at the point of export.
        </p>
      </Card>

      <Card
        title="Every opportunity behind that figure"
        subtitle="Openable on purpose. An attributed pipeline number nobody can disagree with a row of is the fabricated bill again, one table over."
      >
        {opportunities.length === 0 ? (
          <p className="text-sm text-text-muted">
            No opportunity is linked to a lead from this show. That is an absence rather than a
            finding unless a sync has actually looked — the table above says which.
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
