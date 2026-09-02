import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getPortfolio, type PortfolioRow } from '@/lib/readiness/store';
import { PLANNING_WINDOW_DAYS } from '@/lib/readiness/portfolio';
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  money,
  readinessLabel,
  readinessTone,
  type Tone,
} from '../_components/ui';
import { GoToShow } from '../_components/go-to-show';

/**
 * The portfolio rollup — every show being run, ranked by how much trouble it is in.
 *
 * The ranking is the whole point of the screen and it deliberately is **not** the
 * readiness score. A show 40% ready eight months out is on schedule; a show 70%
 * ready in nine days is the emergency, and a list sorted by percentage puts the
 * emergency underneath it. `src/lib/readiness/portfolio.ts` holds the pace model
 * and the reasoning; this renders it, and states on the page that the pace curve
 * is a heuristic rather than letting a number imply a precision it does not have.
 */

export const metadata = { title: 'Readiness' };

export default async function ReadinessPortfolio() {
  const actor = await getActor();
  const rows = await getPortfolio(actor);

  const incurred = rows.reduce((sum, r) => sum + r.missedDeadlineCents, 0);
  const critical = rows.filter((r) => r.severity === 'critical');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Readiness"
        blurb={
          <>
            Every committed show, soonest first. What is wrong with one is the sentence beside
            it, judged against pace rather than against its score — a low score a long way out
            is not a problem and a high score next week can be.
          </>
        }
        action={
          <GoToShow
            actor={actor}
            tab="readiness"
            label="Open a checklist"
            hint={
              <>
                Tasks, templates and the deadline register all live on one show’s Readiness tab.
              </>
            }
          />
        }
      />

      {rows.length === 0 ? (
        <Empty>
          No committed shows. Prospects are not scored — there is nothing to be behind on
          until somebody decides to do the show.
        </Empty>
      ) : (
        <>
          <Card title="Across the calendar">
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <Fact label="Shows" value={String(rows.length)} />
              <Fact
                label="Need attention"
                value={String(critical.length)}
                tone={critical.length > 0 ? 'bad' : undefined}
              />
              <Fact
                label="Late-order surcharges incurred"
                value={money(incurred)}
                tone={incurred > 0 ? 'bad' : undefined}
                // Not "at risk": past the date the money is spent. §5a, and
                // `src/lib/deadlines/alerts.ts`.
                note="Deadlines open and already past due. Not recoverable."
              />
            </div>
            <p className="mt-3 text-xs text-text-muted">
              Pace is a straight line over the {PLANNING_WINDOW_DAYS} days before a show opens:
              halfway through the window, half the weighted checklist is expected to be done.
              It is a heuristic, said out loud rather than dressed up — what makes it useful is
              that it reads the same way week to week, so &ldquo;three weeks behind&rdquo; means
              something.
            </p>
          </Card>

          <div className="space-y-3">
            {rows.map((row) => (
              <ShowRow key={row.id} row={row} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SEVERITY_TONE: Record<PortfolioRow['severity'], Tone> = {
  critical: 'bad',
  warn: 'warn',
  ok: 'good',
};

function ShowRow({ row }: { row: PortfolioRow }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={`/shows/${row.id}/readiness`} className="font-medium hover:underline">
          {row.name}
        </Link>
        <Badge tone={readinessTone(row.readiness.score)}>
          {readinessLabel(row.readiness.score)}
        </Badge>
        {row.behindBy !== null && row.behindBy > 0 && (
          <Badge tone={SEVERITY_TONE[row.severity]}>{row.behindBy} pts behind pace</Badge>
        )}
        <span className="text-xs text-text-muted">
          {row.daysUntil > 0
            ? `opens in ${row.daysUntil} days`
            : row.daysUntil === 0
              ? 'opens today'
              : `opened ${-row.daysUntil} days ago`}
        </span>
        <span className="ml-auto text-xs text-text-muted">
          expected {row.expected}% by now
        </span>
      </div>

      {row.concerns.length === 0 ? (
        <p className="mt-2 text-sm text-good">
          On pace, nothing overdue, nothing blocked.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {row.concerns.map((c) => (
            <li key={c} className="flex gap-2">
              <span className={row.severity === 'critical' ? 'text-bad' : 'text-warn'}>
                •
              </span>
              <span>{c}</span>
            </li>
          ))}
        </ul>
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
      <div className={`text-lg font-semibold ${tone === 'bad' ? 'text-bad' : ''}`}>
        {value}
      </div>
      {note && <div className="text-xs text-text-muted">{note}</div>}
    </div>
  );
}
