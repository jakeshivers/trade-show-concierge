import type { UserRole } from '@/lib/auth/actor';
import { andList } from '@/lib/text';

/**
 * What a workspace still needs before it works at all — pure.
 *
 * Every other module here reports on a show. This one reports on the
 * *installation*, and it exists because of a gap nothing else could have found:
 * `travel_policies` and `cost_centers` were read by screens and written only by
 * the seed for twenty-four steps, so a real organization signed in to a product
 * whose booking agent refused to search and whose every financial form had an
 * empty required select — each failing with a message about the missing thing,
 * on the screen where somebody was trying to do something else. The write paths
 * exist now. Nothing told anybody they had to use them first.
 *
 * **This is deliberately not an eighth alert engine**, for the reason already
 * written down when drayage rate cards raised the same temptation: *a condition
 * with no clock is not an alert*. All seven engines fire on something that
 * changes with time. "This org has no travel policy" is true from the first
 * minute, stays true until somebody types one, and never sharpens — and a
 * permanently-true alert that never escalates is a nag, which teaches a team to
 * close the next alert unread. It belongs on the screen somebody is reading.
 *
 * Two rules about what a step may say:
 *
 * 1. **It names the consequence, not the instruction.** "Set a travel policy" is
 *    a chore; "until this is set the booking agent refuses to search" is a
 *    reason, and the second one is what gets it done.
 * 2. **A step the reader cannot perform is still listed, and names who can.**
 *    Hiding the admin steps from a Member would leave them meeting `NoPolicyError`
 *    with no idea why or who to ask — the posture every `access.ts` refusal in
 *    this codebase already takes.
 */

export type SetupStepKey = 'travel_policy' | 'cost_centers' | 'traveler_details' | 'shows';

export type SetupStep = {
  key: SetupStepKey;
  /** The heading, as an act rather than a noun. */
  title: string;
  /** What does not work until it is done. Present tense, and specific. */
  blocks: string;
  href: string;
  /** The control at the other end, named — copy asking for an action names the button. */
  cta: string;
  /**
   * Whether this reader can do it. False does not hide the step; it swaps the
   * link for `whoCan`.
   */
  mine: boolean;
  /** Who to ask, when it is not yours. */
  whoCan: string | null;
};

export type SetupInputs = {
  role: UserRole;
  hasTravelPolicy: boolean;
  costCenterCount: number;
  showCount: number;
  /** From `missingForTicket` — the same list the booking agent throws with. */
  missingTravelerDetails: string[];
};

export function setupSteps(inputs: SetupInputs): SetupStep[] {
  const admin = inputs.role === 'admin';
  const steps: SetupStep[] = [];

  if (!inputs.hasTravelPolicy) {
    steps.push({
      key: 'travel_policy',
      title: 'Set a travel policy',
      blocks:
        'Until an organization has one, the booking agent will not search for a fare at all — ' +
        'it has no spend ceiling or schedule limit to buy within, and it refuses rather than guessing one.',
      href: '/settings/travel-policy',
      cta: 'Set the policy',
      mine: admin,
      whoCan: admin ? null : 'An admin sets this.',
    });
  }

  if (inputs.costCenterCount === 0) {
    steps.push({
      key: 'cost_centers',
      title: 'Add a cost center',
      blocks:
        'Every hotel, crate, expense, asset and print run is filed against one when it is created. ' +
        'Until there is at least one, none of those can be saved and the form offers nothing to pick.',
      href: '/settings/cost-centers',
      cta: 'Add a cost center',
      mine: admin,
      whoCan: admin ? null : 'An admin adds these.',
    });
  }

  if (inputs.missingTravelerDetails.length > 0) {
    steps.push({
      key: 'traveler_details',
      title: 'Complete your traveler details',
      blocks:
        `An airline will not issue a ticket without ${andList(inputs.missingTravelerDetails)}, ` +
        'and they are never guessed — a placeholder buys a real ticket that fails at the gate. ' +
        'A phone number is also how somebody reaches you when a show is going wrong.',
      href: '/settings/profile',
      cta: 'Add your details',
      // Always yours, and only yours: nobody else may type a date of birth on
      // your behalf. Same rule as answering a roster invitation.
      mine: true,
      whoCan: null,
    });
  }

  if (inputs.showCount === 0) {
    steps.push({
      key: 'shows',
      title: 'Propose a show',
      blocks:
        'Everything else here hangs off one — deadlines, freight, the roster, leads and the cost of it. ' +
        'Proposing a show is not committing to it; it records the decision either way.',
      href: '/shows/new',
      cta: 'Propose a show',
      mine: true,
      whoCan: null,
    });
  }

  return steps;
}
