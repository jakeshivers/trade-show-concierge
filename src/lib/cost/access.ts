import type { Actor } from '@/lib/auth/actor';
import { canApprove } from '@/lib/auth/actor';

/**
 * Who reads a show's cost.
 *
 * This is the one screen in the product where §3's line about travel is
 * decisive rather than incidental. A true-cost figure is every colleague's fare,
 * every room rate and every freight bill added together, and a Member who can
 * see it can very often read one person's salary-adjacent detail straight back
 * out of it — six attendees, five fares recorded, one figure conspicuously
 * larger. `travelerScope` narrows a Member's travel queries to themselves
 * precisely so a colleague's fare is never on their screen; a rollup that
 * aggregated those same rows and showed a Member the total would walk around
 * the narrowing rather than through it.
 *
 * So cost is Travel Manager and Admin, the same audience §3 gives "see all
 * users' travel and shipments". A Member's own spend is on their itinerary and
 * their own travel requests, where it always was.
 */
export function canSeeCost(actor: Actor): boolean {
  return canApprove(actor);
}

/**
 * Who files an invoice against a show.
 *
 * The same audience that reads the figure, and deliberately not the wider
 * "anybody" gate that confirming a crate or capturing a lead gets. Those two are
 * loose because the person holding the fact is whoever is standing there — in a
 * warehouse at 6am, or at a booth at hour six of day two — and a gate would
 * leave the field empty forever.
 *
 * An invoice is the opposite: it arrives at a desk, it is a claim about money
 * that lands in a cost center, and the number it moves is the one a budget is
 * set from next year. Nobody is standing next to it. So it sits with the people
 * who can already read the total, which also means writing one can never reveal
 * more than reading already does.
 */
export function canRecordCost(actor: Actor): boolean {
  return canApprove(actor);
}
