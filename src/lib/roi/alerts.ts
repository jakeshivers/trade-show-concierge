import type { Maturity } from './rollup';
import type { MatchCoverage } from './rollup';

/**
 * The seventh engine, and the only one that reports an unanswered *question*
 * rather than a broken thing.
 *
 * Pure. The six engines before this one report that something went wrong with a
 * thing that exists, or — twice — that a thing which should exist does not: a
 * crate that never came back, a show that ran and captured nothing. This one
 * reports that a show has a cost and no return side, which is not a failure of
 * any row. It is §1's third job going unanswered, and it goes unanswered
 * silently, months after anybody could have fixed it.
 *
 * Four conditions, and the tense rule (§5a) decides three of them.
 *
 * - **`never_synced`** — the show is old enough to have pipeline and no sync has
 *   ever looked. Warning, and it names the leads rather than the shows, because
 *   the fix is one button.
 * - **`unmatchable_leads`** — leads that will never reach a CRM because no
 *   lawful basis was recorded. Deliberately *not* the same alert as
 *   `basis_unrecorded` (§5j's engine), which fires while the show is on and is
 *   addressed at fixing the record. This one fires later and says something
 *   different: those conversations are now permanently outside every ROI figure
 *   this show will ever produce. Same rows, different tense, different reader —
 *   which is exactly the split §5a made between "at risk" and "incurred".
 * - **`attribution_unwritten`** — we read the CRM and never wrote back, so the
 *   CRM still cannot answer the question. Info: it is our half of §8b undone,
 *   and nothing is lost by it except the ability to be believed by somebody
 *   else's dashboard.
 * - **`sync_failing`** — the last run failed. Critical only if it has failed
 *   twice, because one failed sync is a network, and a board that shouts at
 *   every transient is one nobody reads.
 *
 * **The alert nobody gets, deliberately:** a low pipeline multiple. It is the
 * headline number and the obvious thing to alert on, and alerting on it would be
 * this product telling somebody to cut a show — over a figure that §8e says is
 * not final for a year, computed from a cost that may be a floor and a lead
 * count that may be one too. The engine reports that the *question* is
 * unanswered. It does not answer it.
 */

export type RoiAlertReason =
  | 'never_synced'
  | 'unmatchable_leads'
  | 'attribution_unwritten'
  | 'sync_failing';

export type PlannedRoiAlert = {
  showId: string | null;
  userId: string | null;
  reason: RoiAlertReason;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  dedupeKey: string;
};

export type RoiAlertableShow = {
  showId: string;
  showName: string;
  endsOn: Date;
  status: string;
  maturity: Maturity;
  leadCount: number;
  matching: MatchCoverage;
  /** Links read from the CRM with nothing written back. */
  attributionsUnwritten: number;
  /**
   * True when this show's links came from a replay.
   *
   * It suppresses the attribution alert, and the reason is §5e's rule about a
   * warning that fires on the ordinary case. The recorded provider *cannot*
   * write — it refuses, because there is no CRM on the other end and reporting a
   * successful write would send somebody looking in Salesforce for a field
   * nothing ever set. So on a workspace with no CRM key, "you never wrote the
   * attribution back" would fire on every show, forever, and name a fix nobody
   * can perform. An alert nobody can act on is one that teaches a reader to skip
   * the list it is in.
   */
  replayed: boolean;
  costCents: number;
};

/** How long after a show closes a sync is genuinely overdue rather than early. */
export const SYNC_GRACE_DAYS = 30;

export function planRoiAlerts(
  shows: RoiAlertableShow[],
  recentFailures: { provider: string; reason: string; count: number } | null,
  asOf: Date,
): PlannedRoiAlert[] {
  const out: PlannedRoiAlert[] = [];

  for (const show of shows) {
    if (show.status === 'cancelled' || show.status === 'prospect') continue;
    const daysClosed = (asOf.getTime() - show.endsOn.getTime()) / 86_400_000;

    if (
      daysClosed >= SYNC_GRACE_DAYS &&
      show.leadCount > 0 &&
      show.matching.unsynced === show.matching.leads
    ) {
      out.push({
        showId: show.showId,
        userId: null,
        reason: 'never_synced',
        severity: 'warning',
        title: `${show.showName} closed ${Math.round(daysClosed)} days ago and its leads have never been matched to a CRM`,
        body:
          `${show.leadCount} lead${show.leadCount === 1 ? '' : 's'} and ` +
          `${(show.costCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} of recorded cost, ` +
          'with no return side at all. This is the show that gets cut next budget round over a number nobody ever ' +
          'computed — not a bad number, an absent one.',
        dedupeKey: `roi:never_synced:${show.showId}`,
      });
    }

    if (show.matching.withheld > 0 && daysClosed >= SYNC_GRACE_DAYS) {
      out.push({
        showId: show.showId,
        userId: null,
        reason: 'unmatchable_leads',
        severity: 'info',
        title: `${show.matching.withheld} lead${show.matching.withheld === 1 ? '' : 's'} from ${show.showName} will never appear in a pipeline figure`,
        body:
          'No lawful basis was recorded when they were captured, so nothing about them is sent to a CRM — ' +
          'they are lawfully held and still counted, and they are permanently outside every ROI figure this ' +
          'show will produce. Past tense on purpose: the moment to record what the booth said was at the ' +
          'booth. It is worth knowing when reading this show’s cost per opportunity.',
        // Bucketed by count, §5b's shape: the sentence is worth repeating when
        // the number changes and not on a schedule.
        dedupeKey: `roi:unmatchable:${show.showId}:${show.matching.withheld}`,
      });
    }

    if (show.attributionsUnwritten > 0 && !show.replayed) {
      out.push({
        showId: show.showId,
        userId: null,
        reason: 'attribution_unwritten',
        severity: 'info',
        title:
        show.attributionsUnwritten === 1
          ? `A matched lead from ${show.showName} carries no attribution in the CRM`
          : `${show.attributionsUnwritten} matched leads from ${show.showName} carry no attribution in the CRM`,
        body:
          'We read the opportunities and never wrote the show back onto the records, so the CRM still cannot ' +
          'answer "which shows produce pipeline" on its own. That is the write half of §8b, and it is the half ' +
          'that makes the answer believable to somebody who does not use this app.',
        dedupeKey: `roi:attribution_unwritten:${show.showId}:${show.attributionsUnwritten}`,
      });
    }
  }

  if (recentFailures && recentFailures.count > 0) {
    out.push({
      showId: null,
      userId: null,
      reason: 'sync_failing',
      severity: recentFailures.count > 1 ? 'critical' : 'warning',
      title:
        recentFailures.count > 1
          ? `The ${recentFailures.provider} sync has failed ${recentFailures.count} times running`
          : `The last ${recentFailures.provider} sync failed`,
      body:
        `${recentFailures.reason} While it is failing, every pipeline figure in this workspace is as old as the ` +
        'last run that worked — which is a different problem from having no CRM, because the figures are still ' +
        'on the screen and still look current.',
      // The count, not the message: a token expiring and then a rate limit is
      // one ongoing outage to whoever has to fix it.
      dedupeKey: `roi:sync_failing:${recentFailures.provider}`,
    });
  }

  return out;
}
