import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { recordNotices, syncConditionAlerts } from '@/lib/alerts/store';
import { canSetDestination } from '@/lib/notify/access';
import {
  connectMyChannel,
  deliverPending,
  disableMyChannel,
  getDeliveryLog,
  getMyChannel,
} from '@/lib/notify/store';
import { runNightly, getRunStanding } from '@/lib/schedule/nightly';
import { ConsoleTransport } from '@/lib/integrations/notify/console/provider';
import { TransportError, type NotificationTransport } from '@/lib/integrations/notify/types';

/**
 * Step 21 against the real database.
 *
 * The pure half — what is worth carrying, the Slack failure shape, the
 * scheduler's credential — is in `src/lib/notify/notify.test.ts` with no
 * database. What can only be checked here is what touches rows: that the
 * delivery rail makes a second run send nothing while a *recurrence* sends
 * again, that a failed send is recorded as failed and retried, that each
 * person's message is composed from their own scoped feed, and that a nightly
 * run leaves a record either way.
 *
 * **It runs entirely in a throwaway workspace**, for the reason `leads.test.ts`
 * states about the retention sweep and step 15 learned the hard way: a delivery
 * pass plans over *every person in an org*, and every assertion here about
 * "nothing was sent" would otherwise be an assertion about the seeded
 * workspace's whole alert table — which the test would then have to quieten to
 * make true. Green suite, degraded demo, nothing to notice it.
 */

const db = getDb();
const scratchOrgs: string[] = [];

class FakeTransport implements NotificationTransport {
  readonly name = 'fake';
  readonly reachesPeople = true;
  sent: { address: string; text: string }[] = [];
  /**
   * Fail for one address only. A delivery pass plans over every person in the
   * org, so "fail the next send" is a race against whoever the query returns
   * first — which is exactly the kind of order-dependence that makes a suite
   * pass for a year and then not.
   */
  failFor: string | null = null;

  isConfigured() {
    return true;
  }
  async resolveAddress({ email }: { email: string }) {
    return { address: `X-${email}`, kind: 'dm' as const, label: email };
  }
  async send(message: { address: string; text: string }) {
    if (this.failFor && message.address === this.failFor) {
      this.failFor = null;
      throw new TransportError('Slack refused chat.postMessage: is_archived.', this.name, false);
    }
    this.sent.push({ address: message.address, text: message.text });
    return { transport: this.name, outcome: 'sent' as const, providerMessageId: 'm1', detail: null };
  }
}

async function workspace(): Promise<{ ana: Actor; ben: Actor }> {
  const [org] = await db
    .insert(s.organizations)
    .values({ name: 'Notifications scratch workspace' })
    .returning({ id: s.organizations.id });
  scratchOrgs.push(org.id);

  const made: Actor[] = [];
  for (const [name, role] of [
    ['Ana Scratch', 'member'],
    ['Ben Scratch', 'admin'],
  ] as const) {
    const [user] = await db
      .insert(s.users)
      .values({
        orgId: org.id,
        email: `${name.split(' ')[0].toLowerCase()}-${org.id}@scratch.test`,
        fullName: name,
        role,
      })
      .returning();
    made.push({
      userId: user.id,
      orgId: org.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      costCenterId: user.costCenterId,
    });
  }
  return { ana: made[0], ben: made[1] };
}

let ana: Actor;
let ben: Actor;
let fake: FakeTransport;

async function raise(
  actor: Actor,
  key: string,
  title: string,
  severity: 'critical' | 'info',
  now: Date,
) {
  await syncConditionAlerts(db, {
    orgId: actor.orgId,
    source: 'asset',
    now,
    writes: [
      {
        showId: null,
        userId: actor.userId,
        severity,
        title,
        body: 'Body written by the engine that owns the judgment.',
        dedupeKey: key,
      },
    ],
  });
  return (await db.query.alerts.findFirst({
    where: and(eq(s.alerts.orgId, actor.orgId), eq(s.alerts.dedupeKey, key)),
  }))!;
}

beforeAll(async () => {
  ({ ana, ben } = await workspace());
  fake = new FakeTransport();
});

afterAll(async () => {
  if (scratchOrgs.length) {
    await db.delete(s.organizations).where(inArray(s.organizations.id, scratchOrgs));
  }
});

describe('connecting a destination', () => {
  it('resolves the address from the transport rather than taking one', async () => {
    const result = await connectMyChannel(ana, { transport: fake });
    expect('channel' in result).toBe(true);
    if ('channel' in result) {
      expect(result.channel.address).toBe(`X-${ana.email}`);
      expect(result.channel.verifiedAt).not.toBeNull();
    }
  });

  it('reports an unknown person as unreachable rather than as an error', async () => {
    const absent: NotificationTransport = {
      name: 'fake',
      reachesPeople: true,
      isConfigured: () => true,
      resolveAddress: async () => ({ noAddress: true as const, reason: 'Not in this workspace.' }),
      send: async () => {
        throw new Error('never reached');
      },
    };
    expect('unreachable' in (await connectMyChannel(ben, { transport: absent }))).toBe(true);
  });

  it('is the subject’s own act — an admin does not set somebody else’s', () => {
    // Structural first: `connectMyChannel` has no subject parameter, so there is
    // nothing for an admin to pass. The gate is what stops one being added.
    expect(canSetDestination(ben, ana.userId)).toBe(false);
    expect(canSetDestination(ana, ana.userId)).toBe(true);
  });

  it('turns off with a written reason, and keeps the row', async () => {
    await connectMyChannel(ben, { transport: fake });
    await expect(disableMyChannel(ben, '   ')).rejects.toThrow();
    await disableMyChannel(ben, 'Too noisy during a build week.');
    const row = await getMyChannel(ben, 'fake');
    expect(row?.disabledAt).not.toBeNull();
    expect(row?.disabledReason).toContain('noisy');
    // Back on for the rest of the file.
    await connectMyChannel(ben, { transport: fake });
  });
});

describe('the delivery rail', () => {
  it('carries once, then nothing, then again on a recurrence', async () => {
    const now = new Date();
    const alert = await raise(ana, 'rail:one', 'A booth is unserviceable', 'critical', now);

    const first = await deliverPending(ana.orgId, { transport: fake, now }, db);
    expect(first.sent).toBe(1);

    // Same condition, another sweep: occurrences climb, createdAt does not.
    const second = await deliverPending(
      ana.orgId,
      { transport: fake, now: new Date(now.getTime() + 60_000) },
      db,
    );
    expect(second.sent).toBe(0);

    // A recurrence: `alerts/store.ts` restarts the clock, and the transport
    // inherits that decision rather than making a second one beside it.
    await db
      .update(s.alerts)
      .set({ createdAt: new Date(now.getTime() + 120_000), occurrences: 1 })
      .where(eq(s.alerts.id, alert.id));
    const third = await deliverPending(
      ana.orgId,
      { transport: fake, now: new Date(now.getTime() + 180_000) },
      db,
    );
    expect(third.sent).toBe(1);
  });

  it('records a failure as failed, and retries it on the next pass', async () => {
    const now = new Date(Date.now() + 600_000);
    await raise(ben, 'rail:fail', 'A crate has gone quiet', 'critical', now);

    fake.failFor = `X-${ben.email}`;
    const failed = await deliverPending(ben.orgId, { transport: fake, now }, db);
    expect(failed.failed).toBe(1);

    const log = await getDeliveryLog(ben, { scope: 'mine', limit: 5 }, db);
    expect(log[0].outcome).toBe('failed');
    expect(log[0].detail).toContain('will not succeed on a retry');

    const retried = await deliverPending(
      ben.orgId,
      { transport: fake, now: new Date(now.getTime() + 60_000) },
      db,
    );
    expect(retried.sent).toBe(1);
  });

  it('composes each person’s message from their own scoped feed', async () => {
    // The posture `assistant/tools.ts` states: the narrowing is in the query, so
    // there is no filter here to get wrong. Ana's message can only contain rows
    // `getAlertFeed(ana)` returned.
    const now = new Date(Date.now() + 1_200_000);
    await raise(ben, 'rail:bens-only', 'Ben only: a fare needs approval', 'critical', now);
    fake.sent = [];
    await deliverPending(ana.orgId, { transport: fake, now }, db);
    const toAna = fake.sent.filter((m) => m.address === `X-${ana.email}`);
    expect(toAna.every((m) => !m.text.includes('Ben only'))).toBe(true);
  });

  it('never records a console delivery as sent', async () => {
    const now = new Date(Date.now() + 1_800_000);
    await raise(ana, 'rail:console', 'A reservation is overdue', 'critical', now);
    const rendering = new ConsoleTransport();
    await connectMyChannel(ana, { transport: rendering });
    const run = await deliverPending(ana.orgId, { transport: rendering, now }, db);
    expect(run.sent).toBe(0);
    expect(run.rendered).toBeGreaterThan(0);
    // And the message really was composed, from the real alert.
    expect(rendering.outbox[0].text).toContain('A reservation is overdue');
  });

  it('carries a notice at info severity, because a notice is an event', async () => {
    const now = new Date(Date.now() + 2_400_000);
    await recordNotices(db, {
      orgId: ana.orgId,
      source: 'booking',
      now,
      writes: [
        {
          showId: null,
          userId: ana.userId,
          severity: 'info',
          title: '[dry run] Your flight is ticketed: SFO → ORD',
          body: '$412.00, confirmation ABC123.',
          dedupeKey: 'rail:ticketed',
        },
      ],
    });
    fake.sent = [];
    await connectMyChannel(ana, { transport: fake });
    await deliverPending(ana.orgId, { transport: fake, now }, db);
    expect(fake.sent.some((m) => m.text.includes('Your flight is ticketed'))).toBe(true);
  });

  it('refuses the org-wide log to a Member', async () => {
    await expect(getDeliveryLog(ana, { scope: 'org' }, db)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets an admin read who was told what', async () => {
    const rows = await getDeliveryLog(ben, { scope: 'org', limit: 100 }, db);
    expect(rows.some((r) => r.recipientName === 'Ana Scratch')).toBe(true);
  });
});

describe('the nightly run', () => {
  it('records the run before it does anything, and closes it either way', async () => {
    const run = await runNightly(
      ana.orgId,
      { trigger: 'manual', transport: fake, skipRetention: true },
      db,
    );
    expect(run.runId).toBeTruthy();
    const row = await db.query.scheduledRuns.findFirst({
      where: eq(s.scheduledRuns.id, run.runId),
    });
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.summary).toContain('Delivery via');
  });

  it('keeps “somebody ran it” and “it runs” as different answers', async () => {
    const standing = await getRunStanding(ana.orgId, new Date(), db);
    expect(standing.standing).toBe('manual_only');
  });

  it('writes a row and an error when a stage throws, rather than nothing', async () => {
    const exploding: NotificationTransport = {
      name: 'exploding',
      reachesPeople: true,
      isConfigured: () => true,
      resolveAddress: async () => ({ noAddress: true as const, reason: 'n/a' }),
      send: async () => {
        throw new Error('the transport is down');
      },
    };
    const run = await runNightly(
      ana.orgId,
      { trigger: 'manual', transport: exploding, skipRetention: true },
      db,
    );
    const row = await db.query.scheduledRuns.findFirst({
      where: eq(s.scheduledRuns.id, run.runId),
    });
    expect(row).toBeTruthy();
    expect(row?.finishedAt).not.toBeNull();
    // A send that throws is caught and recorded against the alerts it would
    // have carried; the run itself still finished, which is the distinction
    // between a stage failing and the job never having happened.
    expect(row?.summary).toContain('failed');
  });
});
