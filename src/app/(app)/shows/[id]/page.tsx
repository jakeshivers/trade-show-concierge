import { canDecideShow } from '@/lib/shows/visibility';
import {
  Badge,
  Card,
  Empty,
  Row,
  dateRange,
  money,
  place,
  readinessLabel,
  readinessTone,
  showDateTime,
} from '../../_components/ui';
import { loadShow } from './detail';
import { DecideForm } from './decide-form';

/** Overview: the show record, the intake history, and — for a prospect — the decision. */
export default async function ShowOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, detail } = await loadShow(id);
  const { show, decisions, expenses, committedCents } = detail;

  const openDeadlines = detail.deadlines.filter((d) => !d.deadline.completedAt);
  const unconfirmed = openDeadlines.filter((d) => !d.deadline.confirmedAt);

  return (
    <div className="space-y-6">
      {show.status === 'prospect' && canDecideShow(actor) && (
        <Card title="Decide">
          <DecideForm showId={show.id} />
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="The show">
          <Row label="Dates">{dateRange(show.startsOn, show.endsOn, show.timezone)}</Row>
          <Row label="Move in / out">
            {showDateTime(show.moveInAt, show.timezone)} → {showDateTime(show.moveOutAt, show.timezone)}
          </Row>
          <Row label="Venue">
            {show.venueName ?? '—'}
            {show.venueAddress && (
              <span className="block text-xs text-zinc-500">{show.venueAddress}</span>
            )}
          </Row>
          <Row label="Location">
            {place(show)}
            {show.airportCode && ` · ${show.airportCode}`}
          </Row>
          <Row label="Booth">
            {show.boothNumber ? `${show.boothNumber} · ` : ''}
            {show.boothSize ?? '—'}
          </Row>
          <Row label="Website">
            {show.website ? (
              <a className="underline" href={show.website} target="_blank" rel="noreferrer">
                {show.website}
              </a>
            ) : (
              '—'
            )}
          </Row>
        </Card>

        <div className="space-y-6">
          <Card title="Where it stands">
            <Row label="Readiness">
              <Badge tone={readinessTone(detail.readiness.score)}>
                {readinessLabel(detail.readiness.score)}
              </Badge>{' '}
              <span className="text-zinc-500">
                across {detail.readiness.counted}{' '}
                {detail.readiness.counted === 1 ? 'task' : 'tasks'}
                {detail.readiness.overdue > 0 && `, ${detail.readiness.overdue} past due`}
                {detail.readiness.blocked > 0 && `, ${detail.readiness.blocked} blocked`}
              </span>
            </Row>
            <Row label="Budget">{money(show.budgetCents)}</Row>
            <Row label="Recorded spend">
              {money(committedCents)}
              <span className="block text-xs text-zinc-500">
                {expenses.length} expense {expenses.length === 1 ? 'line' : 'lines'}. The true-cost
                rollup that folds in flights, lodging, and shipping lands at step 16.
              </span>
            </Row>
            <Row label="Open deadlines">
              {openDeadlines.length}
              {unconfirmed.length > 0 && (
                <span className="ml-2">
                  <Badge tone="warn">{unconfirmed.length} unconfirmed</Badge>
                </span>
              )}
            </Row>
            <Row label="Team">{detail.attendees.length}</Row>
          </Card>

          {show.goals && (
            <Card title="Goals">
              <p className="whitespace-pre-line">{show.goals}</p>
            </Card>
          )}
        </div>
      </div>

      <Card title="Intake history">
        {decisions.length === 0 ? (
          <Empty>
            No recorded decision. This show predates the intake log, or was created directly in
            the database.
          </Empty>
        ) : (
          <ol className="space-y-3">
            {decisions.map(({ decision, by }) => (
              <li key={decision.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge tone={TONE[decision.decision]}>{decision.decision}</Badge>
                  <span className="text-xs text-zinc-500">
                    {by?.fullName ?? 'Unknown'} · {decision.decidedAt.toLocaleDateString('en-US')}
                  </span>
                </div>
                <p className="mt-1">{decision.rationale}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

const TONE = {
  proposed: 'info',
  cloned: 'info',
  committed: 'good',
  declined: 'bad',
} as const;
