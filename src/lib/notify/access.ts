import type { Actor } from '@/lib/auth/actor';

/**
 * Who decides where a message goes.
 *
 * **A person owns their own destination, and an admin does not own it for
 * them.** That is the one split in this file worth arguing about, and it is not
 * a courtesy. Every engine in this product addresses its rows to a *person*, and
 * `alerts/access.ts` refuses an org-wide read specifically so that a Travel
 * Manager never sees the delay alert on a Member's personal flight home. If an
 * admin could point that Member's alerts at an address of the admin's choosing,
 * the same door reopens from the transport side — and it would be invisible from
 * the alerts screen, which is where anybody would look. So setting, verifying
 * and disabling a destination is the subject's own act, exactly as answering a
 * shift invitation and confirming a crate at the booth are.
 *
 * The corollary is that this is one of the very few settings a **Member** can
 * change, which is right: §1's corollary says the app should be almost invisible
 * to a Member, and the way to be invisible is to reach them where they already
 * are.
 *
 * What an admin does own is the **transport itself** — whether this workspace
 * talks to Slack at all, which is an installation with a bot token and a set of
 * scopes, and is a decision about the company rather than about a person.
 *
 * Reading the delivery log is deliberately split the same way as leads were:
 * anybody may see whether *they* were reached, because "why did nobody tell me"
 * is a question about their own alerts. The org-wide log is an admin's, because
 * it names who was told what.
 */

/** Your own row, and nobody else's — not even an admin's. */
export function canSetDestination(actor: Actor, subjectUserId: string): boolean {
  return actor.userId === subjectUserId;
}

/** Installing or removing the transport for the whole workspace. */
export function canConfigureTransport(actor: Actor): boolean {
  return actor.role === 'admin';
}

/** The whole org's delivery log — who was told what, and who was not. */
export function canReadOrgDeliveries(actor: Actor): boolean {
  return actor.role === 'admin';
}

/**
 * Running the delivery pass by hand.
 *
 * Not a privilege, for `alerts/access.ts`'s reason one layer out: a delivery
 * pass carries alerts that were already addressed to whoever gets them, and it
 * can only ever send somebody their own. Refusing it to a Member means the
 * person whose crate is missing cannot make the app tell them about it.
 */
export function canRunDelivery(): boolean {
  return true;
}
