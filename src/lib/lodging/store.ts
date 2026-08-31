import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { NotFoundError } from '@/lib/shows/store';
import { travelerScope } from '@/lib/shows/visibility';
import { summarizeExposure, type AlertableDeadline } from '@/lib/deadlines/alerts';
import { canAssignRoom, canManageLodging } from './access';
import {
  LodgingError,
  roomBlockDeadlineTitle,
  validateLodging,
  type LodgingDraft,
} from './edit';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of lodging — and the one place in this step where a *second*
 * feature's engine gets reused rather than reimplemented.
 *
 * **Two clocks for one date is how the date gets missed.** §4 makes
 * `room_block_cutoff` first-class because missing it is among the most expensive
 * routine mistakes in this business; §5a built an engine whose entire job is to
 * escalate exactly that kind of date, with thresholds, an audience, a tense, and
 * a dedupe key that voids itself when the date moves. The obvious thing to build
 * here — a room-block warning on the lodging screen — would be a second, weaker
 * copy of that engine, firing on a different schedule, into a different place,
 * with no exposure figure and no dedupe. And the two would disagree: this is a
 * date somebody has to *act* on, and whichever screen the person is not looking
 * at is the one holding the version they needed.
 *
 * So a lodging row with a cutoff **owns a deadline row**. `show_deadlines.
 * lodging_id` marks it as derived; the date is edited on the lodging record and
 * nowhere else; and everything the register already knows how to do — assign an
 * owner, quote a penalty once a human confirms it, alert at T-30/14/3, count the
 * money as incurred once the date has passed — comes for free and is correct
 * without a line of new alert logic.
 *
 * Two properties fall out of that composition, both wanted, neither designed:
 * moving the cutoff moves the deadline, which withdraws its confirmation
 * (`deadlines/store.ts`); and a derived row arrives unowned, which the engine
 * escalates to the show runners rather than silently addressing to nobody
 * (`alerts.ts`, correction 3).
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError();
  return show;
}

async function requireLodging(actor: Actor, lodgingId: string, db: Db) {
  const [row] = await db
    .select({ lodging: s.lodgings, show: s.shows })
    .from(s.lodgings)
    .innerJoin(s.shows, eq(s.lodgings.showId, s.shows.id))
    .where(and(eq(s.lodgings.id, lodgingId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('lodging');
  return row;
}

async function requireCostCenter(actor: Actor, costCenterId: string, db: Db) {
  const cc = await db.query.costCenters.findFirst({
    where: and(eq(s.costCenters.id, costCenterId), eq(s.costCenters.orgId, actor.orgId)),
  });
  if (!cc) throw new NotFoundError('cost center');
  return cc;
}

/* ---------------------------------- read ----------------------------------- */

export type LodgingEntry = {
  lodging: typeof s.lodgings.$inferSelect;
  costCenter: { id: string; code: string; name: string } | null;
  guests: { id: string; userId: string; fullName: string }[];
  /**
   * True when the guest list was filtered to the actor — a Member sees their own
   * room assignment, not the whole floor plan. `shows/store.ts` does the same.
   */
  guestsNarrowed: boolean;
  /** The register row this cutoff owns, if it has one. */
  deadline: typeof s.showDeadlines.$inferSelect | null;
  /** Nights × rate, or null when either is unknown — never a partial guess. */
  estimatedCents: number | null;
  nights: number | null;
  /** Roster members not already in this room block. */
  assignable: { id: string; fullName: string }[];
};

export type LodgingBoard = {
  show: typeof s.shows.$inferSelect;
  entries: LodgingEntry[];
  people: { id: string; fullName: string }[];
  costCenters: { id: string; code: string; name: string }[];
  /** The cutoff exposure, from the same model the register and portfolio use. */
  cutoffExposure: ReturnType<typeof summarizeExposure>;
  may: { manage: boolean };
};

export async function getLodgingBoard(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<LodgingBoard> {
  const show = await requireShow(actor, showId, db);
  const scope = travelerScope(actor);
  const mineOnly = scope.kind === 'self';

  const [rows, roster, costCenters] = await Promise.all([
    db
      .select({ lodging: s.lodgings, costCenter: s.costCenters })
      .from(s.lodgings)
      .leftJoin(s.costCenters, eq(s.lodgings.costCenterId, s.costCenters.id))
      .where(eq(s.lodgings.showId, showId))
      .orderBy(asc(s.lodgings.hotelName)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.showAttendees)
      .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
      .where(eq(s.showAttendees.showId, showId))
      .orderBy(asc(s.users.fullName)),
    db
      .select({ id: s.costCenters.id, code: s.costCenters.code, name: s.costCenters.name })
      .from(s.costCenters)
      .where(eq(s.costCenters.orgId, actor.orgId))
      .orderBy(asc(s.costCenters.code)),
  ]);

  const ids = rows.map((r) => r.lodging.id);
  const [guests, deadlines] = await Promise.all([
    ids.length
      ? db
          .select({ guest: s.lodgingGuests, user: s.users })
          .from(s.lodgingGuests)
          .innerJoin(s.users, eq(s.lodgingGuests.userId, s.users.id))
          .where(inArray(s.lodgingGuests.lodgingId, ids))
          .orderBy(asc(s.users.fullName))
      : [],
    ids.length
      ? db.select().from(s.showDeadlines).where(inArray(s.showDeadlines.lodgingId, ids))
      : [],
  ]);

  const entries = rows.map(({ lodging, costCenter }): LodgingEntry => {
    const all = guests.filter((g) => g.guest.lodgingId === lodging.id);
    const visible = all.filter((g) => !mineOnly || g.user.id === scope.userId);
    const assignedIds = new Set(all.map((g) => g.user.id));
    const nights =
      lodging.checkIn && lodging.checkOut
        ? Math.max(
            1,
            Math.round((lodging.checkOut.getTime() - lodging.checkIn.getTime()) / 86_400_000),
          )
        : null;

    return {
      lodging,
      costCenter,
      guests: visible.map((g) => ({
        id: g.guest.id,
        userId: g.user.id,
        fullName: g.user.fullName,
      })),
      guestsNarrowed: mineOnly && all.length !== visible.length,
      deadline: deadlines.find((d) => d.lodgingId === lodging.id) ?? null,
      // Rooms × nights × rate would be the real figure and we do not model rooms;
      // one row is one reservation, so this is per-reservation and says so on the
      // screen rather than presenting a total the finance team would dispute.
      estimatedCents: nights !== null && lodging.nightlyRateCents !== null
        ? nights * lodging.nightlyRateCents
        : null,
      nights,
      assignable: roster.filter((p) => !assignedIds.has(p.id)),
    };
  });

  const alertable: AlertableDeadline[] = deadlines.map((d) => ({ ...d }));

  return {
    show,
    entries,
    people: roster,
    costCenters,
    cutoffExposure: summarizeExposure(alertable, asOf),
    may: { manage: canManageLodging(actor) },
  };
}

/* --------------------------------- writes ---------------------------------- */

function instant(local: string | null, timezone: string): Date | null {
  return local === null ? null : zonedToInstant(local, timezone);
}

export async function addLodging(
  actor: Actor,
  showId: string,
  draft: LodgingDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ id: string }> {
  if (!canManageLodging(actor)) throw new ForbiddenError('add lodging');
  const show = await requireShow(actor, showId, db);
  const valid = validateLodging(draft);
  await requireCostCenter(actor, valid.costCenterId, db);

  const [row] = await db
    .insert(s.lodgings)
    .values({
      showId,
      hotelName: valid.hotelName,
      address: valid.address,
      phone: valid.phone,
      confirmationCode: valid.confirmationCode,
      checkIn: instant(valid.checkInLocal, show.timezone),
      checkOut: instant(valid.checkOutLocal, show.timezone),
      nightlyRateCents: valid.nightlyRateCents,
      roomBlockCutoff: instant(valid.roomBlockCutoffLocal, show.timezone),
      costCenterId: valid.costCenterId,
      notes: valid.notes,
      updatedAt: now,
    })
    .returning({ id: s.lodgings.id });

  await syncRoomBlockDeadline(row.id, showId, valid.hotelName, instant(valid.roomBlockCutoffLocal, show.timezone), now, db);
  return row;
}

export async function editLodging(
  actor: Actor,
  lodgingId: string,
  draft: LodgingDraft,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canManageLodging(actor)) throw new ForbiddenError('edit lodging');
  const { lodging, show } = await requireLodging(actor, lodgingId, db);
  const valid = validateLodging(draft);
  await requireCostCenter(actor, valid.costCenterId, db);

  const cutoff = instant(valid.roomBlockCutoffLocal, show.timezone);

  await db
    .update(s.lodgings)
    .set({
      hotelName: valid.hotelName,
      address: valid.address,
      phone: valid.phone,
      confirmationCode: valid.confirmationCode,
      checkIn: instant(valid.checkInLocal, show.timezone),
      checkOut: instant(valid.checkOutLocal, show.timezone),
      nightlyRateCents: valid.nightlyRateCents,
      roomBlockCutoff: cutoff,
      costCenterId: valid.costCenterId,
      notes: valid.notes,
      updatedAt: now,
    })
    .where(eq(s.lodgings.id, lodging.id));

  await syncRoomBlockDeadline(lodging.id, lodging.showId, valid.hotelName, cutoff, now, db);
}

export async function deleteLodging(
  actor: Actor,
  lodgingId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canManageLodging(actor)) throw new ForbiddenError('delete lodging');
  const { lodging } = await requireLodging(actor, lodgingId, db);
  // The derived deadline cascades with it — a room block cutoff for a hotel we
  // are no longer using is a date nobody should be chased about.
  await db.delete(s.lodgings).where(eq(s.lodgings.id, lodging.id));
}

/**
 * Keep the derived register row in step with the cutoff.
 *
 * Deliberately *not* an upsert of everything: owner, penalty estimate, status
 * and confirmation are the register's to hold, and re-saving a hotel's phone
 * number must not reset who owns the deadline or wipe a confirmation. Only the
 * date and the title — the two things the lodging row is the source of — are
 * written, and only the date being different is allowed to un-confirm anything.
 */
async function syncRoomBlockDeadline(
  lodgingId: string,
  showId: string,
  hotelName: string,
  cutoff: Date | null,
  now: Date,
  db: Db,
): Promise<void> {
  const existing = await db.query.showDeadlines.findFirst({
    where: eq(s.showDeadlines.lodgingId, lodgingId),
  });

  if (cutoff === null) {
    if (existing) await db.delete(s.showDeadlines).where(eq(s.showDeadlines.id, existing.id));
    return;
  }

  if (!existing) {
    await db.insert(s.showDeadlines).values({
      showId,
      lodgingId,
      kind: 'room_block',
      title: roomBlockDeadlineTitle(hotelName),
      dueAt: cutoff,
      // No penalty figure: what a blown room block costs is the difference
      // between the block rate and whatever is left in town that week, which
      // nobody knows in advance. §5a's rule is that an unconfirmed date is
      // chased as a date and never quoted as an amount, and this row is a date
      // somebody typed off a contract — so it arrives unconfirmed, like every
      // other hand-entered deadline.
      penaltyEstimateCents: null,
      penaltyNote:
        'Missing a room block does not bill a surcharge — it drops the whole party to walk-up ' +
        'rates in a city that is sold out that week. Set an estimate here once somebody has ' +
        'priced the alternative.',
      ownerId: null,
      confirmedAt: null,
      updatedAt: now,
    });
    return;
  }

  const moved = existing.dueAt.getTime() !== cutoff.getTime();
  await db
    .update(s.showDeadlines)
    .set({
      title: roomBlockDeadlineTitle(hotelName),
      dueAt: cutoff,
      // Same rule as `editDeadline`: a date that moved is a date nobody has
      // checked. Confirmation is an assertion about one specific date.
      ...(moved ? { confirmedAt: null, confirmedById: null } : {}),
      updatedAt: now,
    })
    .where(eq(s.showDeadlines.id, existing.id));
}

/* ---------------------------------- guests --------------------------------- */

export async function assignRoom(
  actor: Actor,
  lodgingId: string,
  userId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canAssignRoom(actor)) throw new ForbiddenError('assign a hotel room');
  const { lodging } = await requireLodging(actor, lodgingId, db);

  const user = await db.query.users.findFirst({
    where: and(eq(s.users.id, userId), eq(s.users.orgId, actor.orgId)),
  });
  if (!user) throw new NotFoundError('user');

  await db
    .insert(s.lodgingGuests)
    .values({ lodgingId: lodging.id, userId })
    .onConflictDoNothing();
}

export async function unassignRoom(
  actor: Actor,
  lodgingId: string,
  userId: string,
  db: Db = getDb(),
): Promise<void> {
  if (!canAssignRoom(actor)) throw new ForbiddenError('unassign a hotel room');
  const { lodging } = await requireLodging(actor, lodgingId, db);
  await db
    .delete(s.lodgingGuests)
    .where(and(eq(s.lodgingGuests.lodgingId, lodging.id), eq(s.lodgingGuests.userId, userId)));
}

export { LodgingError };
