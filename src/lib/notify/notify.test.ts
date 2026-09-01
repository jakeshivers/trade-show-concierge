import { describe, it, expect } from 'vitest';
import type { FeedAlert } from '@/lib/alerts/feed';
import { planForPerson, BACKFILL_GRACE_HOURS, type Destination, type PriorDelivery } from './plan';
import { blocksFor, escapeMrkdwn, SlackTransport } from '@/lib/integrations/notify/slack/client';
import { ConsoleTransport } from '@/lib/integrations/notify/console/provider';
import { selectTransport } from './provider';
import { authenticateScheduler } from '@/lib/schedule/principal';
import { describeRunStanding } from '@/lib/schedule/nightly';
import { isNoAddress, TransportError } from '@/lib/integrations/notify/types';

/**
 * Step 21's pure half: what is worth carrying, the transport's failure shape,
 * and the scheduler's credential. Nothing here touches the database — the rows
 * are exercised in `tests/notifications.test.ts`.
 */

const NOW = new Date('2026-09-01T09:00:00Z');
const USER = 'user-1';

function alert(over: Partial<FeedAlert> = {}): FeedAlert {
  return {
    id: 'a1',
    source: 'shipping',
    kind: 'condition',
    severity: 'critical',
    title: 'Crate NW-1104 has not scanned since Tuesday',
    body: 'Still promised for Thursday. Nothing has scanned it in 61 hours.',
    showId: 'show-1',
    showName: 'Automate 2026',
    userId: USER,
    dedupeKey: 'shipping:1:stalled',
    createdAt: new Date('2026-09-01T02:00:00Z'),
    lastSeenAt: new Date('2026-09-01T02:00:00Z'),
    occurrences: 1,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedByName: null,
    ...over,
  };
}

const dm: Destination = {
  channelId: 'chan-1',
  transport: 'slack',
  kind: 'dm',
  address: 'U123',
  userId: USER,
  verifiedAt: new Date('2026-08-01T00:00:00Z'),
};

const room: Destination = { ...dm, channelId: 'chan-2', kind: 'channel', address: 'C999', userId: null };

const plan = (alerts: FeedAlert[], destination: Destination | null, prior: PriorDelivery[] = []) =>
  planForPerson({ alerts, destination, prior, now: NOW });

describe('what is worth carrying', () => {
  it('carries a critical condition once', () => {
    const p = plan([alert()], dm);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].items).toHaveLength(1);
    expect(p.messages[0].text).toContain('Crate NW-1104');
    // The engine's own sentence, verbatim. Five steps of tense arguments live
    // in that string and a paraphrase here would undo all of them.
    expect(p.messages[0].text).toContain('Nothing has scanned it in 61 hours.');
  });

  it('leaves an info condition on the screen', () => {
    const p = plan([alert({ severity: 'info' })], dm);
    expect(p.messages).toHaveLength(0);
    expect(p.suppressed[0].reason).toBe('below_floor');
  });

  it('carries an info NOTICE, because a notice is an event', () => {
    // §6c rail 6: a purchase notifies at the moment of ticketing. It is `info`
    // and it is exactly the message a traveler wants pushed.
    const p = plan([alert({ kind: 'notice', severity: 'info', title: 'Your flight is ticketed' })], dm);
    expect(p.messages).toHaveLength(1);
  });

  it('sends nothing twice for a condition that simply persists', () => {
    const a = alert();
    const prior: PriorDelivery[] = [
      { alertId: a.id, channelId: dm.channelId, phase: 'raised', alertCreatedAt: a.createdAt, outcome: 'sent' },
    ];
    // The row's occurrences climb every night; createdAt does not move.
    const p = plan([{ ...a, occurrences: 9, lastSeenAt: NOW }], dm, prior);
    expect(p.messages).toHaveLength(0);
  });

  it('sends again for a recurrence, because the alert store restarted the clock', () => {
    const a = alert();
    const prior: PriorDelivery[] = [
      { alertId: a.id, channelId: dm.channelId, phase: 'raised', alertCreatedAt: a.createdAt, outcome: 'sent' },
    ];
    const recurred = { ...a, createdAt: new Date('2026-09-01T08:00:00Z') };
    expect(plan([recurred], dm, prior).messages).toHaveLength(1);
  });

  it('retries a failure and does not re-litigate a suppression', () => {
    const a = alert();
    const failed: PriorDelivery[] = [
      { alertId: a.id, channelId: dm.channelId, phase: 'raised', alertCreatedAt: a.createdAt, outcome: 'failed' },
    ];
    expect(plan([a], dm, failed).messages).toHaveLength(1);

    const suppressed: PriorDelivery[] = [
      { alertId: a.id, channelId: dm.channelId, phase: 'raised', alertCreatedAt: a.createdAt, outcome: 'suppressed' },
    ];
    expect(plan([a], dm, suppressed).messages).toHaveLength(0);
  });
});

describe('the four refusals', () => {
  it('does not replay history when a transport is switched on', () => {
    const old = alert({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const p = plan([old], dm);
    expect(p.messages).toHaveLength(0);
    expect(p.suppressed[0].reason).toBe('backfill');
    expect(p.suppressed[0].detail).toContain('does not replay');
  });

  it('allows a grace window, so an alert raised just before connecting still goes', () => {
    const justBefore = alert({
      createdAt: new Date(dm.verifiedAt.getTime() - (BACKFILL_GRACE_HOURS - 1) * 3_600_000),
      lastSeenAt: NOW,
    });
    expect(plan([justBefore], dm).messages).toHaveLength(1);
  });

  it('tells nobody a thing resolved if they were never told it started', () => {
    const done = alert({ resolvedAt: new Date('2026-09-01T08:00:00Z') });
    const p = plan([done], dm);
    expect(p.messages).toHaveLength(0);
    expect(p.suppressed[0].reason).toBe('not_told');
  });

  it('tells somebody it resolved when they were told it started', () => {
    const a = alert();
    const prior: PriorDelivery[] = [
      { alertId: a.id, channelId: dm.channelId, phase: 'raised', alertCreatedAt: a.createdAt, outcome: 'sent' },
    ];
    const done = { ...a, resolvedAt: new Date('2026-09-01T08:00:00Z') };
    const p = plan([done], dm, prior);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].items[0].phase).toBe('resolved');
    expect(p.messages[0].text).toContain('Resolved');
    // And it says the app noticed, rather than implying somebody cleared it.
    expect(p.messages[0].text).toContain('Nobody dismissed it');
  });

  it('refuses to post a personal alert to a shared channel', () => {
    const p = plan([alert()], room);
    expect(p.messages).toHaveLength(0);
    expect(p.suppressed[0].reason).toBe('wrong_kind');
  });

  it('routes an org-wide alert to a channel', () => {
    const p = plan([alert({ userId: null })], room);
    expect(p.messages).toHaveLength(1);
  });

  it('reports somebody with nowhere to send, rather than skipping them', () => {
    const p = plan([alert()], null);
    expect(p.messages).toHaveLength(0);
    expect(p.suppressed[0].reason).toBe('no_destination');
  });
});

describe('one sentence, once', () => {
  it('folds eleven identical rows into one message', () => {
    // The feed found this on real data: eleven people on one re-timed flight.
    const rows = Array.from({ length: 11 }, (_, i) =>
      alert({
        id: `f${i}`,
        source: 'flight',
        severity: 'warning',
        title: 'The airline moved DL 1422',
        dedupeKey: `flight:${i}`,
      }),
    );
    const p = plan(rows, dm);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].items).toHaveLength(1);
    // Every row still gets its own log entry — the engine's granularity is
    // right, and it is only the reading that had to collapse.
    expect(p.messages[0].items[0].covers).toHaveLength(11);
    expect(p.messages[0].text).toContain('10 more row(s) say the same thing');
  });

  it('never sends more than one message to one person', () => {
    const p = plan(
      [alert({ id: 'a' }), alert({ id: 'b', source: 'deadline', title: 'Rigging labor closes Friday' })],
      dm,
    );
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].items).toHaveLength(2);
  });

  it('says out loud when a claim has not been re-checked', () => {
    const stale = alert({ lastSeenAt: new Date('2026-08-27T00:00:00Z'), createdAt: new Date('2026-08-27T00:00:00Z') });
    // Old enough to be unchecked, and within the backfill grace of a
    // destination verified a month ago? No — so verify recently.
    const dest = { ...dm, verifiedAt: new Date('2026-08-26T00:00:00Z') };
    const p = planForPerson({ alerts: [stale], destination: dest, prior: [], now: NOW });
    expect(p.messages[0].text).toContain('rather than what is true now');
  });
});

/* -------------------------------- transports ------------------------------- */

function mockSlack(responses: Record<string, unknown>, status = 200) {
  const calls: { method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      json: async () => responses[method] ?? { ok: false, error: 'unhandled_in_test' },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    transport: new SlackTransport({ botToken: 'xoxb-test', fetch: fetchImpl }),
  };
}

describe('the Slack transport', () => {
  it('reads `ok`, not the HTTP status — a refusal arrives as 200', () => {
    // The one thing about this API a fixture written from the docs can catch,
    // and the failure with no symptom: a client checking `res.ok` records every
    // refusal as a delivery.
    const { transport } = mockSlack({ 'conversations.open': { ok: false, error: 'channel_not_found' } });
    return expect(
      transport.send({ address: 'U1', kind: 'dm', text: 'hi' }),
    ).rejects.toThrow(/channel_not_found/);
  });

  it('marks an archived channel as not retryable and a rate limit as retryable', async () => {
    const { transport } = mockSlack({ 'conversations.open': { ok: false, error: 'is_archived' } });
    await transport.send({ address: 'U1', kind: 'dm', text: 'hi' }).catch((err: TransportError) => {
      expect(err.retryable).toBe(false);
    });
    const limited = mockSlack({}, 429);
    await limited.transport.send({ address: 'U1', kind: 'dm', text: 'hi' }).catch((err: TransportError) => {
      expect(err.retryable).toBe(true);
    });
  });

  it('opens the DM before posting, and posts to the conversation', async () => {
    const { transport, calls } = mockSlack({
      'conversations.open': { ok: true, channel: { id: 'D42' } },
      'chat.postMessage': { ok: true, ts: '1725181200.000100' },
    });
    const receipt = await transport.send({ address: 'U1', kind: 'dm', text: 'hi' });
    expect(calls.map((c) => c.method)).toEqual(['conversations.open', 'chat.postMessage']);
    expect((calls[1].body as { channel: string }).channel).toBe('D42');
    expect(receipt.outcome).toBe('sent');
    expect(receipt.providerMessageId).toBe('1725181200.000100');
  });

  it('reports a missing person as no-address rather than as an error', async () => {
    const { transport } = mockSlack({ 'users.lookupByEmail': { ok: false, error: 'users_not_found' } });
    const found = await transport.resolveAddress({ email: 'nobody@example.test' });
    expect(isNoAddress(found)).toBe(true);
  });

  it('reports a deactivated account as unreachable rather than as an address', async () => {
    const { transport } = mockSlack({
      'users.lookupByEmail': { ok: true, user: { id: 'U9', deleted: true } },
    });
    const found = await transport.resolveAddress({ email: 'gone@example.test' });
    expect(isNoAddress(found)).toBe(true);
  });

  it('escapes Slack’s three reserved characters and caps the block count', () => {
    expect(escapeMrkdwn('R&D <urgent>')).toBe('R&amp;D &lt;urgent&gt;');
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, body: 'b' }));
    expect(blocksFor({ address: 'U1', kind: 'dm', text: 't', sections: many })!.length).toBe(50);
  });
});

describe('the console transport', () => {
  it('renders, and never reports a delivery', async () => {
    const t = new ConsoleTransport();
    const receipt = await t.send({ address: 'console:a@b.test', kind: 'dm', text: 'hi' });
    // The `recorded` rule, on the way out: a replayed *answer* is honest and a
    // replayed *delivery* is a claim that somebody's phone buzzed.
    expect(receipt.outcome).toBe('rendered');
    expect(t.reachesPeople).toBe(false);
    expect(t.outbox).toHaveLength(1);
  });

  it('resolves to an address that cannot be mistaken for a real one', async () => {
    const found = await new ConsoleTransport().resolveAddress({ email: 'a@b.test' });
    expect(isNoAddress(found)).toBe(false);
    if (!isNoAddress(found)) expect(found.address.startsWith('console:')).toBe(true);
  });
});

describe('choosing a transport', () => {
  it('falls to console with no key, and says it is not live', () => {
    const c = selectTransport({});
    expect(c.source).toBe('console');
    expect(c.live).toBe(false);
  });

  it('uses Slack when there is a token', () => {
    expect(selectTransport({ SLACK_BOT_TOKEN: 'xoxb-x' }).source).toBe('slack');
  });

  it('throws when slack is asked for by name and not configured', () => {
    expect(() => selectTransport({ NOTIFY_TRANSPORT: 'slack' })).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('throws on a name it does not have, rather than quietly reaching nobody', () => {
    expect(() => selectTransport({ NOTIFY_TRANSPORT: 'teams' })).toThrow(/not a transport/);
  });
});

/* -------------------------------- scheduling ------------------------------- */

describe('the scheduler credential', () => {
  it('refuses when no secret is configured, rather than running', () => {
    const r = authenticateScheduler('Bearer anything', {});
    expect('refusal' in r && r.refusal.status).toBe(503);
  });

  it('accepts the secret with or without the Bearer prefix', () => {
    const env = { CRON_SECRET: 's3cret' };
    expect('principal' in authenticateScheduler('Bearer s3cret', env)).toBe(true);
    expect('principal' in authenticateScheduler('s3cret', env)).toBe(true);
  });

  it('refuses a wrong secret', () => {
    const r = authenticateScheduler('Bearer nope', { CRON_SECRET: 's3cret' });
    expect('refusal' in r && r.refusal.status).toBe(401);
  });

  it('is not an Actor — it has no org, no role and no user', () => {
    const r = authenticateScheduler('s3cret', { CRON_SECRET: 's3cret' });
    if (!('principal' in r)) throw new Error('expected a principal');
    expect(Object.keys(r.principal).sort()).toEqual(['job', 'trigger']);
  });
});

describe('did the job run', () => {
  it('distinguishes never, manual-only and overdue', () => {
    expect(describeRunStanding({ lastRun: null, standing: 'never', hoursSince: null })).toContain(
      'No sweep has ever run',
    );
    const last = { startedAt: NOW, ok: true, trigger: 'manual', error: null };
    expect(describeRunStanding({ lastRun: last, standing: 'manual_only', hoursSince: 1 })).toContain(
      'run by a person',
    );
    expect(describeRunStanding({ lastRun: last, standing: 'overdue', hoursSince: 70 })).toContain(
      'an empty feed is not evidence of a quiet night',
    );
  });
});

describe('the order the refusals are applied in', () => {
  it('counts alerts *worth carrying* as unreachable, not every alert', () => {
    // Reversed, a person with no Slack account and nine info-level rows is
    // reported as nine missed notifications — a shortfall the transport was
    // never going to fill, growing every time an engine says something quiet.
    const p = plan([alert({ severity: 'info' }), alert({ id: 'a2' })], null);
    const missed = p.suppressed.filter((x) => x.reason === 'no_destination');
    expect(missed).toHaveLength(1);
    expect(missed[0].alert.id).toBe('a2');
  });

  it('does not blame a missing destination for a resolution nobody was owed', () => {
    const p = plan([alert({ resolvedAt: NOW })], null);
    expect(p.suppressed[0].reason).toBe('not_told');
  });
});

describe('Slack’s hard limits', () => {
  it('trims a long section rather than letting the whole digest be rejected', () => {
    // Both limits are rejections, not truncations: one wordy alert would take
    // every other alert in the message down with it, with `invalid_blocks`.
    const long = { title: 'Asset', body: 'x'.repeat(5_000) };
    const [block] = blocksFor({ address: 'U1', kind: 'dm', text: 't', sections: [long] })!;
    expect(block.type).toBe('section');
    if (block.type === 'section') {
      expect(block.text.text.length).toBeLessThan(3_000);
      expect(block.text.text).toContain('trimmed');
    }
  });
});
