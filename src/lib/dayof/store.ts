import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { getShipmentBoard } from '@/lib/shipping/store';
import { coverageFor, type AssignedStaff, type Shift } from '@/lib/team/coverage';
import { captureLead, recordMeeting } from '@/lib/leads/store';
import { LeadError, validateMeeting } from '@/lib/leads/edit';
import { canManageTargets } from './access';
import { isDeviceRef, type QueuedItem, type SyncOutcome } from './outbox';
import {
  crateLine,
  SNAPSHOT_VERSION,
  type DaySnapshot,
  type SnapshotCrate,
  type SnapshotShift,
} from './snapshot';
import { targetStandings, type TargetAccount, type TargetStanding } from './targets';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of day-of.
 *
 * Two jobs, and they are the two halves of offline: build one object a device
 * can live on, and accept back a queue of things that happened while it was
 * alone.
 *
 * **The snapshot is a fixed number of queries and it is the whole screen.** Not
 * because of load — it is one show — but because a device that has to make six
 * requests to render is a device that renders one sixth of a page on a floor
 * with two bars. Everything the screen needs arrives together or not at all, and
 * `capturedAt` is stamped once so every figure on it shares an instant. A screen
 * assembled from four responses taken forty seconds apart has no such instant,
 * and the freshness line at the top of it would be a lie about the oldest part.
 *
 * **The sync path writes through the existing store functions, as the actor.**
 * `captureLead` and `recordMeeting` are called exactly as the form calls them —
 * same validation, same dedupe, same consent rules, same permission check. The
 * alternative, a leaner insert for the offline path, is how an offline lead ends
 * up with a lawful basis nobody chose. Step 15 settled the general form of this:
 * the access model is the set of functions you are allowed to call, not a
 * sentence about what you may do.
 *
 * Org-scoped through the show, like leads and shipping.
 */

async function requireShow(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');
  return show;
}

/* -------------------------------- the snapshot ------------------------------ */

/**
 * The shows worth opening this screen for.
 *
 * Deliberately not "shows I am staffed on". §3's correction at step 8 —
 * "see own shows" scopes travel, not the calendar — and here it has a second,
 * operational half: the person who ends up covering a shift at nine in the
 * morning is regularly not the person on the roster at eight.
 *
 * Ordered by how close the show is to being *now*, which is the only ordering
 * this screen has any use for.
 */
export async function listDayOfShows(actor: Actor, now: Date = new Date(), db: Db = getDb()) {
  const rows = await db
    .select({
      id: s.shows.id,
      name: s.shows.name,
      status: s.shows.status,
      city: s.shows.city,
      timezone: s.shows.timezone,
      startsOn: s.shows.startsOn,
      endsOn: s.shows.endsOn,
      moveInAt: s.shows.moveInAt,
      boothNumber: s.shows.boothNumber,
    })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId))
    .orderBy(asc(s.shows.startsOn));

  const DAY = 86_400_000;
  return rows
    .filter((r) => r.status !== 'cancelled' && r.status !== 'prospect')
    .map((r) => {
      const opensAt = (r.moveInAt ?? r.startsOn).getTime();
      const closesAt = r.endsOn.getTime() + DAY;
      const onFloorNow = now.getTime() >= opensAt && now.getTime() <= closesAt;
      return { ...r, onFloorNow, distanceMs: Math.abs(opensAt - now.getTime()) };
    })
    .sort((a, b) => {
      if (a.onFloorNow !== b.onFloorNow) return a.onFloorNow ? -1 : 1;
      return a.distanceMs - b.distanceMs;
    });
}

async function loadTargets(showId: string, db: Db): Promise<TargetAccount[]> {
  const rows = await db
    .select({ target: s.showTargets, owner: s.users })
    .from(s.showTargets)
    .leftJoin(s.users, eq(s.showTargets.ownerId, s.users.id))
    .where(eq(s.showTargets.showId, showId))
    .orderBy(asc(s.showTargets.companyName));
  return rows.map((r) => ({
    id: r.target.id,
    companyName: r.target.companyName,
    aliases: r.target.aliases ?? [],
    priority: r.target.priority,
    reason: r.target.reason,
    ownerId: r.target.ownerId,
    ownerName: r.owner?.fullName ?? null,
  }));
}

/**
 * The leads a snapshot carries, and the one field it deliberately does not.
 *
 * A target standing needs a company name and a capture instant, and nothing
 * else — so that is what goes to the device: no email, no phone, no notes. §5j's
 * data minimisation, and it happens to be the right call for the medium as well.
 * A phone in a lanyard on a show floor is the most losable computer anybody
 * owns, and a cache of four hundred strangers' phone numbers on it is a breach
 * waiting for a taxi.
 *
 * Names *are* carried, because "Lakeside Manufacturing — Dana Whitfield, 10:14"
 * is the sentence that stops a second person having the same conversation, and a
 * company with no name under it does not.
 */
async function loadLeads(showId: string, db: Db) {
  return db
    .select({
      id: s.leads.id,
      fullName: s.leads.fullName,
      company: s.leads.company,
      capturedAt: s.leads.capturedAt,
      capturedByName: s.users.fullName,
      duplicateOfId: s.leads.duplicateOfId,
      redactedAt: s.leads.redactedAt,
    })
    .from(s.leads)
    .leftJoin(s.users, eq(s.leads.capturedById, s.users.id))
    .where(eq(s.leads.showId, showId))
    .orderBy(desc(s.leads.capturedAt));
}

async function loadShifts(showId: string, db: Db): Promise<Shift[]> {
  const [shiftRows, attendeeRows] = await Promise.all([
    db.select().from(s.boothShifts).where(eq(s.boothShifts.showId, showId)).orderBy(asc(s.boothShifts.startsAt)),
    db
      .select({ attendee: s.showAttendees, user: s.users })
      .from(s.showAttendees)
      .innerJoin(s.users, eq(s.showAttendees.userId, s.users.id))
      .where(eq(s.showAttendees.showId, showId)),
  ]);
  const shiftIds = shiftRows.map((r) => r.id);
  const [assignments, presence] = await Promise.all([
    shiftIds.length
      ? db
          .select({ assignment: s.shiftAssignments, user: s.users })
          .from(s.shiftAssignments)
          .innerJoin(s.users, eq(s.shiftAssignments.userId, s.users.id))
          .where(inArray(s.shiftAssignments.shiftId, shiftIds))
      : [],
    shiftIds.length
      ? db.select().from(s.shiftPresence).where(inArray(s.shiftPresence.shiftId, shiftIds))
      : [],
  ]);

  const roster = new Map(attendeeRows.map((r) => [r.attendee.userId, r]));
  return shiftRows.map((shift) => {
    const assigned: AssignedStaff[] = assignments
      .filter((a) => a.assignment.shiftId === shift.id)
      .map((a) => {
        const entry = roster.get(a.user.id);
        return {
          userId: a.user.id,
          fullName: a.user.fullName,
          attendeeStatus: entry?.attendee.status ?? null,
          respondedAt: entry?.attendee.respondedAt ?? null,
          arrivesOn: entry?.attendee.arrivesOn ?? null,
          departsOn: entry?.attendee.departsOn ?? null,
        };
      });
    return {
      id: shift.id,
      showId,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      targetStaff: shift.targetStaff,
      notes: shift.notes,
      assigned,
      presentUserIds: presence.filter((p) => p.shiftId === shift.id).map((p) => p.userId),
    };
  });
}

/** A first name is what somebody reads at a glance on a phone. */
function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}

/**
 * Everything the day-of screen needs, in one object, stamped with one instant.
 *
 * `asOf` is threaded rather than read from the clock inside each helper, for the
 * reason above: every figure here has to be true at the same moment, or the
 * freshness line is a claim about the newest part of a screen whose oldest part
 * is what will hurt somebody.
 */
export async function buildSnapshot(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<DaySnapshot> {
  const show = await requireShow(actor, showId, db);

  const [shifts, board, leads, targets] = await Promise.all([
    loadShifts(showId, db),
    getShipmentBoard(actor, { showId, asOf }, db),
    loadLeads(showId, db),
    loadTargets(showId, db),
  ]);

  const snapshotShifts: SnapshotShift[] = shifts.map((shift) => {
    const coverage = coverageFor(shift, asOf);
    return {
      id: shift.id,
      startsAt: shift.startsAt.toISOString(),
      endsAt: shift.endsAt.toISOString(),
      targetStaff: shift.targetStaff,
      assignedCount: coverage.assignedCount,
      effectiveCount: coverage.effectiveCount,
      overstated: coverage.overstated,
      mine: shift.assigned.some((a) => a.userId === actor.userId),
      // Only the people who can actually work it. A name on this list is a
      // person you can turn to; `standingFor` already decided which those are,
      // and re-listing everybody assigned would put the shift's holes back on
      // the screen wearing the costume of colleagues.
      staff: coverage.standings.filter((st) => st.counts).map((st) => firstName(st.fullName)),
    };
  });

  const crates: SnapshotCrate[] = board.rows.map((row) => {
    const line = crateLine({
      status: row.status,
      window: row.window.standing,
      stalledHours: row.stall.kind === 'stalled' ? row.stall.sinceHours : null,
      neverScanned: row.stall.kind === 'never_scanned',
      deliveredAt: row.shipment.deliveredAt,
      receivedAt: row.shipment.receivedAt,
      hasTracking: row.shipment.trackingNumber !== null,
    });
    return {
      id: row.shipment.id,
      description: row.shipment.description,
      direction: row.shipment.direction,
      consignment: row.shipment.consignment,
      standing: line.standing,
      standingTone: line.tone,
      derivedFrom: line.derivedFrom,
      lastScan: row.shipment.lastScanAt
        ? { at: row.shipment.lastScanAt.toISOString(), description: '', location: null }
        : null,
      trackingNumber: row.shipment.trackingNumber,
      receivedAt: row.shipment.receivedAt?.toISOString() ?? null,
      mayConfirm: row.shipment.deliveredAt !== null && row.shipment.receivedAt === null,
    };
  });

  return {
    version: SNAPSHOT_VERSION,
    capturedAt: asOf.toISOString(),
    actorId: actor.userId,
    show: {
      id: show.id,
      name: show.name,
      timezone: show.timezone,
      boothNumber: show.boothNumber,
      venueName: show.venueName,
      city: show.city,
      startsOn: show.startsOn.toISOString(),
      endsOn: show.endsOn.toISOString(),
      moveInAt: show.moveInAt?.toISOString() ?? null,
    },
    shifts: snapshotShifts,
    crates,
    leads: leads
      // A redacted lead keeps its shell so the count does not move, and its name
      // is gone. Sending the shell to a device would render a row of nothing;
      // it still counts toward a target, which is why it is filtered *here*
      // rather than in `targetStandings`.
      .filter((l) => !l.redactedAt)
      .map((l) => ({
        id: l.id,
        fullName: l.fullName,
        company: l.company,
        capturedAt: l.capturedAt.toISOString(),
        capturedByName: l.capturedByName,
        duplicateOfId: l.duplicateOfId,
      })),
    targets: targets.map((t) => ({
      id: t.id,
      companyName: t.companyName,
      aliases: t.aliases,
      priority: t.priority,
      reason: t.reason,
      ownerId: t.ownerId,
      ownerName: t.ownerName,
    })),
    // Whatever this booth has been reading out. Carried so an offline capture
    // can record a real notice rather than being forced to `unknown` by the
    // network — a lawful basis lost to bad wifi is still a lawful basis lost.
    consentNotice: await lastConsentNotice(showId, db),
  };
}

async function lastConsentNotice(showId: string, db: Db): Promise<string | null> {
  const [row] = await db
    .select({ notice: s.leads.consentNotice })
    .from(s.leads)
    .where(and(eq(s.leads.showId, showId), eq(s.leads.consentBasis, 'consent')))
    .orderBy(desc(s.leads.capturedAt))
    .limit(1);
  return row?.notice ?? null;
}

/* ---------------------------------- targets --------------------------------- */

export async function getTargetBoard(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<{ standings: TargetStanding[]; people: { id: string; fullName: string }[] }> {
  await requireShow(actor, showId, db);
  const [targets, leads, people] = await Promise.all([
    loadTargets(showId, db),
    loadLeads(showId, db),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
  ]);
  return {
    standings: targetStandings(
      targets,
      leads.map((l) => ({
        id: l.id,
        fullName: l.fullName,
        company: l.company,
        capturedAt: l.capturedAt,
        duplicateOfId: l.duplicateOfId,
      })),
    ),
    people,
  };
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

export type TargetInput = {
  companyName: string;
  aliases: string[];
  priority: 'must_meet' | 'target' | 'watch';
  reason: string | null;
  ownerId: string | null;
};

function validateTarget(input: TargetInput): TargetInput {
  const companyName = input.companyName.trim();
  if (!companyName) throw new TargetError('A target account needs a company name.');
  if (input.priority === 'must_meet' && !input.reason?.trim()) {
    // The one written-reason rule this feature adds, and it is the same rule as
    // everywhere else: a must-meet is read by somebody at hour six of day two
    // who was not in the meeting where it was decided. "Lakeside Manufacturing"
    // with no sentence under it tells them to do nothing in particular.
    throw new TargetError(
      'A must-meet account needs a reason — the sentence somebody at the booth reads before they walk over.',
    );
  }
  return {
    companyName,
    aliases: input.aliases.map((a) => a.trim()).filter(Boolean),
    priority: input.priority,
    reason: input.reason?.trim() || null,
    ownerId: input.ownerId,
  };
}

export async function addTarget(
  actor: Actor,
  showId: string,
  input: TargetInput,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canManageTargets(actor)) {
    throw new ForbiddenError('add a target account — it moves every "targets met" figure');
  }
  await requireShow(actor, showId, db);
  const draft = validateTarget(input);
  const existing = await db.query.showTargets.findFirst({
    where: and(eq(s.showTargets.showId, showId), eq(s.showTargets.companyName, draft.companyName)),
  });
  if (existing) throw new TargetError(`${draft.companyName} is already a target on this show.`);
  const [row] = await db
    .insert(s.showTargets)
    .values({
      showId,
      companyName: draft.companyName,
      aliases: draft.aliases,
      priority: draft.priority,
      reason: draft.reason,
      ownerId: draft.ownerId,
      createdById: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function editTarget(
  actor: Actor,
  targetId: string,
  input: TargetInput,
  now: Date = new Date(),
  db: Db = getDb(),
) {
  if (!canManageTargets(actor)) throw new ForbiddenError('edit a target account');
  const target = await targetInOrg(actor, targetId, db);
  const draft = validateTarget(input);
  await db
    .update(s.showTargets)
    .set({
      companyName: draft.companyName,
      aliases: draft.aliases,
      priority: draft.priority,
      reason: draft.reason,
      ownerId: draft.ownerId,
      updatedAt: now,
    })
    .where(eq(s.showTargets.id, target.id));
}

export async function removeTarget(actor: Actor, targetId: string, db: Db = getDb()): Promise<void> {
  if (!canManageTargets(actor)) throw new ForbiddenError('remove a target account');
  const target = await targetInOrg(actor, targetId, db);
  await db.delete(s.showTargets).where(eq(s.showTargets.id, target.id));
}

async function targetInOrg(actor: Actor, targetId: string, db: Db) {
  const [row] = await db
    .select({ target: s.showTargets })
    .from(s.showTargets)
    .innerJoin(s.shows, eq(s.showTargets.showId, s.shows.id))
    .where(and(eq(s.showTargets.id, targetId), eq(s.shows.orgId, actor.orgId)));
  if (!row) throw new NotFoundError('target account');
  return row.target;
}

/* ----------------------------------- sync ----------------------------------- */

/**
 * Accept a device's queue.
 *
 * Every item is answered — one outcome per `clientRef`, in the order sent — and
 * that is the endpoint's whole contract, because `outbox.reconcile` refuses to
 * drop anything it was not told about. A batch that half-fails is not an error
 * here: it is a list, and the device shows it.
 *
 * **A re-send is a success.** The client ref rides in `external_ref`, unique per
 * show, so a second attempt at an item whose first response never arrived finds
 * its own row and comes back `already`. That is step 18's rule about a scanner's
 * retry, and it matters more here, not less: a scanner retries over seconds, and
 * an outbox can retry over a lunch break, after a browser has been killed, from
 * a different network. The difference between `already` and `duplicate` is kept
 * because only one of them is news — somebody else on the booth met this person.
 *
 * Deliberately **not** in a transaction. A batch of nine leads where the seventh
 * has a bad email must write eight, not zero: the whole point of the queue is
 * that these conversations exist in one place, and rolling back to protect the
 * consistency of a batch that has no meaning as a batch would send them back to
 * a phone.
 */
export async function applyOutbox(
  actor: Actor,
  showId: string,
  items: QueuedItem[],
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<SyncOutcome[]> {
  await requireShow(actor, showId, db);
  const outcomes: SyncOutcome[] = [];

  for (const item of items) {
    if (item.showId !== showId) {
      outcomes.push({
        clientRef: item.clientRef,
        result: 'rejected',
        detail: 'This item was captured on a different show.',
      });
      continue;
    }
    if (!isDeviceRef(item.clientRef)) {
      // The rail only works if everything on it is ours. A ref without the
      // prefix could collide with a badge vendor's, and a collision here means
      // an offline capture silently answering `already` to a stranger's scan.
      outcomes.push({
        clientRef: item.clientRef,
        result: 'rejected',
        detail: 'That reference was not minted by this app.',
      });
      continue;
    }
    try {
      outcomes.push(
        item.kind === 'lead'
          ? await syncLead(actor, showId, item, now, db)
          : await syncMeeting(actor, showId, item, now, db),
      );
    } catch (err) {
      if (err instanceof LeadError || err instanceof TargetError) {
        outcomes.push({ clientRef: item.clientRef, result: 'rejected', detail: err.message });
        continue;
      }
      // Anything else is ours, not theirs. Leaving it unanswered keeps the item
      // on the device, which is the correct place for a conversation the server
      // could not store.
      throw err;
    }
  }
  return outcomes;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

async function syncLead(
  actor: Actor,
  showId: string,
  item: QueuedItem,
  now: Date,
  db: Db,
): Promise<SyncOutcome> {
  const b = item.body;
  // The device's clock, not the server's. A lead typed at 10:14 in a hall with
  // no signal happened at 10:14; stamping it with the moment the wifi came back
  // moves it into the wrong shift, past the end of the show, or — on a phone
  // synced the next morning — onto the wrong day entirely.
  const capturedAt = capturedAtOf(item, now);
  const result = await captureLead(
    actor,
    showId,
    {
      fullName: str(b.fullName) ?? '',
      email: str(b.email),
      phone: str(b.phone),
      company: str(b.company),
      title: str(b.title),
      notes: str(b.notes),
      interests: Array.isArray(b.interests) ? b.interests.filter((i): i is string => typeof i === 'string') : null,
      externalRef: item.clientRef,
      basis: str(b.basis),
      consentNotice: str(b.consentNotice),
    },
    capturedAt,
    db,
  );

  if (result.lead) return { clientRef: item.clientRef, result: 'accepted', id: result.lead.id };
  const match = result.match!;
  return match.kind === 'same_scan'
    ? // Our own ref came back. An earlier attempt landed and we never heard.
      { clientRef: item.clientRef, result: 'already', id: match.lead.id }
    : { clientRef: item.clientRef, result: 'duplicate', id: match.lead.id, detail: match.reason };
}

async function syncMeeting(
  actor: Actor,
  showId: string,
  item: QueuedItem,
  now: Date,
  db: Db,
): Promise<SyncOutcome> {
  const existing = await db.query.meetings.findFirst({
    where: and(eq(s.meetings.showId, showId), eq(s.meetings.externalRef, item.clientRef)),
  });
  if (existing) return { clientRef: item.clientRef, result: 'already', id: existing.id };

  const b = item.body;
  const at = capturedAtOf(item, now);
  const draft = validateMeeting({
    subject: str(b.subject) ?? '',
    company: str(b.company),
    isExistingCustomer: b.isExistingCustomer === true,
    scheduledAt: null,
    // A meeting recorded at the booth is one that just happened. The form has no
    // "when" field, because asking for one is four more seconds and §8c is a
    // story about seconds.
    occurredAt: b.noShow === true ? null : at,
    noShowAt: b.noShow === true ? at : null,
    leadId: null,
    ownerId: null,
    notes: str(b.notes),
  });
  const row = await recordMeeting(
    actor,
    showId,
    { ...draft, subject: draft.subject },
    at,
    db,
  );
  await db.update(s.meetings).set({ externalRef: item.clientRef }).where(eq(s.meetings.id, row.id));
  return { clientRef: item.clientRef, result: 'accepted', id: row.id };
}

/**
 * When it happened, according to the device — clamped forward.
 *
 * A device clock can be wrong, and a *future* capture instant is the one error
 * that breaks things downstream: it sorts to the top of a list forever, and it
 * would be counted in a shift that has not run. The EasyPost replay's rule
 * — never hand back anything dated in the future — reached from the client side.
 * A clock that is slow is left alone: it is very likely right about the order
 * the conversations happened in, which is what the day-of screen reads.
 */
function capturedAtOf(item: QueuedItem, now: Date): Date {
  const parsed = Date.parse(item.queuedAt);
  if (Number.isNaN(parsed)) return now;
  return parsed > now.getTime() ? now : new Date(parsed);
}
