import { describe, expect, it } from 'vitest';
import { andList, setupSteps, type SetupInputs } from './checklist';
import { missingForTicket, passengerForUser, MissingTravelerDetailsError } from '@/lib/travel/passengers';

const configured: SetupInputs = {
  role: 'admin',
  hasTravelPolicy: true,
  costCenterCount: 2,
  showCount: 3,
  missingTravelerDetails: [],
};

describe('setupSteps', () => {
  it('says nothing about a workspace that is set up', () => {
    expect(setupSteps(configured)).toEqual([]);
  });

  it('raises a step for each thing that is missing, and only those', () => {
    expect(setupSteps({ ...configured, hasTravelPolicy: false }).map((s) => s.key)).toEqual([
      'travel_policy',
    ]);
    expect(setupSteps({ ...configured, costCenterCount: 0 }).map((s) => s.key)).toEqual([
      'cost_centers',
    ]);
    expect(setupSteps({ ...configured, showCount: 0 }).map((s) => s.key)).toEqual(['shows']);
    expect(
      setupSteps({ ...configured, missingTravelerDetails: ['a date of birth'] }).map((s) => s.key),
    ).toEqual(['traveler_details']);
  });

  it('lists a step the reader cannot perform, and names who can', () => {
    const [step] = setupSteps({ ...configured, role: 'member', hasTravelPolicy: false });
    // The whole point: hiding it would leave a Member meeting `NoPolicyError`
    // with no idea why, and nobody to ask.
    expect(step.key).toBe('travel_policy');
    expect(step.mine).toBe(false);
    expect(step.whoCan).toMatch(/admin/i);
  });

  it('gives an admin the control rather than a name to ask', () => {
    const [step] = setupSteps({ ...configured, hasTravelPolicy: false });
    expect(step.mine).toBe(true);
    expect(step.whoCan).toBeNull();
    expect(step.href).toBe('/settings/travel-policy');
  });

  it('keeps traveler details the subject’s own, whatever the role', () => {
    for (const role of ['member', 'travel_manager', 'admin'] as const) {
      const [step] = setupSteps({
        ...configured,
        role,
        missingTravelerDetails: ['a phone number'],
      });
      expect(step.mine).toBe(true);
    }
  });

  it('states the consequence rather than the instruction', () => {
    // The direction that must not change: a step says what stops working, in
    // the present tense. A chore ("Set a travel policy") does not get done.
    const [policy] = setupSteps({ ...configured, hasTravelPolicy: false });
    // Matched on the direction rather than the sentence: a copy pass must be
    // free to reword these, and must not be free to turn them back into chores.
    expect(policy.blocks).toMatch(/will not search|refuses/i);
    const [centers] = setupSteps({ ...configured, costCenterCount: 0 });
    expect(centers.blocks).toMatch(/saved/i);
    for (const step of setupSteps({ ...configured, hasTravelPolicy: false, showCount: 0 })) {
      expect(step.blocks.length).toBeGreaterThan(40);
    }
  });

  it('names every outstanding thing at once on a brand new workspace', () => {
    const steps = setupSteps({
      role: 'admin',
      hasTravelPolicy: false,
      costCenterCount: 0,
      showCount: 0,
      missingTravelerDetails: ['a date of birth', 'a phone number'],
    });
    expect(steps.map((s) => s.key)).toEqual([
      'travel_policy',
      'cost_centers',
      'traveler_details',
      'shows',
    ]);
  });
});

describe('andList', () => {
  it('joins with an "and" rather than a trailing comma', () => {
    expect(andList([])).toBe('');
    expect(andList(['a'])).toBe('a');
    expect(andList(['a', 'b'])).toBe('a and b');
    expect(andList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

/**
 * The point of moving `missingForTicket` next to the thing that throws.
 *
 * These two used to be hand-kept mirrors in different files and had already
 * drifted: `splitName` maps a one-word name to a given and family name that are
 * the same word, both truthy, so the agent's own check passed a traveler the
 * profile screen was correctly refusing. Asserted against the *caller* rather
 * than the helper, because a test on the helper alone passed throughout.
 */
describe('what a ticket needs', () => {
  const complete = {
    id: 'u1',
    fullName: 'Priya Nair',
    email: 'priya@example.test',
    phone: '+1 555 0100',
    bornOn: '1988-04-02',
  };

  it('agrees with the screen about a one-word legal name', () => {
    const user = { ...complete, fullName: 'Priya' };
    expect(missingForTicket(user)).toContain('a full legal name (given and family)');
    expect(() => passengerForUser(user as never)).toThrow(MissingTravelerDetailsError);
  });

  it('accepts a name of three parts', () => {
    const user = { ...complete, fullName: 'Ana Maria Nair' };
    expect(missingForTicket(user)).toEqual([]);
    expect(passengerForUser(user as never).familyName).toBe('Maria Nair');
  });

  it('throws with exactly the list the screen would have shown', () => {
    const user = { ...complete, phone: null, bornOn: null };
    let thrown: MissingTravelerDetailsError | null = null;
    try {
      passengerForUser(user as never);
    } catch (err) {
      thrown = err as MissingTravelerDetailsError;
    }
    expect(thrown).toBeInstanceOf(MissingTravelerDetailsError);
    expect(thrown!.missing).toEqual(missingForTicket(user));
  });
});
