import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who may change the roster.
 *
 * `readiness/access.ts` and `deadlines/access.ts` both landed on the same split —
 * *reporting is not a privilege; changing the plan is* — and the roster is the
 * third feature to need it, from a third direction. Here the line falls between
 * **who is going** (a plan: whoever runs the show) and **whether I am going and
 * when I land** (a fact about me, which only I actually know).
 *
 * SCOPE.md §1's corollary is what settles it: *"for a Member, this app should be
 * almost invisible."* An invitation only a Travel Manager can accept on your
 * behalf is an invitation answered by email and typed in later, which is the
 * spreadsheet we are replacing — and worse, it means every `confirmed` on the
 * roster is somebody's assumption. `coverage.ts` counts confirmations. If they
 * are second-hand, the coverage model is counting hearsay.
 *
 * So: staffing, shifts, assignments and the guest list belong to whoever runs the
 * show; answering an invitation, recording your own travel window, RSVP-ing to a
 * dinner, and checking yourself in at the booth belong to you.
 */

/** Add or remove people, create shifts, assign them. Planning. */
export function canStaffShow(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Accepting or declining an invitation, and saying when you land.
 *
 * An approver may also answer for somebody — people go on leave, and a roster
 * that cannot be corrected by anyone but its subject is a roster with permanent
 * stale rows. What matters is that the subject is never *locked out* of it.
 */
export function canRespondForAttendee(actor: Actor, attendee: { userId: string }): boolean {
  return attendee.userId === actor.userId || canApprove(actor);
}

/**
 * Booth check-in. Anyone, for themselves; an approver, for anybody.
 *
 * The looser gate of the two on purpose: presence is a record of what happened,
 * and the failure mode of an over-tight gate here is an empty `shift_presence`
 * table, which destroys §4's rostered-versus-present insight entirely.
 */
export function canRecordPresence(actor: Actor, forUserId: string): boolean {
  return forUserId === actor.userId || canApprove(actor);
}

/**
 * A side event belongs to its host as well as to the show's runners.
 *
 * The person who booked the restaurant is the person who knows who is coming,
 * and making them ask a Travel Manager to add a customer to the list is how the
 * guest list ends up in somebody's inbox instead.
 */
export function canManageSideEvent(actor: Actor, event: { hostId: string | null }): boolean {
  return canApprove(actor) || event.hostId === actor.userId;
}

/** Answering for yourself is always yours; answering for a guest is the host's. */
export function canRsvpFor(
  actor: Actor,
  event: { hostId: string | null },
  rsvp: { userId: string | null },
): boolean {
  return rsvp.userId !== null && rsvp.userId === actor.userId
    ? true
    : canManageSideEvent(actor, event);
}
