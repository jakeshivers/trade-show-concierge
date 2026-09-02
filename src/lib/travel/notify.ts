import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '@/db';
import * as s from '@/db/schema';
import { plural } from '@/lib/text';
import { recordNotices, syncConditionAlerts, type AlertWrite } from '@/lib/alerts/store';

/**
 * Ticketing notifications. SCOPE.md §6c rail 6: every purchase notifies the
 * traveler and a Travel Manager *at the moment of ticketing*, not on a digest.
 *
 * There is no email or Slack transport yet, so these land in the `alerts` table
 * — which is the right first stop regardless: an alert row is the durable record
 * that the notification was owed, and a transport that fails later cannot erase
 * it. Step 21 adds Slack behind this same call.
 *
 * The dedupe key is per booking, so a retried ticketing writes one alert per
 * recipient rather than a pile.
 *
 * Two of the three below are **notices** and one is a **condition**, which is
 * the distinction step 17 had to draw before a feed could exist. A ticket was
 * bought and a credit was missed at the moment of a purchase: both happened, at
 * an instant, and no later state of the world makes either untrue, so nothing
 * ever resolves them. A credit *approaching expiry* is a claim about right now
 * that ends when the credit is spent — and a feed that could not tell those
 * apart would either nag about a ticket bought in March forever, or quietly
 * close a warning about money that is still about to evaporate.
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

  await recordNotices(db, {
    orgId,
    source: 'booking',
    now,
    writes: recipients.map((r) => ({
      showId,
      userId: r.userId,
      severity: 'info' as const,
      title: r.title,
      body: r.body,
      dedupeKey: `booking:${booking.id}:ticketed:${r.userId}`,
    })),
  });

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

  const writes: AlertWrite[] = [];
  for (const credit of credits) {
    for (const userId of recipients) {
      writes.push({
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
      });
    }
  }

  // A notice, not a condition: this is a report of what happened at the moment
  // of one purchase. The credit may well still be sitting there tomorrow, and
  // the *expiry* warning below is the row that says so — this one is about a
  // cash payment that has already been made.
  return recordNotices(db, { orgId, source: 'credit', writes, now });
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
): Promise<{ raised: number; resolved: number }> {
  const { orgId, expiring, now } = args;
  // No early return on an empty list: nothing expiring is the *good* case, and
  // it is also the case where yesterday's warnings have to be taken down.

  const managers = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  const writes: AlertWrite[] = [];
  for (const { credit, bucketDays, daysLeft } of expiring) {
    const audience = [
      credit.userId,
      ...managers.map((m) => m.id).filter((id) => id !== credit.userId),
    ];
    for (const userId of audience) {
      writes.push({
        showId: null,
        userId,
        // Under two weeks this stops being a reminder and starts being a loss.
        severity: bucketDays <= 14 ? 'warning' : 'info',
        title: `${usd(credit.remainingValueCents)} ${credit.airlineCode} credit expires in ${plural(daysLeft, 'day', 'days')}`,
        body:
          `Issued ${day(credit.issuedOn)}, expires ${day(credit.expiresOn)}. ` +
          (credit.providerCreditId
            ? 'The booking agent will apply it automatically to a matching itinerary.'
            : 'It is not redeemable through our booking provider — book with the airline directly to use it.'),
        dedupeKey: `credit:${credit.id}:expiry:${bucketDays}:${userId}`,
      });
    }
  }

  // `creditsExpiringSoon` states the current bucket for every live credit in the
  // org, which is what makes absence meaningful: a credit that gets spent, or
  // one whose bucket has tightened from 90 days to 60, drops out of this list
  // and the row it left behind is closed rather than left standing beside its
  // own successor.
  return syncConditionAlerts(db, { orgId, source: 'credit', writes, now });
}
