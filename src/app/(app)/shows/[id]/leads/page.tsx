import { getActor } from '@/lib/auth/actor';
import { getLeadBoard } from '@/lib/leads/store';
import { getTargetBoard } from '@/lib/dayof/store';
import { canManageTargets } from '@/lib/dayof/access';
import { canEditLead } from '@/lib/leads/access';
import { summarizeTargets } from '@/lib/dayof/targets';
import { mayQuotePerLead } from '@/lib/leads/coverage';
import { Badge, Card, Empty, Table, Td, Th, showDate, showDateTime } from '../../../_components/ui';
import {
  BasisBadge,
  CoverageHeadline,
  CoverageNotes,
  OutboundBadge,
  RetentionBadge,
} from '../../../leads/_present';
import { plural } from '../../../_components/text';
import { loadShow } from '../detail';
import {
  CaptureForm,
  DuplicateForm,
  EditLeadForm,
  EraseForm,
  ImportForm,
  MeetingForm,
  RemoveTargetForm,
  RetentionButton,
  TargetForm,
  UndoDuplicateForm,
} from './forms';

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
  const [board, targetBoard] = await Promise.all([
    getLeadBoard(actor, id),
    getTargetBoard(actor, id),
  ]);
  const targetSummary = summarizeTargets(targetBoard.standings);
  const mayEditTargets = canManageTargets(actor);
  const { show } = detail;
  const { coverage, leads, meetings, imports, people, possiblePairs, may } = board;
  const perLead = mayQuotePerLead(coverage);
  const linkable = leads.filter((l) => !l.redactedAt && !l.restricted);

  return (
    <div className="space-y-6">

      {/* Adding a lead, first and on its own.

          This was the bottom of a card titled "Capture" whose first 130 words
          were the count, its coverage notes and the cost-per-lead refusal — so
          the only control on the tab for the act the tab is named after sat
          under six lines of reporting, and a reader looking for "add a lead"
          found a report. Reported by a user who could add a *target account* and
          concluded there was no way to add a lead.

          One card was doing two jobs and the reporting half was winning. The
          count is a report and keeps its own card, next to the list it counts.
          `UI-REWORK.md` §14's rule about page copy has a layout half: a card is
          named for what somebody does in it. */}
      {may.capture && (
        <Card id="add-lead" title="Add a lead">
          <CaptureForm showId={id} />
        </Card>
      )}

      {/* Who we came for. Above the lead list rather than below it, because the
          list answers "who did we meet" and this answers "who did we not" — and
          the second is the one nobody goes looking for. Reading it is
          everybody's; editing it is an approver's, because adding a must-meet
          moves the denominator of every figure it will ever produce. */}
      <Card title="Target accounts" subtitle={targetSummary.sentence}>
        {targetBoard.standings.length === 0 ? (
          <Empty>
            Add the companies this show is for, and the booth team will be told when one of them
            walks up — including on the Day of screen, which works with no signal.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Priority</Th>
                <Th>Owner</Th>
                <Th>Met</Th>
                {mayEditTargets && <Th />}
              </tr>
            </thead>
            <tbody>
              {targetBoard.standings.map((t) => (
                <tr key={t.target.id}>
                  <Td>
                    <span className="font-medium">{t.target.companyName}</span>
                    {t.target.reason && (
                      <span className="block text-xs text-text-muted">{t.target.reason}</span>
                    )}
                    {t.target.aliases.length > 0 && (
                      <span className="block text-xs text-text-muted">
                        also {t.target.aliases.join(', ')}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={t.target.priority === 'must_meet' ? 'bad' : 'neutral'}>
                      {t.target.priority.replace('_', ' ')}
                    </Badge>
                  </Td>
                  <Td>
                    {t.target.ownerName ?? (
                      <span className={t.unowned ? 'text-warn' : 'text-text-muted'}>unowned</span>
                    )}
                  </Td>
                  <Td>
                    {t.met ? (
                      <>
                        <Badge tone="good">met</Badge>
                        <span className="ml-2 text-xs text-text-muted">
                          {t.leads[0].fullName}
                          {t.leads.length > 1 && ` +${t.leads.length - 1}`}
                        </span>
                      </>
                    ) : (
                      <span className="text-text-muted">not yet</span>
                    )}
                  </Td>
                  {mayEditTargets && (
                    <Td>
                      <RemoveTargetForm showId={id} targetId={t.target.id} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {mayEditTargets && <TargetForm showId={id} people={targetBoard.people} />}
      </Card>
      <Card title="Lead count">
        <CoverageHeadline coverage={coverage} />
        <CoverageNotes coverage={coverage} />
        {!perLead.ok && coverage.standing !== 'not_yet' && (
          <p className="mt-2 text-sm text-text-muted">
            <span className="font-medium">Cost per lead is not shown yet.</span> {perLead.reason}
          </p>
        )}
      </Card>

      {may.manage && possiblePairs.length > 0 && (
        <Card title="Might be the same person">
          <p className="text-sm text-text-muted">
            These have the same name and company, so they may be one person captured twice — or
            two people who happen to share a name. Nothing is merged automatically; somebody who
            was there has to say. Marking a pair deletes nothing: the second lead is kept and its
            follow-up still works, it just stops being counted twice.
          </p>
          <ul className="mt-3 space-y-3">
            {possiblePairs.map((pair) => (
              <li key={`${pair.keep.id}-${pair.other.id}`} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{pair.keep.fullName}</span>
                  {pair.company && <span className="text-text-muted">{pair.company}</span>}
                  <span className="text-xs text-text-muted">
                    first {showDate(pair.keep.capturedAt, show.timezone)}
                    {pair.keep.capturedByName && ` · ${pair.keep.capturedByName}`}
                    {' · again '}
                    {showDate(pair.other.capturedAt, show.timezone)}
                    {pair.other.capturedByName && ` · ${pair.other.capturedByName}`}
                  </span>
                </div>
                <div className="mt-1">
                  <DuplicateForm showId={id} leadId={pair.other.id} ofLeadId={pair.keep.id} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

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
                <Th>Consent</Th>
                <Th>Erase by</Th>
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
                    {!lead.redactedAt && (
                      <div className="mt-1">
                        <OutboundBadge outbound={lead.outbound} />
                      </div>
                    )}
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
                    {lead.duplicateOfId && (
                      <div className="mb-1">
                        <span className="text-xs text-text-muted">not counted — duplicate</span>
                        {may.manage && <UndoDuplicateForm showId={id} leadId={lead.id} />}
                      </div>
                    )}
                    {/* Editing needs the same reach as reading, which `restricted`
                        already carries — but it is asked directly rather than
                        inferred from it, because two definitions that happen to
                        agree today are one refactor away from a control that
                        edits a row it cannot show. */}
                    {canEditLead(actor, lead.capturedById) && !lead.redactedAt && (
                      <details className="mb-1">
                        <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
                          Edit
                        </summary>
                        <EditLeadForm showId={id} lead={{ ...lead, basis: lead.basis }} />
                      </details>
                    )}
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
                ? `${plural(coverage.retentionOverdue, 'lead is', 'leads are')} past the date we said we would erase their details.`
                : `${plural(coverage.retentionDueSoon, 'lead is', 'leads are')} due to be erased soon.`}{' '}
              Erasing removes the name, email, phone and notes, and keeps the lead itself — so
              this show’s lead count and every figure built on it stay exactly where they are.
            </p>
            <RetentionButton showId={id} />
          </div>
        )}
      </Card>

      <Card title="Meetings">
        {meetings.length === 0 ? (
          <Empty>
            No meetings recorded. A meeting is booked, held, or a no-show, and the three are
            counted separately.
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
            Upload a scanner export and you will be shown which column becomes which field, and
            what will happen to every row, before anything is imported. Each row is either imported,
            rejected with a reason, or already here — nothing is skipped quietly.
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
                  {/* The mapping this import actually used. Kept and shown because
                      "why is every company blank" has no other answer, and a batch
                      record that stored it without ever displaying it would only
                      look like one. */}
                  {batch.mapping && (
                    <p className="mt-0.5 text-xs text-text-muted">
                      {Object.entries(batch.mapping)
                        .map(([header, field]) => `${header} → ${field ?? 'not imported'}`)
                        .join(' · ')}
                    </p>
                  )}
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
