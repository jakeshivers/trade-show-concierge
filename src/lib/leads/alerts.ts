import { hasOpened, type LeadCoverage } from './coverage';

/**
 * The sixth engine, and it is mostly about silence.
 *
 * Pure. Five of the six alert engines in this product report that something went
 * wrong with a thing that exists — a crate stalled, a deadline passed, a booth
 * never came back. This one's sharpest alert has **no lead row behind it**, in
 * the same way `shipping/alerts.ts`'s sharpest has no shipment row: a show that
 * ran, was staffed, and recorded nothing. §8c says that is the normal case at
 * most companies, and nothing in a lead table can report it, because the failure
 * is the table being empty.
 *
 * Four conditions, and each is a different kind of problem:
 *
 * - **`no_capture`** — the show opened, people stood on the booth, and no lead
 *   exists. The one worth building the engine for.
 * - **`thin_capture`** — some staff captured, some did not. Named people, so it
 *   is a thing to do rather than a statistic. It fires while the show is *on*,
 *   because the only moment this is fixable is the moment the person is still
 *   standing there; §5a's tense rule says the past-tense version goes to whoever
 *   runs the show and does not repeat.
 * - **`retention_overdue`** — personal data held past the date we said we would
 *   erase it. This is the only alert in the product that reports our own
 *   non-compliance rather than a supplier's, and it is `critical` from the first
 *   night. A retention promise nothing enforces is worse than no promise: it is
 *   a documented commitment being documented-ly broken.
 * - **`basis_unrecorded`** — leads held with no lawful basis. Warning, not
 *   critical: the rows are lawfully held for the follow-up the person started
 *   (see `consent.ts`), they simply cannot be marketed to, and the fix is
 *   somebody remembering what the booth actually said.
 *
 * **Dedupe keys carry a bucket, never a count.** §5b's shape rather than §5a's,
 * for the reason `assets/alerts.ts` gives about a quantity: a lead count moves
 * every time somebody scans a badge, so keying on it would raise a fresh alert
 * per scan all afternoon. The bucket is the *condition*, and the sentence under
 * a stable key is free to move — `alerts/store.ts` keeps the latest wording.
 */

export type LeadAlertReason =
  | 'no_capture'
  | 'thin_capture'
  | 'retention_overdue'
  | 'basis_unrecorded';

export type PlannedLeadAlert = {
  showId: string;
  /** Null when the show's runners are the audience — which is all four today. */
  userId: string | null;
  reason: LeadAlertReason;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  dedupeKey: string;
};

export type AlertableShow = {
  showId: string;
  showName: string;
  startsOn: Date;
  endsOn: Date;
  status: string;
  coverage: LeadCoverage;
};

/** How long after a show closes capture is still plausibly being caught up. */
export const CATCH_UP_DAYS = 5;

export function planLeadAlerts(shows: AlertableShow[], asOf: Date): PlannedLeadAlert[] {
  const out: PlannedLeadAlert[] = [];
  for (const show of shows) {
    out.push(...planForShow(show, asOf));
  }
  return out;
}

function planForShow(show: AlertableShow, asOf: Date): PlannedLeadAlert[] {
  const out: PlannedLeadAlert[] = [];
  const { coverage } = show;

  // Retention and basis are true whatever the calendar says. A show that ended
  // two years ago is exactly where an overdue erasure lives, so these are
  // deliberately not gated on the show being recent.
  if (coverage.retentionOverdue > 0) {
    out.push({
      showId: show.showId,
      userId: null,
      reason: 'retention_overdue',
      severity: 'critical',
      title: `${coverage.retentionOverdue} lead${
        coverage.retentionOverdue === 1 ? ' is' : 's are'
      } past the date we said we would erase them`,
      body:
        `${show.showName}. These rows still hold names, emails and phone numbers past their retention date. ` +
        'This is a commitment we made and are currently not keeping — run the retention sweep, or extend the ' +
        'date deliberately and record why.',
      dedupeKey: `lead:retention_overdue:${show.showId}`,
    });
  }

  if (coverage.basis.unknown > 0) {
    out.push({
      showId: show.showId,
      userId: null,
      reason: 'basis_unrecorded',
      severity: 'warning',
      title: `${coverage.basis.unknown} lead${
        coverage.basis.unknown === 1 ? '' : 's'
      } with no record of what the person was told`,
      body:
        `${show.showName}. They can be followed up on the conversation the person started, and they cannot be ` +
        'marketed to or pushed to a CRM until somebody records what was said at the booth. Nothing will guess it: ' +
        'a basis inferred from a blank column is not a basis.',
      dedupeKey: `lead:basis_unrecorded:${show.showId}`,
    });
  }

  const opened = hasOpened(show, asOf);
  const closedDaysAgo = (asOf.getTime() - show.endsOn.getTime()) / 86_400_000;
  if (!opened || show.status === 'cancelled') return out;

  // Still on, or just closed: the alert is a thing to do, and it is addressed to
  // the show's runners because the fix is a person walking to the booth.
  if (coverage.standing === 'none') {
    const past = closedDaysAgo > CATCH_UP_DAYS;
    out.push({
      showId: show.showId,
      userId: null,
      reason: 'no_capture',
      severity: past ? 'critical' : 'warning',
      title: past
        ? `${show.showName} ran with ${coverage.boothStaff} people on the booth and no leads recorded`
        : `No leads recorded yet at ${show.showName}`,
      body: past
        ? 'Nothing was captured, so this show has no return side at all — cost per lead cannot be computed, and ' +
          'a show with a real cost and no recorded leads is the one that gets cut over a number that was never true. ' +
          'Whatever was collected on paper or in a scanner vendor’s portal needs importing.'
        : `${coverage.boothStaff} people are rostered on booth shifts and none has recorded a lead. If badges are ` +
          'being scanned into a vendor portal, that is fine and the import can wait; if they are on paper, they ' +
          'stop being leads the moment somebody puts the notebook in a bag.',
      dedupeKey: `lead:no_capture:${show.showId}:${past ? 'after' : 'during'}`,
    });
    return out;
  }

  if (coverage.standing === 'partial' && closedDaysAgo <= CATCH_UP_DAYS) {
    const names = coverage.silent.map((s) => s.fullName).join(', ');
    out.push({
      showId: show.showId,
      userId: null,
      reason: 'thin_capture',
      severity: 'info',
      title: `${coverage.silent.length} of ${coverage.boothStaff} on the booth have recorded no leads at ${show.showName}`,
      body:
        `${names} ${coverage.silent.length === 1 ? 'has' : 'have'} captured nothing. This is the moment it is ` +
        'fixable — the count itself stays honest either way, because every figure derived from it says how many of ' +
        'the booth staff it came from.',
      // Bucketed by *how many* are silent, not by the lead count: the sentence
      // is worth repeating when another person goes quiet, and not when one more
      // badge is scanned.
      dedupeKey: `lead:thin_capture:${show.showId}:${coverage.silent.length}`,
    });
  }

  return out;
}
