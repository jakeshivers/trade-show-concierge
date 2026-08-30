import {
  Badge,
  Card,
  Empty,
  money,
  readinessTone,
  showDate,
  showDateTime,
  type Tone,
} from '../../../_components/ui';
import { loadShow } from '../detail';

/**
 * Readiness — the checklist and the service-manual deadlines, read-only.
 *
 * Editing lands at step 10 (checklist) and step 11 (the deadline engine). What is
 * worth showing now is the shape of the risk: a deadline with a dollar penalty is
 * a different object from a task, and the *unconfirmed* ones are the ones that
 * cost money, because a date nobody has read out of this year's exhibitor manual
 * is a guess wearing a due date.
 */
export default async function ReadinessTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { detail } = await loadShow(id);
  const { show, tasks, deadlines } = detail;

  const exposure = deadlines
    .filter((d) => !d.deadline.completedAt)
    .reduce((sum, d) => sum + (d.deadline.penaltyEstimateCents ?? 0), 0);

  return (
    <div className="space-y-6">
      <Card title="Service manual deadlines">
        <p className="mb-3 text-xs text-zinc-500">
          {money(exposure)} of estimated penalties sits behind the open deadlines below. The
          alerting engine is step 11; this is the register it will run on.
        </p>
        {deadlines.length === 0 ? (
          <Empty>No deadlines recorded. They come from the show&rsquo;s exhibitor manual.</Empty>
        ) : (
          <ul className="space-y-2">
            {deadlines.map(({ deadline, owner }) => (
              <li
                key={deadline.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-800"
              >
                <span className="font-medium">{deadline.title}</span>
                <Badge>{deadline.kind.replace(/_/g, ' ')}</Badge>
                {deadline.completedAt ? (
                  <Badge tone="good">done</Badge>
                ) : deadline.confirmedAt ? null : (
                  <Badge tone="warn">unconfirmed</Badge>
                )}
                <span className="text-zinc-500">{showDateTime(deadline.dueAt, show.timezone)}</span>
                {deadline.penaltyEstimateCents != null && (
                  <span className="text-rose-700 dark:text-rose-400">
                    {money(deadline.penaltyEstimateCents)} at risk
                  </span>
                )}
                <span className="ml-auto text-xs text-zinc-500">{owner?.fullName ?? 'Unowned'}</span>
                {deadline.penaltyNote && (
                  <span className="w-full text-xs text-zinc-500">{deadline.penaltyNote}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Checklist"
        action={<Badge tone={readinessTone(detail.readiness)}>{detail.readiness}% ready</Badge>}
      >
        {tasks.length === 0 ? (
          <Empty>
            No tasks yet. Step 10 adds templates that seed the standard set; a cloned show
            arrives with its source&rsquo;s list, reset.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map(({ task, assignee }) => (
              <li
                key={task.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 py-1 last:border-0 dark:border-zinc-800"
              >
                <Badge tone={TASK_TONE[task.status]}>{task.status.replace('_', ' ')}</Badge>
                <span>{task.title}</span>
                <span className="text-xs text-zinc-500">{task.category.replace('_', ' ')}</span>
                <span className="ml-auto text-xs text-zinc-500">
                  {assignee?.fullName ?? 'Unassigned'} · due {showDate(task.dueOn, show.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const TASK_TONE: Record<string, Tone> = {
  complete: 'good',
  in_progress: 'info',
  blocked: 'bad',
  not_started: 'neutral',
  skipped: 'neutral',
};
