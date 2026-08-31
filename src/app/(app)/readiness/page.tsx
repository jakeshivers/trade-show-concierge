import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getPortfolio, type PortfolioRow } from '@/lib/readiness/store';
import { PLANNING_WINDOW_DAYS } from '@/lib/readiness/portfolio';
import {
  Badge,
  Card,
  Empty,
  money,
  readinessLabel,
  readinessTone,
  type Tone,
} from '../_components/ui';

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

  const exposure = rows.reduce((sum, r) => sum + r.overdueDeadlineCents, 0);
  const critical = rows.filter((r) => r.severity === 'critical');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Readiness</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every committed show, worst first. Ranked by how far behind pace each one is —
          not by its score, because a low score a long way out is not a problem and a high
          score next week can be.
        </p>
      </header>

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
                label="Penalties already exposed"
                value={money(exposure)}
                tone={exposure > 0 ? 'bad' : undefined}
                note="Deadlines open and past due. §5a."
              />
            </div>
            <p className="mt-3 text-xs text-zinc-500">
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
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
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
        <span className="text-xs text-zinc-500">
          {row.daysUntil > 0
            ? `opens in ${row.daysUntil} days`
            : row.daysUntil === 0
              ? 'opens today'
              : `opened ${-row.daysUntil} days ago`}
        </span>
        <span className="ml-auto text-xs text-zinc-500">
          expected {row.expected}% by now
        </span>
      </div>

      {row.concerns.length === 0 ? (
        <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
          On pace, nothing overdue, nothing blocked.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {row.concerns.map((c) => (
            <li key={c} className="flex gap-2">
              <span className={row.severity === 'critical' ? 'text-rose-600' : 'text-amber-600'}>
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
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${tone === 'bad' ? 'text-rose-700 dark:text-rose-400' : ''}`}>
        {value}
      </div>
      {note && <div className="text-xs text-zinc-500">{note}</div>}
    </div>
  );
}
