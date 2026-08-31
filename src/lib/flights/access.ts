import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who sees and who edits a flight record.
 *
 * Seeing is `shows/visibility.ts`'s rule and nothing new: a flight is a
 * per-person travel row, so a Member sees their own and an approver sees
 * everyone's. The narrowing happens in the query.
 *
 * Refreshing status is **not** a privilege, and this is the one call worth
 * arguing about. It looks like a write — it updates rows — but what it writes is
 * the carrier's answer to a public question, and the alternative is a traveler
 * standing at a gate looking at a board this app refuses to refresh for them.
 * The readiness split applies unchanged: reporting what is true is not a
 * privilege; changing the plan is.
 *
 * Correcting a flight record *is* changing the plan — it moves the times the
 * arrival-buffer verdict is computed against — so that needs an approver, or
 * being the traveler on it, which is the same line the roster draws around
 * answering for yourself.
 */

export function canSeeAllFlights(actor: Actor): boolean {
  return canApprove(actor);
}

export function canRefreshStatus(): boolean {
  return true;
}

export function canEditFlight(actor: Actor, flight: { userId: string }): boolean {
  return canApprove(actor) || flight.userId === actor.userId;
}
