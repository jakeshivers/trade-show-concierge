import { getActor } from '@/lib/auth/actor';
import { getLeadBoard } from '@/lib/leads/store';
import { mayQuotePerLead } from '@/lib/leads/coverage';
import { Badge, Card, Empty, Table, Td, Th, showDate, showDateTime } from '../../../_components/ui';
import { BasisBadge, CoverageHeadline, CoverageNotes, RetentionBadge } from '../../../leads/_present';
import { loadShow } from '../detail';
import { CaptureForm, EraseForm, ImportForm, MeetingForm, RetentionButton } from './forms';

/**
 * Leads & meetings — the return side of §8, and the eighth tab.
 *
 * It leads with what is *missing* rather than with the number, which is now the
 * sixth screen in this product to do so and the one where it matters most. §8c
 * says the lead count is the weakest link in the whole ROI story and that a
 * confidently wrong cost-per-lead gets a working show cut. So the count is never
 * rendered bare: `coverage.ts` computes one sentence — "at least 6 leads, from 2
 * of 4 people on the booth" — and both this tab and the portfolio print it.
 *
 * Cost per lead is deliberately absent here rather than shown with a caveat.
 * §19 owns that figure; what step 18 owes it is a denominator that says what it
 * is missing, and the refusal is stated on the page so nobody goes looking for
 * the number on a different screen.
 *
 * A Member sees every lead — the count is nobody's private business — and reads
 * the personal detail only of the ones they captured. The narrowing is in the
 * query, not in this markup.
 */
export default async function LeadsTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ detail }, actor] = await Promise.all([loadShow(id), getActor()]);
  const board = await getLeadBoard(actor, id);
  const { show } = detail;
  const { coverage, leads, meetings, imports, people, may } = board;
  const perLead = mayQuotePerLead(coverage);
  const linkable = leads.filter((l) => !l.redactedAt && !l.restricted);

  return (
    <div className="space-y-6">
      <Card title="Capture">
        <CoverageHeadline coverage={coverage} />
        <CoverageNotes coverage={coverage} />
        {!perLead.ok && coverage.standing !== 'not_yet' && (
          <p className="mt-2 text-sm text-text-muted">
            <span className="font-medium">Cost per lead is withheld.</span> {perLead.reason}
          </p>
        )}
        {may.capture && <CaptureForm showId={id} />}
      </Card>

      <Card title="Leads">
        {leads.length === 0 ? (
          <Empty>
            Nothing captured. Leads arrive three ways: typed above, imported from a scanner
            vendor’s CSV below, or posted to the intake endpoint by a scanner itself — an admin
            issues a key for that in Settings → Lead intake.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Captured by</Th>
                <Th>Basis</Th>
                <Th>Retention</Th>
                <Th>{may.redact ? '' : ''}</Th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-border">
                  <Td>
                    <span className={lead.redactedAt || lead.restricted ? 'text-text-muted' : ''}>
                      {lead.fullName}
                    </span>
                    {lead.restricted && (
                      <span className="ml-2 text-xs text-text-muted">
                        captured by somebody else
                      </span>
                    )}
                    {lead.email && <div className="text-xs text-text-muted">{lead.email}</div>}
                    {lead.title && <div className="text-xs text-text-muted">{lead.title}</div>}
                  </Td>
                  <Td>{lead.company ?? '—'}</Td>
                  <Td>
                    <div>{lead.capturedByName ?? <span className="text-text-muted">imported</span>}</div>
                    <div className="text-xs text-text-muted">
                      {lead.source} · {showDate(lead.capturedAt, show.timezone)}
                    </div>
                  </Td>
                  <Td>
                    <BasisBadge basis={lead.basis} />
                  </Td>
                  <Td>
                    <RetentionBadge standing={lead.retention} />
                    {lead.retention === 'live' && (
                      <span className="text-xs text-text-muted">
                        {showDate(lead.deleteAfter, show.timezone)}
                      </span>
                    )}
                    {lead.redactionReason && (
                      <div className="text-xs text-text-muted">{lead.redactionReason}</div>
                    )}
                  </Td>
                  <Td>
                    {may.redact && !lead.redactedAt && <EraseForm showId={id} leadId={lead.id} />}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {may.redact && (coverage.retentionOverdue > 0 || coverage.retentionDueSoon > 0) && (
          <div className="mt-4 space-y-2 rounded-md bg-muted p-3">
            <p className="text-sm">
              {coverage.retentionOverdue > 0
                ? `${coverage.retentionOverdue} lead(s) here are past the date we said we would erase them.`
                : `${coverage.retentionDueSoon} lead(s) here are due for erasure soon.`}{' '}
              Erasure nulls the name, email, phone and notes and keeps the row, so every count and
              every ROI figure this show has produced stays exactly where it was.
            </p>
            <RetentionButton showId={id} />
          </div>
        )}
      </Card>

      <Card title="Meetings">
        {meetings.length === 0 ? (
          <Empty>
            No meetings recorded. A meeting is booked, held, or a no-show — the third is counted
            separately, because a meeting nobody came to is not a meeting held.
          </Empty>
        ) : (
          <ul className="space-y-2">
            {meetings.map((m) => (
              <li key={m.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <Badge tone={m.occurredAt ? 'good' : m.noShowAt ? 'bad' : 'info'}>
                  {m.occurredAt ? 'held' : m.noShowAt ? 'no-show' : 'booked'}
                </Badge>
                <span className="font-medium">{m.subject}</span>
                {m.company && <span className="text-text-muted">{m.company}</span>}
                {m.isExistingCustomer && <Badge tone="neutral">existing customer</Badge>}
                <span className="ml-auto text-xs text-text-muted">
                  {showDateTime(m.occurredAt ?? m.noShowAt ?? m.scheduledAt, show.timezone)}
                  {m.ownerName && ` · ${m.ownerName}`}
                </span>
                {m.notes && <p className="w-full text-xs text-text-muted">{m.notes}</p>}
              </li>
            ))}
          </ul>
        )}
        <MeetingForm showId={id} people={people} leads={linkable} />
      </Card>

      {may.manage && (
        <Card title="Import a scanner CSV">
          <p className="text-sm text-text-muted">
            Every row read lands in exactly one of accepted, rejected or already-here, and the three
            add up to the row count — an import that quietly skipped a malformed row would report a
            smaller number with the same confidence as a correct one. The column mapping is proposed
            and confirmed, never applied silently.
          </p>
          <ImportForm showId={id} />

          {imports.length > 0 && (
            <ul className="mt-4 space-y-3 border-t border-border pt-3">
              {imports.map((batch) => (
                <li key={batch.id} className="text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{batch.filename ?? 'Untitled file'}</span>
                    <span className="text-text-muted">
                      {batch.rowsRead} read · {batch.accepted} imported · {batch.rejected} rejected ·{' '}
                      {batch.duplicates} already here
                    </span>
                    <span className="ml-auto text-xs text-text-muted">
                      {showDateTime(batch.createdAt, show.timezone)}
                      {batch.importedByName && ` · ${batch.importedByName}`}
                    </span>
                  </div>
                  {batch.notes && <p className="text-xs text-warn">{batch.notes}</p>}
                  {batch.problems.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
                      {batch.problems.map((p) => (
                        <li key={`${p.row}-${p.reason}`}>
                          row {p.row}: {p.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
