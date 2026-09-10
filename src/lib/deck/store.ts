import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { canSeeCost } from '@/lib/cost/access';
import { canSeeRoi } from '@/lib/roi/access';
import { getShowDetail } from '@/lib/shows/store';
import { getChecklist } from '@/lib/readiness/store';
import { getRegister } from '@/lib/deadlines/store';
import { getTeamBoard } from '@/lib/team/store';
import { getTargetBoard } from '@/lib/dayof/store';
import { getShipmentBoard } from '@/lib/shipping/store';
import { getShowCost } from '@/lib/cost/store';
import { getShowRoi } from '@/lib/roi/store';
import { loadCoverage } from '@/lib/leads/store';
import { money, planDeck, type Deck, type DeckInputs, type PriorYear, type Quoted } from './plan';

type Db = ReturnType<typeof getDb>;

/**
 * Everything the brief needs, loaded as the acting actor.
 *
 * **Every read here goes through the same store function a screen calls**, so
 * the deck inherits each one's org scoping and permission gate rather than
 * re-deriving them — `assistant/tools.ts`'s posture, applied to an export. That
 * is what makes rule 5 in `plan.ts` true: a Member's deck has no cost or ROI
 * because `getShowCost` would refuse, so the input is simply absent and the
 * slide is never planned.
 *
 * Cost and ROI are gated *before* the call rather than by catching the refusal,
 * because a `ForbiddenError` swallowed in a try/catch is indistinguishable from
 * a bug that produced no data.
 */
export async function buildDeckInputs(
  actor: Actor,
  showId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<DeckInputs> {
  const detail = await getShowDetail(actor, showId, now, db);
  const show = detail.show;

  const [checklist, register, team, targets, freight, cost] = await Promise.all([
    getChecklist(actor, showId, now, db),
    getRegister(actor, showId, now, db),
    getTeamBoard(actor, showId, now, db),
    getTargetBoard(actor, showId, db),
    getShipmentBoard(actor, { showId, asOf: now }, db).catch(() => null),
    canSeeCost(actor) ? getShowCost(actor, showId, { asOf: now }, db) : null,
  ]);

  const roster = team.roster;
  // Only the person confirms their own attendance: a `confirmed` with no
  // `responded_at` was typed on somebody's behalf and is not a confirmation.
  const confirmed = roster.filter(
    (r) => r.attendee.status === 'confirmed' && r.attendee.respondedAt !== null,
  );
  const unconfirmed = roster.filter(
    (r) => !(r.attendee.status === 'confirmed' && r.attendee.respondedAt !== null),
  );

  return {
    show: {
      name: show.name,
      status: show.status,
      city: show.city,
      region: show.region,
      country: show.country,
      venueName: show.venueName,
      boothNumber: show.boothNumber,
      boothSize: show.boothSize,
      goals: show.goals,
      budgetCents: show.budgetCents,
    },
    dates: {
      range: dateRange(show.startsOn, show.endsOn, show.timezone),
      moveIn: show.moveInAt ? dateTime(show.moveInAt, show.timezone) : null,
      daysUntil: calendarDaysUntil(show.startsOn, now, show.timezone),
    },
    priorYear: await loadPriorYear(actor, showId, now, db),
    attendees: {
      confirmed: confirmed.length,
      invited: roster.length,
      names: confirmed.map((r) => r.user.fullName),
      unconfirmed: unconfirmed.map((r) => r.user.fullName),
    },
    readiness: {
      score: checklist.readiness.score,
      done: checklist.readiness.byStatus.complete ?? 0,
      total: checklist.readiness.counted,
    },
    deadlines: {
      total: register.entries.length,
      unconfirmed: register.exposure.unconfirmed,
      missed: register.exposure.missed,
      // The confirmed figure only. Adding the unconfirmed one produces a number
      // that is neither a quote from the manual nor a guess.
      exposureCents: register.exposure.atRiskCents,
    },
    targets: {
      total: targets.standings.length,
      mustMeet: targets.standings.filter((t) => t.target.priority === 'must_meet').length,
      unowned: targets.standings.filter((t) => t.unowned).length,
    },
    freight: freight
      ? {
          crates: freight.rows.length,
          // Delivered is the carrier's word; received is a person's. The gap
          // between them is drayage, which this app cannot see.
          unconfirmed: freight.rows.filter(
            (r) => r.shipment.deliveredAt && !r.shipment.receivedAt,
          ).length,
        }
      : null,
    cost: cost
      ? {
          committedCents: cost.totalCents,
          isFloor: cost.isFloor,
          // The §8a categories with no figure at all — a silent line is not a
          // zero, it is an invoice nobody has entered.
          missing: cost.coverage.silent,
        }
      : null,
    builtAt: now,
    builtBy: actor.fullName,
    timezone: show.timezone,
  };
}

/**
 * Last year, and only when somebody linked it.
 *
 * `shows.cloned_from_id` is a deliberate act — one person cloned this show from
 * that one. Falling back to a name match would let "Automate 2026" pick up a
 * different "Automate" and attribute its cost and pipeline here, which is the
 * fuzzy match `dayof/targets.ts` refuses for the same reason: the failure is
 * silent and reads as a fact.
 */
async function loadPriorYear(
  actor: Actor,
  showId: string,
  now: Date,
  db: Db,
): Promise<PriorYear | null> {
  // The link lives on the intake decision rather than on the show: cloning is a
  // decision somebody made with a written reason, and `show_decisions` is where
  // this product keeps those. Append-only, so the first clone decision is the
  // lineage even if the show was later re-decided.
  // The *clone* decision specifically. A show accumulates decisions — proposed,
  // committed, sometimes declined — and taking whichever row came back first
  // reported "no prior year" for any show that had been committed after it was
  // cloned, which is every cloned show.
  const decision = await db.query.showDecisions.findFirst({
    where: and(
      eq(s.showDecisions.showId, showId),
      isNotNull(s.showDecisions.clonedFromId),
    ),
  });
  if (!decision?.clonedFromId) return null;
  const prior = await db.query.shows.findFirst({ where: eq(s.shows.id, decision.clonedFromId) });
  if (!prior || prior.orgId !== actor.orgId) return null;

  const [cost, roi, coverage] = await Promise.all([
    canSeeCost(actor) ? getShowCost(actor, prior.id, { asOf: now }, db).catch(() => null) : null,
    canSeeRoi(actor) ? getShowRoi(actor, prior.id, { asOf: now }, db).catch(() => null) : null,
    loadCoverage(actor.orgId, now, db)
      .then((m) => m.get(prior.id)?.coverage ?? null)
      .catch(() => null),
  ]);

  const attendees = await db
    .select({ id: s.showAttendees.id })
    .from(s.showAttendees)
    .where(eq(s.showAttendees.showId, prior.id));

  return {
    name: prior.name,
    dates: dateRange(prior.startsOn, prior.endsOn, prior.timezone),
    costCents: cost?.totalCents ?? null,
    costIsFloor: cost?.isFloor ?? false,
    costMissing: cost ? cost.coverage.silent : [],
    leads: coverage?.leadCount ?? null,
    leadsIsFloor: coverage?.isFloor ?? false,
    // Pipeline inherits closed-won's refusal rather than printing its own
    // number. Both are derived from the same attribution, so when that has no
    // referent — no CRM connected, a replayed pipeline — `pipelineCents` is 0
    // and printing "$0" states that this show sourced nothing. It did not; we
    // do not know. A printed zero is a claim, which is the whole reason
    // `Quotable` exists.
    pipeline: roi
      ? roi.closedWon.ok
        ? { value: money(roi.pipelineCents), refusal: null }
        : { value: null, refusal: roi.closedWon.reason }
      : { value: null, refusal: notVisible(actor, 'pipeline') },
    won: roi ? quoted(roi.closedWon) : { value: null, refusal: notVisible(actor, 'closed won') },
    multiple: roi
      ? roi.pipelineMultiple.ok
        ? { value: `${roi.pipelineMultiple.multiple.toFixed(1)}×`, refusal: null }
        : { value: null, refusal: roi.pipelineMultiple.reason }
      : { value: null, refusal: notVisible(actor, 'return') },
    attendees: attendees.length,
    withinHorizon: roi ? roi.maturity === 'immature' || roi.maturity === 'future' : false,
  };
}

function quoted(q: { ok: true; cents: number } | { ok: false; reason: string }): Quoted {
  return q.ok ? { value: money(q.cents), refusal: null } : { value: null, refusal: q.reason };
}

/** Why a figure is absent, said plainly rather than left blank. */
function notVisible(actor: Actor, what: string): string {
  return canSeeRoi(actor)
    ? `No ${what} figure has been produced for that show yet.`
    : `A show’s ${what} is visible to travel managers and admins.`;
}

/* -------------------------------- formatting ------------------------------- */

function dateRange(start: Date, end: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${f.format(start)} – ${f.format(end)}`;
}

function dateTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

/** Whole days on the show's own calendar, never a millisecond division. */
function calendarDaysUntil(start: Date, now: Date, timeZone: string): number {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d);
  const a = Date.parse(`${day(now)}T00:00:00Z`);
  const b = Date.parse(`${day(start)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export async function planShowDeck(
  actor: Actor,
  showId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<Deck> {
  return planDeck(await buildDeckInputs(actor, showId, now, db));
}
