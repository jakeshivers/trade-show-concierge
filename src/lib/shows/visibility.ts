import type { Actor } from '@/lib/auth/actor';
import { canApprove, isAdmin } from '@/lib/auth/actor';

/**
 * Who sees what on the planning screens.
 *
 * SCOPE.md §3 draws its line around *travel*, not around shows: a Member sees
 * "own shows, flights, lodging, itinerary" while a Travel Manager sees "all
 * users' travel and shipments". Reading that as "a Member may only see shows they
 * are staffed on" is the wrong split, and step 8 corrected it — the show calendar
 * is the org's plan, and hiding next quarter's calendar from the engineer who
 * will staff it makes the app less useful without making anything safer. What is
 * actually scoped is the per-person rows hanging off a show: who is flying on
 * what fare, which hotel they are in, what they asked for.
 *
 * So: the show list and every planning fact on a show are org-wide. Flights,
 * lodging assignments, and travel requests are filtered to the actor unless the
 * actor may approve.
 */

/** `'all'` or the single traveler the actor is allowed to see. */
export type TravelerScope = { kind: 'all' } | { kind: 'self'; userId: string };

export function travelerScope(actor: Actor): TravelerScope {
  return canApprove(actor) ? { kind: 'all' } : { kind: 'self', userId: actor.userId };
}

export function seesTraveler(actor: Actor, userId: string): boolean {
  const scope = travelerScope(actor);
  return scope.kind === 'all' || scope.userId === userId;
}

/** Anyone may propose a show. Only an admin commits or declines one. §3, "Manage shows". */
export function canProposeShow(): boolean {
  return true;
}

export function canDecideShow(actor: Actor): boolean {
  return isAdmin(actor);
}

/**
 * Cloning creates a show, which is an admin act — but the clone lands as a
 * `prospect`, not a committed show, so a Travel Manager building next year's
 * calendar for review does not need admin rights to draft it.
 */
export function canCloneShow(actor: Actor): boolean {
  return canApprove(actor);
}
