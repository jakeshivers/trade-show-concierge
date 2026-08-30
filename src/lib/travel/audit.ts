import { asc, eq, or } from 'drizzle-orm';
import type { getDb } from '@/db';
import * as s from '@/db/schema';

/**
 * The audit trail, assembled and made readable. SCOPE.md §6c rail 3.
 *
 * The rows have existed since step 4 — every decision, every offer seen, every
 * verdict. What was missing is the part that makes an audit record an audit
 * record rather than a pile of tables: one call that puts them in order and
 * answers the question people actually ask, which is never "what is in
 * agent_runs" but "why did this cost $612, and who said it could?"
 *
 * Ordering comes from `agent_runs.sequence`, not from timestamps: the clock is
 * injected so the pipeline is reproducible, which means several steps of one run
 * legitimately share an instant.
 *
 * Read-only by construction — it assembles, it never writes. That matters
 * because the audit trail is the one thing in this system that must not be
 * mutable by the code that reads it.
 */

type Db = ReturnType<typeof getDb>;

export type AuditOffer = {
  rank: number | null;
  offerId: string;
  provider: string;
  totalCents: number;
  currency: string;
  stops: number | null;
  cabin: string | null;
  selected: boolean;
  expiresAt: Date;
  decision: string | null;
  blockers: string[];
  policyId: string | null;
  policyVersion: number | null;
};

export type AuditTrail = {
  request: typeof s.travelRequests.$inferSelect;
  traveler: { id: string; email: string; fullName: string } | null;
  requester: { id: string; email: string; fullName: string } | null;
  /** Newest search first — an expired-and-re-priced request has more than one. */
  searches: { searchId: string | null; capturedAt: Date; offers: AuditOffer[] }[];
  approvals: (typeof s.approvals.$inferSelect)[];
  booking: typeof s.bookings.$inferSelect | null;
  /** Credit movements this booking caused. Empty on a dry run, which burns none. */
  creditEntries: (typeof s.ticketCreditEntries.$inferSelect)[];
  timeline: (typeof s.agentRuns.$inferSelect)[];
  notifications: (typeof s.alerts.$inferSelect)[];
  /** The layered rule set the last verdict was made against. */
  resolvedPolicy: unknown;
};

export async function getAuditTrail(requestId: string, db: Db): Promise<AuditTrail> {
  const request = await db.query.travelRequests.findFirst({
    where: eq(s.travelRequests.id, requestId),
  });
  if (!request) throw new Error(`Travel request ${requestId} not found`);

  const people = await db
    .select({ id: s.users.id, email: s.users.email, fullName: s.users.fullName })
    .from(s.users)
    .where(or(eq(s.users.id, request.travelerId), eq(s.users.id, request.requesterId)));
  const person = (id: string) => people.find((p) => p.id === id) ?? null;

  const offerRows = await db
    .select({
      snapshot: s.offerSnapshots,
      evaluation: s.policyEvaluations,
    })
    .from(s.offerSnapshots)
    .leftJoin(
      s.policyEvaluations,
      eq(s.policyEvaluations.offerSnapshotId, s.offerSnapshots.id),
    )
    .where(eq(s.offerSnapshots.travelRequestId, requestId))
    .orderBy(asc(s.offerSnapshots.capturedAt), asc(s.offerSnapshots.rank));

  // Grouped by search, because "the agent looked again" is the single most
  // confusing thing in one of these trails and flattening the offers hides it.
  const searches: AuditTrail['searches'] = [];
  for (const { snapshot, evaluation } of offerRows) {
    const key = snapshot.providerSearchId;
    let group = searches.find((g) => g.searchId === key);
    if (!group) {
      group = { searchId: key, capturedAt: snapshot.capturedAt, offers: [] };
      searches.push(group);
    }
    group.offers.push({
      rank: snapshot.rank,
      offerId: snapshot.providerOfferId,
      provider: snapshot.provider,
      totalCents: snapshot.totalCents,
      currency: snapshot.currency,
      stops: snapshot.maxStops,
      cabin: snapshot.highestCabin,
      selected: snapshot.selected,
      expiresAt: snapshot.offerExpiresAt,
      decision: evaluation?.decision ?? null,
      blockers: evaluation?.blockerRuleIds ?? [],
      policyId: evaluation?.policyId ?? null,
      policyVersion: evaluation?.policyVersion ?? null,
    });
  }

  const booking = await db.query.bookings.findFirst({
    where: eq(s.bookings.travelRequestId, requestId),
  });

  return {
    request,
    traveler: person(request.travelerId),
    requester: person(request.requesterId),
    searches,
    approvals: await db
      .select()
      .from(s.approvals)
      .where(eq(s.approvals.travelRequestId, requestId))
      .orderBy(asc(s.approvals.decidedAt)),
    booking: booking ?? null,
    // What the booking did to the credit ledger. A purchase that quietly spent
    // $184 of credit is a fact about this request, and the audit is the place a
    // person goes to find it.
    creditEntries: booking
      ? await db
          .select()
          .from(s.ticketCreditEntries)
          .where(eq(s.ticketCreditEntries.bookingId, booking.id))
          .orderBy(asc(s.ticketCreditEntries.occurredAt))
      : [],
    timeline: await db
      .select()
      .from(s.agentRuns)
      .where(eq(s.agentRuns.travelRequestId, requestId))
      .orderBy(asc(s.agentRuns.sequence)),
    notifications: booking
      ? await db
          .select()
          .from(s.alerts)
          .where(eq(s.alerts.orgId, request.orgId))
          .then((rows) => rows.filter((a) => a.dedupeKey.startsWith(`booking:${booking.id}:`)))
      : [],
    resolvedPolicy: offerRows.at(-1)?.evaluation?.resolvedPolicy ?? null,
  };
}

const usd = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const when = (d: Date | null | undefined) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) : '—');

/**
 * The same trail as plain text.
 *
 * Phase A has no screens, and an audit record nobody can read is not evidence.
 * This is what `pnpm booking:audit` prints, and it is deliberately the same data
 * an approvals UI will render at step 9 — the assembly stays here, the markup
 * goes there.
 */
export function renderAuditTrail(trail: AuditTrail): string {
  const { request, booking } = trail;
  const out: string[] = [];

  out.push(`Travel request ${request.id}`);
  out.push(
    `  ${request.originAirport} → ${request.destinationAirport}  ` +
      `depart ≥ ${when(request.earliestDeparture)}  arrive ≤ ${when(request.latestArrival)}`,
  );
  out.push(`  status      ${request.status}`);
  out.push(`  traveler    ${trail.traveler?.fullName ?? '—'} <${trail.traveler?.email ?? '—'}>`);
  out.push(`  requested by ${trail.requester?.fullName ?? '—'}`);
  out.push(`  idempotency ${request.idempotencyKey}`);

  for (const [i, search] of trail.searches.entries()) {
    out.push('');
    out.push(
      `Search ${i + 1} of ${trail.searches.length} — ${search.searchId ?? 'unknown'} at ${when(search.capturedAt)}`,
    );
    for (const o of search.offers) {
      out.push(
        `  ${o.selected ? '▸' : ' '} ${o.offerId.padEnd(26)} ${usd(o.totalCents).padStart(9)}  ` +
          `${o.stops ?? '?'} stop  ${(o.cabin ?? '').padEnd(16)} ${(o.decision ?? '—').padEnd(14)} ` +
          `${o.blockers.join(', ')}`,
      );
    }
  }

  if (trail.approvals.length) {
    out.push('');
    out.push('Approvals');
    for (const a of trail.approvals) {
      out.push(
        `  ${when(a.decidedAt)}  ${a.outcome.padEnd(12)} up to ${usd(a.priceAtApprovalCents)}` +
          (a.reSearchedOnApproval ? '  (offer had expired — re-priced)' : '') +
          (a.breakGlassJustification ? `\n      break-glass: ${a.breakGlassJustification}` : '') +
          (a.reason ? `\n      reason: ${a.reason}` : ''),
      );
    }
  }

  out.push('');
  if (booking) {
    out.push(
      `Booking     ${booking.live ? 'LIVE' : 'dry run'}  ${booking.provider}  ` +
        `${booking.providerOrderId}` +
        (booking.bookingReference ? `  ref ${booking.bookingReference}` : ''),
    );
    out.push(
      `  charged   ${usd(booking.chargedCents)} ${booking.currency}` +
        (booking.ticketNumbers?.length ? `  ticket ${booking.ticketNumbers.join(', ')}` : '') +
        (booking.isHold ? '  (HELD, not paid)' : ''),
    );
    out.push(`  cost center ${booking.costCenterId ?? '— none recorded —'}`);
    if (booking.creditAppliedCents) {
      out.push(`  credit    ${usd(booking.creditAppliedCents)} applied against the fare`);
    }
    for (const e of trail.creditEntries) {
      out.push(
        `    ${e.kind.padEnd(9)} ${(e.deltaCents >= 0 ? '+' : '−') + usd(Math.abs(e.deltaCents))}` +
          `  → ${usd(e.balanceAfterCents)}  ${e.reason}`,
      );
    }
  } else {
    out.push('Booking     none');
  }

  out.push('');
  out.push('Timeline');
  for (const run of trail.timeline) {
    const arrow = run.fromStatus ? `${run.fromStatus} → ${run.toStatus}` : (run.toStatus ?? '·');
    out.push(
      `  ${String(run.sequence).padStart(2)} ${when(run.occurredAt)}  ` +
        `${run.step.padEnd(20)} ${arrow.padEnd(30)} ${run.summary}`,
    );
  }

  if (trail.notifications.length) {
    out.push('');
    out.push('Notifications');
    for (const n of trail.notifications) {
      out.push(`  ${when(n.createdAt)}  ${n.title}`);
    }
  }

  return out.join('\n');
}
