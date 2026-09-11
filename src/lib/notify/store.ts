import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { getAlertFeed } from '@/lib/alerts/store';
import type { FeedAlert } from '@/lib/alerts/feed';
import {
  isNoAddress,
  TransportError,
  type NotificationTransport,
} from '@/lib/integrations/notify/types';
import {
  canConfigureTransport,
  canReadOrgDeliveries,
  canSetDestination,
} from './access';
import {
  planForPerson,
  sectionsFor,
  type Destination,
  type DeliveryPhase,
  type PlannedMessage,
  type PriorDelivery,
} from './plan';
import { appBaseUrl, selectTransport } from './provider';

type Db = ReturnType<typeof getDb>;

/**
 * The only file that touches `notification_channels` and
 * `notification_deliveries`, and the only place a transport is ever called.
 *
 * The shape is the one every step since 8 has used: the decisions are in
 * `plan.ts` and are pure, this file loads rows, calls the adapter, and writes
 * down what happened. Two things about it are specific to a transport and are
 * worth stating where somebody changing it will read them.
 *
 * **Delivery never runs inside the act it reports.** §6c rail 6 asks for a
 * purchase to notify the traveler *at the moment of ticketing*, and
 * `travel/notify.ts` does exactly that — into the `alerts` table, which is the
 * durable record that the notification was owed. Carrying it further is a
 * separate pass, because a Slack outage must not fail a ticket purchase and a
 * retry of a purchase must not be a retry of a message. What that costs is
 * honesty about latency: with no job queue in this product, "the moment of
 * ticketing" for the *transport* means the next delivery pass, which is the
 * nightly run or somebody pressing a button. The row is what makes the
 * difference recoverable rather than lost.
 *
 * **A failed send is recorded as failed, and is retried exactly as often as it
 * is planned again.** Not in a loop here. A rate limit clears by tomorrow; an
 * archived channel does not, and the transport says which is which. Retrying a
 * permanent failure forever is the badge that is always on, which `outbox.ts`
 * settled for a device queue and applies unchanged here.
 */

/* ------------------------------- destinations ------------------------------ */

export class NotifyError extends Error {}

export type ChannelRow = {
  id: string;
  userId: string | null;
  transport: string;
  kind: 'dm' | 'channel';
  address: string;
  label: string | null;
  verifiedAt: Date | null;
  disabledAt: Date | null;
  disabledReason: string | null;
};

function asChannel(row: typeof s.notificationChannels.$inferSelect): ChannelRow {
  return {
    id: row.id,
    userId: row.userId,
    transport: row.transport,
    kind: row.kind === 'channel' ? 'channel' : 'dm',
    address: row.address,
    label: row.label,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
  };
}

export async function getMyChannel(
  actor: Actor,
  transportName?: string,
  db: Db = getDb(),
): Promise<ChannelRow | null> {
  const name = transportName ?? selectTransport().transport.name;
  const row = await db.query.notificationChannels.findFirst({
    where: and(
      eq(s.notificationChannels.orgId, actor.orgId),
      eq(s.notificationChannels.userId, actor.userId),
      eq(s.notificationChannels.transport, name),
    ),
  });
  return row ? asChannel(row) : null;
}

/**
 * Connect this person to the transport, using the transport's own answer.
 *
 * The address is **resolved, never typed**. A Slack member id pasted into a form
 * is a claim, and a message sent to a wrong one does not bounce — Slack accepts
 * it, the delivery log says `sent`, and nobody's phone ever buzzes. So the only
 * input is the actor's own email, the transport turns it into an id, and the row
 * is written with `verified_at` set by that answer.
 *
 * `noAddress` is not an error. "You are not in this Slack workspace" is an
 * ordinary fact about a contractor, and it deserves the sentence the transport
 * wrote rather than a red box.
 */
export async function connectMyChannel(
  actor: Actor,
  opts: { transport?: NotificationTransport; now?: Date } = {},
  db: Db = getDb(),
): Promise<{ channel: ChannelRow } | { unreachable: string }> {
  if (!canSetDestination(actor, actor.userId)) {
    throw new ForbiddenError('A destination is set by the person whose alerts go to it.');
  }
  const transport = opts.transport ?? selectTransport().transport;
  const now = opts.now ?? new Date();

  const lookup = await transport.resolveAddress({ email: actor.email });
  if (isNoAddress(lookup)) return { unreachable: lookup.reason };

  const [row] = await db
    .insert(s.notificationChannels)
    .values({
      orgId: actor.orgId,
      userId: actor.userId,
      transport: transport.name,
      kind: lookup.kind,
      address: lookup.address,
      label: lookup.label,
      verifiedAt: now,
      disabledAt: null,
      disabledReason: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        s.notificationChannels.orgId,
        s.notificationChannels.userId,
        s.notificationChannels.transport,
      ],
      set: {
        kind: lookup.kind,
        address: lookup.address,
        label: lookup.label,
        verifiedAt: now,
        disabledAt: null,
        disabledReason: null,
        updatedAt: now,
      },
    })
    .returning();
  return { channel: asChannel(row) };
}

/**
 * Turn it off. A timestamp, never a delete — the intake key's rule, and the
 * declined show's: "why did these messages stop" has to stay answerable, and a
 * deleted row takes the delivery log's foreign key with it.
 */
export async function disableMyChannel(
  actor: Actor,
  reason: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canSetDestination(actor, actor.userId)) {
    throw new ForbiddenError('A destination is turned off by the person whose alerts go to it.');
  }
  const written = reason.trim();
  if (!written) throw new NotifyError('Say why, so the log can answer why these stopped.');
  await db
    .update(s.notificationChannels)
    .set({ disabledAt: now, disabledReason: written, updatedAt: now })
    .where(
      and(
        eq(s.notificationChannels.orgId, actor.orgId),
        eq(s.notificationChannels.userId, actor.userId),
      ),
    );
}

/* --------------------------------- delivery -------------------------------- */

export type DeliveryOutcome = 'sent' | 'rendered' | 'undeliverable' | 'suppressed' | 'failed';

export type DeliveryRunResult = {
  transport: string;
  /** False when nothing this run did reached a person. */
  live: boolean;
  people: number;
  messages: number;
  sent: number;
  rendered: number;
  failed: number;
  suppressed: number;
  undeliverable: number;
  /** People with alerts worth carrying and nowhere to carry them to. */
  unreachable: { userId: string; name: string; alerts: number }[];
  /** Every message this run composed, for `pnpm nightly` to print verbatim. */
  composed: PlannedMessage[];
};

/**
 * Carry everything that is owed, to everybody it is owed to.
 *
 * Plans **over every person in the org**, not over what changed tonight, and for
 * `alerts/store.ts`'s reason stated from the other end: a delivery pass that
 * looked only at alerts raised in the last hour could never notice that
 * somebody's destination was verified this morning, or that a condition
 * resolved. There is nothing here that reads a transition.
 *
 * Every person's plan is built from **their own feed**, through `getAlertFeed`
 * with their own `Actor`, which is the same posture `assistant/tools.ts` takes:
 * the narrowing is in the query, so a message cannot contain a row this person's
 * screen would not. There is no org-wide alert read here for the same reason
 * there is not one there.
 */
export async function deliverPending(
  orgId: string,
  opts: {
    transport?: NotificationTransport;
    now?: Date;
    baseUrl?: string | null;
    /**
     * Plan and compose, write nothing, send nothing. What `pnpm nightly --dry`
     * uses to show a person the messages their colleagues would receive before
     * a transport is installed — and the only mode in which reading this
     * function's output does not change what tomorrow's run will do.
     */
    dryRun?: boolean;
  } = {},
  db: Db = getDb(),
): Promise<DeliveryRunResult> {
  const choice = opts.transport
    ? { transport: opts.transport, live: opts.transport.reachesPeople }
    : (() => {
        const c = selectTransport();
        return { transport: c.transport, live: c.live };
      })();
  const transport = choice.transport;
  const now = opts.now ?? new Date();
  const baseUrl = opts.baseUrl !== undefined ? opts.baseUrl : appBaseUrl();

  const people = await db
    .select({
      id: s.users.id,
      email: s.users.email,
      fullName: s.users.fullName,
      role: s.users.role,
      costCenterId: s.users.costCenterId,
    })
    .from(s.users)
    .where(eq(s.users.orgId, orgId));

  const channels = await db
    .select()
    .from(s.notificationChannels)
    .where(
      and(
        eq(s.notificationChannels.orgId, orgId),
        eq(s.notificationChannels.transport, transport.name),
        isNull(s.notificationChannels.disabledAt),
      ),
    );
  const byUser = new Map(channels.filter((c) => c.userId).map((c) => [c.userId!, c]));

  const result: DeliveryRunResult = {
    transport: transport.name,
    live: choice.live,
    people: people.length,
    messages: 0,
    sent: 0,
    rendered: 0,
    failed: 0,
    suppressed: 0,
    undeliverable: 0,
    unreachable: [],
    composed: [],
  };

  for (const person of people) {
    const actor: Actor = {
      userId: person.id,
      orgId,
      email: person.email,
      fullName: person.fullName,
      role: person.role,
      costCenterId: person.costCenterId,
    };
    const { alerts } = await getAlertFeed(actor, { asOf: now }, db);
    if (alerts.length === 0) continue;

    const row = byUser.get(person.id);
    const destination: Destination | null =
      row && row.verifiedAt
        ? {
            channelId: row.id,
            transport: row.transport,
            kind: row.kind === 'channel' ? 'channel' : 'dm',
            address: row.address,
            userId: row.userId,
            verifiedAt: row.verifiedAt,
          }
        : null;

    const prior = await loadPrior(db, alerts, destination?.channelId ?? null);
    const plan = planForPerson({ alerts, destination, prior, now });

    for (const sup of plan.suppressed) {
      const outcome: DeliveryOutcome =
        sup.reason === 'no_destination' ? 'undeliverable' : 'suppressed';
      if (!opts.dryRun) await record(db, {
        orgId,
        alert: sup.alert,
        channelId: sup.channelId,
        transport: transport.name,
        phase: sup.phase,
        outcome,
        detail: sup.detail,
        messageRef: null,
        providerMessageId: null,
        now,
      });
      if (outcome === 'undeliverable') result.undeliverable += 1;
      else result.suppressed += 1;
    }

    const missed = plan.suppressed.filter((x) => x.reason === 'no_destination').length;
    if (missed > 0) {
      result.unreachable.push({ userId: person.id, name: person.fullName, alerts: missed });
    }

    for (const message of plan.messages) {
      result.messages += 1;
      result.composed.push(message);
      const messageRef = `${person.id}:${now.getTime()}`;
      let outcome: DeliveryOutcome;
      let detail: string | null;
      let providerMessageId: string | null = null;

      if (opts.dryRun) {
        result.rendered += 1;
        continue;
      }

      try {
        const receipt = await transport.send({
          address: message.destination.address,
          kind: message.destination.kind,
          text: message.text,
          sections: sectionsFor(message.items, baseUrl),
        });
        outcome = receipt.outcome;
        detail = receipt.detail;
        providerMessageId = receipt.providerMessageId;
        if (outcome === 'sent') result.sent += 1;
        else result.rendered += 1;
      } catch (err) {
        // A send that threw is recorded as failed against every alert it would
        // have carried, so tomorrow's plan finds them unsent and tries again —
        // and so that "nobody was told, and here is what the transport said"
        // survives the process that discovered it.
        outcome = 'failed';
        detail =
          err instanceof TransportError
            ? `${err.message}${err.retryable ? '' : ' This will not succeed on a retry.'}`
            : (err as Error).message;
        result.failed += 1;
      }

      for (const item of message.items) {
        for (const covered of item.covers) {
          await record(db, {
            orgId,
            alert: covered,
            channelId: message.destination.channelId,
            transport: transport.name,
            phase: item.phase,
            outcome,
            detail,
            messageRef,
            providerMessageId,
            now,
          });
        }
      }
    }
  }

  return result;
}

async function loadPrior(
  db: Db,
  alerts: FeedAlert[],
  channelId: string | null,
): Promise<PriorDelivery[]> {
  if (alerts.length === 0) return [];
  const rows = await db
    .select({
      alertId: s.notificationDeliveries.alertId,
      channelId: s.notificationDeliveries.channelId,
      phase: s.notificationDeliveries.phase,
      alertCreatedAt: s.notificationDeliveries.alertCreatedAt,
      outcome: s.notificationDeliveries.outcome,
    })
    .from(s.notificationDeliveries)
    .where(
      inArray(
        s.notificationDeliveries.alertId,
        alerts.map((a) => a.id),
      ),
    );
  return rows
    .filter((r) => r.channelId === channelId)
    .map((r) => ({
      alertId: r.alertId,
      channelId: r.channelId,
      phase: r.phase === 'resolved' ? ('resolved' as DeliveryPhase) : ('raised' as DeliveryPhase),
      alertCreatedAt: r.alertCreatedAt,
      outcome: r.outcome as PriorDelivery['outcome'],
    }));
}

async function record(
  db: Db,
  args: {
    orgId: string;
    alert: FeedAlert;
    channelId: string | null;
    transport: string;
    phase: DeliveryPhase;
    outcome: DeliveryOutcome;
    detail: string | null;
    messageRef: string | null;
    providerMessageId: string | null;
    now: Date;
  },
): Promise<void> {
  await db
    .insert(s.notificationDeliveries)
    .values({
      orgId: args.orgId,
      alertId: args.alert.id,
      channelId: args.channelId,
      transport: args.transport,
      phase: args.phase,
      alertCreatedAt: args.alert.createdAt,
      outcome: args.outcome,
      detail: args.detail,
      messageRef: args.messageRef,
      providerMessageId: args.providerMessageId,
      createdAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        s.notificationDeliveries.alertId,
        s.notificationDeliveries.channelId,
        s.notificationDeliveries.phase,
        s.notificationDeliveries.alertCreatedAt,
      ],
      // The rail permits exactly one row per occurrence, so a retry after a
      // failure overwrites the failure rather than piling up beside it. What
      // must never be overwritten is a success, which the planner guarantees by
      // never planning one again.
      set: {
        outcome: args.outcome,
        detail: args.detail,
        messageRef: args.messageRef,
        providerMessageId: args.providerMessageId,
        createdAt: args.now,
      },
    });
}

/* ---------------------------------- reading -------------------------------- */

export type DeliveryLogRow = {
  id: string;
  alertTitle: string;
  recipientName: string | null;
  transport: string;
  phase: string;
  outcome: DeliveryOutcome;
  detail: string | null;
  createdAt: Date;
};

/**
 * The log. `scope: 'mine'` is anybody's — "why was I not told" is a question
 * about your own alerts. The org-wide read is an admin's, because it names who
 * was told what.
 */
export async function getDeliveryLog(
  actor: Actor,
  opts: { scope?: 'mine' | 'org'; limit?: number } = {},
  db: Db = getDb(),
): Promise<DeliveryLogRow[]> {
  const scope = opts.scope ?? 'mine';
  if (scope === 'org' && !canReadOrgDeliveries(actor)) {
    throw new ForbiddenError('The whole workspace’s delivery log is an admin’s.');
  }

  const rows = await db
    .select({
      d: s.notificationDeliveries,
      alertTitle: s.alerts.title,
      alertUserId: s.alerts.userId,
      recipientName: s.users.fullName,
    })
    .from(s.notificationDeliveries)
    .innerJoin(s.alerts, eq(s.notificationDeliveries.alertId, s.alerts.id))
    .leftJoin(s.users, eq(s.alerts.userId, s.users.id))
    .where(
      scope === 'org'
        ? eq(s.notificationDeliveries.orgId, actor.orgId)
        : and(
            eq(s.notificationDeliveries.orgId, actor.orgId),
            eq(s.alerts.userId, actor.userId),
          ),
    )
    .orderBy(desc(s.notificationDeliveries.createdAt))
    .limit(opts.limit ?? 50);

  return rows.map((r) => ({
    id: r.d.id,
    alertTitle: r.alertTitle,
    recipientName: r.recipientName,
    transport: r.d.transport,
    phase: r.d.phase,
    outcome: r.d.outcome as DeliveryOutcome,
    detail: r.d.detail,
    createdAt: r.d.createdAt,
  }));
}

export type TransportStanding = {
  name: string;
  /** False when nothing this workspace sends reaches anybody. */
  live: boolean;
  /** Set when the environment names a transport this app does not have. */
  misconfigured: string | null;
  /** How many people have a verified destination, out of how many people. */
  connected: number;
  people: number;
  /** Messages this workspace has actually delivered to a person. Often zero. */
  everSent: number;
};

/** What `/settings/notifications` and `/alerts` both say about the transport. */
export async function getTransportStanding(
  actor: Actor,
  db: Db = getDb(),
): Promise<TransportStanding> {
  let name = 'console';
  let live = false;
  let misconfigured: string | null = null;
  try {
    const c = selectTransport();
    name = c.transport.name;
    live = c.live;
  } catch (err) {
    misconfigured = (err as Error).message;
  }

  const [people] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.users)
    .where(eq(s.users.orgId, actor.orgId));
  const [connected] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.notificationChannels)
    .where(
      and(
        eq(s.notificationChannels.orgId, actor.orgId),
        eq(s.notificationChannels.transport, name),
        isNull(s.notificationChannels.disabledAt),
      ),
    );
  const [everSent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.notificationDeliveries)
    .where(
      and(
        eq(s.notificationDeliveries.orgId, actor.orgId),
        eq(s.notificationDeliveries.outcome, 'sent'),
      ),
    );

  return {
    name,
    live,
    misconfigured,
    connected: connected?.n ?? 0,
    people: people?.n ?? 0,
    everSent: everSent?.n ?? 0,
  };
}

export { canConfigureTransport };
