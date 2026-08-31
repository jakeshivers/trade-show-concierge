import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getChecklist } from '@/lib/readiness/store';
import { getRegister } from '@/lib/deadlines/store';
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
import { AddDeadlineForm, DeadlineRow } from './deadline-forms';

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
 * The register below is writable as of step 11, and what it renders is the alert
 * engine's own reasoning rather than a second opinion about the same rows: each
 * row shows what the engine will say about it next, in the tense it will say it
 * in. §5a, and `src/lib/deadlines/alerts.ts` for why "at risk" and "already
 * incurred" are never the same sentence.
 */
export default async function ReadinessTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ detail }, actor] = await Promise.all([loadShow(id), getActor()]);
  const now = new Date();
  const [checklist, register] = await Promise.all([
    getChecklist(actor, id, now),
    getRegister(actor, id, now),
  ]);
  const { show } = detail;
  const { readiness, entries, may, people } = checklist;
  const { exposure } = register;

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
        {/*
          Three figures, never one. The confirmed and the guessed are kept apart
          because adding them makes a number that is neither, and incurred is
          kept apart from both because past the date it is not at risk — it is
          spent. `src/lib/deadlines/alerts.ts`.
        */}
        <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2">
          <Fact
            label="Avoidable"
            value={money(exposure.atRiskCents)}
            note={`across ${exposure.open} open ${exposure.open === 1 ? 'deadline' : 'deadlines'}, on dates checked against the manual`}
          />
          {exposure.atRiskUnconfirmedCents > 0 && (
            <Fact
              label="On unconfirmed dates"
              value={money(exposure.atRiskUnconfirmedCents)}
              tone="warn"
              note="A guess until somebody checks it — not counted above"
            />
          )}
          {exposure.missed > 0 && (
            <Fact
              label="Already incurred"
              value={money(exposure.incurredCents)}
              tone="bad"
              note={`${exposure.missed} ${exposure.missed === 1 ? 'deadline has' : 'deadlines have'} passed — this is spent, not at risk`}
            />
          )}
        </div>

        {register.entries.length === 0 ? (
          <Empty>No deadlines recorded. They come from the show&rsquo;s exhibitor manual.</Empty>
        ) : (
          <ul className="space-y-3">
            {register.entries.map((entry) => {
              const d = entry.deadline;
              const missed = d.status === 'open' && entry.daysUntil < 0;
              return (
                <li
                  key={d.id}
                  className="border-b border-border pb-3 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={d.status === 'not_applicable' ? 'font-medium line-through' : 'font-medium'}>
                      {d.title}
                    </span>
                    <Badge>{d.kind.replace(/_/g, ' ')}</Badge>
                    {d.status === 'complete' && <Badge tone="good">ordered</Badge>}
                    {d.status === 'not_applicable' && <Badge>does not apply</Badge>}
                    {d.lodgingId && <Badge tone="info">from a room block</Badge>}
                    {d.status === 'open' && (
                      <>
                        {missed && <Badge tone="bad">missed</Badge>}
                        {!d.confirmedAt && <Badge tone="warn">unconfirmed</Badge>}
                        {!d.ownerId && <Badge tone="warn">unowned</Badge>}
                      </>
                    )}
                    <span className="text-text-muted">{showDateTime(d.dueAt, show.timezone)}</span>
                    {d.penaltyEstimateCents != null && d.status === 'open' && (
                      <span className="text-bad">
                        {/* The tense is the product. Past the date it is not at risk. */}
                        {money(d.penaltyEstimateCents)}{' '}
                        {missed ? 'already incurred' : d.confirmedAt ? 'at risk' : 'at risk if the date is right'}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-text-muted">
                      {entry.owner?.fullName ?? 'Unowned'}
                    </span>
                  </div>

                  {d.lodgingId && (
                    <p className="mt-1 text-xs text-text-muted">
                      Derived from a hotel&rsquo;s room block cutoff, so its date lives on the{' '}
                      <Link href={`/shows/${id}/lodging`} className="underline">
                        Lodging tab
                      </Link>{' '}
                      and is edited only there — two editable copies of one date is how the date
                      gets missed. Its owner, penalty estimate and completion are ordinary register
                      facts.
                    </p>
                  )}
                  {d.penaltyNote && <p className="mt-1 text-xs text-text-muted">{d.penaltyNote}</p>}
                  {d.statusNote && (
                    <p className="mt-1 text-xs text-warn">
                      Does not apply: {d.statusNote}
                    </p>
                  )}
                  {d.sourceUrl && (
                    <p className="mt-1 text-xs">
                      <a href={d.sourceUrl} className="text-text-muted underline" rel="noreferrer">
                        the manual page this came from
                      </a>
                    </p>
                  )}

                  {entry.pending && (
                    <p className="mt-1 text-xs text-text-muted">
                      <span className="font-medium">Alert:</span> {entry.pending.title} — to{' '}
                      {entry.pending.audience === 'owner'
                        ? entry.owner?.fullName ?? 'its owner'
                        : 'whoever runs the show'}
                    </p>
                  )}

                  <DeadlineRow
                    showId={id}
                    timezone={show.timezone}
                    entry={entry}
                    people={register.people}
                    may={register.may}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {register.may.edit ? (
          <div className="mt-4 border-t border-border pt-4">
            <AddDeadlineForm showId={id} timezone={show.timezone} people={register.people} />
          </div>
        ) : (
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
            You can mark a deadline you own as ordered. Adding, re-dating and confirming
            deadlines belongs to whoever runs the show — a date here is what the alerts fire
            against and what the exposure above is computed from.
          </p>
        )}

        <p className="mt-3 text-xs text-text-muted">
          Alerts escalate at 30, 14 and 3 days out and on the day. A date nobody has confirmed
          against this year&rsquo;s manual is chased as a <em>date</em> rather than quoted as an
          amount, because a penalty figure behind a guessed date is a fabricated bill. Run{' '}
          <code>pnpm deadlines</code> to see what the engine would send tonight, or read what it
          has already said on the <a className="underline hover:no-underline" href="/alerts">alerts
          feed</a>.
        </p>
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
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {category.replace('_', ' ')}
                  </h3>
                  <ul className="space-y-3">
                    {rows.map((entry) => (
                      <li
                        key={entry.task.id}
                        className="border-b border-border pb-3 last:border-0"
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
                          <span className="ml-auto text-xs text-text-muted">
                            {entry.assignee?.fullName ?? 'Unassigned'} · due{' '}
                            {showDate(entry.task.dueOn, show.timezone)}
                          </span>
                        </div>

                        {entry.task.description && (
                          <p className="mt-1 text-xs text-text-muted">{entry.task.description}</p>
                        )}
                        {entry.task.statusNote && (
                          <p className="mt-1 text-xs text-warn">
                            {entry.task.status === 'skipped' ? 'Skipped: ':'Blocked on: '}
                            {entry.task.statusNote}
                          </p>
                        )}

                        {entry.mayUpdate ? (
                          <div className="mt-2">
                            <StatusControl showId={id} entry={entry} maySkip={may.skip} />
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-text-muted">
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
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
            You can move your own tasks, but not skip one. A skipped task drops out of the
            readiness score entirely, so it is a change to the plan rather than a report of
            progress — it belongs to whoever runs the show.
          </p>
        )}

        {may.edit && (
          <div className="mt-4 border-t border-border pt-4">
            <AddTaskForm showId={id} people={people} />
          </div>
        )}
      </Card>

      {may.applyTemplate && (
        <Card title="Templates">
          <p className="mb-3 text-xs text-text-muted">
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
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : ''}`}>
        {value}
      </div>
      {note && <div className="text-xs text-text-muted">{note}</div>}
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
