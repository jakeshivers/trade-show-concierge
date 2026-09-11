import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { listShows } from '@/lib/shows/store';
import {
  addTarget,
  applyOutbox,
  buildSnapshot,
  getTargetBoard,
  listDayOfShows,
  removeTarget,
  TargetError,
} from '@/lib/dayof/store';
import { reconcile, type QueuedItem } from '@/lib/dayof/outbox';
import { SNAPSHOT_VERSION } from '@/lib/dayof/snapshot';

/**
 * Step 20 against the real database.
 *
 * The pure half — target matching, the outbox arithmetic, freshness and the
 * crate line — is tested with no database in `src/lib/dayof/dayof.test.ts`. What
 * can only be checked here is the claim the whole feature rests on: **a re-sent
 * capture is a success and not a second lead.** That is a property of the unique
 * index on `(show_id, external_ref)`, not of any function, so asserting it
 * anywhere else would be asserting an intention.
 *
 * The rest is the same shape: that a queued item goes through the *real*
 * `captureLead` and therefore obeys the same consent rule a form does, that a
 * device's clock cannot file a lead in the future, and that editing the target
 * list is an approver's while reading it is everybody's.
 */

const db = getDb();
const scratchTargets: string[] = [];
const scratchLeads: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let shelley: Actor;
let priya: Actor;
let dmwestId: string;

const ref = (suffix: string) => `dev_test_${suffix}`;

const queued = (over: Partial<QueuedItem> & { clientRef: string }): QueuedItem => ({
  showId: dmwestId,
  kind: 'lead',
  body: { fullName: 'Test Person', company: 'Test Co' },
  queuedAt: new Date().toISOString(),
  attempts: 0,
  lastError: null,
  blocked: false,
  ...over,
});

beforeAll(async () => {
  shelley = await actorFor('shelley@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');
  const shows = await listShows(shelley);
  dmwestId = shows.find((sh) => sh.name.startsWith('Design & Manufacturing'))!.id;
});

afterAll(async () => {
  if (scratchLeads.length) await db.delete(s.leads).where(inArray(s.leads.id, scratchLeads));
  if (scratchTargets.length) {
    await db.delete(s.showTargets).where(inArray(s.showTargets.id, scratchTargets));
  }
  await db.delete(s.meetings).where(eq(s.meetings.externalRef, ref('meeting')));
});

/* -------------------------------- the snapshot ------------------------------ */

describe('the snapshot', () => {
  it('carries one instant and everything the screen needs', async () => {
    const at = new Date();
    const snapshot = await buildSnapshot(priya, dmwestId, at);
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.capturedAt).toBe(at.toISOString());
    // Whose copy this is. The client refuses to render a cached snapshot whose
    // actor is not the person signed in — a phone at a booth gets handed round.
    expect(snapshot.actorId).toBe(priya.userId);
    expect(snapshot.show.boothNumber).toBe('2209');
    expect(snapshot.shifts.length).toBeGreaterThan(0);
    expect(snapshot.targets.length).toBeGreaterThan(0);
  });

  it('carries no personal data beyond a name and a company', async () => {
    // §5j's minimisation, and the right call for the medium: a phone in a
    // lanyard is the most losable computer anybody owns.
    const snapshot = await buildSnapshot(priya, dmwestId);
    for (const lead of snapshot.leads) {
      expect(Object.keys(lead).sort()).toEqual([
        'capturedAt',
        'capturedByName',
        'company',
        'duplicateOfId',
        'fullName',
        'id',
      ]);
    }
  });

  it('puts a show that is on the floor now ahead of one that is closer on the calendar', async () => {
    const shows = await listDayOfShows(shelley);
    expect(shows[0].onFloorNow).toBe(true);
    // A declined show is never somewhere anybody is standing.
    expect(shows.some((sh) => sh.status === 'cancelled')).toBe(false);
  });
});

/* ---------------------------------- targets --------------------------------- */

describe('target accounts', () => {
  it('derives met from the leads, and re-derives when they change', async () => {
    const { standings } = await getTargetBoard(priya, dmwestId);
    const lakeside = standings.find((t) => t.target.companyName === 'Lakeside Manufacturing')!;
    expect(lakeside.met).toBe(true);
    expect(lakeside.leads[0].fullName).toBe('Dana Whitfield');

    // Matched under a different spelling on the badge, which is the only thing
    // normalisation is for.
    const corvid = standings.find((t) => t.target.companyName.startsWith('Corvid'))!;
    expect(corvid.met).toBe(true);

    const vance = standings.find((t) => t.target.companyName === 'Vance Group')!;
    expect(vance.met).toBe(false);
    expect(vance.unowned).toBe(true);
  });

  it('is read by everybody and edited by an approver', async () => {
    // Reading has to be everybody's: a target nobody at the booth can see is a
    // target nobody meets. Editing moves the denominator of every figure it
    // produces, so it sits with changing the plan.
    await expect(getTargetBoard(priya, dmwestId)).resolves.toBeTruthy();
    await expect(
      addTarget(priya, dmwestId, {
        companyName: 'Nope Industries',
        aliases: [],
        priority: 'watch',
        reason: null,
        ownerId: null,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a must-meet with no reason on it', async () => {
    await expect(
      addTarget(shelley, dmwestId, {
        companyName: 'Reasonless Corp',
        aliases: [],
        priority: 'must_meet',
        reason: null,
        ownerId: null,
      }),
    ).rejects.toThrow(TargetError);
  });

  it('refuses the same company twice on one show', async () => {
    const row = await addTarget(shelley, dmwestId, {
      companyName: 'Duplicate Test Co',
      aliases: [],
      priority: 'watch',
      reason: null,
      ownerId: null,
    });
    scratchTargets.push(row.id);
    await expect(
      addTarget(shelley, dmwestId, {
        companyName: 'Duplicate Test Co',
        aliases: [],
        priority: 'watch',
        reason: null,
        ownerId: null,
      }),
    ).rejects.toThrow(TargetError);
    await removeTarget(shelley, row.id);
    scratchTargets.pop();
  });
});

/* ----------------------------------- sync ----------------------------------- */

describe('draining a device queue', () => {
  it('writes a queued capture as the person who typed it', async () => {
    const item = queued({ clientRef: ref('one'), body: { fullName: 'Offline Person', company: 'Acme' } });
    const [outcome] = await applyOutbox(priya, dmwestId, [item]);
    expect(outcome.result).toBe('accepted');
    if (outcome.result !== 'accepted') return;
    scratchLeads.push(outcome.id);

    const row = await db.query.leads.findFirst({ where: eq(s.leads.id, outcome.id) });
    // Attributed to the person, not to a service principal — that attribution
    // is the entire input to §8c's coverage figure.
    expect(row!.capturedById).toBe(priya.userId);
    expect(row!.externalRef).toBe(ref('one'));
    // No basis was chosen, so none is recorded. The offline path goes through
    // the same `captureLead` a form does, so `consent.ts`'s first rule holds.
    expect(row!.consentBasis).toBe('unknown');
    expect(row!.consentCapturedAt).toBeNull();
  });

  it('answers a re-send as a success and writes nothing twice', async () => {
    // The claim the whole feature rests on. An outbox retries over a lunch
    // break, after a browser has been killed, from a different network — and a
    // 409 would teach it that a recorded lead is a failure, after which somebody
    // writes the loop that manufactures the duplicates the rail exists to stop.
    const item = queued({ clientRef: ref('retry'), body: { fullName: 'Retry Person' } });
    const [first] = await applyOutbox(priya, dmwestId, [item]);
    expect(first.result).toBe('accepted');
    if (first.result === 'accepted') scratchLeads.push(first.id);

    const [second] = await applyOutbox(priya, dmwestId, [item]);
    expect(second.result).toBe('already');
    if (second.result === 'already') expect(second.id).toBe((first as { id: string }).id);

    const rows = await db
      .select()
      .from(s.leads)
      .where(and(eq(s.leads.showId, dmwestId), eq(s.leads.externalRef, ref('retry'))));
    expect(rows).toHaveLength(1);

    // And `already` clears the item off the device, exactly as `accepted` does.
    expect(reconcile([item], [second]).remaining).toHaveLength(0);
  });

  it('tells our own re-send apart from somebody else meeting the same person', async () => {
    // Both are duplicates in the database's eyes and only one of them is news.
    const item = queued({
      clientRef: ref('dupe'),
      body: { fullName: 'Dana Whitfield', email: 'dana.whitfield@lakeside-mfg.test' },
    });
    const [outcome] = await applyOutbox(priya, dmwestId, [item]);
    expect(outcome.result).toBe('duplicate');
    if (outcome.result === 'duplicate') expect(outcome.detail).toContain('already captured');
  });

  it('writes eight when the seventh is bad, and answers about all nine', async () => {
    // A batch is not a transaction. Rolling back to protect the consistency of
    // something that only exists because a hall had no wifi would send eight
    // real conversations back to a phone.
    const good = queued({ clientRef: ref('batch-a'), body: { fullName: 'Batch A' } });
    const bad = queued({ clientRef: ref('batch-b'), body: { fullName: '   ' } });
    const alsoGood = queued({ clientRef: ref('batch-c'), body: { fullName: 'Batch C' } });

    const outcomes = await applyOutbox(priya, dmwestId, [good, bad, alsoGood]);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.result)).toEqual(['accepted', 'rejected', 'accepted']);
    for (const o of outcomes) if ('id' in o) scratchLeads.push(o.id);

    const result = reconcile([good, bad, alsoGood], outcomes);
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].blocked).toBe(true);
  });

  it('refuses a reference this app did not mint', async () => {
    // The rail only works if everything on it is ours. A badge vendor's ref
    // sharing the column could answer `already` to a stranger's scan.
    const [outcome] = await applyOutbox(
      priya,
      dmwestId,
      [queued({ clientRef: 'DMW-88301' })],
    );
    expect(outcome.result).toBe('rejected');
  });

  it('records a lead at the device clock, and never in the future', async () => {
    const past = new Date(Date.now() - 3 * 3_600_000);
    const item = queued({
      clientRef: ref('clock'),
      body: { fullName: 'Clock Person' },
      queuedAt: past.toISOString(),
    });
    const [outcome] = await applyOutbox(priya, dmwestId, [item]);
    if (outcome.result !== 'accepted') throw new Error('expected accepted');
    scratchLeads.push(outcome.id);
    const row = await db.query.leads.findFirst({ where: eq(s.leads.id, outcome.id) });
    expect(row!.capturedAt.getTime()).toBe(past.getTime());

    // A fast device clock would file a conversation that has not happened yet:
    // it sorts to the top of every list forever and lands in a shift that has
    // not run. The EasyPost replay's rule, from the client side.
    const now = new Date();
    const future = queued({
      clientRef: ref('future'),
      body: { fullName: 'Future Person' },
      queuedAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    const [second] = await applyOutbox(priya, dmwestId, [future], now);
    if (second.result !== 'accepted') throw new Error('expected accepted');
    scratchLeads.push(second.id);
    const futureRow = await db.query.leads.findFirst({ where: eq(s.leads.id, second.id) });
    expect(futureRow!.capturedAt.getTime()).toBe(now.getTime());
  });

  it('records a meeting once, however many times it is sent', async () => {
    const item = queued({
      clientRef: ref('meeting'),
      kind: 'meeting',
      body: { subject: 'Offline Meeting', company: 'Acme' },
    });
    const [first] = await applyOutbox(priya, dmwestId, [item]);
    expect(first.result).toBe('accepted');
    const [second] = await applyOutbox(priya, dmwestId, [item]);
    expect(second.result).toBe('already');
    const rows = await db
      .select()
      .from(s.meetings)
      .where(and(eq(s.meetings.showId, dmwestId), eq(s.meetings.externalRef, ref('meeting'))));
    expect(rows).toHaveLength(1);
    // A meeting recorded at the booth is one that just happened, not one that
    // is scheduled — the form has no "when", because §8c is a story about
    // seconds.
    expect(rows[0].occurredAt).not.toBeNull();
  });

  it('refuses an item captured against a different show', async () => {
    const [outcome] = await applyOutbox(
      priya,
      dmwestId,
      [queued({ clientRef: ref('elsewhere'), showId: 'someone-elses-show' })],
    );
    expect(outcome.result).toBe('rejected');
  });
});
