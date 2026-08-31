import { getActor } from '@/lib/auth/actor';
import { getChecklist } from '@/lib/readiness/store';
import { TEMPLATES } from '@/lib/readiness/templates';
import { TASK_CATEGORIES } from '@/lib/readiness/edit';
import {
  Badge,
  Card,
  Empty,
  money,
  readinessLabel,
  readinessTone,
  showDate,
  showDateTime,
  type Tone,
} from '../../../_components/ui';
import { loadShow } from '../detail';
import { AddTaskForm, EditTaskForm, StatusControl, TemplateForm } from './forms';

/**
 * Readiness — the checklist, writable as of step 10, and the deadline register.
 *
 * What the screen leads with is the argument of `src/lib/readiness/score.ts` made
 * visible: **the headline percentage is the least useful number here.** A show at
 * 88% with its last critical task blocked on a contract is in worse shape than
 * one at 60% moving steadily, so what sits at the top is what is *wrong* —
 * overdue, blocked, unplanned — and the percentage sits beside it as context.
 * "No checklist" is its own state and says so; it is never rendered as 0%.
 *
 * Deadline editing is still step 11: the register below is read-only, and says
 * so where the controls would be.
 */
export default async function ReadinessTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ detail }, actor] = await Promise.all([loadShow(id), getActor()]);
  const checklist = await getChecklist(actor, id);
  const { show, deadlines } = detail;
  const { readiness, entries, may, people } = checklist;

  const now = new Date();
  const openDeadlines = deadlines.filter((d) => !d.deadline.completedAt);
  const exposure = openDeadlines.reduce(
    (sum, d) => sum + (d.deadline.penaltyEstimateCents ?? 0),
    0,
  );
  const pastDue = openDeadlines.filter((d) => d.deadline.dueAt.getTime() < now.getTime());

  return (
    <div className="space-y-6">
      {/* What is wrong, before what is done. */}
      <Card
        title="Where this show stands"
        action={
          <Badge tone={readinessTone(readiness.score)}>{readinessLabel(readiness.score)}</Badge>
        }
      >
        {readiness.score === null ? (
          <p>
            <strong>Nothing has been planned yet.</strong> This is not 0% ready — it is a show
            with no checklist, which is a different problem and a different fix. Apply a
            template below, or add tasks by hand.
          </p>
        ) : (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Fact
              label="Counted"
              value={`${readiness.counted} of ${readiness.total} tasks`}
              note={
                readiness.byStatus.skipped > 0
                  ? `${readiness.byStatus.skipped} skipped, and out of the score`
                  : undefined
              }
            />
            <Fact
              label="Complete"
              value={`${readiness.byStatus.complete}`}
              note={
                readiness.byStatus.in_progress > 0
                  ? `${readiness.byStatus.in_progress} in progress, at half credit`
                  : undefined
              }
            />
            <Fact
              label="Past due"
              value={`${readiness.overdue}`}
              tone={readiness.overdue > 0 ? 'bad' : undefined}
              note={readiness.overdue > 0 ? 'The score does not know about the clock' : undefined}
            />
            <Fact
              label="Blocked"
              value={`${readiness.blocked}`}
              tone={readiness.blocked > 0 ? 'warn' : undefined}
              note={
                readiness.blocked > 0
                  ? `holding ${Math.round(readiness.blockedShare * 100)}% of remaining weight`
                  : undefined
              }
            />
          </div>
        )}
      </Card>

      <Card title="Service manual deadlines">
        <p className="mb-3 text-xs text-zinc-500">
          {money(exposure)} of estimated penalties sits behind the {openDeadlines.length} open{' '}
          {openDeadlines.length === 1 ? 'deadline' : 'deadlines'} below
          {pastDue.length > 0 && (
            <>
              , and <strong>{pastDue.length}</strong> of them {pastDue.length === 1 ? 'is' : 'are'}{' '}
              already past due
            </>
          )}
          . Editing this register and the escalating alerts on it are step 11; this is the
          register the engine will run on.
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
                ) : (
                  <>
                    {deadline.dueAt.getTime() < now.getTime() && <Badge tone="bad">past due</Badge>}
                    {!deadline.confirmedAt && <Badge tone="warn">unconfirmed</Badge>}
                  </>
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

      <Card title="Checklist">
        {entries.length === 0 ? (
          <Empty>
            No tasks yet. Apply a template below to seed the standard set, or add one by hand.
          </Empty>
        ) : (
          <div className="space-y-6">
            {TASK_CATEGORIES.map((category) => {
              const rows = entries.filter((e) => e.task.category === category);
              if (rows.length === 0) return null;
              return (
                <section key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {category.replace('_', ' ')}
                  </h3>
                  <ul className="space-y-3">
                    {rows.map((entry) => (
                      <li
                        key={entry.task.id}
                        className="border-b border-zinc-100 pb-3 last:border-0 dark:border-zinc-800"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <Badge tone={TASK_TONE[entry.task.status]}>
                            {entry.task.status.replace('_', ' ')}
                          </Badge>
                          <span className={entry.task.status === 'skipped' ? 'line-through' : ''}>
                            {entry.task.title}
                          </span>
                          {entry.task.weight >= 3 && <Badge tone="info">critical</Badge>}
                          {entry.overdue && <Badge tone="bad">past due</Badge>}
                          <span className="ml-auto text-xs text-zinc-500">
                            {entry.assignee?.fullName ?? 'Unassigned'} · due{' '}
                            {showDate(entry.task.dueOn, show.timezone)}
                          </span>
                        </div>

                        {entry.task.description && (
                          <p className="mt-1 text-xs text-zinc-500">{entry.task.description}</p>
                        )}
                        {entry.task.statusNote && (
                          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                            {entry.task.status === 'skipped' ? 'Skipped: ' : 'Blocked on: '}
                            {entry.task.statusNote}
                          </p>
                        )}

                        {entry.mayUpdate ? (
                          <div className="mt-2">
                            <StatusControl showId={id} entry={entry} maySkip={may.skip} />
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-zinc-500">
                            {entry.assignee
                              ? `${entry.assignee.fullName} reports progress on this one.`
                              : 'Unassigned — whoever runs the show can assign it.'}
                          </p>
                        )}

                        {may.edit && (
                          <EditTaskForm
                            showId={id}
                            timezone={show.timezone}
                            entry={entry}
                            people={people}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        {!may.skip && entries.some((e) => e.mayUpdate) && (
          <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
            You can move your own tasks, but not skip one. A skipped task drops out of the
            readiness score entirely, so it is a change to the plan rather than a report of
            progress — it belongs to whoever runs the show.
          </p>
        )}

        {may.edit && (
          <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <AddTaskForm showId={id} people={people} />
          </div>
        )}
      </Card>

      {may.applyTemplate && (
        <Card title="Templates">
          <p className="mb-3 text-xs text-zinc-500">
            Built-in and versioned in the codebase, not editable here — a template builder is
            deferred until the standard list has been used and argued with. Dates are computed
            as offsets from this show&rsquo;s opening day, in {show.timezone}.
          </p>
          <TemplateForm showId={id} templates={TEMPLATES} hasTasks={entries.length > 0} />
        </Card>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: Tone;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'bad' ? 'text-rose-700 dark:text-rose-400' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : ''}`}>
        {value}
      </div>
      {note && <div className="text-xs text-zinc-500">{note}</div>}
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
