import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getLeadPortfolio } from '@/lib/leads/store';
import { mayQuotePerLead } from '@/lib/leads/coverage';
import { Card, Empty, PageHeader, Stat, showDate } from '../_components/ui';
import { GoToShow } from '../_components/go-to-show';
import { plural } from '../_components/text';
import { CoverageHeadline, CoverageNotes } from './_present';

/**
 * Lead capture across the calendar, most recent show first. SCOPE.md §8c.
 *
 * The ordering inverts the one the other three boards use, and the inversion is
 * the point. Flights, freight and assets are prospective — they list obligations
 * and the soonest is the most urgent. Capture is **retrospective**: a lead count
 * is a fact about a show that already happened, so the nearest thing to now is
 * the show that just ended and the clock runs backwards from there. A show that
 * has not opened sorts after all of them, because it recorded nothing for want
 * of anything to record, which is not a finding.
 *
 * What this page is careful *not* to show is a total. "412 leads this year" over
 * a set of shows whose coverage ranges from complete to unmeasured is the
 * confidently-wrong number §8c warns about, assembled from six honest ones. So
 * the counts stay per show, each with the sentence that qualifies it, and the
 * one aggregate figure on the page is how many of them are floors.
 */
export default async function LeadsPage() {
  const actor = await getActor();
  const rows = await getLeadPortfolio(actor);
  const floors = rows.filter((r) => r.coverage.isFloor).length;
  const overdue = rows.reduce((n, r) => n + r.coverage.retentionOverdue, 0);
  const unrecordedBasis = rows.reduce((n, r) => n + r.coverage.basis.unknown, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        blurb="Every show’s leads, most recent first. Each count says how complete it is."
        action={
          <GoToShow
            actor={actor}
            tab="leads"
            hash="add-lead"
            label="Capture a lead"
            hint={
              <>
                Opens the form on that show’s Leads tab, where the CSV import and erasure also
                live. At the booth, use <strong>Day of</strong> — it keeps working with no signal.
              </>
            }
          />
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Shows with an incomplete count" value={String(floors)} />
        <Stat label="Leads with no consent record" value={String(unrecordedBasis)} />
        <Stat label="Leads past their erase date" value={String(overdue)} />
      </div>

      {rows.length === 0 ? (
        <Empty>
          No shows to count leads against yet. Leads are captured on a show — at the booth on the
          day-of screen, typed on its Leads tab, imported from a scanner export, or posted by a
          badge scanner through an intake key.
        </Empty>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => {
            const perLead = mayQuotePerLead(row.coverage);
            return (
              <Card key={row.showId}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <Link href={`/shows/${row.showId}/leads`} className="font-medium hover:underline">
                    {row.showName}
                  </Link>
                  <span className="text-xs text-text-muted">
                    {showDate(row.startsOn, row.timezone)} · {row.status}
                  </span>
                  <span className="ml-auto text-xs text-text-muted">
                    {row.meetingsHeld + row.meetingsBooked + row.meetingsNoShow === 0
                      ? 'No meetings'
                      : `${plural(row.meetingsHeld, 'meeting', 'meetings')} held · ` +
                        `${row.meetingsBooked} booked · ${row.meetingsNoShow} no-show`}
                  </span>
                </div>
                <div className="mt-2">
                  <CoverageHeadline coverage={row.coverage} />
                  <CoverageNotes coverage={row.coverage} />
                  {!perLead.ok && row.coverage.standing !== 'not_yet' && (
                    <p className="mt-2 text-sm text-text-muted">
                      <span className="font-medium">Cost per lead is not shown yet.</span>{' '}
                      {perLead.reason}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
