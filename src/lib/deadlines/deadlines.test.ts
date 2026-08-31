import { describe, it, expect } from 'vitest';
import {
  CONFIRM_BY_DAYS,
  daysUntilDue,
  planDeadlineAlert,
  planDeadlineAlerts,
  summarizeExposure,
  thresholdFor,
  THRESHOLD_DAYS,
  type AlertableDeadline,
} from './alerts';
import {
  DeadlineError,
  MIN_REASON,
  planDeadlineStatus,
  validateDeadline,
} from './edit';

/**
 * The pure half of the deadline engine — no database, fixed clock. Most of these
 * assertions are about a *sentence*, not a number, because the sentence is the
 * product: "$3,125 at risk" and "$3,125 already spent" are the same figure and
 * opposite instructions.
 */

const NOW = new Date('2026-03-01T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const d = (over: Partial<AlertableDeadline> = {}): AlertableDeadline => ({
  id: 'd1',
  showId: 'show1',
  title: 'Advance order deadline',
  kind: 'advance_order',
  dueAt: days(10),
  status: 'open',
  penaltyEstimateCents: 312_500,
  penaltyNote: null,
  ownerId: 'marcus',
  confirmedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('thresholds', () => {
  it('fires the tightest threshold entered, not every one passed', () => {
    // A deadline first seen nine days out is a T-14 problem. Replaying the T-30
    // we slept through would bury the alert that is actually actionable.
    expect(thresholdFor(9)).toBe(14);
    expect(thresholdFor(31)).toBeNull();
    expect(thresholdFor(30)).toBe(30);
    expect(thresholdFor(3)).toBe(3);
    expect(thresholdFor(0)).toBe(0);
    expect(thresholdFor(-1)).toBeNull();
  });

  it('exposes §5a’s thresholds verbatim', () => {
    expect([...THRESHOLD_DAYS]).toEqual([30, 14, 3, 0]);
  });

  it('counts whole days toward the deadline', () => {
    expect(daysUntilDue(days(3), NOW)).toBe(3);
    // 2.5 days out is "2 days", never "3" — rounding away from the deadline is
    // the direction that costs money.
    expect(daysUntilDue(new Date(NOW.getTime() + 2.5 * 86_400_000), NOW)).toBe(2);
    expect(daysUntilDue(days(-1), NOW)).toBe(-1);
  });
});

describe('planDeadlineAlert', () => {
  it('says nothing about a deadline outside every window', () => {
    expect(planDeadlineAlert(d({ dueAt: days(60) }), NOW)).toBeNull();
  });

  it('quotes the penalty once inside a threshold', () => {
    const a = planDeadlineAlert(d({ dueAt: days(12) }), NOW)!;
    expect(a.bucketDays).toBe(14);
    expect(a.title).toContain('14-day warning');
    // The window it is, and the distance it actually is — "T-14" on a deadline
    // twelve days out reads as a typo.
    expect(a.title).toContain('due in 12 days');
    expect(a.body).toContain('$3,125');
    expect(a.severity).toBe('warning');
  });

  it('escalates to critical inside three days and on the day', () => {
    expect(planDeadlineAlert(d({ dueAt: days(2) }), NOW)!.severity).toBe('critical');
    const dayOf = planDeadlineAlert(d({ dueAt: days(0) }), NOW)!;
    expect(dayOf.bucketDays).toBe(0);
    expect(dayOf.title).toContain('Due today');
  });

  it('says nothing at all about a completed or waived deadline', () => {
    expect(planDeadlineAlert(d({ dueAt: days(1), status: 'complete' }), NOW)).toBeNull();
    expect(planDeadlineAlert(d({ dueAt: days(-5), status: 'not_applicable' }), NOW)).toBeNull();
  });

  /* ------------------------- correction 1: unconfirmed --------------------- */

  it('chases an unconfirmed date as a date, and never quotes its penalty', () => {
    const a = planDeadlineAlert(d({ dueAt: days(10), confirmedAt: null }), NOW)!;
    expect(a.title).toContain('Confirm the date');
    // The whole point: a figure nobody checked must not go out as a bill.
    expect(a.body).not.toContain('$3,125');
    expect(a.dedupeKey).toContain(':unconfirmed');
  });

  it('starts chasing confirmation before the first money alert, not after', () => {
    expect(CONFIRM_BY_DAYS).toBeGreaterThan(THRESHOLD_DAYS[0]);
    const early = planDeadlineAlert(d({ dueAt: days(40), confirmedAt: null }), NOW)!;
    expect(early.title).toContain('Confirm the date');
    // ...and a confirmed deadline that far out still has nothing to say.
    expect(planDeadlineAlert(d({ dueAt: days(40) }), NOW)).toBeNull();
  });

  it('raises exactly one alert for a deadline that is both unconfirmed and imminent', () => {
    // One problem, not two. A register that sends both teaches people that two
    // thirds of these can be closed unread.
    const a = planDeadlineAlert(d({ dueAt: days(2), confirmedAt: null }), NOW)!;
    expect(a.title).toContain('Confirm the date');
    expect(a.severity).toBe('warning');
  });

  /* --------------------------- correction 2: missed ------------------------ */

  it('changes tense and audience once the date has passed', () => {
    const a = planDeadlineAlert(d({ dueAt: days(-4) }), NOW)!;
    expect(a.title).toContain('Missed');
    expect(a.body).toContain('now billed at the late rate');
    expect(a.body).not.toContain('at risk');
    // The owner needed the reminder; the show lead needs the cost.
    expect(a.audience).toBe('show_runners');
    expect(a.severity).toBe('critical');
    expect(a.bucketDays).toBe(-1);
  });

  it('reports a missed deadline once, not once per night', () => {
    const first = planDeadlineAlert(d({ dueAt: days(-1) }), NOW)!;
    const later = planDeadlineAlert(d({ dueAt: days(-1) }), days(9))!;
    expect(later.dedupeKey).toBe(first.dedupeKey);
  });

  it('still names an unconfirmed date as unchecked when it is missed', () => {
    // Silence would be wrong — the date may be right and the money really gone —
    // but so would booking the loss without saying nobody checked the date.
    const a = planDeadlineAlert(d({ dueAt: days(-2), confirmedAt: null }), NOW)!;
    expect(a.title).toContain('Missed');
    expect(a.body).toContain('never confirmed');
  });

  /* --------------------------- correction 3: unowned ----------------------- */

  it('escalates an unowned deadline instead of mailing nobody', () => {
    const a = planDeadlineAlert(d({ dueAt: days(5), ownerId: null }), NOW)!;
    expect(a.audience).toBe('show_runners');
    expect(a.body).toContain('Nobody owns this deadline');
  });

  it('addresses an owned deadline to its owner', () => {
    const a = planDeadlineAlert(d({ dueAt: days(5) }), NOW)!;
    expect(a.audience).toBe('owner');
    expect(a.ownerId).toBe('marcus');
    expect(a.body).not.toContain('Nobody owns');
  });

  it('says so rather than going quiet when no penalty has been estimated', () => {
    const a = planDeadlineAlert(d({ dueAt: days(5), penaltyEstimateCents: null }), NOW)!;
    expect(a.body).toContain('No penalty estimate is recorded');
    expect(a.severity).toBe('warning');
  });

  /* ------------------------ correction 4: dedupe by date ------------------- */

  it('voids every alert already sent about a deadline when the date moves', () => {
    // The credit ledger can key on the bucket alone because a credit's expiry
    // never moves. A deadline's does — that is half of what editing is for — and
    // a bucket-only key would leave a "3 days left" warning standing for a date
    // that no longer exists while suppressing the one the new date deserves.
    const march = planDeadlineAlert(d({ dueAt: days(2) }), NOW)!;
    const may = planDeadlineAlert(d({ dueAt: days(62) }), days(60))!;
    expect(may.bucketDays).toBe(march.bucketDays);
    expect(may.dedupeKey).not.toBe(march.dedupeKey);
  });

  it('keys the same alert identically across runs so a repeat sweep writes nothing', () => {
    const a = planDeadlineAlert(d({ dueAt: days(2) }), NOW)!;
    const b = planDeadlineAlert(d({ dueAt: days(2) }), new Date(NOW.getTime() + 3_600_000))!;
    expect(b.dedupeKey).toBe(a.dedupeKey);
  });

  it('orders a sweep by urgency, nearest first', () => {
    const planned = planDeadlineAlerts(
      [
        d({ id: 'far', dueAt: days(25) }),
        d({ id: 'missed', dueAt: days(-3) }),
        d({ id: 'near', dueAt: days(1) }),
      ],
      NOW,
    );
    expect(planned.map((a) => a.deadlineId)).toEqual(['missed', 'near', 'far']);
  });
});

describe('summarizeExposure', () => {
  it('counts money past the date as incurred and never as at risk', () => {
    const e = summarizeExposure(
      [d({ id: 'a', dueAt: days(-1) }), d({ id: 'b', dueAt: days(20) })],
      NOW,
    );
    expect(e.incurredCents).toBe(312_500);
    expect(e.atRiskCents).toBe(312_500);
    expect(e.missed).toBe(1);
    expect(e.open).toBe(1);
  });

  it('keeps unconfirmed exposure apart from confirmed exposure', () => {
    // Adding a figure from the manual to a figure somebody guessed produces a
    // number that is neither, and it is the total a screen would print largest.
    const e = summarizeExposure(
      [
        d({ id: 'a', dueAt: days(20) }),
        d({ id: 'b', dueAt: days(20), confirmedAt: null, penaltyEstimateCents: 100_000 }),
      ],
      NOW,
    );
    expect(e.atRiskCents).toBe(312_500);
    expect(e.atRiskUnconfirmedCents).toBe(100_000);
    expect(e.unconfirmed).toBe(1);
  });

  it('ignores completed and waived rows entirely', () => {
    const e = summarizeExposure(
      [d({ id: 'a', dueAt: days(-1), status: 'complete' }), d({ id: 'b', status: 'not_applicable' })],
      NOW,
    );
    expect(e).toMatchObject({ open: 0, missed: 0, incurredCents: 0, atRiskCents: 0 });
  });

  it('counts open deadlines nobody owns', () => {
    const e = summarizeExposure([d({ dueAt: days(5), ownerId: null })], NOW);
    expect(e.unowned).toBe(1);
  });
});

describe('validateDeadline', () => {
  const draft = {
    title: 'Electrical order',
    kind: 'electrical',
    dueDate: '2026-04-01',
    dueTime: '16:00',
    penaltyEstimate: '470.00',
  };

  it('parses money through the decimal parser, not parseFloat', () => {
    expect(validateDeadline({ ...draft, penaltyEstimate: '8618.36' }).penaltyEstimateCents).toBe(
      861_836,
    );
    expect(validateDeadline({ ...draft, penaltyEstimate: '$3,125.00' }).penaltyEstimateCents).toBe(
      312_500,
    );
    expect(validateDeadline({ ...draft, penaltyEstimate: '' }).penaltyEstimateCents).toBeNull();
  });

  it('requires a time of day, because 5pm is an hour late on a 4pm cutoff', () => {
    expect(() => validateDeadline({ ...draft, dueTime: '' })).toThrow(DeadlineError);
    expect(() => validateDeadline({ ...draft, dueTime: '25:00' })).toThrow(DeadlineError);
    expect(validateDeadline(draft).dueTime).toBe('16:00');
  });

  it('refuses a date it cannot resolve and a kind it does not know', () => {
    expect(() => validateDeadline({ ...draft, dueDate: '4/1/2026' })).toThrow(DeadlineError);
    expect(() => validateDeadline({ ...draft, kind: 'catering' })).toThrow(DeadlineError);
  });

  it('rejects a source link that is not a URL', () => {
    expect(() => validateDeadline({ ...draft, sourceUrl: 'manual.pdf' })).toThrow(DeadlineError);
    expect(validateDeadline({ ...draft, sourceUrl: 'https://x/manual.pdf' }).sourceUrl).toBe(
      'https://x/manual.pdf',
    );
  });
});

describe('planDeadlineStatus', () => {
  it('demands a written reason for not-applicable, because it removes money', () => {
    expect(() => planDeadlineStatus('not_applicable', 'no', 'u1', NOW)).toThrow(DeadlineError);
    const ok = planDeadlineStatus('not_applicable', 'Booth has no rigging this year', 'u1', NOW);
    expect(ok.note).toHaveLength('Booth has no rigging this year'.length);
    expect(ok.note!.length).toBeGreaterThanOrEqual(MIN_REASON);
  });

  it('needs no reason to report the work done', () => {
    const done = planDeadlineStatus('complete', null, 'u1', NOW);
    expect(done.completedAt).toEqual(NOW);
    expect(done.completedById).toBe('u1');
  });

  it('clears the completion when a deadline is re-opened', () => {
    const reopened = planDeadlineStatus('open', null, 'u1', NOW);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.completedById).toBeNull();
    expect(reopened.note).toBeNull();
  });

  it('refuses a status it does not have', () => {
    expect(() => planDeadlineStatus('skipped', null, 'u1', NOW)).toThrow(DeadlineError);
  });
});
