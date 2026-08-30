import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import {
  type Actor,
  ForbiddenError,
  canApproveRequestFor,
  routeApproval,
  isValidBreakGlass,
} from '@/lib/auth/actor';
import {
  rankOffers,
  selectBest,
  type Offer,
  type RankedOffer,
  type TravelConstraints,
  type PolicyVerdict,
  type EvaluationContext,
} from '@/lib/policy';
import * as offerFacts from '@/lib/policy/offer';
import type { FlightProvider } from '@/lib/integrations/flights/types';
import { resolveTravelPolicy, type PolicyResolution } from './policy-store';
import { assertTransition, type RequestStatus } from './machine';

/**
 * The booking agent's spine.
 *
 * The whole loop from SCOPE.md §6 lives here: submit → search → snapshot →
 * evaluate → decide → book or escalate. Deliberately transport-agnostic (§6e):
 * a web form, a script, and a future Slack adapter all call these functions, so
 * no agent logic has to move when a new front door arrives.
 *
 * Nothing in this file decides anything. It sequences the pieces that do — the
 * policy engine rules, the state machine permits, the provider executes — and
 * writes down what happened. That separation is what makes an audit readable.
 */

export type AgentDeps = {
  db: ReturnType<typeof getDb>;
  provider: FlightProvider;
  /** Injected, never `new Date()` inline: the whole pipeline must be reproducible. */
  now: () => Date;
  /**
   * Real money. Off unless the environment says otherwise, and re-read here
   * rather than trusted from a caller. SCOPE.md §6c rail 4.
   */
  live: boolean;
};

export function defaultDeps(provider: FlightProvider): AgentDeps {
  return {
    db: getDb(),
    provider,
    now: () => new Date(),
    live: process.env.FLIGHT_BOOKING_LIVE === 'true',
  };
}

type TravelRequestRow = typeof s.travelRequests.$inferSelect;
type OfferSnapshotRow = typeof s.offerSnapshots.$inferSelect;

export class RequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Travel request ${id} not found`);
    this.name = 'RequestNotFoundError';
  }
}

/**
 * Thrown when a status update finds the row already moved on. Two workers, a
 * double-clicked button, and a retried job all land here instead of racing.
 */
export class ConcurrentUpdateError extends Error {
  constructor(id: string, expected: RequestStatus, to: RequestStatus) {
    super(
      `Travel request ${id} was no longer in status "${expected}" when moving to "${to}" — ` +
        'another actor got there first.',
    );
    this.name = 'ConcurrentUpdateError';
  }
}

/** The second, dumber ceiling check. SCOPE.md §6c rail 1. */
export class HardCeilingError extends Error {
  constructor(amountCents: number, ceilingCents: number) {
    super(
      `Refusing to purchase ${usd(amountCents)}: above the hard ceiling of ${usd(ceilingCents)}, ` +
        'which no approval can raise.',
    );
    this.name = 'HardCeilingError';
  }
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/* ------------------------------- submitting -------------------------------- */

/**
 * The one input shape. A web form, a script, and a Slack message all produce
 * this; nothing downstream can tell which it was. SCOPE.md §6e.
 */
export type TravelRequestInput = {
  travelerId?: string;
  showId?: string | null;
  costCenterId?: string | null;
  originAirport: string;
  destinationAirport: string;
  earliestDeparture: Date;
  latestArrival: Date;
  returnEarliestDeparture?: Date | null;
  returnLatestArrival?: Date | null;
  cabinPreference?: string | null;
  /** What the user actually typed, when an LLM parsed the constraints above. */
  rawRequestText?: string | null;
  notes?: string | null;
  /**
   * Caller-supplied dedupe key. Supply a stable one (a Slack message id, a form
   * submission id) and a resubmitted request returns the original rather than
   * opening a second one. SCOPE.md §6c rail 2.
   */
  idempotencyKey?: string;
};

async function logRun(
  deps: AgentDeps,
  entry: {
    travelRequestId: string;
    step: string;
    fromStatus?: RequestStatus | null;
    toStatus?: RequestStatus | null;
    actor?: Actor | null;
    summary: string;
    detail?: unknown;
    durationMs?: number;
  },
): Promise<void> {
  // Serialized by the status lock in `transition`, so a plain max+1 is enough;
  // the unique index turns any genuine collision into an error rather than a
  // silently scrambled history.
  const [last] = await deps.db
    .select({ sequence: s.agentRuns.sequence })
    .from(s.agentRuns)
    .where(eq(s.agentRuns.travelRequestId, entry.travelRequestId))
    .orderBy(desc(s.agentRuns.sequence))
    .limit(1);

  await deps.db.insert(s.agentRuns).values({
    travelRequestId: entry.travelRequestId,
    sequence: (last?.sequence ?? 0) + 1,
    step: entry.step,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    actorId: entry.actor?.userId ?? null,
    actorKind: entry.actor ? 'user' : 'agent',
    impersonatedById: entry.actor?.impersonatedBy ?? null,
    summary: entry.summary,
    detail: (entry.detail ?? null) as never,
    durationMs: entry.durationMs ?? null,
    occurredAt: deps.now(),
  });
}

/**
 * Move a request, enforcing the state machine and losing the race gracefully.
 *
 * The `where status = from` clause is the important part: it makes the status
 * column itself the lock, so two concurrent workers cannot both believe they are
 * the one booking this ticket.
 */
async function transition(
  deps: AgentDeps,
  request: TravelRequestRow,
  to: RequestStatus,
  log: { step: string; summary: string; actor?: Actor | null; detail?: unknown },
): Promise<TravelRequestRow> {
  const from = request.status as RequestStatus;
  assertTransition(from, to);

  const [updated] = await deps.db
    .update(s.travelRequests)
    .set({ status: to, updatedAt: deps.now() })
    .where(and(eq(s.travelRequests.id, request.id), eq(s.travelRequests.status, from)))
    .returning();

  if (!updated) throw new ConcurrentUpdateError(request.id, from, to);

  await logRun(deps, {
    travelRequestId: request.id,
    step: log.step,
    fromStatus: from,
    toStatus: to,
    actor: log.actor,
    summary: log.summary,
    detail: log.detail,
  });

  return updated;
}

/**
 * Open a travel request.
 *
 * Idempotent by `(orgId, idempotencyKey)`: resubmitting returns the existing
 * request untouched rather than opening a second one that could produce a second
 * ticket.
 */
export async function submitTravelRequest(
  input: TravelRequestInput,
  actor: Actor,
  deps: AgentDeps,
): Promise<TravelRequestRow> {
  const travelerId = input.travelerId ?? actor.userId;

  // A member may only request for themselves; booking travel for other people
  // is a travel-manager capability. SCOPE.md §3.
  if (travelerId !== actor.userId && actor.role === 'member') {
    throw new ForbiddenError('submit a travel request on behalf of another user');
  }

  const traveler = await deps.db.query.users.findFirst({
    where: eq(s.users.id, travelerId),
  });
  if (!traveler) throw new Error(`Traveler ${travelerId} not found`);

  // Non-negotiable #6: every financial row carries a cost center at creation.
  // A booking will descend from this row, so the requirement starts here.
  const costCenterId = input.costCenterId ?? traveler.costCenterId;
  if (!costCenterId) {
    throw new Error(
      `Cannot open a travel request for ${traveler.email}: no cost center. ` +
        'Travel spend is never booked to an unassigned cost center.',
    );
  }

  const idempotencyKey =
    input.idempotencyKey ??
    `tr:${travelerId}:${input.originAirport}-${input.destinationAirport}:${input.earliestDeparture.toISOString()}`;

  const existing = await deps.db.query.travelRequests.findFirst({
    where: and(
      eq(s.travelRequests.orgId, actor.orgId),
      eq(s.travelRequests.idempotencyKey, idempotencyKey),
    ),
  });
  if (existing) return existing;

  const [row] = await deps.db
    .insert(s.travelRequests)
    .values({
      orgId: actor.orgId,
      showId: input.showId ?? null,
      requesterId: actor.userId,
      travelerId,
      costCenterId,
      // Parsed natural language is not acted on until a human confirms it:
      // an LLM's reading of "back Thursday night" is a proposal. SCOPE.md §6a.
      status: 'submitted',
      originAirport: input.originAirport,
      destinationAirport: input.destinationAirport,
      earliestDeparture: input.earliestDeparture,
      latestArrival: input.latestArrival,
      returnEarliestDeparture: input.returnEarliestDeparture ?? null,
      returnLatestArrival: input.returnLatestArrival ?? null,
      cabinPreference: input.cabinPreference ?? null,
      rawRequestText: input.rawRequestText ?? null,
      constraintsConfirmedAt: input.rawRequestText ? null : deps.now(),
      idempotencyKey,
      notes: input.notes ?? null,
      createdAt: deps.now(),
      updatedAt: deps.now(),
    })
    .returning();

  await logRun(deps, {
    travelRequestId: row.id,
    step: 'submit',
    toStatus: 'submitted',
    actor,
    summary: `${actor.email} opened a request for ${traveler.email}: ${row.originAirport} → ${row.destinationAirport}`,
    detail: { idempotencyKey, costCenterId },
  });

  return row;
}

/**
 * A human signing off on what the parser understood.
 *
 * Required before search whenever the request came from free text, because the
 * constraints are what the policy engine rules against — an unreviewed
 * misparse would be laundered into an authorized purchase.
 */
export async function confirmConstraints(
  requestId: string,
  actor: Actor,
  deps: AgentDeps,
): Promise<TravelRequestRow> {
  const request = await loadRequest(requestId, deps);
  const [row] = await deps.db
    .update(s.travelRequests)
    .set({ constraintsConfirmedAt: deps.now(), updatedAt: deps.now() })
    .where(eq(s.travelRequests.id, request.id))
    .returning();

  await logRun(deps, {
    travelRequestId: row.id,
    step: 'confirm_constraints',
    actor,
    summary: `${actor.email} confirmed the parsed constraints`,
  });
  return row;
}

async function loadRequest(id: string, deps: AgentDeps): Promise<TravelRequestRow> {
  const row = await deps.db.query.travelRequests.findFirst({
    where: eq(s.travelRequests.id, id),
  });
  if (!row) throw new RequestNotFoundError(id);
  return row;
}

function constraintsOf(request: TravelRequestRow): TravelConstraints {
  return {
    originAirport: request.originAirport,
    destinationAirport: request.destinationAirport,
    earliestDeparture: request.earliestDeparture,
    latestArrival: request.latestArrival,
    returnEarliestDeparture: request.returnEarliestDeparture ?? undefined,
    returnLatestArrival: request.returnLatestArrival ?? undefined,
    cabinPreference: (request.cabinPreference ?? undefined) as TravelConstraints['cabinPreference'],
  };
}

/* -------------------------- search, snapshot, judge ------------------------- */

export type AgentOutcome = {
  request: TravelRequestRow;
  status: RequestStatus;
  ranked: RankedOffer[];
  /** The offer the agent chose, if any survived policy. */
  selected: { offer: Offer; verdict: PolicyVerdict; snapshotId: string } | null;
  policy: PolicyResolution;
  booking?: typeof s.bookings.$inferSelect;
  /** Set when nothing was bookable — the relaxations worth suggesting. */
  noOptionsReasons?: string[];
};

/** Spend already committed to this show's travel, for the per-show budget rule. */
async function showTravelSpent(
  deps: AgentDeps,
  showId: string | null,
): Promise<number | undefined> {
  if (!showId) return undefined;
  const rows = await deps.db
    .select({ total: sql<number>`coalesce(sum(${s.bookings.chargedCents}), 0)` })
    .from(s.bookings)
    .innerJoin(s.travelRequests, eq(s.bookings.travelRequestId, s.travelRequests.id))
    .where(and(eq(s.travelRequests.showId, showId), sql`${s.bookings.cancelledAt} is null`));
  return Number(rows[0]?.total ?? 0);
}

/** Credits this traveler could put against a given carrier's fare. SCOPE.md §5b. */
async function applicableCredits(
  deps: AgentDeps,
  travelerId: string,
): Promise<{ airlineCode: string; remainingValueCents: number }[]> {
  const now = deps.now();
  const rows = await deps.db
    .select({
      airlineCode: s.ticketCredits.airlineCode,
      remainingValueCents: s.ticketCredits.remainingValueCents,
      expiresOn: s.ticketCredits.expiresOn,
    })
    .from(s.ticketCredits)
    .where(
      and(eq(s.ticketCredits.userId, travelerId), eq(s.ticketCredits.status, 'available')),
    );
  return rows.filter((r) => r.expiresOn > now);
}

async function buildContext(
  deps: AgentDeps,
  request: TravelRequestRow,
): Promise<{
  base: Omit<EvaluationContext, 'offer'>;
  resolution: PolicyResolution;
  credits: { airlineCode: string; remainingValueCents: number }[];
}> {
  const resolution = await resolveTravelPolicy(
    request.orgId,
    { costCenterId: request.costCenterId, showId: request.showId },
    deps.db,
  );

  const show = request.showId
    ? await deps.db.query.shows.findFirst({ where: eq(s.shows.id, request.showId) })
    : null;

  return {
    base: {
      constraints: constraintsOf(request),
      policy: resolution.policy,
      now: deps.now(),
      moveInAt: show?.moveInAt ?? undefined,
      showTravelSpentCents: await showTravelSpent(deps, request.showId),
    },
    resolution,
    credits: await applicableCredits(deps, request.travelerId),
  };
}

/**
 * Record every offer the agent saw, not just the one it took.
 *
 * Offers vanish from the provider within the hour, so without this row the
 * question "why did it pick the $612 fare?" becomes permanently unanswerable.
 * `rawPayload` keeps the provider's own words beside our reading of them.
 */
async function snapshotOffers(
  deps: AgentDeps,
  request: TravelRequestRow,
  ranked: RankedOffer[],
  searchId: string,
  bestOfferId: string | null,
  resolution: PolicyResolution,
): Promise<Map<string, OfferSnapshotRow>> {
  const byOfferId = new Map<string, OfferSnapshotRow>();

  for (const [index, entry] of ranked.entries()) {
    const { offer, verdict, score } = entry;
    const [snapshot] = await deps.db
      .insert(s.offerSnapshots)
      .values({
        travelRequestId: request.id,
        provider: offer.provider,
        providerOfferId: offer.id,
        providerSearchId: searchId,
        totalCents: offer.totalCents,
        currency: offer.currency,
        totalAmountRaw: (offer.totalCents / 100).toFixed(2),
        ownerAirlineCode: offerFacts.firstSegment(offer).airlineCode,
        outboundDeparture: offerFacts.outboundDeparture(offer),
        outboundArrival: offerFacts.outboundArrival(offer),
        maxStops: offerFacts.maxStopsInAnySlice(offer),
        highestCabin: offerFacts.highestCabin(offer),
        refundable: offer.refundable,
        refundPenaltyCents: offer.refundPenaltyCents,
        changeable: offer.changeable,
        changePenaltyCents: offer.changePenaltyCents,
        requiresInstantPayment: offer.requiresInstantPayment,
        paymentRequiredBy: offer.paymentRequiredBy,
        priceGuaranteeExpiresAt: offer.priceGuaranteeExpiresAt,
        offerExpiresAt: offer.expiresAt ?? deps.now(),
        availableCreditIds: offer.availableCreditIds,
        corporateFareCodes: offer.corporateFareCodes,
        selected: offer.id === bestOfferId,
        rank: index,
        score,
        rawPayload: offer as never,
        capturedAt: deps.now(),
      })
      .returning();

    // Non-negotiable #5: the verdict is written before anything can be bought,
    // for every offer considered — including the ones that were refused.
    await deps.db.insert(s.policyEvaluations).values({
      travelRequestId: request.id,
      offerSnapshotId: snapshot.id,
      decision: verdict.decision,
      policyId: verdict.policyId,
      policyVersion: verdict.policyVersion,
      resolvedPolicy: { policy: resolution.policy, layers: resolution.layers } as never,
      results: verdict.results as never,
      blockerRuleIds: verdict.blockers.map((b) => b.ruleId),
      evaluatedAt: verdict.evaluatedAt,
    });

    byOfferId.set(offer.id, snapshot);
  }

  return byOfferId;
}

/**
 * Search, snapshot, and rule. Shared by the first run and by the re-search that
 * an expired offer forces at approval time — the same code path both times, so
 * a re-priced itinerary is judged exactly as strictly as the original.
 */
async function searchAndEvaluate(
  deps: AgentDeps,
  request: TravelRequestRow,
): Promise<{
  ranked: RankedOffer[];
  best: RankedOffer | null;
  snapshots: Map<string, OfferSnapshotRow>;
  resolution: PolicyResolution;
}> {
  const startedAt = Date.now();
  const { base, resolution, credits } = await buildContext(deps, request);

  const traveler = await deps.db.query.users.findFirst({
    where: eq(s.users.id, request.travelerId),
  });
  const [givenName, ...rest] = (traveler?.fullName ?? 'Unknown Traveler').split(' ');

  const result = await deps.provider.search({
    constraints: base.constraints,
    passengers: [{ givenName, familyName: rest.join(' ') || givenName }],
    cabinClass: base.constraints.cabinPreference,
    maxConnections: base.policy.maxStops,
  });

  // Credits are matched per offer: a Delta credit does nothing for an American
  // fare, and pretending otherwise would escalate every request for no reason.
  const scored = rankOffers(result.offers, base).map((entry) => {
    const carriers = new Set(offerFacts.marketingAirlines(entry.offer));
    const credit = credits
      .filter((c) => carriers.has(c.airlineCode))
      .reduce((sum, c) => sum + c.remainingValueCents, 0);
    if (credit === 0) return entry;
    // Re-rule this offer with its credit in view; the credit-first rule cares.
    const [reranked] = rankOffers([entry.offer], { ...base, applicableCreditCents: credit });
    return reranked;
  });

  scored.sort((a, b) => a.score - b.score);

  const best = selectBest(scored);
  const snapshots = await snapshotOffers(
    deps,
    request,
    scored,
    result.searchId,
    best?.offer.id ?? null,
    resolution,
  );

  await logRun(deps, {
    travelRequestId: request.id,
    step: 'search',
    summary:
      `${deps.provider.name} returned ${result.offers.length} offer(s); ` +
      (best
        ? `best is ${best.offer.id} at ${usd(best.offer.totalCents)} → ${best.verdict.decision}`
        : 'none were bookable'),
    detail: {
      searchId: result.searchId,
      policyLayers: resolution.layers,
      offers: scored.map((r) => ({
        id: r.offer.id,
        totalCents: r.offer.totalCents,
        decision: r.verdict.decision,
        score: r.score,
        blockers: r.verdict.blockers.map((b) => b.ruleId),
      })),
    },
    durationMs: Date.now() - startedAt,
  });

  return { ranked: scored, best, snapshots, resolution };
}

/**
 * Run the agent on a submitted request: search, judge, then either book it or
 * put it in front of a human.
 */
export async function runAgent(
  requestId: string,
  deps: AgentDeps,
  actor?: Actor,
): Promise<AgentOutcome> {
  let request = await loadRequest(requestId, deps);

  if (request.rawRequestText && !request.constraintsConfirmedAt) {
    throw new Error(
      `Travel request ${request.id} came from free text whose parsed constraints are unconfirmed. ` +
        'A human confirms the interpretation before anything is searched.',
    );
  }

  request = await transition(deps, request, 'searching', {
    step: 'search_start',
    actor,
    summary: `Searching ${request.originAirport} → ${request.destinationAirport} via ${deps.provider.name}`,
  });

  const { ranked, best, snapshots, resolution } = await searchAndEvaluate(deps, request);

  if (!best) {
    const reasons = uniqueReasons(ranked);
    request = await transition(deps, request, 'no_options', {
      step: 'no_options',
      actor,
      summary: ranked.length
        ? `${ranked.length} offer(s) found, none bookable`
        : 'No offers matched the request',
      detail: { reasons },
    });
    return { request, status: 'no_options', ranked, selected: null, policy: resolution, noOptionsReasons: reasons };
  }

  request = await transition(deps, request, 'offers_found', {
    step: 'offers_found',
    actor,
    summary: `Chose ${best.offer.id} at ${usd(best.offer.totalCents)} — ${best.verdict.decision}`,
    detail: { reasons: best.verdict.reasons },
  });

  const snapshot = snapshots.get(best.offer.id)!;
  const selected = { offer: best.offer, verdict: best.verdict, snapshotId: snapshot.id };

  if (best.verdict.decision === 'auto_approve') {
    const booked = await book(deps, request, best, snapshot, resolution, actor);
    return { request: booked.request, status: booked.request.status as RequestStatus, ranked, selected, policy: resolution, booking: booked.booking };
  }

  // Needs a human. Hold the space first where the carrier allows it, so the
  // approver gets a real deadline instead of a 30-minute fuse. SCOPE.md §6b.
  await tryHold(deps, request, best, snapshot, actor);

  request = await transition(deps, request, 'pending_approval', {
    step: 'escalate',
    actor,
    summary: `Escalated for approval: ${best.verdict.reasons.join('; ') || 'over policy'}`,
    detail: { blockers: best.verdict.blockers },
  });

  return { request, status: 'pending_approval', ranked, selected, policy: resolution };
}

/** What to tell the user to relax, drawn from what actually blocked. */
function uniqueReasons(ranked: RankedOffer[]): string[] {
  const seen = new Set<string>();
  for (const entry of ranked) {
    for (const blocker of entry.verdict.blockers) seen.add(blocker.message);
  }
  return [...seen];
}

/* ---------------------------------- holds ---------------------------------- */

/**
 * Reserve the space without paying, when the offer permits it.
 *
 * A failure here is not a failure of the request: the approver simply gets the
 * shorter, riskier path where the offer may expire under them. So it is logged
 * and swallowed rather than thrown.
 */
async function tryHold(
  deps: AgentDeps,
  request: TravelRequestRow,
  best: RankedOffer,
  snapshot: OfferSnapshotRow,
  actor?: Actor,
): Promise<void> {
  if (best.offer.requiresInstantPayment) {
    await logRun(deps, {
      travelRequestId: request.id,
      step: 'hold_skipped',
      actor,
      summary: `${best.offer.id} requires instant payment — no hold available, the offer expires ${best.offer.expiresAt?.toISOString() ?? 'soon'}`,
    });
    return;
  }

  try {
    const held = await deps.provider.hold({
      offerId: best.offer.id,
      passengers: [],
      idempotencyKey: `${request.idempotencyKey}:hold`,
    });

    await deps.db.insert(s.bookings).values({
      travelRequestId: request.id,
      offerSnapshotId: snapshot.id,
      provider: deps.provider.name,
      providerOrderId: held.orderId,
      bookingReference: held.bookingReference,
      isHold: true,
      payBy: held.payBy,
      priceGuaranteedUntil: held.priceGuaranteedUntil,
      chargedCents: null,
      currency: held.currency,
      costCenterId: request.costCenterId,
      live: deps.live,
      idempotencyKey: request.idempotencyKey,
      createdAt: deps.now(),
    });

    await logRun(deps, {
      travelRequestId: request.id,
      step: 'hold',
      actor,
      summary:
        `Held ${held.bookingReference} until ${held.payBy?.toISOString() ?? 'unknown'}` +
        (held.priceGuaranteedUntil
          ? ` with the fare guaranteed to ${held.priceGuaranteedUntil.toISOString()}`
          : ' — space is held but the fare is NOT guaranteed'),
      detail: held,
    });
  } catch (err) {
    await logRun(deps, {
      travelRequestId: request.id,
      step: 'hold_failed',
      actor,
      summary: `Hold attempt failed: ${(err as Error).message}`,
    });
  }
}

/* --------------------------------- booking --------------------------------- */

/**
 * Buy it — or, in dry run, record exactly what would have been bought.
 *
 * Dry run is the default everywhere; production purchasing needs an explicit
 * env flag, so the first bug in this pipeline is never a real ticket.
 * SCOPE.md §6c rail 4.
 */
async function book(
  deps: AgentDeps,
  request: TravelRequestRow,
  best: RankedOffer,
  snapshot: OfferSnapshotRow,
  resolution: PolicyResolution,
  actor?: Actor,
): Promise<{ request: TravelRequestRow; booking: typeof s.bookings.$inferSelect }> {
  // Non-negotiable #5: a recorded verdict for *this* offer, or nothing happens.
  const evaluation = await deps.db.query.policyEvaluations.findFirst({
    where: eq(s.policyEvaluations.offerSnapshotId, snapshot.id),
  });
  if (!evaluation) {
    throw new Error(
      `No policy evaluation recorded for offer snapshot ${snapshot.id}. No purchase without a verdict.`,
    );
  }

  // Rail 1: the hard ceiling, checked here against the resolved policy rather
  // than trusted from the verdict. Independent of the agent's own reasoning,
  // and above it no approval — break-glass included — can authorize anything.
  const ceiling = resolution.policy.bands.denyOverCents;
  if (best.offer.totalCents > ceiling) {
    throw new HardCeilingError(best.offer.totalCents, ceiling);
  }

  const moving = await transition(deps, request, 'booking', {
    step: 'booking_start',
    actor,
    summary: `${deps.live ? 'Purchasing' : 'Dry-run booking'} ${best.offer.id} at ${usd(best.offer.totalCents)}`,
  });

  // Rail 2: one ticket per request, ever. The unique index on
  // `bookings.travel_request_id` is the real guarantee; this read just turns a
  // constraint violation into an idempotent no-op for an honest retry.
  const existing = await deps.db.query.bookings.findFirst({
    where: eq(s.bookings.travelRequestId, request.id),
  });

  let booking: typeof s.bookings.$inferSelect;

  if (deps.live) {
    const purchased = await deps.provider.purchase({
      offerId: best.offer.id,
      orderId: existing?.isHold ? existing.providerOrderId : undefined,
      amountCents: best.offer.totalCents,
      currency: best.offer.currency,
      idempotencyKey: request.idempotencyKey,
    });
    booking = existing
      ? (
          await deps.db
            .update(s.bookings)
            .set({
              isHold: false,
              providerOrderId: purchased.orderId,
              bookingReference: purchased.bookingReference,
              ticketNumbers: purchased.ticketNumbers,
              chargedCents: purchased.chargedCents,
              live: true,
            })
            .where(eq(s.bookings.id, existing.id))
            .returning()
        )[0]
      : (
          await deps.db
            .insert(s.bookings)
            .values({
              travelRequestId: request.id,
              offerSnapshotId: snapshot.id,
              provider: deps.provider.name,
              providerOrderId: purchased.orderId,
              bookingReference: purchased.bookingReference,
              ticketNumbers: purchased.ticketNumbers,
              isHold: false,
              chargedCents: purchased.chargedCents,
              currency: purchased.currency,
              costCenterId: request.costCenterId,
              live: true,
              idempotencyKey: request.idempotencyKey,
              createdAt: deps.now(),
            })
            .returning()
        )[0];
  } else {
    // The dry-run order id is prefixed so it can never be mistaken for a real
    // provider reference by a later query, a report, or a person.
    const dryRunOrderId = `dryrun:${deps.provider.name}:${request.idempotencyKey}`;
    booking = existing
      ? (
          await deps.db
            .update(s.bookings)
            .set({
              isHold: false,
              chargedCents: best.offer.totalCents,
              offerSnapshotId: snapshot.id,
              live: false,
            })
            .where(eq(s.bookings.id, existing.id))
            .returning()
        )[0]
      : (
          await deps.db
            .insert(s.bookings)
            .values({
              travelRequestId: request.id,
              offerSnapshotId: snapshot.id,
              provider: deps.provider.name,
              providerOrderId: dryRunOrderId,
              bookingReference: null,
              ticketNumbers: [],
              isHold: false,
              chargedCents: best.offer.totalCents,
              currency: best.offer.currency,
              costCenterId: request.costCenterId,
              live: false,
              idempotencyKey: request.idempotencyKey,
              createdAt: deps.now(),
            })
            .returning()
        )[0];
  }

  const ticketed = await transition(deps, moving, 'ticketed', {
    step: 'ticketed',
    actor,
    summary: deps.live
      ? `Ticketed ${booking.bookingReference} for ${usd(booking.chargedCents ?? 0)}`
      : `Dry run complete — would have bought ${best.offer.id} for ${usd(best.offer.totalCents)}. No money moved.`,
    detail: { bookingId: booking.id, live: booking.live, evaluationId: evaluation.id },
  });

  return { request: ticketed, booking };
}

/* -------------------------------- approvals -------------------------------- */

export type ApprovalInput = {
  /** Required when no eligible approver exists and the requester self-approves. */
  breakGlassJustification?: string;
  reason?: string;
};

/**
 * Approve a request — and re-price it first if the offer died while waiting.
 *
 * This is the case that breaks most booking integrations. An offer lives about
 * thirty minutes; an approval queue lives overnight. So approving does not mean
 * "buy the thing you showed me" — it means "buy the trip, up to the price I
 * signed off on." If the re-searched fare comes back higher, the approval no
 * longer covers it and the request goes back to the queue rather than quietly
 * charging the difference. SCOPE.md §6b.
 */
export async function approveRequest(
  requestId: string,
  approver: Actor,
  deps: AgentDeps,
  input: ApprovalInput = {},
): Promise<AgentOutcome> {
  let request = await loadRequest(requestId, deps);
  if (request.status !== 'pending_approval') {
    throw new Error(`Travel request ${requestId} is ${request.status}, not awaiting approval`);
  }

  const breakGlass = await authorizeApproval(deps, request, approver, input);

  const snapshot = await deps.db.query.offerSnapshots.findFirst({
    where: and(
      eq(s.offerSnapshots.travelRequestId, request.id),
      eq(s.offerSnapshots.selected, true),
    ),
  });
  if (!snapshot) throw new Error(`Travel request ${requestId} has no selected offer to approve`);

  const evaluation = await deps.db.query.policyEvaluations.findFirst({
    where: eq(s.policyEvaluations.offerSnapshotId, snapshot.id),
  });

  const approvedPriceCents = snapshot.totalCents;
  const held = await deps.db.query.bookings.findFirst({
    where: and(eq(s.bookings.travelRequestId, request.id), eq(s.bookings.isHold, true)),
  });
  // A hold keeps the space; only a price guarantee keeps the fare. Approving a
  // held-but-unguaranteed fare still has to survive a re-price.
  const offerStillGood =
    snapshot.offerExpiresAt > deps.now() ||
    (held !== undefined && held.priceGuaranteedUntil !== null && held.priceGuaranteedUntil > deps.now());

  await deps.db.insert(s.approvals).values({
    travelRequestId: request.id,
    policyEvaluationId: evaluation?.id ?? null,
    approverId: approver.userId,
    outcome: breakGlass ? 'break_glass' : 'approved',
    reason: input.reason ?? null,
    breakGlassJustification: breakGlass ? input.breakGlassJustification! : null,
    reSearchedOnApproval: !offerStillGood,
    priceAtApprovalCents: approvedPriceCents,
    decidedAt: deps.now(),
  });

  await logRun(deps, {
    travelRequestId: request.id,
    step: 'approval',
    actor: approver,
    summary:
      `${approver.email} approved up to ${usd(approvedPriceCents)}` +
      (breakGlass ? ' (BREAK-GLASS: no eligible approver existed)' : '') +
      (offerStillGood ? '' : ' — the offer had expired, re-searching'),
  });

  if (offerStillGood) {
    request = await transition(deps, request, 'approved', {
      step: 'approved',
      actor: approver,
      summary: `Approved at ${usd(approvedPriceCents)}, offer still live`,
    });
    const { base, resolution } = await buildContext(deps, request);
    const offer = snapshot.rawPayload as unknown as Offer;
    const rehydrated = rehydrate(offer);
    const [best] = rankOffers([rehydrated], base);
    const booked = await book(deps, request, best, snapshot, resolution, approver);
    return {
      request: booked.request,
      status: booked.request.status as RequestStatus,
      ranked: [best],
      selected: { offer: rehydrated, verdict: best.verdict, snapshotId: snapshot.id },
      policy: resolution,
      booking: booked.booking,
    };
  }

  return reSearchAfterApproval(deps, request, approver, approvedPriceCents);
}

/**
 * JSON round-trips dates into strings. The snapshot is the audit record, so it
 * is stored verbatim; reviving it for re-evaluation is this function's job.
 */
function rehydrate(raw: Offer): Offer {
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return {
    ...raw,
    expiresAt: date(raw.expiresAt),
    paymentRequiredBy: date(raw.paymentRequiredBy),
    priceGuaranteeExpiresAt: date(raw.priceGuaranteeExpiresAt),
    slices: raw.slices.map((slice) => ({
      segments: slice.segments.map((seg) => ({
        ...seg,
        departsAt: new Date(seg.departsAt),
        arrivesAt: new Date(seg.arrivesAt),
      })),
    })),
  };
}

async function authorizeApproval(
  deps: AgentDeps,
  request: TravelRequestRow,
  approver: Actor,
  input: ApprovalInput,
): Promise<boolean> {
  if (canApproveRequestFor(approver, request.requesterId)) return false;

  // Nobody else could sign this off. Break-glass keeps a one-admin org from
  // deadlocking, at the price of a written justification and a flagged record.
  const members = await deps.db.query.users.findMany({
    where: eq(s.users.orgId, request.orgId),
  });
  const route = routeApproval(
    request.requesterId,
    members.map((m) => ({
      userId: m.id,
      orgId: m.orgId,
      email: m.email,
      fullName: m.fullName,
      role: m.role,
      costCenterId: m.costCenterId,
    })),
  );

  if (route.kind === 'eligible_approvers') {
    throw new ForbiddenError(
      `approve this request — ${route.approverIds.length} other eligible approver(s) exist`,
    );
  }
  if (!input.breakGlassJustification || !isValidBreakGlass(input.breakGlassJustification)) {
    throw new ForbiddenError(
      'self-approve without a written justification of at least 20 characters',
    );
  }
  return true;
}

/**
 * The offer died under the approver. Search again, judge again, and hold the
 * result to the price that was actually approved.
 */
async function reSearchAfterApproval(
  deps: AgentDeps,
  request: TravelRequestRow,
  approver: Actor,
  approvedPriceCents: number,
): Promise<AgentOutcome> {
  let current = await transition(deps, request, 'searching', {
    step: 're_search',
    actor: approver,
    summary: `Offer expired before approval — re-searching against the approved ceiling of ${usd(approvedPriceCents)}`,
  });

  // Old snapshots stay for the audit trail, but only one can be `selected`.
  await deps.db
    .update(s.offerSnapshots)
    .set({ selected: false })
    .where(eq(s.offerSnapshots.travelRequestId, current.id));

  const { ranked, best, snapshots, resolution } = await searchAndEvaluate(deps, current);

  if (!best) {
    const reasons = uniqueReasons(ranked);
    current = await transition(deps, current, 'no_options', {
      step: 'no_options',
      actor: approver,
      summary: 'Re-search after approval found nothing bookable',
      detail: { reasons },
    });
    return { request: current, status: 'no_options', ranked, selected: null, policy: resolution, noOptionsReasons: reasons };
  }

  const snapshot = snapshots.get(best.offer.id)!;
  current = await transition(deps, current, 'offers_found', {
    step: 'offers_found',
    actor: approver,
    summary: `Re-search found ${best.offer.id} at ${usd(best.offer.totalCents)}`,
  });

  const selected = { offer: best.offer, verdict: best.verdict, snapshotId: snapshot.id };

  // The approval was for an amount, not for an offer id. A cheaper or equal
  // fare is covered by it; a dearer one is not, and goes back to the queue.
  if (best.offer.totalCents > approvedPriceCents) {
    await tryHold(deps, current, best, snapshot, approver);
    current = await transition(deps, current, 'pending_approval', {
      step: 'reapproval_required',
      actor: approver,
      summary:
        `Re-priced at ${usd(best.offer.totalCents)}, ` +
        `${usd(best.offer.totalCents - approvedPriceCents)} above the approved ${usd(approvedPriceCents)} — needs a fresh approval`,
      detail: { approvedPriceCents, newPriceCents: best.offer.totalCents },
    });
    return { request: current, status: 'pending_approval', ranked, selected, policy: resolution };
  }

  await logRun(deps, {
    travelRequestId: current.id,
    step: 'reprice_accepted',
    actor: approver,
    summary: `Re-priced at ${usd(best.offer.totalCents)}, within the approved ${usd(approvedPriceCents)}`,
    detail: { approvedPriceCents, newPriceCents: best.offer.totalCents },
  });

  const booked = await book(deps, current, best, snapshot, resolution, approver);
  return {
    request: booked.request,
    status: booked.request.status as RequestStatus,
    ranked,
    selected,
    policy: resolution,
    booking: booked.booking,
  };
}

export async function rejectRequest(
  requestId: string,
  approver: Actor,
  reason: string,
  deps: AgentDeps,
): Promise<TravelRequestRow> {
  const request = await loadRequest(requestId, deps);
  if (!canApproveRequestFor(approver, request.requesterId)) {
    throw new ForbiddenError('reject this request');
  }

  const snapshot = await deps.db.query.offerSnapshots.findFirst({
    where: and(
      eq(s.offerSnapshots.travelRequestId, request.id),
      eq(s.offerSnapshots.selected, true),
    ),
  });
  const evaluation = snapshot
    ? await deps.db.query.policyEvaluations.findFirst({
        where: eq(s.policyEvaluations.offerSnapshotId, snapshot.id),
      })
    : undefined;

  await deps.db.insert(s.approvals).values({
    travelRequestId: request.id,
    policyEvaluationId: evaluation?.id ?? null,
    approverId: approver.userId,
    outcome: 'rejected',
    reason,
    decidedAt: deps.now(),
  });

  return transition(deps, request, 'rejected', {
    step: 'rejected',
    actor: approver,
    summary: `${approver.email} rejected the request: ${reason}`,
  });
}

export async function cancelRequest(
  requestId: string,
  actor: Actor,
  reason: string,
  deps: AgentDeps,
): Promise<TravelRequestRow> {
  const request = await loadRequest(requestId, deps);
  return transition(deps, request, 'cancelled', {
    step: 'cancelled',
    actor,
    summary: `${actor.email} cancelled the request: ${reason}`,
  });
}

/**
 * Sweep requests whose offer died while nobody was looking.
 *
 * Without this, a request sits in `pending_approval` showing a fare that no
 * longer exists, which is how an approver ends up authorizing a number that was
 * never available.
 */
export async function expireStaleRequests(
  orgId: string,
  deps: AgentDeps,
): Promise<TravelRequestRow[]> {
  const now = deps.now();
  const candidates = await deps.db
    .select()
    .from(s.travelRequests)
    .where(
      and(eq(s.travelRequests.orgId, orgId), eq(s.travelRequests.status, 'pending_approval')),
    );

  const expired: TravelRequestRow[] = [];
  for (const request of candidates) {
    const snapshot = await deps.db.query.offerSnapshots.findFirst({
      where: and(
        eq(s.offerSnapshots.travelRequestId, request.id),
        eq(s.offerSnapshots.selected, true),
      ),
    });
    if (!snapshot || snapshot.offerExpiresAt > now) continue;

    const held = await deps.db.query.bookings.findFirst({
      where: and(eq(s.bookings.travelRequestId, request.id), eq(s.bookings.isHold, true)),
    });
    // A live hold means the space is still ours; the request is not stale.
    if (held?.payBy && held.payBy > now) continue;

    expired.push(
      await transition(deps, request, 'expired', {
        step: 'expired',
        summary: `Offer ${snapshot.providerOfferId} expired at ${snapshot.offerExpiresAt.toISOString()} while awaiting approval`,
      }),
    );
  }
  return expired;
}
