import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { getDb } from '@/db';
import * as s from '@/db/schema';
import { notifyExpiringCredits } from './notify';

/**
 * The unused-ticket-credit ledger. SCOPE.md §5b.
 *
 * 5–11% of corporate air spend is forfeited to credits nobody remembered, and
 * trade show travel is unusually exposed: shows get cancelled, staffing changes
 * late, and a non-refundable ticket becomes money with a clock on it. We hold
 * every one of these only because we booked the ticket — which is exactly why a
 * competitor that only plans cannot ship this.
 *
 * Two things make this file more than a table:
 *
 * **The balance is derived, never assigned.** `ticket_credits.remaining_value_cents`
 * is a cached projection of the append-only entries in `ticket_credit_entries`.
 * Nothing here sets a balance; it appends a signed delta and lets the projection
 * follow. A credit's balance is money, and money that can be silently overwritten
 * cannot be audited.
 *
 * **We cannot spend a credit the provider has never heard of.** This is the
 * correction that shaped the whole step — see `PROVIDER_VISIBILITY` below.
 *
 * The decision half of this file is pure: which credits apply to which fare is
 * decided by functions that take rows and return rows, so the rules are tested
 * without a database, exactly as the policy engine is.
 */

type Db = ReturnType<typeof getDb>;

export type CreditRow = typeof s.ticketCredits.$inferSelect;
export type CreditEntryRow = typeof s.ticketCreditEntries.$inferSelect;

/**
 * **PROVIDER_VISIBILITY — the correction step 6 turned up.**
 *
 * "Auto-apply credits before new spend" sounds like a ledger problem. It is not.
 * A credit is redeemed by the *carrier*, through whoever is selling the ticket.
 * Duffel can apply the credits it surfaces on an offer as
 * `available_airline_credit_ids`; it cannot apply a credit that exists only as a
 * row in our database, because it has no relationship to that ticket coupon.
 *
 * So the ledger's credits fall into two kinds, and conflating them would either
 * double-spend the same money or quietly invent a discount:
 *
 * - **Redeemable here** — `providerCreditId` is set, meaning this row and an id
 *   on the offer are the same money. The agent passes it to the provider and
 *   records what the provider actually took off the fare.
 * - **Redeemable elsewhere** — no `providerCreditId`. Real money, still ours,
 *   but it takes a person on the phone to the airline. The agent must never
 *   pretend to have applied it. It escalates instead, so the human sees "there
 *   is $612 of Delta credit for this traveler" *before* the org spends new cash.
 *
 * That is why `credit_first` in the policy engine is an escalation rule and not
 * a discount calculation, and it is the honest version of §5b's promise.
 */
export const PROVIDER_VISIBILITY = ['redeemable_here', 'redeemable_elsewhere'] as const;
export type CreditVisibility = (typeof PROVIDER_VISIBILITY)[number];

export function visibilityOf(credit: Pick<CreditRow, 'providerCreditId'>): CreditVisibility {
  return credit.providerCreditId ? 'redeemable_here' : 'redeemable_elsewhere';
}

/* ------------------------------ the pure core ------------------------------ */

/** Statuses that still hold value. `partially_used` very much does. */
const SPENDABLE: CreditRow['status'][] = ['available', 'partially_used'];

/**
 * Is this credit worth anything, right now?
 *
 * Note `expiresOn > now` and not `>=`: a credit expiring at this instant is gone,
 * and rounding that in our favour would produce a purchase the carrier rejects at
 * the counter.
 */
export function isSpendable(credit: CreditRow, now: Date): boolean {
  return (
    SPENDABLE.includes(credit.status) &&
    credit.remainingValueCents > 0 &&
    credit.expiresOn > now
  );
}

export type OfferCreditContext = {
  /** Every marketing carrier on the itinerary; a Delta credit needs a Delta flight. */
  carriers: string[];
  currency: string;
  fareCents: number;
  now: Date;
  /**
   * Most carriers refuse to combine credits on one ticket, and a few allow it.
   * Default false: over-claiming makes the agent escalate a request it could have
   * booked, which is annoying; under-claiming makes it promise a discount the
   * carrier will not honour at the counter, which is a failed trip.
   */
  allowCombining?: boolean;
};

export type CreditMatch = {
  /** Credits chosen, best first. At most one unless combining is allowed. */
  chosen: CreditRow[];
  /** What those credits can actually take off this fare, capped at the fare. */
  applicableCents: number;
  /** Of the chosen credits, the ones the provider can redeem for us. */
  redeemableHere: CreditRow[];
  /** Chosen credits that need a human and an airline phone call. */
  redeemableElsewhere: CreditRow[];
  /** Why each rejected credit did not apply — this is what a person wants to read. */
  rejected: { credit: CreditRow; reason: string }[];
};

/**
 * Which of a traveler's credits apply to one specific offer.
 *
 * Pure, and deliberately conservative. Every rejection carries its reason,
 * because "you have $2,400 in credit and the agent used none of it" is only
 * acceptable if the system can say why for each dollar.
 */
export function matchCreditsToOffer(pool: CreditRow[], ctx: OfferCreditContext): CreditMatch {
  const carriers = new Set(ctx.carriers);
  const rejected: { credit: CreditRow; reason: string }[] = [];
  const eligible: CreditRow[] = [];

  for (const credit of pool) {
    if (!isSpendable(credit, ctx.now)) {
      rejected.push({
        credit,
        reason:
          credit.expiresOn <= ctx.now
            ? `expired ${credit.expiresOn.toISOString().slice(0, 10)}`
            : `status ${credit.status} with ${credit.remainingValueCents} cents left`,
      });
      continue;
    }
    if (!carriers.has(credit.airlineCode)) {
      rejected.push({
        credit,
        reason: `issued by ${credit.airlineCode}; this itinerary flies ${[...carriers].join(', ')}`,
      });
      continue;
    }
    // A EUR credit does not pay a USD fare. Airlines do not convert, and doing
    // the arithmetic ourselves would invent an exchange rate nobody agreed to.
    if (credit.currency !== ctx.currency) {
      rejected.push({
        credit,
        reason: `held in ${credit.currency}; this fare is priced in ${ctx.currency}`,
      });
      continue;
    }
    eligible.push(credit);
  }

  // Redeemable-here first, then largest, then closest to expiring.
  //
  // The first key is not an optimisation. Only one credit goes on a ticket, so
  // choosing a larger credit the provider cannot redeem over a smaller one it
  // can means the request escalates and *nothing* is applied — strictly worse
  // than applying the smaller one. Size only breaks ties within a visibility.
  const rank = (c: CreditRow) => (visibilityOf(c) === 'redeemable_here' ? 0 : 1);
  eligible.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.remainingValueCents - a.remainingValueCents ||
      a.expiresOn.getTime() - b.expiresOn.getTime(),
  );

  const chosen = ctx.allowCombining ? eligible : eligible.slice(0, 1);
  for (const credit of eligible.slice(chosen.length)) {
    rejected.push({
      credit,
      reason: 'only one credit may be applied per ticket by this carrier',
    });
  }

  const raw = chosen.reduce((sum, c) => sum + c.remainingValueCents, 0);

  return {
    chosen,
    // A credit is not cash back: value above the fare stays on the credit.
    applicableCents: Math.min(raw, ctx.fareCents),
    redeemableHere: chosen.filter((c) => visibilityOf(c) === 'redeemable_here'),
    redeemableElsewhere: chosen.filter((c) => visibilityOf(c) === 'redeemable_elsewhere'),
    rejected,
  };
}

/**
 * Split an amount across credits, largest first, never taking more from one than
 * it holds. Returns the per-credit draw the ledger will write.
 */
export function allocate(
  credits: CreditRow[],
  amountCents: number,
): { credit: CreditRow; drawCents: number }[] {
  let left = amountCents;
  const draws: { credit: CreditRow; drawCents: number }[] = [];
  for (const credit of credits) {
    if (left <= 0) break;
    const draw = Math.min(left, credit.remainingValueCents);
    if (draw <= 0) continue;
    draws.push({ credit, drawCents: draw });
    left -= draw;
  }
  return draws;
}

/** The balance an ordered list of entries produces. The projection's definition. */
export function projectBalance(entries: Pick<CreditEntryRow, 'deltaCents'>[]): number {
  return entries.reduce((sum, e) => sum + e.deltaCents, 0);
}

/**
 * The status a balance implies. Derived, so a credit can never sit at
 * `available` with nothing left on it.
 */
export function statusFor(
  credit: Pick<CreditRow, 'originalValueCents'>,
  remainingCents: number,
  expiresOn: Date,
  now: Date,
): CreditRow['status'] {
  // Expiry is checked first, and the order is the point: a swept credit lands at
  // a zero balance just as a spent one does, but `used` means we got the value
  // and `expired` means we lost it. Collapsing the two would erase the only
  // number that justifies this feature — how much we forfeit per year.
  if (expiresOn <= now) return 'expired';
  if (remainingCents <= 0) return 'used';
  return remainingCents < credit.originalValueCents ? 'partially_used' : 'available';
}

/** Days before expiry at which someone should hear about it. */
export const EXPIRY_BUCKETS_DAYS = [90, 60, 30, 14, 7, 1] as const;

const DAY_MS = 86_400_000;

export function daysUntil(expiresOn: Date, now: Date): number {
  return Math.floor((expiresOn.getTime() - now.getTime()) / DAY_MS);
}

/**
 * The tightest bucket this credit has crossed, or null if it is not close yet.
 *
 * Bucketing rather than "alert if under 30 days" is what stops the alert firing
 * every night for a month and training everyone to ignore it — the dedupe key
 * carries the bucket, so each threshold speaks exactly once.
 */
export function expiryBucket(expiresOn: Date, now: Date): number | null {
  const days = daysUntil(expiresOn, now);
  if (days < 0) return null;
  // The buckets are listed loosest first, so the *last* one that still contains
  // this credit is the tightest threshold it has crossed.
  return EXPIRY_BUCKETS_DAYS.filter((b) => days <= b).at(-1) ?? null;
}

/* -------------------------------- the ledger ------------------------------- */

export class CreditLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditLedgerError';
  }
}

/**
 * The credits a traveler could spend, newest facts first.
 *
 * Org-scoped as well as traveler-scoped: credits are the org's money held in a
 * person's name, and a query that forgets the org is one tenancy bug away from
 * spending someone else's. Transferable credits widen to the whole org, which is
 * the only reason that column exists.
 */
export async function creditPool(
  db: Db,
  args: { orgId: string; travelerId: string; now: Date },
): Promise<CreditRow[]> {
  const rows = await db
    .select()
    .from(s.ticketCredits)
    .where(
      and(
        eq(s.ticketCredits.orgId, args.orgId),
        or(
          eq(s.ticketCredits.userId, args.travelerId),
          eq(s.ticketCredits.transferable, true),
        ),
        inArray(s.ticketCredits.status, SPENDABLE),
        sql`${s.ticketCredits.remainingValueCents} > 0`,
      ),
    );
  return rows.filter((r) => isSpendable(r, args.now));
}

export type EntryInput = {
  credit: CreditRow;
  kind: CreditEntryRow['kind'];
  /** Signed. Positive adds value, negative removes it. */
  deltaCents: number;
  reason: string;
  bookingId?: string | null;
  travelRequestId?: string | null;
  costCenterId?: string | null;
  actorId?: string | null;
  actorKind?: string;
  now: Date;
};

/**
 * Append one movement and let the projection follow it.
 *
 * The entry is written first and the cached balance second, in that order on
 * purpose: if the process dies between them the ledger is still right and
 * `reconcile()` repairs the cache. The other order loses the reason for a
 * balance that already moved.
 */
export async function recordEntry(db: Db, input: EntryInput): Promise<CreditEntryRow> {
  const { credit, deltaCents, now } = input;
  const balanceAfter = credit.remainingValueCents + deltaCents;

  if (balanceAfter < 0) {
    throw new CreditLedgerError(
      `Credit ${credit.id} holds ${credit.remainingValueCents} cents; refusing an entry of ` +
        `${deltaCents} that would take it to ${balanceAfter}. A negative credit is not a thing ` +
        'an airline will honour.',
    );
  }
  if (balanceAfter > credit.originalValueCents) {
    throw new CreditLedgerError(
      `Credit ${credit.id} would rise to ${balanceAfter} cents, above the ${credit.originalValueCents} ` +
        'it was issued for. A credit cannot grow past the ticket that created it.',
    );
  }

  const [entry] = await db
    .insert(s.ticketCreditEntries)
    .values({
      creditId: credit.id,
      orgId: credit.orgId,
      kind: input.kind,
      deltaCents,
      balanceAfterCents: balanceAfter,
      currency: credit.currency,
      bookingId: input.bookingId ?? null,
      travelRequestId: input.travelRequestId ?? null,
      // Non-negotiable #7: at creation, never backfilled. Falls back to the
      // credit's own centre, which is where the original ticket was charged.
      costCenterId: input.costCenterId ?? credit.costCenterId,
      actorId: input.actorId ?? null,
      actorKind: input.actorKind ?? 'agent',
      reason: input.reason,
      occurredAt: now,
    })
    .returning();

  await db
    .update(s.ticketCredits)
    .set({
      remainingValueCents: balanceAfter,
      status: statusFor(credit, balanceAfter, credit.expiresOn, now),
    })
    .where(eq(s.ticketCredits.id, credit.id));

  return entry;
}

/**
 * Draw credits down against a booking that actually happened.
 *
 * `appliedCents` is the amount the *provider* took off the fare, not the amount
 * we hoped it would — the caller derives it from what was charged. Believing our
 * own intent here is how a ledger drifts from the airline's.
 *
 * Idempotent by construction: the unique index on (credit, booking, kind) means
 * a retried purchase cannot burn the same credit twice, and the conflict is
 * swallowed rather than raised because a retry is a normal event on this path.
 */
export async function applyCreditsToBooking(
  db: Db,
  args: {
    credits: CreditRow[];
    appliedCents: number;
    booking: typeof s.bookings.$inferSelect;
    travelRequestId: string;
    actorId?: string | null;
    now: Date;
  },
): Promise<{ appliedCents: number; entries: CreditEntryRow[] }> {
  if (args.appliedCents <= 0) return { appliedCents: 0, entries: [] };

  const already = await db
    .select({ id: s.ticketCreditEntries.id })
    .from(s.ticketCreditEntries)
    .where(
      and(
        eq(s.ticketCreditEntries.bookingId, args.booking.id),
        eq(s.ticketCreditEntries.kind, 'applied'),
      ),
    );
  if (already.length > 0) return { appliedCents: 0, entries: [] };

  const entries: CreditEntryRow[] = [];
  for (const { credit, drawCents } of allocate(args.credits, args.appliedCents)) {
    entries.push(
      await recordEntry(db, {
        credit,
        kind: 'applied',
        deltaCents: -drawCents,
        reason:
          `Applied to booking ${args.booking.providerOrderId} ` +
          `(${args.booking.provider}) on travel request ${args.travelRequestId}`,
        bookingId: args.booking.id,
        travelRequestId: args.travelRequestId,
        costCenterId: args.booking.costCenterId,
        actorId: args.actorId ?? null,
        now: args.now,
      }),
    );
  }

  const drawn = entries.reduce((sum, e) => sum + Math.abs(e.deltaCents), 0);
  await db
    .update(s.bookings)
    .set({ creditAppliedCents: drawn })
    .where(eq(s.bookings.id, args.booking.id));

  return { appliedCents: drawn, entries };
}

/**
 * Put credit back when the booking it paid for goes away.
 *
 * The carrier reinstates the coupon, so the ledger must too; a credit silently
 * consumed by a cancelled booking is the same forfeited money §5b exists to stop,
 * only now it is our bug rather than the airline's clock.
 */
export async function releaseCreditsForBooking(
  db: Db,
  args: { bookingId: string; reason: string; actorId?: string | null; now: Date },
): Promise<CreditEntryRow[]> {
  const applied = await db
    .select()
    .from(s.ticketCreditEntries)
    .where(
      and(
        eq(s.ticketCreditEntries.bookingId, args.bookingId),
        eq(s.ticketCreditEntries.kind, 'applied'),
      ),
    );

  const released: CreditEntryRow[] = [];
  for (const entry of applied) {
    const credit = await db.query.ticketCredits.findFirst({
      where: eq(s.ticketCredits.id, entry.creditId),
    });
    if (!credit) continue;
    // A release restores value; it does not resurrect an expired credit. The
    // status recomputes from the expiry date, so money returning to a credit
    // whose clock ran out is visible as `expired` rather than quietly spendable.
    released.push(
      await recordEntry(db, {
        credit,
        kind: 'released',
        deltaCents: Math.abs(entry.deltaCents),
        reason: args.reason,
        bookingId: null,
        travelRequestId: entry.travelRequestId,
        costCenterId: entry.costCenterId,
        actorId: args.actorId ?? null,
        now: args.now,
      }),
    );
  }
  return released;
}

/**
 * Turn a cancelled non-refundable ticket into a credit.
 *
 * This is the mechanism behind §5b's claim that we already hold every credit:
 * we booked it, so we know the ticket number, the carrier, and the value, and we
 * can write the row at the moment of cancellation instead of hoping someone
 * forwards the airline's email.
 *
 * `expiresOn` is required and never defaulted. Carrier expiry runs 6–24 months
 * and differs by fare, and a guessed date is worse than no date: it either
 * alarms people early or lets the money quietly expire while the ledger says it
 * is fine.
 */
export async function issueCreditFromCancellation(
  db: Db,
  args: {
    booking: typeof s.bookings.$inferSelect;
    orgId: string;
    travelerId: string;
    airlineCode: string;
    valueCents: number;
    expiresOn: Date;
    providerCreditId?: string | null;
    ticketNumber?: string | null;
    transferable?: boolean;
    actorId?: string | null;
    reason: string;
    now: Date;
  },
): Promise<{ credit: CreditRow; entry: CreditEntryRow }> {
  if (args.valueCents <= 0) {
    throw new CreditLedgerError(
      `Refusing to issue a credit worth ${args.valueCents} cents against booking ${args.booking.id}.`,
    );
  }
  if (args.expiresOn <= args.now) {
    throw new CreditLedgerError(
      `Credit for booking ${args.booking.id} would expire at ${args.expiresOn.toISOString()}, ` +
        'which is already past. Carrier expiry must be read from the carrier, not assumed.',
    );
  }

  const existing = await db.query.ticketCredits.findFirst({
    where: eq(s.ticketCredits.originBookingId, args.booking.id),
  });
  if (existing) {
    throw new CreditLedgerError(
      `Booking ${args.booking.id} already produced credit ${existing.id}. One cancelled ticket ` +
        'is one credit; issuing a second would invent money.',
    );
  }

  const [credit] = await db
    .insert(s.ticketCredits)
    .values({
      orgId: args.orgId,
      userId: args.travelerId,
      providerCreditId: args.providerCreditId ?? null,
      originBookingId: args.booking.id,
      airlineCode: args.airlineCode,
      recordLocator: args.booking.bookingReference,
      ticketNumber: args.ticketNumber ?? args.booking.ticketNumbers?.[0] ?? null,
      originalValueCents: args.valueCents,
      // Opens at zero and is moved by the `issued` entry, so even the first
      // dollar of a credit's life has a row explaining where it came from.
      remainingValueCents: 0,
      currency: args.booking.currency,
      issuedOn: args.now,
      expiresOn: args.expiresOn,
      status: 'available',
      transferable: args.transferable ?? false,
      costCenterId: args.booking.costCenterId,
    })
    .returning();

  const entry = await recordEntry(db, {
    credit,
    kind: 'issued',
    deltaCents: args.valueCents,
    reason: args.reason,
    bookingId: args.booking.id,
    costCenterId: args.booking.costCenterId,
    actorId: args.actorId ?? null,
    actorKind: args.actorId ? 'user' : 'agent',
    now: args.now,
  });

  return { credit: { ...credit, remainingValueCents: args.valueCents }, entry };
}

/**
 * Write off credits whose clock has run out.
 *
 * The write-off is an entry, not a status flip: the forfeited amount is the
 * number §5b is about, and a status change alone would leave "how much did we
 * lose to expiry last year" unanswerable — which is the question that justifies
 * this whole feature.
 */
export async function sweepExpiredCredits(
  db: Db,
  orgId: string,
  now: Date,
): Promise<{ credit: CreditRow; forfeitedCents: number }[]> {
  const rows = await db
    .select()
    .from(s.ticketCredits)
    .where(
      and(
        eq(s.ticketCredits.orgId, orgId),
        inArray(s.ticketCredits.status, SPENDABLE),
        sql`${s.ticketCredits.expiresOn} <= ${now}`,
      ),
    );

  const swept: { credit: CreditRow; forfeitedCents: number }[] = [];
  for (const credit of rows) {
    if (credit.remainingValueCents <= 0) continue;
    await recordEntry(db, {
      credit,
      kind: 'expired',
      deltaCents: -credit.remainingValueCents,
      reason:
        `Forfeited at expiry: ${credit.airlineCode} credit issued ` +
        `${credit.issuedOn.toISOString().slice(0, 10)} expired ${credit.expiresOn.toISOString().slice(0, 10)}`,
      actorKind: 'sweep',
      now,
    });
    swept.push({ credit, forfeitedCents: credit.remainingValueCents });
  }
  return swept;
}

/** Credits close enough to expiry that somebody should be told. */
export async function creditsExpiringSoon(
  db: Db,
  orgId: string,
  now: Date,
): Promise<{ credit: CreditRow; bucketDays: number; daysLeft: number }[]> {
  const rows = await db
    .select()
    .from(s.ticketCredits)
    .where(and(eq(s.ticketCredits.orgId, orgId), inArray(s.ticketCredits.status, SPENDABLE)));

  return rows
    .filter((c) => c.remainingValueCents > 0)
    .map((credit) => ({
      credit,
      bucketDays: expiryBucket(credit.expiresOn, now) ?? -1,
      daysLeft: daysUntil(credit.expiresOn, now),
    }))
    .filter((r) => r.bucketDays > 0)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * Check the cached balance against the entries that produced it.
 *
 * Cheap, and worth running wherever the number is about to be trusted: the whole
 * design rests on the projection agreeing with the ledger, and an assertion that
 * is never made is a comment.
 */
export async function reconcileCredit(
  db: Db,
  creditId: string,
): Promise<{ credit: CreditRow; ledgerCents: number; cachedCents: number; ok: boolean }> {
  const credit = await db.query.ticketCredits.findFirst({
    where: eq(s.ticketCredits.id, creditId),
  });
  if (!credit) throw new CreditLedgerError(`Credit ${creditId} not found`);

  const entries = await db
    .select({ deltaCents: s.ticketCreditEntries.deltaCents })
    .from(s.ticketCreditEntries)
    .where(eq(s.ticketCreditEntries.creditId, creditId));

  const ledgerCents = projectBalance(entries);
  return {
    credit,
    ledgerCents,
    cachedCents: credit.remainingValueCents,
    ok: ledgerCents === credit.remainingValueCents,
  };
}

/** The org's exposure, split the way a travel manager needs to see it. */
export async function creditExposure(
  db: Db,
  orgId: string,
  now: Date,
): Promise<{
  liveCents: number;
  expiringWithin30Cents: number;
  forfeitedCents: number;
  redeemableElsewhereCents: number;
}> {
  const rows = await db.select().from(s.ticketCredits).where(eq(s.ticketCredits.orgId, orgId));
  const live = rows.filter((c) => isSpendable(c, now));

  const forfeited = await db
    .select({ total: sql<number>`coalesce(sum(-${s.ticketCreditEntries.deltaCents}), 0)` })
    .from(s.ticketCreditEntries)
    .where(
      and(eq(s.ticketCreditEntries.orgId, orgId), eq(s.ticketCreditEntries.kind, 'expired')),
    );

  return {
    liveCents: live.reduce((sum, c) => sum + c.remainingValueCents, 0),
    expiringWithin30Cents: live
      .filter((c) => daysUntil(c.expiresOn, now) <= 30)
      .reduce((sum, c) => sum + c.remainingValueCents, 0),
    forfeitedCents: Number(forfeited[0]?.total ?? 0),
    redeemableElsewhereCents: live
      .filter((c) => visibilityOf(c) === 'redeemable_elsewhere')
      .reduce((sum, c) => sum + c.remainingValueCents, 0),
  };
}

/**
 * The nightly job: write off what expired, warn about what is about to.
 *
 * Order matters. The sweep runs first so a credit that died overnight is written
 * off rather than announced as "expires in 0 days", which would send people to
 * an airline that will not honour it.
 */
export async function runCreditMaintenance(
  db: Db,
  orgId: string,
  now: Date,
): Promise<{ forfeitedCents: number; sweptCount: number; alertsSent: number; warned: number }> {
  const swept = await sweepExpiredCredits(db, orgId, now);
  const expiring = await creditsExpiringSoon(db, orgId, now);
  const alertsSent = await notifyExpiringCredits(db, { orgId, expiring, now });

  return {
    forfeitedCents: swept.reduce((sum, x) => sum + x.forfeitedCents, 0),
    sweptCount: swept.length,
    alertsSent,
    warned: expiring.length,
  };
}
