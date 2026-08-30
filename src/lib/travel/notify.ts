import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '@/db';
import * as s from '@/db/schema';

/**
 * Ticketing notifications. SCOPE.md §6c rail 6: every purchase notifies the
 * traveler and a Travel Manager *at the moment of ticketing*, not on a digest.
 *
 * There is no email or Slack transport yet, so these land in the `alerts` table
 * — which is the right first stop regardless: an alert row is the durable record
 * that the notification was owed, and a transport that fails later cannot erase
 * it. Step 20 adds Slack behind this same call.
 *
 * The dedupe key is per booking, so a retried ticketing writes one alert per
 * recipient rather than a pile.
 */

type Db = ReturnType<typeof getDb>;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function notifyTicketed(
  db: Db,
  args: {
    orgId: string;
    showId: string | null;
    travelerId: string;
    booking: typeof s.bookings.$inferSelect;
    request: typeof s.travelRequests.$inferSelect;
    now: Date;
  },
): Promise<number> {
  const { orgId, showId, travelerId, booking, request, now } = args;

  const traveler = await db.query.users.findFirst({ where: eq(s.users.id, travelerId) });
  const managers = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  const route = `${request.originAirport} → ${request.destinationAirport}`;
  const amount = usd(booking.chargedCents ?? 0);
  // A dry run notifies too. If it did not, the notification path would be
  // untested until the first real purchase — which is the one that must not
  // silently fail to tell anyone.
  const prefix = booking.live ? '' : '[dry run] ';

  const recipients = [
    {
      userId: travelerId,
      title: `${prefix}Your flight is ticketed: ${route}`,
      body:
        `${route} for ${amount}` +
        (booking.bookingReference ? `, confirmation ${booking.bookingReference}` : '') +
        (booking.ticketNumbers?.length ? `, ticket ${booking.ticketNumbers.join(', ')}` : ''),
    },
    ...managers
      .filter((m) => m.id !== travelerId)
      .map((m) => ({
        userId: m.id,
        title: `${prefix}Flight purchased for ${traveler?.fullName ?? 'a traveler'}: ${route}`,
        body: `${amount} on ${booking.provider}, order ${booking.providerOrderId}.`,
      })),
  ];

  for (const r of recipients) {
    await db
      .insert(s.alerts)
      .values({
        orgId,
        showId,
        userId: r.userId,
        severity: 'info',
        title: r.title,
        body: r.body,
        dedupeKey: `booking:${booking.id}:ticketed:${r.userId}`,
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  return recipients.length;
}

/* --------------------------------- credits --------------------------------- */

type CreditRow = typeof s.ticketCredits.$inferSelect;

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Tell people about credit the agent found but could not spend. SCOPE.md §5b.
 *
 * This fires at the moment of purchase, which is the only moment it is useful:
 * the org is about to spend cash it did not have to, and afterwards the message
 * is just a reproach. A person has to phone the airline to redeem these, so the
 * alert carries the record locator and ticket number they will be asked for.
 *
 * Deduped per credit per travel request, so a re-priced or re-approved request
 * does not send the same warning three times.
 */
export async function notifyUnreachableCredit(
  db: Db,
  args: {
    orgId: string;
    showId: string | null;
    travelerId: string;
    credits: CreditRow[];
    requestId: string;
    now: Date;
  },
): Promise<number> {
  const { orgId, showId, travelerId, credits, requestId, now } = args;
  if (credits.length === 0) return 0;

  const managers = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));
  const recipients = [travelerId, ...managers.map((m) => m.id).filter((id) => id !== travelerId)];

  let sent = 0;
  for (const credit of credits) {
    for (const userId of recipients) {
      const written = await db
        .insert(s.alerts)
        .values({
          orgId,
          showId,
          userId,
          severity: 'warning',
          title: `${usd(credit.remainingValueCents)} of ${credit.airlineCode} credit went unused`,
          body:
            `This purchase paid cash while ${usd(credit.remainingValueCents)} of ${credit.airlineCode} ` +
            `credit sits unused, expiring ${day(credit.expiresOn)}. It is not redeemable through our ` +
            'booking provider — recover it directly with the airline' +
            (credit.ticketNumber ? `, ticket ${credit.ticketNumber}` : '') +
            (credit.recordLocator ? `, record locator ${credit.recordLocator}` : '') +
            '.',
          dedupeKey: `credit:${credit.id}:unreachable:${requestId}:${userId}`,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: s.alerts.id });
      sent += written.length;
    }
  }
  return sent;
}

/**
 * Expiry warnings, one per threshold crossed.
 *
 * The dedupe key carries the bucket rather than the date, so a credit speaks
 * once at 90 days, once at 60, and so on. An alert that repeats nightly for a
 * month teaches everyone to ignore it, which is the failure mode this whole
 * feature exists to prevent.
 */
export async function notifyExpiringCredits(
  db: Db,
  args: {
    orgId: string;
    expiring: { credit: CreditRow; bucketDays: number; daysLeft: number }[];
    now: Date;
  },
): Promise<number> {
  const { orgId, expiring, now } = args;
  if (expiring.length === 0) return 0;

  const managers = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  let sent = 0;
  for (const { credit, bucketDays, daysLeft } of expiring) {
    const audience = [
      credit.userId,
      ...managers.map((m) => m.id).filter((id) => id !== credit.userId),
    ];
    for (const userId of audience) {
      const written = await db
        .insert(s.alerts)
        .values({
          orgId,
          showId: null,
          userId,
          // Under two weeks this stops being a reminder and starts being a loss.
          severity: bucketDays <= 14 ? 'warning' : 'info',
          title: `${usd(credit.remainingValueCents)} ${credit.airlineCode} credit expires in ${daysLeft} day(s)`,
          body:
            `Issued ${day(credit.issuedOn)}, expires ${day(credit.expiresOn)}. ` +
            (credit.providerCreditId
              ? 'The booking agent will apply it automatically to a matching itinerary.'
              : 'It is not redeemable through our booking provider — book with the airline directly to use it.'),
          dedupeKey: `credit:${credit.id}:expiry:${bucketDays}:${userId}`,
          createdAt: now,
        })
        .onConflictDoNothing()
        // Count what was written, not what was attempted. The dedupe is the
        // whole feature here, so a caller reporting "6 alerts sent" on a repeat
        // run would be reporting the opposite of what happened.
        .returning({ id: s.alerts.id });
      sent += written.length;
    }
  }
  return sent;
}
