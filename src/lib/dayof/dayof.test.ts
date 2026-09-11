import { describe, it, expect } from 'vitest';
import {
  keysFor,
  matchTarget,
  normalizeCompany,
  summarizeTargets,
  targetStandings,
  type TargetAccount,
  type TargetableLead,
} from './targets';
import {
  DEVICE_REF_PREFIX,
  describeOutbox,
  isDeviceRef,
  isPermanent,
  mintRef,
  OutboxError,
  reconcile,
  sendable,
  type QueuedItem,
  type SyncOutcome,
} from './outbox';
import {
  crateLine,
  degradeVerdicts,
  freshnessOf,
  shiftStanding,
  SNAPSHOT_VERSION,
  VERDICT_STALE_MINUTES,
  type DaySnapshot,
  type SnapshotShift,
} from './snapshot';
import { canManageTargets, canOpenDayOf, canSeeTargets } from './access';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of day-of — no database, no browser, fixed clock.
 *
 * Almost nothing here asserts that something was stored. Every assertion is
 * about a sentence or a number that would read perfectly well and be wrong on a
 * show floor: a crate called on time by a screen that has not spoken to anything
 * in three hours, a target account matched on a prefix and announced to a
 * stranger, a queued lead counted as a recorded one, a sync that dropped an item
 * nobody will ever go looking for.
 */

const NOW = new Date('2026-09-01T17:00:00Z');
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'u1',
  orgId: 'org',
  email: 'a@example.com',
  fullName: 'A',
  role: 'member',
  costCenterId: null,
  ...over,
});

/* --------------------------------- targets ---------------------------------- */

const target = (over: Partial<TargetAccount> = {}): TargetAccount => ({
  id: 't1',
  companyName: 'Lakeside Manufacturing',
  aliases: [],
  priority: 'target',
  reason: null,
  ownerId: 'u2',
  ownerName: 'Marcus',
  ...over,
});

const lead = (over: Partial<TargetableLead> = {}): TargetableLead => ({
  id: 'l1',
  fullName: 'Dana Whitfield',
  company: 'Lakeside Manufacturing',
  capturedAt: NOW,
  ...over,
});

describe('company normalisation', () => {
  it('folds case, punctuation and a trailing legal suffix', () => {
    expect(normalizeCompany('Lakeside Manufacturing, Inc.')).toBe('lakeside manufacturing');
    expect(normalizeCompany('  LAKESIDE   manufacturing ')).toBe('lakeside manufacturing');
    expect(normalizeCompany('Corvid Packaging GmbH')).toBe('corvid packaging');
  });

  it('only strips a suffix from the end, and never the whole name', () => {
    // `co` here is not a suffix, and dropping it makes a different company.
    expect(normalizeCompany('Co-operative Foods')).toBe('co operative foods');
    // A one-word company that *is* a suffix keeps its only word rather than
    // normalising to the empty string, which would match everything.
    expect(normalizeCompany('Ltd')).toBe('ltd');
  });

  it('does not strip words that distinguish real companies from each other', () => {
    // "Group", "Partners" and "Technologies" are deliberately not suffixes: they
    // are the difference between two accounts, and merging them is this file's
    // failure mode pointing inward.
    expect(normalizeCompany('Vance Group')).not.toBe(normalizeCompany('Vance'));
  });

  it('is empty for nothing, so nothing matches nothing', () => {
    expect(normalizeCompany(null)).toBe('');
    expect(normalizeCompany('  ')).toBe('');
    expect(matchTarget('', [target()])).toBeNull();
    expect(matchTarget(null, [target()])).toBeNull();
  });
});

describe('target matching', () => {
  it('matches the name and the aliases, normalised', () => {
    const t = target({ aliases: ['Lakeside Mfg'] });
    expect(keysFor(t)).toEqual(['lakeside manufacturing', 'lakeside mfg']);
    expect(matchTarget('Lakeside Manufacturing Inc', [t])?.id).toBe('t1');
    expect(matchTarget('lakeside mfg', [t])?.id).toBe('t1');
  });

  it('refuses to match on a prefix or a substring, deliberately', () => {
    // The failure of a fuzzy match here is not a wrong row on a screen. It is a
    // person at a booth telling a stranger that their company is one we came
    // for, with no way to check it.
    const t = target();
    expect(matchTarget('Lakeside', [t])).toBeNull();
    expect(matchTarget('Lakeside Manufacturing Services', [t])).toBeNull();
    expect(matchTarget('North Lakeside Manufacturing', [t])).toBeNull();
  });
});

describe('target standings', () => {
  it('derives met from a lead rather than from a stored flag', () => {
    const [standing] = targetStandings([target()], [lead()]);
    expect(standing.met).toBe(true);
    expect(standing.leads[0].fullName).toBe('Dana Whitfield');

    // Take the lead away — an erasure, a duplicate, a correction — and the claim
    // goes with it. A `met_at` column would have survived all three.
    expect(targetStandings([target()], [])[0].met).toBe(false);
    expect(
      targetStandings([target()], [lead({ duplicateOfId: 'other' })])[0].met,
    ).toBe(false);
  });

  it('orders unmet before met, and must-meet first inside that', () => {
    const standings = targetStandings(
      [
        target({ id: 'met', companyName: 'Lakeside Manufacturing', priority: 'must_meet' }),
        target({ id: 'watch', companyName: 'Zeta', priority: 'watch' }),
        target({ id: 'must', companyName: 'Vance Group', priority: 'must_meet' }),
      ],
      [lead()],
    );
    expect(standings.map((s) => s.target.id)).toEqual(['must', 'watch', 'met']);
  });

  it('flags a must-meet nobody owns, and does not flag a watch nobody owns', () => {
    // `show_deadlines.owner_id`'s rule: an alert addressed to an owner who does
    // not exist reaches nobody, on the row most likely to be walked past. A
    // watch with no owner is just a watch.
    const [must] = targetStandings([target({ priority: 'must_meet', ownerId: null })], []);
    const [watch] = targetStandings([target({ priority: 'watch', ownerId: null })], []);
    expect(must.unowned).toBe(true);
    expect(watch.unowned).toBe(false);
  });

  it('names the unmet must-meets rather than averaging them into a ratio', () => {
    const summary = summarizeTargets(
      targetStandings(
        [
          target({ id: 'a', companyName: 'Lakeside Manufacturing' }),
          target({ id: 'b', companyName: 'Vance Group', priority: 'must_meet' }),
        ],
        [lead()],
      ),
    );
    expect(summary.sentence).toContain('1 must-meet account not spoken to yet');
    expect(summary.mustMeetUnmet).toBe(1);
  });

  it('says nobody has set a list rather than "0 of 0 met"', () => {
    // 0 of 0 renders as either perfect or a failure and is neither.
    expect(summarizeTargets([]).sentence).toBe('No target accounts on this show yet.');
  });
});

/* ---------------------------------- outbox ---------------------------------- */

const queued = (over: Partial<QueuedItem> = {}): QueuedItem => ({
  clientRef: 'dev_1',
  showId: 'show',
  kind: 'lead',
  body: { fullName: 'Dana Whitfield' },
  queuedAt: iso(-10),
  attempts: 0,
  lastError: null,
  blocked: false,
  ...over,
});

describe('the device queue', () => {
  it('mints refs that are recognisably ours', () => {
    const ref = mintRef(() => 'abc');
    expect(ref).toBe(`${DEVICE_REF_PREFIX}abc`);
    expect(isDeviceRef(ref)).toBe(true);
    // A badge vendor's reference shares the column and must never be mistaken
    // for one of ours, or an offline capture answers `already` to a stranger.
    expect(isDeviceRef('DMW-88301')).toBe(false);
  });

  it('treats a re-send that finds its own row as a success, not a conflict', () => {
    const item = queued();
    const outcomes: SyncOutcome[] = [{ clientRef: 'dev_1', result: 'already', id: 'lead-1' }];
    const result = reconcile([item], outcomes);
    expect(result.remaining).toHaveLength(0);
    expect(result.already).toHaveLength(1);
    expect(isPermanent('already')).toBe(false);
  });

  it('keeps a rejected item, marks it blocked, and stops sending it', () => {
    // Deleting it would take away the only copy of a real conversation because
    // a field was blank; retrying it forever means the badge never clears and
    // nobody looks at it again.
    const result = reconcile(
      [queued()],
      [{ clientRef: 'dev_1', result: 'rejected', detail: 'A lead needs a name.' }],
    );
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].blocked).toBe(true);
    expect(result.remaining[0].lastError).toBe('A lead needs a name.');
    expect(sendable(result.remaining)).toHaveLength(0);
  });

  it('keeps an unanswered item queued rather than assuming it landed', () => {
    const result = reconcile([queued(), queued({ clientRef: 'dev_2' })], [
      { clientRef: 'dev_1', result: 'accepted', id: 'lead-1' },
    ]);
    expect(result.unanswered.map((i) => i.clientRef)).toEqual(['dev_2']);
    expect(result.remaining.map((i) => i.clientRef)).toEqual(['dev_2']);
    expect(result.remaining[0].blocked).toBe(false);
  });

  it('refuses to reconcile an answer about something it never sent', () => {
    // A queue that quietly shrinks is a person who is certain they captured
    // eleven and a screen that is certain about ten.
    expect(() =>
      reconcile([queued()], [{ clientRef: 'dev_9', result: 'accepted', id: 'x' }]),
    ).toThrow(OutboxError);
  });

  it('never lets an item leave the queue without an outcome', () => {
    const items = [queued(), queued({ clientRef: 'dev_2' }), queued({ clientRef: 'dev_3' })];
    const result = reconcile(items, [
      { clientRef: 'dev_1', result: 'accepted', id: 'a' },
      { clientRef: 'dev_2', result: 'duplicate', id: 'b', detail: 'Priya got them.' },
      { clientRef: 'dev_3', result: 'rejected', detail: 'no name' },
    ]);
    const accountedFor =
      result.accepted.length +
      result.already.length +
      result.duplicates.length +
      result.rejected.length +
      result.unanswered.length;
    expect(accountedFor).toBe(items.length);
  });

  it('tells a queued capture apart from a recorded one, in the sentence', () => {
    // §8c's mitigation is that a thin count is visibly thin. A count that
    // silently includes rows on a phone is that failure with a new cause.
    expect(describeOutbox([], true).sentence).toBe('Everything captured here is recorded.');
    expect(describeOutbox([queued()], false).sentence).toContain('not recorded yet');
    expect(describeOutbox([queued()], false).sentence).toContain('no connection');
    const blocked = describeOutbox([queued({ blocked: true })], true);
    expect(blocked.tone).toBe('warn');
    expect(blocked.sentence).toContain('refused');
  });
});

/* -------------------------------- the snapshot ------------------------------ */

const shift = (over: Partial<SnapshotShift> = {}): SnapshotShift => ({
  id: 's1',
  startsAt: iso(-30),
  endsAt: iso(90),
  targetStaff: 3,
  effectiveCount: 3,
  assignedCount: 3,
  overstated: false,
  mine: true,
  staff: ['Priya'],
  ...over,
});

const snapshot = (over: Partial<DaySnapshot> = {}): DaySnapshot => ({
  version: SNAPSHOT_VERSION,
  capturedAt: NOW.toISOString(),
  actorId: 'u1',
  show: {
    id: 'show',
    name: 'Design & Manufacturing West 2026',
    timezone: 'America/Los_Angeles',
    boothNumber: '2209',
    venueName: 'Anaheim Convention Center',
    city: 'Anaheim',
    startsOn: iso(-60),
    endsOn: iso(2880),
    moveInAt: iso(-600),
  },
  shifts: [shift()],
  crates: [],
  leads: [],
  targets: [],
  consentNotice: null,
  ...over,
});

describe('freshness', () => {
  it('says how old it is in every state, never silently', () => {
    expect(freshnessOf(NOW.toISOString(), NOW).standing).toBe('live');
    expect(freshnessOf(iso(-10), NOW).sentence).toContain('10 min ago');
    expect(freshnessOf(iso(-90), NOW).standing).toBe('stale');
    expect(freshnessOf(iso(-90), NOW).sentence).toContain('no longer current');
    expect(freshnessOf(iso(-600), NOW).standing).toBe('old');
  });
});

describe('degrading a stale snapshot', () => {
  const crates: DaySnapshot['crates'] = [
    {
      id: 'c1',
      description: 'Booth crate',
      direction: 'outbound',
      consignment: 'show_site',
      standing: 'in transit, on time',
      standingTone: 'ok',
      derivedFrom: 'estimate',
      lastScan: null,
      trackingNumber: '1Z',
      receivedAt: null,
      mayConfirm: false,
    },
    {
      id: 'c2',
      description: 'Demo unit',
      direction: 'outbound',
      consignment: 'show_site',
      standing: 'on a dock — nobody has confirmed it at the booth',
      standingTone: 'warn',
      derivedFrom: 'record',
      lastScan: null,
      trackingNumber: '1Z2',
      receivedAt: null,
      mayConfirm: true,
    },
  ];

  it('takes the present tense off an estimate and leaves a recorded fact alone', () => {
    // §5f's unchecked flight, at the scale of a screen: `scheduled` is the calm
    // one, so a board nobody has refreshed shows a full slate of on-time
    // flights. "On a dock, unconfirmed" is a signature, not a guess about a
    // truck, and blanking it would remove the most actionable sentence here.
    const stale = degradeVerdicts(snapshot({ crates }), new Date(NOW.getTime() + 90 * 60_000));
    expect(stale.crates[0].standing).toBeNull();
    expect(stale.crates[0].standingTone).toBe('unknown');
    expect(stale.crates[1].standing).toBe('on a dock — nobody has confirmed it at the booth');
  });

  it('leaves a fresh snapshot untouched', () => {
    const fresh = snapshot({ crates });
    expect(degradeVerdicts(fresh, new Date(NOW.getTime() + (VERDICT_STALE_MINUTES - 5) * 60_000)))
      .toEqual(fresh);
  });
});

describe('which shift is mine', () => {
  it('tells "not on this show" apart from "done for today"', () => {
    // Collapsing the two into an empty card is how somebody rostered at six
    // concludes at four that they are not.
    expect(shiftStanding([shift({ mine: false })], NOW).kind).toBe('not_rostered');
    expect(shiftStanding([shift({ startsAt: iso(-300), endsAt: iso(-120) })], NOW).kind).toBe(
      'none_today',
    );
  });

  it('reports the shift running now, and how long is left of it', () => {
    const standing = shiftStanding([shift()], NOW);
    expect(standing.kind).toBe('on_now');
    if (standing.kind === 'on_now') expect(standing.endsInMinutes).toBe(90);
  });

  it('reports the next one when none is running', () => {
    const standing = shiftStanding([shift({ startsAt: iso(120), endsAt: iso(360) })], NOW);
    expect(standing.kind).toBe('next');
    if (standing.kind === 'next') expect(standing.startsInMinutes).toBe(120);
  });
});

describe('the crate line', () => {
  const base = {
    status: 'in_transit' as const,
    window: 'clear' as const,
    stalledHours: null,
    neverScanned: false,
    deliveredAt: null,
    receivedAt: null,
    hasTracking: true,
  };

  it('does not call a delivered crate done', () => {
    // The carrier signed for a dock; drayage moves it to the booth, and this app
    // cannot see drayage. §5g, on the screen where the person who can say so is
    // actually standing.
    const delivered = crateLine({ ...base, deliveredAt: NOW });
    expect(delivered.standing).toContain('nobody has confirmed it at the booth');
    expect(delivered.tone).toBe('warn');
    expect(crateLine({ ...base, deliveredAt: NOW, receivedAt: NOW }).standing).toBe('at the booth');
  });

  it('says there is no truck rather than making a claim about one', () => {
    const line = crateLine({ ...base, hasTracking: false, window: 'no_estimate' });
    expect(line.standing).toContain('nothing has been handed to a carrier');
    expect(line.derivedFrom).toBe('record');
  });

  it('treats arriving early as a failure, not as spare time', () => {
    expect(crateLine({ ...base, window: 'too_early' }).standing).toContain('refused');
  });

  it('reports silence, which no status field does', () => {
    expect(crateLine({ ...base, stalledHours: 43 }).standing).toBe('silent for 43h');
  });
});

/* ---------------------------------- access ---------------------------------- */

describe('who may do what', () => {
  it('lets anybody open the screen and read the list', () => {
    // A day-of screen a Member cannot open on the one morning it matters
    // produces §8c's bad lead count by construction, and a target nobody at the
    // booth can see is a target nobody meets.
    expect(canOpenDayOf()).toBe(true);
    expect(canSeeTargets()).toBe(true);
  });

  it('keeps editing the target list with changing the plan', () => {
    expect(canManageTargets(actor())).toBe(false);
    expect(canManageTargets(actor({ role: 'travel_manager' }))).toBe(true);
    expect(canManageTargets(actor({ role: 'admin' }))).toBe(true);
  });
});
