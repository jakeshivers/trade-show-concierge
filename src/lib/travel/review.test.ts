import { describe, it, expect } from 'vitest';
import type { Actor } from '@/lib/auth/actor';
import {
  offerStanding,
  standingLabel,
  standingMatters,
  availableActions,
  can,
  whyNot,
  STATUS,
  type ReviewableRequest,
} from './review';

const NOW = new Date('2026-03-10T15:00:00Z');
const soon = (mins: number) => new Date(NOW.getTime() + mins * 60_000);
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000);

describe('offerStanding — what approving actually authorizes', () => {
  it('a live offer is bookable at the price on screen', () => {
    const s = offerStanding({ offerExpiresAt: soon(20) }, NOW);
    expect(s.kind).toBe('live');
    expect(s.bookableAtShownPrice).toBe(true);
    expect(s.goodUntil).toEqual(soon(20));
  });

  it('an expired offer with no hold is a ceiling, not a price', () => {
    const s = offerStanding({ offerExpiresAt: ago(5) }, NOW);
    expect(s.kind).toBe('expired');
    expect(s.bookableAtShownPrice).toBe(false);
    expect(s.meaning).toContain('ceiling');
  });

  it('a hold with a live price guarantee keeps the fare bookable past expiry', () => {
    const s = offerStanding(
      { offerExpiresAt: ago(90), hold: { priceGuaranteedUntil: soon(600), payBy: soon(1200) } },
      NOW,
    );
    expect(s.kind).toBe('held_guaranteed');
    expect(s.bookableAtShownPrice).toBe(true);
  });

  /**
   * The case SCOPE.md §6b singles out. A hold reserves the seat; only a
   * guarantee reserves the fare, and Duffel's guarantee field is nullable — so
   * "held" alone must never render as a price.
   */
  it('a hold WITHOUT a price guarantee is held space at an unknown fare', () => {
    const s = offerStanding(
      { offerExpiresAt: ago(90), hold: { priceGuaranteedUntil: null, payBy: soon(1200) } },
      NOW,
    );
    expect(s.kind).toBe('held_unguaranteed');
    expect(s.bookableAtShownPrice).toBe(false);
    expect(s.meaning).toContain('not guaranteed');
    // The deadline it shows is the payment deadline — the only real one left.
    expect(s.goodUntil).toEqual(soon(1200));
  });

  it('a hold whose guarantee has itself expired is not a price either', () => {
    const s = offerStanding(
      { offerExpiresAt: ago(90), hold: { priceGuaranteedUntil: ago(10), payBy: soon(60) } },
      NOW,
    );
    expect(s.kind).toBe('held_unguaranteed');
    expect(s.bookableAtShownPrice).toBe(false);
  });

  it('every standing has a label and only the two bookable kinds claim a price', () => {
    const kinds = ['live', 'held_guaranteed', 'held_unguaranteed', 'expired'] as const;
    for (const k of kinds) expect(standingLabel(k)).toBeTruthy();
    expect(standingLabel('expired')).toContain('re-price');
  });
});

/* --------------------------------- actions ---------------------------------- */

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'u-member',
  orgId: 'org-1',
  email: 'priya@example.test',
  fullName: 'Priya',
  role: 'member',
  costCenterId: 'cc-1',
  ...over,
});

const request = (over: Partial<ReviewableRequest> = {}): ReviewableRequest => ({
  status: 'pending_approval',
  requesterId: 'u-member',
  travelerId: 'u-member',
  rawRequestText: null,
  constraintsConfirmedAt: new Date(),
  ...over,
});

describe('availableActions', () => {
  it('a member may cancel their own request but never approve it', () => {
    const a = availableActions(actor(), request());
    expect(can(a, 'cancel')).toBe(true);
    expect(can(a, 'approve')).toBe(false);
    expect(whyNot(a, 'approve')).toContain('cannot also approve');
  });

  it('a travel manager may approve someone else’s request', () => {
    const a = availableActions(
      actor({ userId: 'u-tm', role: 'travel_manager', email: 'marcus@example.test' }),
      request(),
    );
    expect(can(a, 'approve')).toBe(true);
    expect(can(a, 'reject')).toBe(true);
  });

  /** Separation of duties, SCOPE.md §3 — and the screen must say why, not hide it. */
  it('a travel manager may NOT approve their own request, with a reason', () => {
    const a = availableActions(
      actor({ userId: 'u-tm', role: 'travel_manager' }),
      request({ requesterId: 'u-tm', travelerId: 'u-tm' }),
    );
    expect(can(a, 'approve')).toBe(false);
    expect(whyNot(a, 'approve')).toContain('cannot also approve');
  });

  it('an impersonated admin can never approve', () => {
    const a = availableActions(
      actor({ userId: 'u-admin', role: 'admin', impersonatedBy: 'u-other' }),
      request(),
    );
    expect(can(a, 'approve')).toBe(false);
    expect(whyNot(a, 'approve')).toContain('impersonated');
  });

  it('refuses to cancel mid-purchase rather than racing the payment', () => {
    const a = availableActions(actor(), request({ status: 'booking' }));
    expect(can(a, 'cancel')).toBe(false);
    expect(whyNot(a, 'cancel')).toContain('race');
  });

  it('a ticketed request offers no approve, reject, or search', () => {
    const a = availableActions(actor({ role: 'admin', userId: 'u-admin' }), request({ status: 'ticketed' }));
    for (const action of ['approve', 'reject', 'search'] as const) expect(can(a, action)).toBe(false);
  });

  /**
   * The machine permits `ticketed → cancelled` and the button must agree with
   * it: a trip that is not happening has to be recordable, and the credit a
   * cancelled non-refundable ticket becomes is real money.
   */
  it('still allows cancelling a ticketed request, because the machine does', () => {
    expect(can(availableActions(actor(), request({ status: 'ticketed' })), 'cancel')).toBe(true);
  });

  it('does not offer cancel from a state the machine has no exit for', () => {
    for (const status of ['rejected', 'cancelled'] as const) {
      const a = availableActions(actor({ role: 'admin', userId: 'u-admin' }), request({ status }));
      expect(can(a, 'cancel'), status).toBe(false);
    }
  });

  it('searching again is offered from no_options, expired, and failed — none are dead ends', () => {
    for (const status of ['no_options', 'expired', 'failed', 'submitted'] as const) {
      expect(can(availableActions(actor(), request({ status })), 'search')).toBe(true);
    }
  });

  /**
   * SCOPE.md §6a: an unreviewed misparse must not be laundered into an
   * authorized purchase, so free-text requests cannot be searched until a human
   * signs off on what the parser read.
   */
  it('blocks search on unconfirmed parsed constraints, and offers confirmation instead', () => {
    const r = request({
      status: 'submitted',
      rawRequestText: 'vegas tuesday back thursday night',
      constraintsConfirmedAt: null,
    });
    const a = availableActions(actor(), r);
    expect(can(a, 'search')).toBe(false);
    expect(whyNot(a, 'search')).toContain('confirmed');
    expect(can(a, 'confirm_constraints')).toBe(true);
  });

  it('offers nothing to confirm once the constraints are confirmed', () => {
    expect(can(availableActions(actor(), request({ status: 'submitted' })), 'confirm_constraints')).toBe(
      false,
    );
  });

  it('every action always comes back with a reason when it is unavailable', () => {
    for (const status of Object.keys(STATUS) as (keyof typeof STATUS)[]) {
      for (const entry of availableActions(actor(), request({ status }))) {
        if (!entry.available) expect(entry.reason, `${status}/${entry.action}`).toBeTruthy();
      }
    }
  });
});

describe('standingMatters', () => {
  it('is worth showing only while approving is still possible', () => {
    expect(standingMatters('pending_approval')).toBe(true);
    expect(standingMatters('held')).toBe(true);
  });

  it('is suppressed on a decided request — "fare live" beside a bought ticket misleads', () => {
    for (const status of ['ticketed', 'rejected', 'cancelled', 'failed', 'no_options'] as const) {
      expect(standingMatters(status), status).toBe(false);
    }
  });
});

describe('STATUS presentation', () => {
  it('covers every status the machine can hold', () => {
    expect(Object.keys(STATUS)).toHaveLength(14);
  });

  it('does not present no_options or expired as failures — both are re-searchable', () => {
    expect(STATUS.no_options.tone).not.toBe('bad');
    expect(STATUS.expired.tone).not.toBe('bad');
  });

  it('marks the states where the agent is working, so screens do not offer actions', () => {
    expect(STATUS.booking.working).toBe(true);
    expect(STATUS.searching.working).toBe(true);
    expect(STATUS.pending_approval.working).toBe(false);
  });
});
