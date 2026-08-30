/**
 * The travel request state machine.
 *
 * Pure and dependency-free, so the legal shape of a request's life is one table
 * you can read in ten seconds rather than something inferred from scattered
 * `if` statements in the orchestrator. Every write in `agent.ts` goes through
 * `assertTransition`, which means an illegal state change is a thrown error at
 * the moment it is attempted, not a corrupt row discovered later.
 *
 * See SCOPE.md §6b.
 */

export type RequestStatus =
  | 'draft'
  | 'submitted'
  | 'searching'
  | 'offers_found'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'held'
  | 'booking'
  | 'ticketed'
  | 'no_options'
  | 'expired'
  | 'failed'
  | 'cancelled';

/**
 * A correction to the diagram in SCOPE.md §6b: there is no `auto_approved`
 * state. It was in the sketch, but a state nothing can observe and nothing can
 * wait in is not a state — an auto-approved request goes straight from
 * `offers_found` to `booking`, and the auto-approval is recorded as a
 * `policy_evaluations` row with decision `auto_approve`. Keeping it as a status
 * would have created a second, weaker record of the same fact.
 */
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['searching', 'cancelled'],
  searching: ['offers_found', 'no_options', 'failed', 'cancelled'],
  // Auto-approved goes straight to booking; anything else waits for a human.
  offers_found: ['booking', 'pending_approval', 'no_options', 'failed', 'cancelled'],
  // `searching` is reachable from here: an offer that expired under an approver
  // must be re-searched and re-priced before that approval can mean anything.
  pending_approval: ['approved', 'rejected', 'searching', 'expired', 'failed', 'cancelled'],
  approved: ['booking', 'held', 'searching', 'expired', 'failed', 'cancelled'],
  held: ['booking', 'expired', 'failed', 'cancelled'],
  booking: ['ticketed', 'failed', 'cancelled'],
  // Changes and refunds are step 6; for now a ticket can only be cancelled.
  ticketed: ['cancelled'],
  // Not terminal: relaxing a constraint and searching again is the whole point
  // of telling the user why nothing matched.
  no_options: ['searching', 'cancelled'],
  expired: ['searching', 'cancelled'],
  failed: ['searching', 'cancelled'],
  rejected: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly RequestStatus[] = ['rejected', 'cancelled', 'ticketed'];

export class IllegalTransitionError extends Error {
  constructor(readonly from: RequestStatus, readonly to: RequestStatus) {
    super(`Illegal travel request transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function nextStatuses(from: RequestStatus): readonly RequestStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** True once the request can never move again — nothing is owed to the user. */
export function isTerminal(status: RequestStatus): boolean {
  return TRANSITIONS[status].length === 0 || status === 'ticketed';
}

/** True while the agent still owes the user an outcome. */
export function isInFlight(status: RequestStatus): boolean {
  return !isTerminal(status) && status !== 'no_options' && status !== 'draft';
}
