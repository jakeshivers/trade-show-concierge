import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may change lodging.
 *
 * Simpler than the roster's split, and deliberately so: a hotel row is a
 * *spending* record — a nightly rate, a cost center, a confirmation number — not
 * a personal fact somebody reports about themselves. There is no equivalent here
 * of "accept your own invitation", because there is nothing about a hotel booking
 * that only the guest knows and nobody else can enter.
 *
 * Reading is narrowed rather than gated: SCOPE.md §3 gives a Member "own shows,
 * flights, lodging", so the hotel itself is a show-wide fact and *who is in which
 * room* is filtered to the actor by `travelerScope`, exactly as `shows/store.ts`
 * already does on the show detail page.
 */

export function canManageLodging(actor: Actor): boolean {
  return canApprove(actor);
}

/** Assigning a room is planning, and it is what the room block is drawn down by. */
export function canAssignRoom(actor: Actor): boolean {
  return canManageLodging(actor);
}
