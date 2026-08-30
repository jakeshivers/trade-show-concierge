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
