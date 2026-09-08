import type { Actor } from '@/lib/auth/actor';
import { canApproveRequestFor } from '@/lib/auth/actor';
import { canTransition, type RequestStatus } from './machine';

/**
 * What a person needs to know before they act on a travel request.
 *
 * Step 9 put screens over the spine, and the first thing that became obvious is
 * that an approvals queue is not a list of buttons. SCOPE.md §6b settled what an
 * approval means — *an amount, not an offer* — and `approveRequest` implements
 * that faithfully. But the approver only ever sees the screen. If the screen
 * shows a fare beside an Approve button and says nothing else, the approver
 * believes they are authorizing that number, and roughly half the time they are
 * not: the offer is already dead and approving will re-search, re-price, and buy
 * something they never saw.
 *
 * So this module exists to answer one question in one place: **given this
 * snapshot, this hold, and this moment, what does pressing Approve actually
 * do?** It is pure, so it is testable, and the agent imports the same predicate
 * the screen renders — see `offerStanding` below. A second, independently
 * written liveness check in JSX would drift from the one that governs the
 * purchase, and a screen that disagrees with the engine about what is being
 * authorized is worse than a screen with no explanation at all.
 */

/* ------------------------------ offer standing ------------------------------ */

/**
 * The four things an offer can be when an approver looks at it.
 *
 * The distinction that matters most is the middle pair. A hold reserves the
 * *seat*; only a price guarantee reserves the *fare*, and Duffel's
 * `price_guarantee_expires_at` is nullable, so "held" and "held at this price"
 * are genuinely different states. Approving a held-but-unguaranteed fare is
 * approving an unknown number, and §6b says the screen must say which of the two
 * it got.
 */
export type OfferStandingKind = 'live' | 'held_guaranteed' | 'held_unguaranteed' | 'expired';

export type OfferStanding = {
  kind: OfferStandingKind;
  /** True when approving books the fare on screen without searching again. */
  bookableAtShownPrice: boolean;
  /** When the thing keeping this fare alive runs out. Null once it already has. */
  goodUntil: Date | null;
  /** One sentence, written for the approver, saying what Approve will do. */
  meaning: string;
};

/** The inputs, named structurally so a snapshot row and a test fixture both fit. */
export type StandingInputs = {
  offerExpiresAt: Date;
  /** The hold placed against this request, if the agent managed to place one. */
  hold?: { priceGuaranteedUntil: Date | null; payBy: Date | null } | null;
};

/**
 * The single definition of "is this offer still good?".
 *
 * `approveRequest` calls this to decide whether to book directly or re-search,
 * and the approvals queue calls it to decide what to tell the approver. That
 * they are the same call is the point: this predicate used to live inline in
 * `agent.ts`, and step 9 lifted it out rather than writing a second copy for the
 * UI. One of the two copies would eventually have been wrong, and it would have
 * been the one that talks to the human.
 */
export function offerStanding(inputs: StandingInputs, now: Date): OfferStanding {
  const { offerExpiresAt, hold } = inputs;
  const guaranteed = hold?.priceGuaranteedUntil ?? null;

  if (offerExpiresAt > now) {
    return {
      kind: 'live',
      bookableAtShownPrice: true,
      goodUntil: offerExpiresAt,
      meaning:
        'This fare is still live. Approving buys it at the price shown, without searching again.',
    };
  }

  if (guaranteed !== null && guaranteed > now) {
    return {
      kind: 'held_guaranteed',
      bookableAtShownPrice: true,
      goodUntil: guaranteed,
      meaning:
        'The offer expired, but the seat is held and the fare is guaranteed until the time shown. ' +
        'Approving buys it at the price shown.',
    };
  }

  if (hold) {
    return {
      kind: 'held_unguaranteed',
      bookableAtShownPrice: false,
      goodUntil: hold.payBy,
      meaning:
        'The seat is held, but the fare is not guaranteed — the airline may have moved the price. ' +
        'Approving authorizes the amount below as a ceiling, then re-prices: at or under it the ' +
        'trip is booked, above it the request comes back to you.',
    };
  }

  return {
    kind: 'expired',
    bookableAtShownPrice: false,
    goodUntil: null,
    meaning:
      'This offer has expired and the price below is no longer for sale. Approving authorizes it ' +
      'as a ceiling and searches again: at or under it the trip is booked, above it the request ' +
      'comes back to you for a fresh decision.',
  };
}

/**
 * Whether an offer's standing is worth showing at all.
 *
 * It is the answer to "what would approving do", so it only means anything
 * while approving is still possible. Beside a ticketed request it is worse than
 * noise: "fare live" next to a bought ticket invites the reader to think the
 * price is still moving, when the only number that matters now is what was
 * actually charged. The same goes for a rejected or cancelled request, where the
 * offer's liveness is a fact about nothing.
 */
export function standingMatters(status: RequestStatus): boolean {
  return status === 'pending_approval' || status === 'offers_found' || status === 'held';
}

/**
 * The one-line version, for a queue row where a paragraph does not fit.
 * Deliberately blunt about the two cases where the number on screen is a
 * ceiling rather than a price.
 */
export function standingLabel(kind: OfferStandingKind): string {
  switch (kind) {
    case 'live':
      return 'fare live';
    case 'held_guaranteed':
      return 'held, fare guaranteed';
    case 'held_unguaranteed':
      return 'held, fare not guaranteed';
    case 'expired':
      return 'offer expired — will re-price';
  }
}

/* ---------------------------- status presentation --------------------------- */

/**
 * What each status means to a person waiting on one.
 *
 * The machine's status names are written for the machine. `no_options` is not a
 * failure and `expired` is not terminal, and a queue that renders the raw enum
 * makes both look like errors. `waiting` marks the states where somebody is
 * owed an answer and nobody is being asked for one — the agent is mid-flight.
 */
export type StatusPresentation = {
  label: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
  /** Whose move it is, in plain words. */
  meaning: string;
  /** True while the agent is working and the screen should not offer actions. */
  working: boolean;
};

export const STATUS: Record<RequestStatus, StatusPresentation> = {
  draft: {
    label: 'draft',
    tone: 'neutral',
    meaning: 'Not submitted yet. Nothing has been searched.',
    working: false,
  },
  submitted: {
    label: 'submitted',
    tone: 'info',
    meaning: 'Opened and waiting for the agent to search.',
    working: false,
  },
  searching: {
    label: 'searching',
    tone: 'info',
    meaning: 'The agent is searching and judging offers right now.',
    working: true,
  },
  offers_found: {
    label: 'offers found',
    tone: 'info',
    meaning: 'Offers are in and being ruled on.',
    working: true,
  },
  pending_approval: {
    label: 'awaiting approval',
    tone: 'warn',
    meaning: 'Outside policy, or purchasing is halted. A travel manager has to decide.',
    working: false,
  },
  approved: {
    label: 'approved',
    tone: 'good',
    meaning: 'Signed off. The agent is buying it.',
    working: true,
  },
  rejected: {
    label: 'rejected',
    tone: 'bad',
    meaning: 'An approver declined it. Nothing was bought.',
    working: false,
  },
  held: {
    label: 'held',
    tone: 'info',
    meaning: 'The seat is reserved without payment while a decision is made.',
    working: false,
  },
  booking: {
    label: 'booking',
    tone: 'info',
    meaning: 'Payment is being taken. This is the one state you should not interrupt.',
    working: true,
  },
  ticketed: {
    label: 'ticketed',
    tone: 'good',
    meaning: 'Bought and ticketed.',
    working: false,
  },
  no_options: {
    label: 'no options',
    tone: 'warn',
    meaning:
      'Nothing matched the constraints and the policy together. Relaxing one and searching ' +
      'again is the intended next move, not an error to report.',
    working: false,
  },
  expired: {
    label: 'expired',
    tone: 'warn',
    meaning: 'It sat unanswered long enough that the offers died. Searching again is free.',
    working: false,
  },
  failed: {
    label: 'failed',
    tone: 'bad',
    meaning:
      'The purchase itself threw. The idempotency key is in the trail, so retrying cannot ' +
      'produce a second charge for a payment that may have gone through.',
    working: false,
  },
  cancelled: {
    label: 'cancelled',
    tone: 'neutral',
    meaning: 'Called off.',
    working: false,
  },
};

/* -------------------------------- what I may do ------------------------------ */

export type RequestAction = 'confirm_constraints' | 'search' | 'approve' | 'reject' | 'cancel';

export type ActionAvailability = {
  action: RequestAction;
  available: boolean;
  /** Why not, when not — shown instead of hiding the control silently. */
  reason?: string;
};

/** The request fields the availability rules actually read. */
export type ReviewableRequest = {
  status: RequestStatus;
  requesterId: string;
  travelerId: string;
  rawRequestText: string | null;
  constraintsConfirmedAt: Date | null;
};

/**
 * Which actions this actor may take on this request, and why not when not.
 *
 * Returned as a list with reasons rather than a set of booleans, because the
 * interesting cases are all refusals a person needs explained. A travel manager
 * looking at their own over-policy request should be told that separation of
 * duties is why they cannot approve it — SCOPE.md §3 — not shown a page with the
 * button quietly missing and left to conclude the app is broken.
 *
 * This is a courtesy, not a control. Every action re-checks server-side; the
 * agent and the store are what actually enforce.
 */
export function availableActions(actor: Actor, request: ReviewableRequest): ActionAvailability[] {
  const mine = request.requesterId === actor.userId || request.travelerId === actor.userId;
  const pres = STATUS[request.status];

  const needsConfirmation =
    request.rawRequestText !== null && request.constraintsConfirmedAt === null;

  const out: ActionAvailability[] = [];

  out.push(
    needsConfirmation
      ? {
          action: 'confirm_constraints',
          available: mine || canApproveRequestFor(actor, request.requesterId),
          reason: mine ? undefined : 'Only the traveler or requester confirms what the parser read.',
        }
      : { action: 'confirm_constraints', available: false, reason: 'Nothing to confirm.' },
  );

  const searchable: RequestStatus[] = ['submitted', 'no_options', 'expired', 'failed'];
  out.push({
    action: 'search',
    available: searchable.includes(request.status) && !needsConfirmation,
    reason: needsConfirmation
      ? 'The parsed constraints have to be confirmed before anything is searched.'
      : searchable.includes(request.status)
        ? undefined
        : `Nothing to search from "${pres.label}".`,
  });

  const decidable = request.status === 'pending_approval';
  const mayApprove = canApproveRequestFor(actor, request.requesterId);
  const approvalReason = !decidable
    ? `This request is not awaiting approval — it is ${pres.label}.`
    : !mayApprove
      ? actor.impersonatedBy
        ? 'An impersonated session can never approve. SCOPE.md §3.'
        : request.requesterId === actor.userId
          ? 'You opened this request, so you cannot also approve it. It needs another approver.'
          : 'Approving travel is a travel manager or admin capability.'
      : undefined;

  out.push({ action: 'approve', available: decidable && mayApprove, reason: approvalReason });
  out.push({ action: 'reject', available: decidable && mayApprove, reason: approvalReason });

  /**
   * Whether cancelling is legal is the state machine's question, not a second
   * opinion formed here. `isTerminal` treats `ticketed` as the end of the
   * line — nothing is owed to the user once they have a ticket — but the machine
   * still permits `ticketed → cancelled`, and it is right to: a trip that is not
   * happening has to be recordable, and the credit a cancelled non-refundable
   * ticket becomes is money. Asking `canTransition` keeps the button and the
   * engine from disagreeing.
   */
  const cancellable = canTransition(request.status, 'cancelled');
  out.push({
    action: 'cancel',
    available: cancellable && (mine || mayApprove) && !pres.working,
    reason: !cancellable
      ? `A ${pres.label} request cannot be cancelled.`
      : pres.working
        ? 'The agent is mid-purchase. Cancelling now would race the payment.'
        : mine || mayApprove
          ? undefined
          : 'Only the traveler, the requester, or an approver may cancel.',
  });

  return out;
}

/** Convenience for JSX: `can(actions, 'approve')`. */
export function can(actions: ActionAvailability[], action: RequestAction): boolean {
  return actions.find((a) => a.action === action)?.available ?? false;
}

export function whyNot(actions: ActionAvailability[], action: RequestAction): string | undefined {
  const found = actions.find((a) => a.action === action);
  return found?.available ? undefined : found?.reason;
}

/* ---------------------- what a preference actually paid --------------------- */

/**
 * One offer as this reader needs it — the audit trail's shape, narrowed.
 *
 * Structural rather than an import of `AuditOffer` so this file stays free of
 * the audit assembly, which is a database module. The three fields here are the
 * whole input: what it cost, whether the policy would have allowed it, and what
 * preference took off its score.
 */
export type PricedOffer = {
  totalCents: number;
  selected: boolean;
  decision: string | null;
  preference: { orgCents: number; travelerCents: number; totalCents: number };
};

export type PreferencePremium = {
  chosenCents: number;
  /** The cheapest fare the policy would actually have permitted. */
  cheapestAllowedCents: number;
  /** What was really paid over it. Always ≤ the allowance, never equal to it. */
  premiumCents: number;
  orgAllowanceCents: number;
  travelerAllowanceCents: number;
};

/**
 * Why the agent did not take the cheapest fare — the one question this page has
 * to be able to answer about a carrier preference.
 *
 * Two refusals, and the second is the one that keeps the screen honest.
 *
 * **The comparison is against the cheapest fare the policy *allowed*, never the
 * cheapest fare seen.** A denied offer was never an option, so measuring a
 * premium against one invents money that was never available — the page would
 * report the agent overspending by the width of a fare nobody could have bought.
 * `agent.ts` makes the same narrowing for the audit line it writes; the two are
 * deliberately separate implementations over different types rather than one
 * shared helper, because merging them would put a database shape into this pure
 * module.
 *
 * **An allowance is a ceiling, not a spend.** A $60 preference that broke a
 * $37.55 gap cost $37.55, and rendering "$60.00" would overstate every
 * preference on every request — quietly, in the flattering-to-nobody direction,
 * on the screen an approver reads. So the premium is the *actual* difference and
 * the allowances are reported beside it as what was authorized.
 *
 * Returns null when there is nothing to explain: no preference applied, or the
 * chosen fare was the cheapest allowed one anyway. A preference that changed
 * nothing is not news, and a row of zeroes on every request in a workspace that
 * has never priced a preference is how a real signal gets skimmed past.
 */
export function preferencePremium(offers: PricedOffer[]): PreferencePremium | null {
  const chosen = offers.find((o) => o.selected);
  if (!chosen || chosen.preference.totalCents <= 0) return null;

  const allowed = offers.filter((o) => o.decision !== 'deny');
  if (allowed.length === 0) return null;
  const cheapestAllowedCents = Math.min(...allowed.map((o) => o.totalCents));

  const premiumCents = chosen.totalCents - cheapestAllowedCents;
  if (premiumCents <= 0) return null;

  return {
    chosenCents: chosen.totalCents,
    cheapestAllowedCents,
    premiumCents,
    orgAllowanceCents: chosen.preference.orgCents,
    travelerAllowanceCents: chosen.preference.travelerCents,
  };
}
