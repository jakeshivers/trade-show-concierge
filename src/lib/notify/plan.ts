import {
  SOURCE_LABEL,
  groupFeed,
  linkFor,
  standingDays,
  standingOf,
  type AlertSeverity,
  type FeedAlert,
} from '@/lib/alerts/feed';

/**
 * What is worth carrying out of this app, to whom, and in what words. Pure.
 *
 * The whole step is here, and it is a set of refusals rather than a fan-out. For
 * twenty steps seven engines wrote `alerts` rows and nothing transported one, so
 * the obvious move — take every unresolved row and send it — is available for
 * the first time and is wrong in five separate ways. Each is a rule below and
 * each has a test.
 *
 * **1. A row is not a message.** The `alerts` table is a durable record that a
 * notification was *owed*: `/alerts` is a working surface a person opens, and a
 * row costs nothing to leave standing there. A transport turns a row into an
 * interruption on a phone, and this product has spent four steps arguing that an
 * alert people learn to scroll past takes the next one with it. So conditions
 * are carried at `warning` and above, and an `info` condition stays on the
 * screen where it was always going to be read. Notices are the exception and go
 * at any severity, because a notice is an event that happened once — "your
 * flight is ticketed" is the message §6c rail 6 asked for, it repeats never, and
 * it is the single thing in this product a traveler most wants pushed.
 *
 * **2. Eleven rows are one sentence, and `groupFeed` already knows.** The feed
 * found this on real data: eleven identical "the airline moved DL 1422" rows
 * addressed to one admin, because eleven people are on that flight. Sent as
 * written that is eleven notifications. This planner reuses `groupFeed` rather
 * than grouping again — the house rule from `review.ts`, where the screen and
 * the agent share one liveness predicate so they cannot disagree.
 *
 * **3. Switching a transport on does not replay history.** The first run against
 * a workspace with a year of alerts in it would deliver all of them at once, and
 * the person it happened to would turn the integration off inside a minute and
 * be right to. Anything raised before the destination existed is suppressed with
 * that reason recorded, so the log can say *why* somebody was not told rather
 * than being silent about it.
 *
 * **4. Only somebody who was told is told it ended.** A resolution is genuinely
 * news — the crate arrived, the deadline was met — but only to a person carrying
 * the worry. Sending "resolved: a thing you never heard about" is noise with the
 * grammar of an update, and it is the cheapest possible way to teach somebody
 * that these messages are not worth opening.
 *
 * **5. A personal alert never goes to a shared room.** `alerts/access.ts`
 * refuses an org-wide read so that a Travel Manager never sees the delay alert
 * on a Member's personal flight home; a channel destination is an org-wide read
 * wearing a different hat, and it would be invisible from the alerts screen. An
 * alert addressed to a person may only be routed to a `dm`. The rule lives here,
 * in a pure function with a test, rather than in the column comment that
 * describes it.
 */

/** How long before an alert's first sighting a destination must have existed. */
export const BACKFILL_GRACE_HOURS = 24;

/** Conditions below this stay on the screen. Notices ignore it — see rule 1. */
const CARRY_SEVERITY: AlertSeverity[] = ['critical', 'warning'];

export type DeliveryPhase = 'raised' | 'resolved';

export type Destination = {
  channelId: string;
  transport: string;
  kind: 'dm' | 'channel';
  address: string;
  /** Null on a channel row. A personal alert may only go to a person's `dm`. */
  userId: string | null;
  /** When this destination became usable. Nothing older than it is replayed. */
  verifiedAt: Date;
};

/** What the log already holds for one alert-and-destination pair. */
export type PriorDelivery = {
  alertId: string;
  channelId: string | null;
  phase: DeliveryPhase;
  /** The alert's `createdAt` at the time. A recurrence restarts it. */
  alertCreatedAt: Date;
  outcome: 'sent' | 'rendered' | 'undeliverable' | 'suppressed' | 'failed';
};

export type PlannedItem = {
  alert: FeedAlert;
  phase: DeliveryPhase;
  /** Rows saying the same sentence, folded in. Each still gets a log row. */
  covers: FeedAlert[];
  title: string;
  body: string;
  url: string | null;
};

export type PlannedMessage = {
  destination: Destination;
  items: PlannedItem[];
  /** The whole message as plain text. Never optional — see `OutboundMessage`. */
  text: string;
};

export type Suppression = {
  alert: FeedAlert;
  phase: DeliveryPhase;
  channelId: string | null;
  /** `below_floor` · `backfill` · `not_told` · `wrong_kind` · `no_destination`. */
  reason: string;
  detail: string;
};

export type NotifyPlan = {
  messages: PlannedMessage[];
  /** Deliberate refusals, each with its reason. Recorded, never silent. */
  suppressed: Suppression[];
};

/**
 * One person's feed → at most one message.
 *
 * At most one, and that is deliberate: a person with nine outstanding alerts has
 * one thing to look at, not nine. The log still records a row per alert, so
 * "was Priya told about this crate" stays answerable at the granularity the
 * engines write at, while the phone buzzes once.
 *
 * `alerts` must be that person's own feed as `getAlertFeed` returns it —
 * scoped, ordered, and already narrowed by the audience each engine chose. This
 * function never widens it and has no way to: it takes no user id and does no
 * lookup, so the only rows it can put in a message are the rows a query already
 * narrowed. That is `assistant/tools.ts`'s posture, and it is the reason there
 * is nothing here to get wrong.
 */
export function planForPerson(args: {
  alerts: FeedAlert[];
  destination: Destination | null;
  prior: PriorDelivery[];
  now: Date;
}): NotifyPlan {
  const { alerts, destination, prior, now } = args;
  const suppressed: Suppression[] = [];

  const priorKey = (alertId: string, channelId: string | null, phase: DeliveryPhase) =>
    `${alertId}|${channelId ?? '-'}|${phase}`;
  const byKey = new Map<string, PriorDelivery>();
  for (const p of prior) byKey.set(priorKey(p.alertId, p.channelId, p.phase), p);

  const groups = groupFeed(alerts, now);
  const items: PlannedItem[] = [];

  for (const group of groups) {
    const lead = group.lead;
    const standing = standingOf(lead, now);
    const phase: DeliveryPhase = standing === 'resolved' ? 'resolved' : 'raised';
    const members = [lead, ...group.rest];

    // Rule 1 first, and the order matters more than it looks. Judging "is this
    // worth an interruption" before "is there anywhere to send it" is what makes
    // the run's `unreachable` count mean *alerts worth carrying* rather than
    // alerts. Reversed, a person with nine info-level rows and no Slack account
    // is reported as nine missed notifications, which is a fabricated shortfall
    // — the count would grow every time an engine raised something the transport
    // was never going to carry anyway.
    if (lead.kind === 'condition' && !CARRY_SEVERITY.includes(lead.severity)) {
      push(suppressed, members, phase, destination?.channelId ?? null, 'below_floor',
        `An ${lead.severity} condition. It is on /alerts, where it was always going to be read.`);
      continue;
    }

    // Rule 4, and it comes before the destination checks for the same reason:
    // somebody who was never told a thing started is not owed the news that it
    // ended, so an absent destination is not what went wrong here.
    if (phase === 'resolved') {
      const told = members.some((a) => {
        const p = byKey.get(priorKey(a.id, destination?.channelId ?? null, 'raised'));
        return p ? p.outcome === 'sent' || p.outcome === 'rendered' : false;
      });
      if (!told) {
        push(suppressed, members, phase, destination?.channelId ?? null, 'not_told',
          'It ended, and this person was never told it had started.');
        continue;
      }
    }

    if (!destination) {
      push(suppressed, members, phase, null, 'no_destination',
        'Worth carrying, and nowhere to carry it: this person has no verified destination ' +
          'on the configured transport.');
      continue;
    }

    // Rule 5. The only one of the five that is about entitlement rather than
    // about noise — an alert with a `userId` belongs to that person, and a
    // shared room is an org-wide read wearing a different hat.
    if (destination.kind === 'channel' && lead.userId !== null) {
      push(suppressed, members, phase, destination.channelId, 'wrong_kind',
        'Addressed to a person, and the only destination configured is a shared channel. ' +
          'A personal alert is never posted to a room: every engine here writes one row per ' +
          'recipient precisely so the audience is decided where the reasoning is.');
      continue;
    }

    // Rule 3. Judged on `createdAt`, which is when this occurrence began —
    // a recurrence restarts it, so a condition that comes back after the
    // destination existed is news even though the row is old.
    const graceStart = new Date(destination.verifiedAt.getTime() - BACKFILL_GRACE_HOURS * 3_600_000);
    if (lead.createdAt < graceStart) {
      push(suppressed, members, phase, destination.channelId, 'backfill',
        `Raised ${standingDays(lead, now)} day(s) ago, before this destination existed. ` +
          'Switching a transport on does not replay a year of alerts at somebody.');
      continue;
    }

    // The rail: one delivery per alert, per destination, per phase, per
    // occurrence. `alertCreatedAt` is what makes a recurrence sendable again,
    // and it is `alerts/store.ts`'s own recurrence decision rather than a second
    // one invented here.
    const unsent = members.filter((a) => {
      const p = byKey.get(priorKey(a.id, destination.channelId, phase));
      if (!p) return true;
      if (p.alertCreatedAt.getTime() !== a.createdAt.getTime()) return true;
      // A failure is retried; a deliberate suppression is not re-litigated
      // every night, or a below-floor alert would be re-suppressed forever.
      return p.outcome === 'failed';
    });
    if (unsent.length === 0) continue;

    items.push({
      alert: lead,
      phase,
      covers: unsent,
      title: titleFor(lead, phase),
      body: bodyFor(lead, group.rest.length, group.showNames, phase, now),
      url: linkFor(lead),
    });
  }

  if (!destination || items.length === 0) return { messages: [], suppressed };

  return {
    messages: [
      { destination, items, text: renderText(items) },
    ],
    suppressed,
  };
}

function push(
  into: Suppression[],
  alerts: FeedAlert[],
  phase: DeliveryPhase,
  channelId: string | null,
  reason: string,
  detail: string,
) {
  for (const alert of alerts) into.push({ alert, phase, channelId, reason, detail });
}

/* --------------------------------- wording --------------------------------- */

/**
 * The tense rule, one layer further out than `assistant/prompt.ts` states it.
 *
 * The engines have spent five steps getting these sentences right — an
 * unconfirmed deadline is a date and never an amount, a missed one is past
 * tense and addressed to somebody else, delivered is the carrier's word,
 * an unchecked flight is not on time. A transport that paraphrased them would
 * undo all of it in the one place people actually read. So the alert's own
 * `title` and `body` are carried **verbatim**, and everything added here is
 * outside them: what kind of thing it is, how long it has been true, and how
 * many rows are saying it.
 */
export function titleFor(alert: FeedAlert, phase: DeliveryPhase): string {
  const label = SOURCE_LABEL[alert.source];
  if (phase === 'resolved') return `Resolved · ${label} · ${alert.title}`;
  return `${label} · ${alert.title}`;
}

export function bodyFor(
  alert: FeedAlert,
  others: number,
  showNames: string[],
  phase: DeliveryPhase,
  now: Date,
): string {
  const parts: string[] = [];
  if (alert.body) parts.push(alert.body);

  if (phase === 'resolved') {
    // No engine "clears" anything: absence from tonight's plan is what resolves
    // a condition, and saying so is the difference between the app noticing and
    // somebody having pressed a button.
    parts.push('This stopped being true — no sweep found it tonight. Nobody dismissed it.');
  } else {
    const days = standingDays(alert, now);
    if (alert.occurrences > 1) {
      parts.push(`Said ${alert.occurrences} times; first reported ${days} day(s) ago.`);
    }
    if (standingOf(alert, now) === 'unchecked') {
      parts.push(
        'Nothing has re-checked this recently, so it is what was true when somebody last ' +
          'looked rather than what is true now.',
      );
    }
  }

  if (others > 0) {
    parts.push(
      `${others} more row(s) say the same thing` +
        (showNames.length > 1 ? ` across ${showNames.join(', ')}` : '') +
        '.',
    );
  }
  return parts.join(' ');
}

function renderText(items: PlannedItem[]): string {
  const lines = items.map((i) => `• ${i.title}\n  ${i.body}`);
  const head =
    items.length === 1
      ? 'One thing from the trade show concierge:'
      : `${items.length} things from the trade show concierge:`;
  return [head, '', ...lines].join('\n');
}

export function sectionsFor(items: PlannedItem[], baseUrl: string | null) {
  return items.map((i) => ({
    title: i.title,
    body: i.body,
    url: i.url && baseUrl ? `${baseUrl.replace(/\/$/, '')}${i.url}` : undefined,
  }));
}
