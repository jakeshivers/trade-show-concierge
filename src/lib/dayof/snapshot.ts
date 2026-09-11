/**
 * What a day-of screen holds when there is no network, and what it is allowed to
 * claim while holding it.
 *
 * This is the file where §5f's rule about an unchecked flight arrives at a whole
 * screen. There, a row that nobody had refreshed rendered `scheduled`, which is
 * the calm one, so a board that had not been asked anything in eight hours
 * showed a full slate of on-time flights. A cached screen is that failure with
 * every row at once, and it is *worse*, because the staleness has no visible
 * cause: the page is drawn, the numbers are there, and nothing about a phone
 * with no bars says the crate status is from Tuesday.
 *
 * So a snapshot carries one instant — `capturedAt` — and every reader has to
 * pass a clock. Two consequences, and the second is the one worth arguing about.
 *
 * **A fact and a verdict age differently.** "Shift 09:00–13:00, booth 2209" was
 * true when it was written and is still true; a booth number does not move
 * because a phone lost signal. "Crate on time" is a claim about the present
 * tense, computed from an estimate that moves hourly, and it is exactly as good
 * as the moment it was computed. So `degradeVerdicts` strips the standing off
 * the crate lines past a threshold and leaves the facts alone — a crate is still
 * *the crate that was in Memphis at 08:12*, and that is a more useful sentence
 * than a cheerful green badge sourced from nothing.
 *
 * **The threshold is short, and it is short because of what the screen is for.**
 * An hour is a long time on a move-in morning: it is the difference between
 * chasing a stalled crate and standing in an empty booth. This is not the
 * deadline engine's calendar.
 *
 * Everything is wire-shaped — instants are ISO strings, because this object is
 * JSON on the way to a device and JSON in IndexedDB when it gets there, and a
 * `Date` that survives one hop and not the other is the bug that only shows up
 * offline.
 */

import type { ShipmentPhase, WindowStanding } from '@/lib/shipping/status';

/** Fresh enough that a present-tense verdict is still a present-tense verdict. */
export const VERDICT_STALE_MINUTES = 45;
/** Past this, the snapshot leads with its age rather than mentioning it. */
export const SNAPSHOT_OLD_MINUTES = 240;

export type Freshness = {
  ageMinutes: number;
  standing: 'live' | 'recent' | 'stale' | 'old';
  /** The line at the top of the screen. Always present, never a footnote. */
  sentence: string;
};

export function freshnessOf(capturedAt: string, now: Date): Freshness {
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(capturedAt)) / 60_000));
  const standing =
    age < 2
      ? 'live'
      : age < VERDICT_STALE_MINUTES
        ? 'recent'
        : age < SNAPSHOT_OLD_MINUTES
          ? 'stale'
          : 'old';
  const sentence =
    standing === 'live'
      ? 'Up to date.'
      : standing === 'recent'
        ? `As of ${minutes(age)} ago.`
        : standing === 'stale'
          ? `As of ${minutes(age)} ago — crate and coverage standings are no longer current.`
          : `This is a snapshot from ${minutes(age)} ago. Treat every figure on it as history.`;
  return { ageMinutes: age, standing, sentence };
}

function minutes(age: number): string {
  if (age < 60) return `${age} min`;
  const h = Math.floor(age / 60);
  const m = age % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/* --------------------------------- shapes ---------------------------------- */

export type SnapshotShift = {
  id: string;
  startsAt: string;
  endsAt: string;
  targetStaff: number;
  /** Who can actually work it, from `team/coverage.ts`, computed server-side. */
  effectiveCount: number;
  assignedCount: number;
  overstated: boolean;
  mine: boolean;
  /** First names, so the person knows who they are standing next to. */
  staff: string[];
};

export type SnapshotCrate = {
  id: string;
  description: string;
  direction: 'outbound' | 'return';
  consignment: string;
  /** What this crate reads as. See `derivedFrom` — only one kind of it ages. */
  standing: string | null;
  standingTone: 'ok' | 'warn' | 'bad' | 'unknown';
  /**
   * Where the line came from, and therefore whether it survives going stale.
   *
   * `record` means a timestamp somebody or something wrote down — delivered at,
   * received at, returned. Those do not stop being true because a phone lost
   * signal; they are history, and history is what a stale screen is *for*.
   * `estimate` means a claim about the present tense computed from a carrier's
   * moving estimate, and it is worth exactly as much as the moment it was
   * computed. `degradeVerdicts` takes the second away and leaves the first.
   *
   * Getting this wrong in the safe-looking direction — withholding everything —
   * is not safe: it would blank "on a dock, nobody has confirmed it at the
   * booth", which is the single most actionable sentence on a move-in morning
   * and is a fact about a signature, not a guess about a truck.
   */
  derivedFrom: 'record' | 'estimate';
  /** Where it was last seen, and when. A fact — it does not go stale, it ages. */
  lastScan: { at: string; description: string; location: string | null } | null;
  trackingNumber: string | null;
  receivedAt: string | null;
  /** Confirming a crate reached the booth is anybody's. §5g. */
  mayConfirm: boolean;
};

export type SnapshotLead = {
  id: string;
  fullName: string;
  company: string | null;
  capturedAt: string;
  capturedByName: string | null;
  duplicateOfId: string | null;
};

export type SnapshotTarget = {
  id: string;
  companyName: string;
  aliases: string[];
  priority: 'must_meet' | 'target' | 'watch';
  reason: string | null;
  ownerId: string | null;
  ownerName: string | null;
};

export type DaySnapshot = {
  /** Bumped when the shape changes, so an old cache is discarded rather than read. */
  version: number;
  capturedAt: string;
  /**
   * Whose snapshot this is.
   *
   * Every row in here was fetched under one person's scope, and a device that
   * signs in as somebody else must not render the previous person's screen from
   * cache while the network is down. The client compares this and wipes on a
   * mismatch — the transcript rule from step 15, on a shared phone.
   */
  actorId: string;
  show: {
    id: string;
    name: string;
    timezone: string;
    boothNumber: string | null;
    venueName: string | null;
    city: string | null;
    startsOn: string;
    endsOn: string;
    moveInAt: string | null;
  };
  shifts: SnapshotShift[];
  crates: SnapshotCrate[];
  leads: SnapshotLead[];
  targets: SnapshotTarget[];
  /** The consent notice this booth reads out, so an offline capture can record one. */
  consentNotice: string | null;
};

export const SNAPSHOT_VERSION = 1;

/* -------------------------------- reading it -------------------------------- */

export type ShiftStanding =
  | { kind: 'on_now'; shift: SnapshotShift; endsInMinutes: number }
  | { kind: 'next'; shift: SnapshotShift; startsInMinutes: number }
  | { kind: 'none_today' }
  | { kind: 'not_rostered' };

/**
 * Which shift is mine right now — the first thing the screen answers.
 *
 * `not_rostered` and `none_today` are told apart deliberately. "You have no
 * shifts on this show" and "you are done for today" are different sentences to
 * read at 4pm, and collapsing them into an empty card is how somebody who *is*
 * rostered at 6 concludes they are not.
 */
export function shiftStanding(shifts: SnapshotShift[], now: Date): ShiftStanding {
  const mine = shifts
    .filter((s) => s.mine)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  if (mine.length === 0) return { kind: 'not_rostered' };

  const t = now.getTime();
  const on = mine.find((s) => Date.parse(s.startsAt) <= t && t < Date.parse(s.endsAt));
  if (on) {
    return {
      kind: 'on_now',
      shift: on,
      endsInMinutes: Math.round((Date.parse(on.endsAt) - t) / 60_000),
    };
  }
  const next = mine.find((s) => Date.parse(s.startsAt) > t);
  if (next) {
    return {
      kind: 'next',
      shift: next,
      startsInMinutes: Math.round((Date.parse(next.startsAt) - t) / 60_000),
    };
  }
  return { kind: 'none_today' };
}

/**
 * Strip the present tense off anything that has stopped being present.
 *
 * The crate keeps its description, its tracking number and its last scan, all of
 * which are dated facts. What it loses is the standing — the word that says what
 * is true *now* — because that word was computed against a clock that has since
 * moved, and rendering it anyway is precisely the on-time-flight failure.
 *
 * A received crate is exempt: `received_at` is a person's word about something
 * that already happened, and it does not become less true while the wifi is out.
 */
export function degradeVerdicts(snapshot: DaySnapshot, now: Date): DaySnapshot {
  if (freshnessOf(snapshot.capturedAt, now).standing === 'live') return snapshot;
  if (freshnessOf(snapshot.capturedAt, now).ageMinutes < VERDICT_STALE_MINUTES) return snapshot;
  return {
    ...snapshot,
    crates: snapshot.crates.map((c) =>
      c.derivedFrom === 'record' ? c : { ...c, standing: null, standingTone: 'unknown' },
    ),
    shifts: snapshot.shifts.map((s) => ({ ...s, overstated: false })),
  };
}

/* ------------------------------- the crate line ----------------------------- */

/**
 * What a crate reads as, to somebody standing in the booth.
 *
 * Deliberately a **different vocabulary** from `/shipping`'s, not a copy of it.
 * The board answers "which of forty crates is in trouble", so it renders a
 * window standing, a stall, a freshness and an owner. A person on the floor is
 * asking one question — *is my booth here* — and the honest answers to that are
 * a much shorter list. Two vocabularies is normally the failure this product
 * warns about; it is not one here, because they are answers to different
 * questions and both derive from the same `windowVerdict` and `stallOf` rather
 * than from two readings of the same rows.
 *
 * The ordering of the branches is the argument. `received` comes first because
 * it is the only end state, and `delivered` is deliberately *not* it: the
 * carrier signed for a dock, drayage moves it to the booth, and a person has to
 * say so. §5g, on the screen where the person who can say so is standing.
 */
export function crateLine(input: {
  status: ShipmentPhase;
  window: WindowStanding;
  stalledHours: number | null;
  neverScanned: boolean;
  deliveredAt: Date | null;
  receivedAt: Date | null;
  hasTracking: boolean;
}): {
  standing: string;
  tone: SnapshotCrate['standingTone'];
  derivedFrom: 'record' | 'estimate';
} {
  if (input.receivedAt) return { standing: 'at the booth', tone: 'ok', derivedFrom: 'record' };
  if (input.deliveredAt) {
    return {
      standing: 'on a dock — nobody has confirmed it at the booth',
      tone: 'warn',
      derivedFrom: 'record',
    };
  }
  if (input.status === 'returned' || input.status === 'cancelled') {
    return { standing: 'not coming', tone: 'bad', derivedFrom: 'record' };
  }
  if (input.window === 'late') {
    return {
      standing: 'will not make the dock',
      tone: 'bad',
      derivedFrom: 'estimate',
    };
  }
  if (input.window === 'too_early') {
    return {
      standing: 'arriving before the dock opens — it will be refused',
      tone: 'bad',
      derivedFrom: 'estimate',
    };
  }
  if (!input.hasTracking) {
    // Not a claim about a truck. There is no truck: nothing has been handed to
    // a carrier, which is a worse problem than a late one and reads calmer.
    return {
      standing: 'no tracking number — nothing has been handed to a carrier',
      tone: 'bad',
      // A fact about our own records, not a reading of a carrier's: there is no
      // truck, and forty minutes later there is still no truck.
      derivedFrom: 'record',
    };
  }
  if (input.neverScanned)
    return {
      standing: 'label printed, never scanned',
      tone: 'bad',
      derivedFrom: 'estimate',
    };
  if (input.stalledHours !== null) {
    return {
      standing: `silent for ${Math.round(input.stalledHours)}h`,
      tone: 'warn',
      derivedFrom: 'estimate',
    };
  }
  if (input.window === 'no_estimate')
    return {
      standing: 'in transit, no delivery estimate',
      tone: 'warn',
      derivedFrom: 'estimate',
    };
  if (input.window === 'tight')
    return {
      standing: 'due, with little room',
      tone: 'warn',
      derivedFrom: 'estimate',
    };
  return {
    standing: 'in transit, on time',
    tone: 'ok',
    derivedFrom: 'estimate',
  };
}
