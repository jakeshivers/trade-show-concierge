import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { getActor } from '@/lib/auth/actor';
import { getAuditTrail } from '@/lib/travel/audit';
import { loadRequest, NotFoundError } from '@/lib/travel/queue';
import { selectProviderOrNull } from '@/lib/travel/provider';
import {
  availableActions,
  can,
  preferencePremium,
  STATUS,
  type ReviewableRequest,
} from '@/lib/travel/review';
import { Badge, Card, Empty, Row, money, moneyExact, type Tone } from '../../_components/ui';
import { Fare, StatusBadge } from '../_components';
import { Decide, Confirm, Cancel, Search } from './forms';

/**
 * One travel request, and the whole of why it is where it is.
 *
 * This is `pnpm booking:audit` as a page. The assembly was already written and
 * is deliberately not re-done here — `getAuditTrail` is read-only by
 * construction and returns exactly this shape, which is what step 4's comment
 * promised it would be used for. Only the markup is new.
 *
 * The load is two calls on purpose: `loadRequest` is org-scoped and
 * visibility-narrowed, and `getAuditTrail` takes a bare id with no scoping of
 * its own. Doing the authorized load first is what keeps the second one safe.
 */
export default async function TravelRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();

  let loaded;
  try {
    loaded = await loadRequest(actor, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { request, snapshot, standing } = loaded;
  const trail = await getAuditTrail(request.id, getDb());
  const provider = selectProviderOrNull();

  const reviewable: ReviewableRequest = {
    status: request.status,
    requesterId: request.requesterId,
    travelerId: request.travelerId,
    rawRequestText: request.rawRequestText,
    constraintsConfirmedAt: request.constraintsConfirmedAt,
  };
  const actions = availableActions(actor, reviewable);
  const presentation = STATUS[request.status];

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {request.originAirport} &rarr; {request.destinationAirport}
          </h1>
          <StatusBadge status={request.status} />
        </div>
        <p className="mt-1 text-sm text-text-muted">{presentation.meaning}</p>
        <p className="mt-1 text-xs text-text-muted">
          {trail.traveler?.fullName ?? 'Unknown traveler'}
          {trail.requester && trail.requester.id !== trail.traveler?.id && (
            <> · opened by {trail.requester.fullName}</>
          )}
          {' · '}
          <Link href="/travel" className="underline">
            all my travel
          </Link>
        </p>
      </header>

      {/* ---------------------------- what happens next --------------------------- */}
      <Card title="Decide">
        {request.status === 'pending_approval' && standing && (
          <div className="mb-4 rounded-md bg-warn-soft px-3 py-2.5 text-sm">
            <p className="flex flex-wrap items-baseline gap-x-2 font-medium">
              Approving authorizes{' '}
              <Fare cents={snapshot?.totalCents ?? null} standing={standing} />{' '}
              {standing.bookableAtShownPrice ? 'as the fare.' : 'as a ceiling.'}
            </p>
            <p className="mt-1 text-xs text-text">{standing.meaning}</p>
            {standing.goodUntil && (
              <p className="mt-1 text-xs text-text-muted">
                Good until {standing.goodUntil.toLocaleString()}.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-6">
          {can(actions, 'confirm_constraints') && <Confirm requestId={request.id} />}
          {can(actions, 'search') && (
            <Search
              requestId={request.id}
              disabled={'unavailable' in provider}
              disabledReason={'unavailable' in provider ? provider.unavailable : undefined}
            />
          )}
          {can(actions, 'approve') && (
            <Decide
              requestId={request.id}
              amountCents={snapshot?.totalCents ?? null}
              needsBreakGlass={request.requesterId === actor.userId}
            />
          )}
          {can(actions, 'cancel') && (
            <Cancel requestId={request.id} ticketed={request.status === 'ticketed'} />
          )}
        </div>

        {/* Refusals are shown, not hidden. A missing button reads as a bug. */}
        <ul className="mt-4 space-y-1 text-xs text-text-muted">
          {actions
            .filter((a) => !a.available && a.reason && a.action !== 'confirm_constraints')
            .map((a) => (
              <li key={a.action}>
                <span className="font-medium capitalize">{a.action.replace('_', ' ')}</span>:{' '}
                {a.reason}
              </li>
            ))}
        </ul>
      </Card>

      {/* ------------------------------- the request ------------------------------ */}
      <Card title="What was asked for">
        <Row label="Window out">
          {request.earliestDeparture.toLocaleString()} &rarr;{' '}
          {request.latestArrival.toLocaleString()}
        </Row>
        {request.returnEarliestDeparture && (
          <Row label="Window back">
            {request.returnEarliestDeparture.toLocaleString()} &rarr;{' '}
            {request.returnLatestArrival?.toLocaleString() ?? '—'}
          </Row>
        )}
        <Row label="Cabin preference">{request.cabinPreference ?? 'none'}</Row>
        <Row label="Cost center">
          {request.costCenterId ? <code className="text-xs">{request.costCenterId}</code> : '—'}
        </Row>
        <Row label="Idempotency key">
          <code className="text-xs">{request.idempotencyKey}</code>
        </Row>
        {request.rawRequestText && (
          <Row label="As typed">
            <span className="italic">&ldquo;{request.rawRequestText}&rdquo;</span>{' '}
            {request.constraintsConfirmedAt ? (
              <Badge tone="good">confirmed</Badge>
            ) : (
              <Badge tone="warn">unconfirmed — nothing will be searched</Badge>
            )}
          </Row>
        )}
        {request.notes && <Row label="Notes">{request.notes}</Row>}
      </Card>

      {/* -------------------------------- the offers ------------------------------ */}
      <Card title={`Offers seen (${trail.searches.length} search${trail.searches.length === 1 ? '' : 'es'})`}>
        {trail.searches.length === 0 ? (
          <Empty>
            Nothing has been searched yet. The offers the agent sees are recorded here — including
            the ones it rejected, which is the only way &ldquo;why not the cheaper one?&rdquo; stays
            answerable after they expire.
          </Empty>
        ) : (
          <div className="space-y-5">
            {trail.searches.map((s, i) => {
              // The column appears only when something in *this* search actually
              // earned a preference. A workspace that has never priced one would
              // otherwise carry an empty column on every request forever, and a
              // column that is blank a hundred times is one nobody reads on the
              // hundred-and-first.
              const anyPreference = s.offers.some((o) => o.preference.totalCents > 0);
              const premium = preferencePremium(s.offers);
              return (
              <div key={s.searchId ?? i}>
                <div className="mb-2 text-xs text-text-muted">
                  Search {i + 1} of {trail.searches.length} · {s.capturedAt.toLocaleString()} ·{' '}
                  <code>{s.searchId}</code>
                  {i > 0 && (
                    <span className="ml-2 text-warn">
                      the agent looked again — the earlier offer had died
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-text-muted">
                      <tr>
                        <th className="py-1 pr-3 font-medium">#</th>
                        <th className="py-1 pr-3 font-medium">Fare</th>
                        <th className="py-1 pr-3 font-medium">Cabin</th>
                        <th className="py-1 pr-3 font-medium">Stops</th>
                        <th className="py-1 pr-3 font-medium">Verdict</th>
                        {anyPreference && (
                          <th className="py-1 pr-3 font-medium">Preference</th>
                        )}
                        <th className="py-1 font-medium">Why not</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.offers.map((o) => (
                        <tr
                          key={o.offerId}
                          className={`border-t border-border ${ o.selected ? 'font-medium' : 'text-text-muted' }`}
                        >
                          <td className="py-1.5 pr-3">{o.rank ?? '—'}</td>
                          <td className="py-1.5 pr-3">
                            {money(o.totalCents)} {o.selected && <Badge tone="info">chosen</Badge>}
                          </td>
                          <td className="py-1.5 pr-3">{o.cabin ?? '—'}</td>
                          <td className="py-1.5 pr-3">{o.stops ?? '—'}</td>
                          <td className="py-1.5 pr-3">
                            {o.decision ? (
                              <Badge tone={DECISION_TONE[o.decision] ?? 'neutral'}>
                                {o.decision.replace('_', ' ')}
                              </Badge>
                            ) : (
                              '—'
                            )}
                          </td>
                          {anyPreference && (
                            <td className="py-1.5 pr-3">
                              {o.preference.totalCents > 0 ? (
                                <span className="whitespace-nowrap">
                                  {o.preference.orgCents > 0 && (
                                    <span className="block">
                                      &minus;{moneyExact(o.preference.orgCents)} company
                                    </span>
                                  )}
                                  {o.preference.travelerCents > 0 && (
                                    <span className="block">
                                      &minus;{moneyExact(o.preference.travelerCents)} traveler
                                    </span>
                                  )}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                          )}
                          <td className="py-1.5">
                            {o.blockers.length > 0 ? o.blockers.join(', ') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/*
                  The money question, in one sentence, under the table that
                  raised it. "Why not the cheaper one" is what this whole card
                  exists to answer, and a carrier preference is now one of the
                  answers — but only when it *cost* something, and only measured
                  against a fare the policy would really have allowed. Both of
                  those refusals live in `preferencePremium`.
                */}
                {premium && (
                  <p className="mt-2 rounded-md bg-surface-muted px-3 py-2 text-xs text-text-muted">
                    The chosen fare is{' '}
                    <strong>{moneyExact(premium.premiumCents)} more</strong> than the cheapest one
                    the policy allowed ({moneyExact(premium.cheapestAllowedCents)}). Carrier
                    preference covered it:{' '}
                    {[
                      premium.orgAllowanceCents > 0 &&
                        `up to ${moneyExact(premium.orgAllowanceCents)} for a carrier the company prefers`,
                      premium.travelerAllowanceCents > 0 &&
                        `up to ${moneyExact(premium.travelerAllowanceCents)} for one the traveler prefers`,
                    ]
                      .filter(Boolean)
                      .join(', and ')}
                    . Those are ceilings the travel policy sets, not amounts spent — the agent
                    pays the difference and no more, and a preference can never move a fare past
                    one that needs approval.
                  </p>
                )}
              </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ------------------------------- the decisions ---------------------------- */}
      {trail.approvals.length > 0 && (
        <Card title="Approvals">
          <ul className="space-y-2">
            {trail.approvals.map((a) => (
              <li key={a.id} className="border-b border-border pb-2 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <Badge tone={a.outcome === 'rejected' ? 'bad' : a.outcome === 'break_glass' ? 'warn' : 'good'}>
                    {a.outcome.replace('_', ' ')}
                  </Badge>
                  <span className="text-sm">
                    up to {money(a.priceAtApprovalCents)}
                  </span>
                  <span className="ml-auto text-xs text-text-muted">
                    {a.decidedAt.toLocaleString()}
                  </span>
                </div>
                {a.reason && <p className="mt-1 text-xs text-text-muted">{a.reason}</p>}
                {a.reSearchedOnApproval && (
                  <p className="mt-1 text-xs text-warn">
                    The offer had expired when this was approved, so the agent re-searched and held
                    the result to this amount.
                  </p>
                )}
                {a.breakGlassJustification && (
                  <p className="mt-1 text-xs text-warn">
                    Break-glass: no eligible approver existed. &ldquo;
                    {a.breakGlassJustification}&rdquo;
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* -------------------------------- the booking ----------------------------- */}
      {trail.booking && (
        <Card title="Booking">
          <Row label="Order">
            <code className="text-xs">{trail.booking.providerOrderId}</code>{' '}
            {!trail.booking.live && (
              <Badge tone="info">
                not live — {trail.booking.providerOrderId.startsWith('dryrun:')
                  ? 'dry run, no money moved'
                  : 'the provider reports this is not live-mode spend'}
              </Badge>
            )}
          </Row>
          <Row label="Reference">{trail.booking.bookingReference ?? '—'}</Row>
          <Row label="Charged">{money(trail.booking.chargedCents)}</Row>
          {(trail.booking.creditAppliedCents ?? 0) > 0 && (
            <Row label="Paid by credit">{money(trail.booking.creditAppliedCents)}</Row>
          )}
          <Row label="Tickets">{trail.booking.ticketNumbers?.join(', ') || '—'}</Row>
          {trail.booking.isHold && (
            <Row label="Hold">
              pay by {trail.booking.payBy?.toLocaleString() ?? '—'} ·{' '}
              {trail.booking.priceGuaranteedUntil
                ? `fare guaranteed until ${trail.booking.priceGuaranteedUntil.toLocaleString()}`
                : 'fare NOT guaranteed'}
            </Row>
          )}
        </Card>
      )}

      {trail.creditEntries.length > 0 && (
        <Card title="Ticket credit movements">
          <ul className="space-y-1 text-xs">
            {trail.creditEntries.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span>{e.reason}</span>
                <span className={e.deltaCents < 0 ? 'text-bad' : 'text-good'}>
                  {e.deltaCents < 0 ? '' : '+'}
                  {money(e.deltaCents)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* -------------------------------- the timeline ---------------------------- */}
      <Card title="Timeline">
        <ol className="space-y-2">
          {trail.timeline.map((t) => (
            <li key={t.id} className="flex flex-wrap gap-x-3 border-b border-border py-1.5 last:border-0">
              <span className="w-10 shrink-0 text-xs text-text-muted">{t.sequence}</span>
              <span className="w-32 shrink-0 text-xs text-text-muted">
                {t.fromStatus ? `${t.fromStatus} → ${t.toStatus ?? '·'}` : (t.toStatus ?? t.step)}
              </span>
              <span className="min-w-0 flex-1 text-sm">{t.summary}</span>
              <span className="text-xs text-text-muted">{t.occurredAt.toLocaleTimeString()}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-text-muted">
          Ordered by sequence, not by clock: the agent&rsquo;s clock is injected so the pipeline is
          reproducible, which means several steps of one run legitimately share an instant.
        </p>
      </Card>

      {trail.notifications.length > 0 && (
        <Card title="Who was told">
          <ul className="space-y-1 text-xs">
            {trail.notifications.map((n) => (
              <li key={n.id}>
                {n.title} — {n.body}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const DECISION_TONE: Record<string, Tone> = {
  auto_approve: 'good',
  needs_approval: 'warn',
  deny: 'bad',
};
