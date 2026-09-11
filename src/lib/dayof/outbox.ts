/**
 * The device's queue, and the accounting that stops a capture from disappearing.
 *
 * Show floor wifi is unusable — §2 calls that an architecture decision rather
 * than a screen, and this file is what the decision actually is. A lead captured
 * with no signal is written to the device first and to the database later, which
 * means that for some period a real conversation exists in exactly one place,
 * and that place is a phone in somebody's pocket.
 *
 * Three rules, each the offline form of a rule this product already has.
 *
 * **A queued capture is not a captured lead, and the screen must not blur
 * them.** §8c's whole mitigation is that a thin count is visibly thin. A count
 * that silently includes rows nobody has stored yet is the same failure with a
 * new cause: the number reads as recorded work and some of it is a phone that
 * has not been unlocked since Tuesday. So the two are counted separately and
 * `describeOutbox` is the sentence in front of them.
 *
 * **Every queued item is accounted for.** `parse.ts` made accepted + rejected +
 * duplicate equal the row count because an import that silently drops rows
 * reports a smaller number with the same confidence. A sync that silently drops
 * a queued lead is worse: there is no file to re-read and no row number to point
 * at, and the person who had the conversation is the only record left.
 * `reconcile` is that arithmetic, and it refuses to let an item leave the queue
 * without a stated outcome.
 *
 * **A permanent refusal must stop retrying and start being visible.** A lead
 * with no name will be refused every time, and a queue that retries it forever
 * is a queue that never empties — after which the badge on the screen means
 * nothing and nobody looks at it again. That is `retention_overdue` alerting
 * nightly, arriving on a device: an indicator that is always on is an indicator
 * that is off.
 *
 * Pure, and shipped to the client, like `targets.ts`.
 */

export type QueuedKind = 'lead' | 'meeting';

/**
 * One thing typed at a booth, waiting to be told to the server.
 *
 * `clientRef` is minted on the device at the moment of typing and never
 * changes — not on retry, not on reload, not when the app is reopened on a
 * different network an hour later. It lands in `leads.external_ref` /
 * `meetings.external_ref`, both unique per show, which is what makes a re-send
 * idempotent rather than merely intended: step 18's rule about a scanner's
 * retry, reused for the machine the person is actually holding.
 */
export type QueuedItem = {
  clientRef: string;
  showId: string;
  kind: QueuedKind;
  /** Exactly what the person typed, unvalidated. Validation happens server-side. */
  body: Record<string, unknown>;
  /** When the conversation happened, on the device's clock. See `capturedAt` below. */
  queuedAt: string;
  attempts: number;
  /** The last refusal, when there was one, in the words a person would be shown. */
  lastError: string | null;
  /** True once a refusal is known to be permanent. Stops retrying, stays visible. */
  blocked: boolean;
};

/**
 * What the server did with one item.
 *
 * `already` is separate from `duplicate` and the distinction is the whole point
 * of the rail. `already` means this exact item was written by an earlier attempt
 * whose response never arrived — the ordinary case, and a **success**, exactly
 * as a scanner's retry is. `duplicate` means somebody else on the booth had the
 * same conversation, which is a real finding and is told to the person.
 */
export type SyncOutcome =
  | { clientRef: string; result: 'accepted'; id: string }
  | { clientRef: string; result: 'already'; id: string }
  | { clientRef: string; result: 'duplicate'; id: string; detail: string }
  | { clientRef: string; result: 'rejected'; detail: string };

export type OutcomeKind = SyncOutcome['result'];

/** A rejection is about the content and will be a rejection again. */
export function isPermanent(result: OutcomeKind): boolean {
  return result === 'rejected';
}

/** Nothing was wrong with the item; it is finished with. */
export function isSettled(result: OutcomeKind): boolean {
  return result === 'accepted' || result === 'already' || result === 'duplicate';
}

export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxError';
  }
}

export type Reconciled = {
  /** What stays on the device, in the order it was typed. */
  remaining: QueuedItem[];
  accepted: SyncOutcome[];
  already: SyncOutcome[];
  duplicates: SyncOutcome[];
  rejected: SyncOutcome[];
  /** Sent and not answered at all — the network went again mid-batch. */
  unanswered: QueuedItem[];
};

/**
 * Apply a batch's outcomes to the queue, losing nothing.
 *
 * The invariant is stated as a throw rather than as a comment: submitted equals
 * settled plus rejected plus unanswered, and every outcome names an item that
 * was actually sent. A server that answered about something we did not send is a
 * bug worth stopping on, not a row to drop — the alternative is a queue that
 * quietly shrinks and a person who is certain they captured eleven.
 *
 * A rejected item is **kept**, marked `blocked`, with the server's sentence on
 * it. It is the only thing in this app that a person can fix by editing what
 * they typed, and deleting it would take away the one copy of a real
 * conversation because a field was blank.
 */
export function reconcile(sent: QueuedItem[], outcomes: SyncOutcome[]): Reconciled {
  const bySent = new Map(sent.map((i) => [i.clientRef, i]));
  for (const o of outcomes) {
    if (!bySent.has(o.clientRef)) {
      throw new OutboxError(
        `The server answered about ${o.clientRef}, which this device never sent. Nothing was removed from the queue.`,
      );
    }
  }

  const byRef = new Map(outcomes.map((o) => [o.clientRef, o]));
  const remaining: QueuedItem[] = [];
  const unanswered: QueuedItem[] = [];

  for (const item of sent) {
    const outcome = byRef.get(item.clientRef);
    if (!outcome) {
      // Sent, no answer. Still ours, and it will go again — the ref makes that
      // safe even if the write actually landed.
      const next = { ...item, attempts: item.attempts + 1 };
      remaining.push(next);
      unanswered.push(next);
      continue;
    }
    if (isSettled(outcome.result)) continue;
    remaining.push({
      ...item,
      attempts: item.attempts + 1,
      lastError: 'detail' in outcome ? outcome.detail : null,
      blocked: isPermanent(outcome.result),
    });
  }

  const of = (result: OutcomeKind) => outcomes.filter((o) => o.result === result);
  const settled = outcomes.filter((o) => isSettled(o.result)).length;
  const rejected = of('rejected');
  if (settled + rejected.length + unanswered.length !== sent.length) {
    throw new OutboxError(
      `${sent.length} items were sent and ${settled + rejected.length + unanswered.length} are accounted for. Nothing was removed from the queue.`,
    );
  }

  return {
    remaining,
    accepted: of('accepted'),
    already: of('already'),
    duplicates: of('duplicate'),
    rejected,
    unanswered,
  };
}

/** What goes up on the next attempt: everything except what cannot succeed. */
export function sendable(queue: QueuedItem[]): QueuedItem[] {
  return queue.filter((i) => !i.blocked);
}

export type OutboxStanding = {
  waiting: number;
  blocked: number;
  /** The line above the capture form. Never a bare number; see the header. */
  sentence: string;
  tone: 'quiet' | 'info' | 'warn';
};

/**
 * What the device says about itself.
 *
 * The word is deliberately "on this device" rather than "pending" or "syncing".
 * Both of those describe a process, and the thing a person needs to understand
 * is a *location*: these conversations exist here and nowhere else, so do not
 * close the tab, and the show's lead count does not include them yet.
 */
export function describeOutbox(queue: QueuedItem[], online: boolean): OutboxStanding {
  const blocked = queue.filter((i) => i.blocked).length;
  const waiting = queue.length - blocked;

  if (blocked > 0) {
    return {
      waiting,
      blocked,
      tone: 'warn',
      sentence:
        blocked === 1
          ? `1 capture on this device was refused and needs fixing before it can be recorded.`
          : `${blocked} captures on this device were refused and need fixing before they can be recorded.`,
    };
  }
  if (waiting === 0) {
    return {
      waiting: 0,
      blocked: 0,
      tone: 'quiet',
      sentence: online ? 'Everything captured here is recorded.' : 'Offline. Nothing waiting.',
    };
  }
  return {
    waiting,
    blocked: 0,
    tone: 'info',
    sentence: `${waiting} capture${waiting === 1 ? '' : 's'} on this device, not recorded yet${
      online ? '' : ' — no connection'
    }.`,
  };
}

/**
 * A ref that is unique without asking anybody.
 *
 * Prefixed so that a ref this app minted is distinguishable from a badge
 * vendor's on sight, in a database and in a support conversation, and so the two
 * can never collide in `leads.external_ref` — which they share.
 */
export function mintRef(random: () => string): string {
  return `dev_${random()}`;
}

export const DEVICE_REF_PREFIX = 'dev_';

export function isDeviceRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(DEVICE_REF_PREFIX);
}
