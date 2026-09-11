import { calendarDaysBetween } from '@/lib/datetime/zoned';
import type { Readiness } from './score';

/**
 * The portfolio rollup — every live show on one screen, ranked.
 *
 * The thing this file exists to get right is the ranking, and the obvious answer
 * is wrong. **Sorting by readiness score puts the wrong show on top.** A show 40%
 * ready that opens in eight months is on schedule; a show 70% ready that opens in
 * nine days is the emergency — and score-ordering buries the emergency below it.
 * Readiness is only meaningful against the clock, so what this ranks on is *how
 * far behind the pace a show is*, which needs both numbers.
 *
 * The pace model is deliberately crude and deliberately explicit: planning is
 * assumed to run over `PLANNING_WINDOW_DAYS` before the doors open, linearly, so
 * a show halfway through its window is expected to be halfway done. It is a
 * heuristic and it is stated as one on the screen — the alternative is a model
 * that looks authoritative and is equally invented. What makes it useful is that
 * it is *stable*: the same show at the same distance always reads the same way,
 * so "we are three weeks behind on Automate" means something week to week.
 *
 * Everything here is pure. `asOf` is a parameter for the same reason it is in
 * `score.ts`: every claim in this file is a claim about a moment.
 */

/** How long before opening a show's planning is assumed to run. */
export const PLANNING_WINDOW_DAYS = 120;

export type PortfolioInput = {
  id: string;
  name: string;
  status: string;
  startsOn: Date;
  timezone: string;
  readiness: Readiness;
  /**
   * Estimated surcharges on deadlines that are open and already past due. §5a.
   * *Incurred*, not at risk — step 11's second correction: past the date the
   * money is spent, and a portfolio that calls it "at risk" is inviting somebody
   * to think it can still be saved.
   */
  missedDeadlineCents: number;
  missedDeadlines: number;
  /** Deadlines open, not yet due. */
  openDeadlines: number;
  /** Deadlines whose date nobody has checked against this year's manual. */
  unconfirmedDeadlines: number;
  /** Open deadlines nobody owns — the ones an owner-addressed alert would miss. */
  unownedDeadlines: number;
};

export type PortfolioRow = PortfolioInput & {
  daysUntil: number;
  /** Where the pace model says this show should be, 0–100. */
  expected: number;
  /**
   * `expected - score`, in points. Positive is behind. `null` when the show has
   * no checklist at all — being behind is not the problem there; having nothing
   * to be behind on is.
   */
  behindBy: number | null;
  /** Plain-language reasons, worst first. Empty means genuinely nothing to say. */
  concerns: string[];
  severity: 'critical' | 'warn' | 'ok';
};

export function expectedReadiness(daysUntil: number): number {
  if (daysUntil <= 0) return 100;
  if (daysUntil >= PLANNING_WINDOW_DAYS) return 0;
  return Math.round(((PLANNING_WINDOW_DAYS - daysUntil) / PLANNING_WINDOW_DAYS) * 100);
}

export function rollUpPortfolio(shows: PortfolioInput[], asOf: Date): PortfolioRow[] {
  return shows.map((show) => assess(show, asOf)).sort(byRisk);
}

function assess(show: PortfolioInput, asOf: Date): PortfolioRow {
  const daysUntil = calendarDaysBetween(asOf, show.startsOn, show.timezone);
  const expected = expectedReadiness(daysUntil);
  const { score } = show.readiness;
  const behindBy = score === null ? null : expected - score;

  const concerns: string[] = [];
  let severity: PortfolioRow['severity'] = 'ok';
  const raise = (level: PortfolioRow['severity']) => {
    if (level === 'critical' || (level === 'warn' && severity === 'ok')) severity = level;
  };

  if (show.missedDeadlines > 0) {
    concerns.push(
      show.missedDeadlineCents > 0
        ? `${dollars(show.missedDeadlineCents)} of late-order surcharges already incurred on ` +
          `${show.missedDeadlines} missed ${show.missedDeadlines === 1 ? 'deadline' : 'deadlines'}`
        : `${show.missedDeadlines} service ${show.missedDeadlines === 1 ? 'deadline has' : 'deadlines have'} passed unmet`,
    );
    raise('critical');
  }

  if (score === null) {
    // Not "0% ready" — nothing has been planned, which is a different sentence
    // and a different fix. See score.ts.
    concerns.push(
      daysUntil <= PLANNING_WINDOW_DAYS
        ? `No checklist, and the show opens in ${daysUntil} days`
        : 'No checklist yet',
    );
    raise(daysUntil <= PLANNING_WINDOW_DAYS ? 'critical' : 'warn');
  } else if (behindBy !== null && behindBy >= 25) {
    concerns.push(`${behindBy} points behind pace — ${score}% ready with ${daysUntil} days to go`);
    raise('critical');
  } else if (behindBy !== null && behindBy >= 10) {
    concerns.push(`Slightly behind pace — ${score}% ready with ${daysUntil} days to go`);
    raise('warn');
  }

  if (show.readiness.overdue > 0) {
    concerns.push(
      `${show.readiness.overdue} ${show.readiness.overdue === 1 ? 'task is' : 'tasks are'} past due`,
    );
    raise('warn');
  }

  if (show.readiness.blocked > 0) {
    const share = Math.round(show.readiness.blockedShare * 100);
    concerns.push(
      `${show.readiness.blocked} blocked, holding ${share}% of the remaining weight`,
    );
    // A blocked task cannot be worked around by trying harder, so a show whose
    // remaining work is mostly blocked is a different problem from a late one.
    raise(share >= 20 ? 'critical' : 'warn');
  }

  if (show.unownedDeadlines > 0) {
    concerns.push(
      `${show.unownedDeadlines} open ${show.unownedDeadlines === 1 ? 'deadline has' : 'deadlines have'} no owner`,
    );
    raise('warn');
  }

  if (show.unconfirmedDeadlines > 0) {
    concerns.push(
      `${show.unconfirmedDeadlines} deadline${show.unconfirmedDeadlines === 1 ? '' : 's'} ` +
        'nobody has confirmed against this year’s manual',
    );
    raise('warn');
  }

  return { ...show, daysUntil, expected, behindBy, concerns, severity };
}

const SEVERITY_ORDER: Record<PortfolioRow['severity'], number> = { critical: 0, warn: 1, ok: 2 };

/**
 * Worst first, and within a severity the nearest show first — once two shows are
 * both on fire, the one that opens sooner is the one you can still do something
 * about.
 */
/**
 * Soonest show first, severity as the tie-break.
 *
 * This is the one board where flipping to the clock costs the least, because the
 * ranking it replaces was *already* a function of the clock: the pace model
 * exists precisely so that 70% nine days out outranks 40% eight months out. What
 * severity-first added on top was a re-sort the reader has to undo — a show
 * opening next week sitting below one opening in March because the March one is
 * further behind pace. The pace verdict is still on every row, in its words and
 * its tone, and it still breaks ties between two shows opening the same day.
 *
 * A show that has already opened sorts first of all and keeps its natural order,
 * which falls out of `daysUntil` going negative rather than needing a rule:
 * readiness during move-in is the last moment it means anything.
 */
function byRisk(a: PortfolioRow, b: PortfolioRow): number {
  if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}
