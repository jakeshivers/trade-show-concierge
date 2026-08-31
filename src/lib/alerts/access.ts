import type { Actor } from '@/lib/auth/actor';

/**
 * Who reads an alert, and who may clear one.
 *
 * There is no org-wide read here, and that is not an omission. Every engine
 * writes **one row per recipient** — the owner plus the show's runners, the
 * traveler plus the managers — so the audience was decided at the moment the
 * alert was planned, by code that knew what the alert was about. A feed that
 * then offered an admin "everybody's alerts" would be a second, dumber audience
 * model layered over the first, and its first act would be to show a Travel
 * Manager the delay alert for a Member's personal flight home, which the flight
 * engine deliberately addresses to the traveler alone.
 *
 * So: you read the alerts addressed to you. An admin who should hear about a
 * thing already has a row for it, and if they do not, the fix is in the engine
 * that decided the audience — where the reasoning lives — and not in a filter on
 * a screen.
 *
 * Acknowledging is available to whoever holds the row, and to nobody else. It
 * asserts only "I have seen this", which is exactly the kind of claim a person
 * may make about themselves and nobody may make on their behalf — the rule
 * `show_attendees.responded_at` established and `shipments.received_at` reused.
 * It is emphatically not a fix: only a sweep resolves a condition.
 */

export function canSeeAlerts(): boolean {
  return true;
}

/** Your own row, and only your own. `store.ts` scopes the query, not this. */
export function canAcknowledge(actor: Actor, alertUserId: string | null): boolean {
  return alertUserId === actor.userId;
}

/**
 * Running the sweeps by hand. Not a privilege: a sweep asks providers what is
 * true and writes down the answer. Refusing it to a Member means the person
 * standing in the booth cannot refresh the board that says where their crate is.
 */
export function canRunSweeps(): boolean {
  return true;
}
