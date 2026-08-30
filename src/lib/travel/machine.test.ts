import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  nextStatuses,
  isTerminal,
  isInFlight,
  IllegalTransitionError,
  type RequestStatus,
} from './machine';

const ALL: RequestStatus[] = [
  'draft',
  'submitted',
  'searching',
  'offers_found',
  'pending_approval',
  'approved',
  'rejected',
  'held',
  'booking',
  'ticketed',
  'no_options',
  'expired',
  'failed',
  'cancelled',
];

describe('travel request state machine', () => {
  it('knows every status the database can hold', () => {
    for (const status of ALL) expect(nextStatuses(status)).toBeDefined();
  });

  it('walks the happy path: submitted through to a ticket', () => {
    const path: RequestStatus[] = ['submitted', 'searching', 'offers_found', 'booking', 'ticketed'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('has no auto_approved state — an auto-approval books immediately', () => {
    // The SCOPE.md §6b diagram had one. A state nothing waits in is not a state;
    // the auto-approval lives in the policy_evaluations row instead.
    expect(canTransition('offers_found', 'booking')).toBe(true);
    expect(ALL).not.toContain('auto_approved');
  });

  it('lets an approval send the request back to searching', () => {
    // The offer expired under the approver; the price must be re-established
    // before that approval can authorize anything. SCOPE.md §6b.
    expect(canTransition('pending_approval', 'searching')).toBe(true);
  });

  it('refuses to skip the verdict: submitted cannot jump straight to booking', () => {
    expect(canTransition('submitted', 'booking')).toBe(false);
    expect(() => assertTransition('submitted', 'ticketed')).toThrow(IllegalTransitionError);
  });

  it('cannot resurrect a rejected or cancelled request', () => {
    expect(nextStatuses('rejected')).toHaveLength(0);
    expect(nextStatuses('cancelled')).toHaveLength(0);
    expect(isTerminal('rejected')).toBe(true);
  });

  it('treats a ticket as final apart from cancellation', () => {
    expect(nextStatuses('ticketed')).toEqual(['cancelled']);
    expect(isTerminal('ticketed')).toBe(true);
  });

  it('keeps no_options and expired recoverable — the user can relax and retry', () => {
    expect(canTransition('no_options', 'searching')).toBe(true);
    expect(canTransition('expired', 'searching')).toBe(true);
    expect(isTerminal('no_options')).toBe(false);
  });

  it('says whether the agent still owes the user an outcome', () => {
    expect(isInFlight('pending_approval')).toBe(true);
    expect(isInFlight('searching')).toBe(true);
    expect(isInFlight('ticketed')).toBe(false);
    expect(isInFlight('no_options')).toBe(false);
    expect(isInFlight('draft')).toBe(false);
  });

  it('never lets a booking become a ticket without passing through booking', () => {
    expect(canTransition('approved', 'ticketed')).toBe(false);
    expect(canTransition('pending_approval', 'ticketed')).toBe(false);
  });
});
