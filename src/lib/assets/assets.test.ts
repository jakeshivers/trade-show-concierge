import { describe, it, expect } from 'vitest';
import {
  MISSING_AFTER_HOURS,
  RETURN_GRACE_HOURS,
  TURNAROUND_HOURS,
  availabilityFor,
  custodyOf,
  freightCoverage,
  gapHours,
  isLive,
  overlaps,
  serviceabilityOf,
  type Reservation,
  type TrackedAsset,
} from './custody';
import { findAssetClashes } from './conflicts';
import {
  allocationStanding,
  projectQuantity,
  reconcileAllocation,
  signOf,
  stockStanding,
  type Allocation,
  type CollateralItem,
} from './inventory';
import {
  planClashAlert,
  planReservationAlert,
  planStockAlert,
  planUnreconciledAlert,
  type AlertableReservation,
} from './alerts';
import { buildAssetRow, nextDueAt, offerAssets, orderAssets, summarizeAssets } from './board';
import {
  AssetError,
  describeReservationRelease,
  validateAsset,
  validateCheckIn,
  validateCollateral,
  validateMovement,
  validateReservation,
} from './edit';
import { canCountStock, canHandleAssets, canManageAssets, canReserveAssets } from './access';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of assets — no database, no network, fixed clock.
 *
 * The assertions worth reading are the ones about the *gaps*: a reservation that
 * is fully recorded and still leaves the asset unavailable, a shelf that is full
 * and still short, a count of zero that must not be inferred from a blank. Each
 * of those is a number that reads fine and is wrong, which is the class of bug
 * every step since 10 has been about.
 */

const NOW = new Date('2026-03-10T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const days = (n: number) => hours(n * 24);

const booth = (over: Partial<TrackedAsset> = {}): TrackedAsset => ({
  id: 'a1',
  name: '20x20 island booth',
  kind: 'booth',
  assetTag: 'NWR-BOOTH-01',
  condition: 'good',
  storageLocation: 'Warehouse A',
  purchaseValueCents: 8_400_000,
  ...over,
});

const res = (over: Partial<Reservation> = {}): Reservation => ({
  id: 'r1',
  assetId: 'a1',
  showId: 'show1',
  reservedFrom: days(-10),
  reservedTo: days(10),
  checkedOutAt: null,
  checkedOutById: null,
  conditionOnCheckout: null,
  returnedAt: null,
  returnedById: null,
  conditionOnReturn: null,
  ...over,
});

const alertable = (over: Partial<AlertableReservation> = {}): AlertableReservation => ({
  asset: booth(),
  reservation: res(),
  showId: 'show1',
  showName: 'Automate 2026',
  moveInAt: days(2),
  holderId: 'u-marcus',
  holderName: 'Marcus Webb',
  ...over,
});

const actor = (role: Actor['role']): Actor => ({
  userId: 'u1',
  orgId: 'o1',
  email: 'a@b.c',
  fullName: 'A',
  role,
  costCenterId: null,
});

/* --------------------------------- custody --------------------------------- */

describe('custodyOf', () => {
  it('is planned before the window and due_out inside it', () => {
    expect(custodyOf(res({ reservedFrom: days(2), reservedTo: days(20) }), NOW).standing).toBe(
      'planned',
    );
    expect(custodyOf(res(), NOW).standing).toBe('due_out');
  });

  it('reads a checked-out asset as out until the grace runs out', () => {
    const out = res({ checkedOutAt: days(-9), reservedTo: hours(-RETURN_GRACE_HOURS + 1) });
    expect(custodyOf(out, NOW).standing).toBe('out');
    const late = res({ checkedOutAt: days(-9), reservedTo: hours(-RETURN_GRACE_HOURS - 1) });
    expect(custodyOf(late, NOW).standing).toBe('overdue');
  });

  it('stops calling it overdue once it is unaccounted for', () => {
    const gone = res({ checkedOutAt: days(-60), reservedTo: hours(-MISSING_AFTER_HOURS - 1) });
    expect(custodyOf(gone, NOW).standing).toBe('missing');
  });

  /**
   * The state nothing on a screen distinguishes: the reservation row looks
   * exactly like every other closed one, and the asset never moved.
   */
  it('separates never collected from returned', () => {
    const uncollected = res({ reservedTo: days(-5) });
    expect(custodyOf(uncollected, NOW).standing).toBe('never_collected');
    expect(isLive(uncollected, NOW)).toBe(false);

    const returned = res({ checkedOutAt: days(-9), returnedAt: days(-1), reservedTo: days(-5) });
    expect(custodyOf(returned, NOW).standing).toBe('returned');
  });

  /** A missing end is not "unchanged", and a screen must not draw it as one. */
  it('reports a condition delta only when both ends were recorded', () => {
    expect(custodyOf(res({ returnedAt: days(-1), conditionOnReturn: 'damaged' }), NOW).conditionChange)
      .toBeNull();
    expect(
      custodyOf(
        res({
          checkedOutAt: days(-9),
          returnedAt: days(-1),
          conditionOnCheckout: 'good',
          conditionOnReturn: 'needs_repair',
        }),
        NOW,
      ).conditionChange,
    ).toBe('worsened');
    expect(
      custodyOf(
        res({
          checkedOutAt: days(-9),
          returnedAt: days(-1),
          conditionOnCheckout: 'needs_repair',
          conditionOnReturn: 'good',
        }),
        NOW,
      ).conditionChange,
    ).toBe('improved');
  });
});

describe('serviceabilityOf', () => {
  it('treats only good as serviceable and keeps the refusals apart', () => {
    expect(serviceabilityOf({ condition: 'good' }).kind).toBe('serviceable');
    const repair = serviceabilityOf({ condition: 'needs_repair' });
    const damaged = serviceabilityOf({ condition: 'damaged' });
    expect(repair.kind).toBe('unserviceable');
    expect(damaged.kind).toBe('unserviceable');
    // Different sentences, because a person acts on them differently.
    expect(repair.kind === 'unserviceable' && repair.why).not.toBe(
      damaged.kind === 'unserviceable' && damaged.why,
    );
  });
});

describe('availabilityFor', () => {
  const window = { from: days(20), to: days(30) };

  it('offers a serviceable, unpromised asset', () => {
    expect(availabilityFor(booth(), [], window).kind).toBe('available');
  });

  /** Reserved is not available — §5e's shape, in a warehouse. */
  it('refuses one already promised, and names the show', () => {
    const a = availabilityFor(
      booth(),
      [res({ showId: 'other', reservedFrom: days(25), reservedTo: days(40) })],
      window,
    );
    expect(a.kind).toBe('committed');
    expect(a.kind === 'committed' && a.toShowIds).toEqual(['other']);
  });

  /** Available is not serviceable, and condition wins over the calendar. */
  it('refuses a free asset that is not fit to go', () => {
    const a = availabilityFor(booth({ condition: 'needs_repair' }), [], window);
    expect(a.kind).toBe('unserviceable');
  });

  it('flags adjacency that is not physically possible', () => {
    const a = availabilityFor(
      booth(),
      [res({ showId: 'other', reservedFrom: days(31), reservedTo: days(40) })],
      window,
    );
    expect(a.kind).toBe('tight_turnaround');
    expect(a.kind === 'tight_turnaround' && a.gapHours).toBe(24);
  });

  it('lets a real turnaround through', () => {
    const a = availabilityFor(
      booth(),
      [res({ showId: 'other', reservedFrom: days(40), reservedTo: days(50) })],
      window,
    );
    expect(a.kind).toBe('available');
    expect(gapHours(window, { from: days(40), to: days(50) })).toBeGreaterThan(TURNAROUND_HOURS);
  });

  it('overlaps is half-open at both ends', () => {
    expect(overlaps({ from: days(0), to: days(5) }, { from: days(5), to: days(9) })).toBe(false);
    expect(overlaps({ from: days(0), to: days(5) }, { from: days(4), to: days(9) })).toBe(true);
  });
});

describe('freightCoverage', () => {
  /** Not knowing is not fine — §5f's rule about an unchecked flight. */
  it('is unverified rather than clear when there is no freight', () => {
    const v = freightCoverage(res(), { outboundBy: null, homeBy: null });
    expect(v.kind).toBe('unverified');
  });

  it('passes a window that brackets the freight', () => {
    const v = freightCoverage(res({ reservedFrom: days(-10), reservedTo: days(10) }), {
      outboundBy: days(-5),
      homeBy: days(5),
    });
    expect(v.kind).toBe('covers');
  });

  /**
   * The days the asset is on a truck and the register says it is on a shelf —
   * which is exactly the window another show can claim it in.
   */
  it('reports both edges of a window shorter than the trip', () => {
    const v = freightCoverage(res({ reservedFrom: days(0), reservedTo: days(4) }), {
      outboundBy: days(-3),
      homeBy: days(9),
    });
    expect(v.kind).toBe('short');
    expect(v.kind === 'short' && v.opensLateHours).toBe(72);
    expect(v.kind === 'short' && v.closesEarlyHours).toBe(120);
  });
});

/* -------------------------------- conflicts -------------------------------- */

describe('findAssetClashes', () => {
  const rows = (over: Partial<Reservation>[], showNames: string[]) =>
    over.map((o, i) => ({
      asset: booth(),
      reservation: res({ id: `r${i}`, showId: `s${i}`, ...o }),
      showName: showNames[i],
    }));

  it('calls an overlap certain', () => {
    const clashes = findAssetClashes(
      rows(
        [
          { reservedFrom: days(0), reservedTo: days(10) },
          { reservedFrom: days(5), reservedTo: days(15) },
        ],
        ['Automate', 'Sensors'],
      ),
    );
    expect(clashes).toHaveLength(1);
    expect(clashes[0].kind).toBe('overlap');
    expect(clashes[0].certainty).toBe('certain');
    expect(clashes[0].overlapHours).toBe(120);
  });

  /**
   * §5e's certainty distinction, reached from the opposite direction: there the
   * doubt was about the data, here it is about the world.
   */
  it('calls a short turnaround possible, and says why it might be fine', () => {
    const clashes = findAssetClashes(
      rows(
        [
          { reservedFrom: days(0), reservedTo: days(10) },
          { reservedFrom: days(11), reservedTo: days(20) },
        ],
        ['Automate', 'Sensors'],
      ),
    );
    expect(clashes).toHaveLength(1);
    expect(clashes[0].kind).toBe('turnaround');
    expect(clashes[0].certainty).toBe('possible');
    expect(clashes[0].detail).toMatch(/same floor/);
  });

  it('says nothing about two shows a month apart', () => {
    expect(
      findAssetClashes(
        rows(
          [
            { reservedFrom: days(0), reservedTo: days(10) },
            { reservedFrom: days(40), reservedTo: days(50) },
          ],
          ['Automate', 'Sensors'],
        ),
      ),
    ).toHaveLength(0);
  });

  it('never compares two different assets', () => {
    const clashes = findAssetClashes([
      { asset: booth({ id: 'a1' }), reservation: res({ id: 'r1', assetId: 'a1' }), showName: 'A' },
      { asset: booth({ id: 'a2' }), reservation: res({ id: 'r2', assetId: 'a2' }), showName: 'B' },
    ]);
    expect(clashes).toHaveLength(0);
  });

  it('puts the certain findings first', () => {
    const clashes = findAssetClashes([
      ...rows(
        [
          { reservedFrom: days(0), reservedTo: days(10) },
          { reservedFrom: days(11), reservedTo: days(20) },
        ],
        ['A', 'B'],
      ),
      {
        asset: booth(),
        reservation: res({ id: 'r9', showId: 's9', reservedFrom: days(5), reservedTo: days(9) }),
        showName: 'C',
      },
    ]);
    expect(clashes[0].certainty).toBe('certain');
  });
});

/* -------------------------------- inventory -------------------------------- */

const item = (over: Partial<CollateralItem> = {}): CollateralItem => ({
  id: 'i1',
  name: 'Platform overview datasheet',
  sku: 'DS-PLAT-01',
  quantityOnHand: 640,
  lowStockThreshold: 250,
  unitCostCents: 85,
  storageLocation: 'Rack 1',
  ...over,
});

const alloc = (over: Partial<Allocation> = {}): Allocation => ({
  id: 'al1',
  itemId: 'i1',
  showId: 'show1',
  quantityAllocated: 400,
  issuedAt: null,
  quantityReturned: null,
  returnedAt: null,
  ...over,
});

describe('stockStanding', () => {
  /** The headline correction: a full shelf that is nearly all promised. */
  it('judges low stock on available, not on hand', () => {
    const s = stockStanding(item(), [alloc()]);
    expect(s.onHand).toBe(640);
    expect(s.committed).toBe(400);
    expect(s.available).toBe(240);
    expect(s.level).toBe('low');
    // The figure every screen shows would have said this was fine.
    expect(s.onHand > s.threshold).toBe(true);
  });

  it('reports promising more than we hold as its own thing', () => {
    const s = stockStanding(item({ quantityOnHand: 180 }), [alloc({ quantityAllocated: 220 })]);
    expect(s.available).toBe(-40);
    expect(s.level).toBe('short');
  });

  /** Issued stock has already left the shelf; counting it as committed too would double it. */
  it('does not double-count stock that is already in a crate', () => {
    const s = stockStanding(item({ quantityOnHand: 240 }), [alloc({ issuedAt: days(-3) })]);
    expect(s.committed).toBe(0);
    expect(s.issued).toBe(400);
    expect(s.available).toBe(240);
    expect(s.openAllocations).toBe(1);
  });

  it('closes the allocation once it has been counted back', () => {
    const s = stockStanding(item(), [
      alloc({ issuedAt: days(-9), returnedAt: days(-1), quantityReturned: 0 }),
    ]);
    expect(s.openAllocations).toBe(0);
    expect(s.issued).toBe(0);
  });

  it('ignores allocations belonging to a different item', () => {
    expect(stockStanding(item(), [alloc({ itemId: 'other' })]).committed).toBe(0);
  });
});

describe('allocationStanding', () => {
  /**
   * The nullability that is load-bearing: "nobody counted" and "counted, none
   * came back" are different facts, and only the second closes the loop.
   */
  it('keeps an uncounted return apart from a zero return', () => {
    expect(allocationStanding(alloc({ issuedAt: days(-9) }))).toBe('issued');
    expect(
      allocationStanding(alloc({ issuedAt: days(-9), returnedAt: days(-1), quantityReturned: 0 })),
    ).toBe('reconciled');
  });
});

describe('the ledger', () => {
  it('projects a quantity from signed deltas', () => {
    const entries = [
      { kind: 'received' as const, delta: 900, quantityAfter: 900, occurredAt: days(-70), reason: 'x' },
      { kind: 'issued' as const, delta: -250, quantityAfter: 650, occurredAt: days(-6), reason: 'y' },
    ];
    expect(projectQuantity(entries)).toBe(650);
    expect(entries[entries.length - 1].quantityAfter).toBe(projectQuantity(entries));
  });

  it('gives counted the only two-way sign', () => {
    expect(signOf('received')).toBe(1);
    expect(signOf('returned')).toBe(1);
    expect(signOf('issued')).toBe(-1);
    expect(signOf('written_off')).toBe(-1);
    expect(signOf('counted')).toBe(0);
  });
});

describe('reconcileAllocation', () => {
  it('derives what was consumed from what came back', () => {
    const v = reconcileAllocation(alloc({ issuedAt: days(-9) }), 120);
    expect(v).toEqual({ kind: 'ok', consumed: 280, returned: 120 });
  });

  it('accepts zero, which for swag is the ordinary result', () => {
    expect(reconcileAllocation(alloc({ issuedAt: days(-9) }), 0).kind).toBe('ok');
  });

  /** The one arithmetic mistake that silently creates inventory. */
  it('refuses to count more in than went out', () => {
    const v = reconcileAllocation(alloc({ issuedAt: days(-9) }), 401);
    expect(v.kind).toBe('refused');
    expect(v.kind === 'refused' && v.why).toMatch(/invents stock/);
  });

  it('refuses to count back stock that never left', () => {
    expect(reconcileAllocation(alloc(), 10).kind).toBe('refused');
  });
});

/* --------------------------------- alerts ---------------------------------- */

describe('planReservationAlert', () => {
  it('says nothing about an ordinary planned reservation', () => {
    expect(
      planReservationAlert(
        alertable({ reservation: res({ reservedFrom: days(20), reservedTo: days(30) }) }),
        NOW,
      ),
    ).toBeNull();
  });

  it('says nothing about an asset that is simply out', () => {
    expect(
      planReservationAlert(
        alertable({ reservation: res({ checkedOutAt: days(-5), reservedTo: days(5) }) }),
        NOW,
      ),
    ).toBeNull();
  });

  it('chases an overdue asset and addresses it to whoever took it', () => {
    const a = planReservationAlert(
      alertable({ reservation: res({ checkedOutAt: days(-20), reservedTo: days(-6) }) }),
      NOW,
    );
    expect(a?.reason).toBe('never_returned');
    expect(a?.userId).toBe('u-marcus');
    expect(a?.severity).toBe('critical');
  });

  /** §5a's tense rule: past a point, "return it" is the wrong sentence. */
  it('switches from chasing to claiming once it is unaccounted for', () => {
    const a = planReservationAlert(
      alertable({ reservation: res({ checkedOutAt: days(-60), reservedTo: days(-45) }) }),
      NOW,
    );
    expect(a?.reason).toBe('missing');
    expect(a?.body).toMatch(/insurance/);
    expect(a?.body).not.toMatch(/Checking it in takes a sentence/);
  });

  /** §5a's third correction, fifth direction. */
  it('escalates an unheld asset instead of going quiet', () => {
    const a = planReservationAlert(
      alertable({
        holderId: null,
        holderName: null,
        reservation: res({ checkedOutAt: days(-20), reservedTo: days(-6) }),
      }),
      NOW,
    );
    expect(a?.userId).toBeNull();
    expect(a?.body).toMatch(/^Nobody signed this out/);
  });

  it('reports a reservation whose window closed with nothing taken', () => {
    const a = planReservationAlert(
      alertable({ reservation: res({ reservedFrom: days(-20), reservedTo: days(-5) }) }),
      NOW,
    );
    expect(a?.reason).toBe('never_collected');
    expect(a?.userId).toBeNull();
  });

  it('reports damage once, on the return, rather than nightly afterwards', () => {
    const a = planReservationAlert(
      alertable({
        reservation: res({
          checkedOutAt: days(-20),
          returnedAt: days(-2),
          reservedTo: days(-3),
          conditionOnCheckout: 'good',
          conditionOnReturn: 'damaged',
        }),
      }),
      NOW,
    );
    expect(a?.reason).toBe('returned_damaged');
    expect(a?.dedupeKey).toMatch(/worsened:damaged$/);
  });

  it('says nothing when a return recorded no condition at either end', () => {
    expect(
      planReservationAlert(
        alertable({
          reservation: res({ checkedOutAt: days(-20), returnedAt: days(-2), reservedTo: days(-3) }),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  /** A future claim invalidated by a past fact, which nothing else joins up. */
  it('warns that an unserviceable asset is promised to a show', () => {
    const a = planReservationAlert(
      alertable({
        asset: booth({ condition: 'needs_repair' }),
        reservation: res({ reservedFrom: days(20), reservedTo: days(30) }),
      }),
      NOW,
    );
    expect(a?.reason).toBe('unserviceable_reservation');
    expect(a?.dedupeKey).toMatch(/unserviceable:needs_repair$/);
  });

  it('does not re-raise condition on a reservation that is already over', () => {
    expect(
      planReservationAlert(
        alertable({
          asset: booth({ condition: 'needs_repair' }),
          reservation: res({
            checkedOutAt: days(-20),
            returnedAt: days(-2),
            reservedTo: days(-3),
          }),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('reports a window shorter than the freight, while there is still time', () => {
    const a = planReservationAlert(
      alertable({
        reservation: res({ reservedFrom: days(20), reservedTo: days(30) }),
        freight: { outboundBy: days(15), homeBy: days(35) },
      }),
      NOW,
    );
    expect(a?.reason).toBe('window_short_of_freight');
    expect(a?.body).toMatch(/5 days before the reservation opens/);
  });

  /** §5a's key rule: move the window and every claim about it is void. */
  it('keys a reservation alert to the reservation and its window', () => {
    const one = planReservationAlert(
      alertable({ reservation: res({ checkedOutAt: days(-20), reservedTo: days(-6) }) }),
      NOW,
    );
    const moved = planReservationAlert(
      alertable({ reservation: res({ checkedOutAt: days(-20), reservedTo: days(-5) }) }),
      NOW,
    );
    expect(one?.dedupeKey).not.toBe(moved?.dedupeKey);
  });
});

describe('planClashAlert', () => {
  it('keys to both reservations regardless of which came first', () => {
    const rows = [
      { asset: booth(), reservation: res({ id: 'rA', showId: 'sA', reservedFrom: days(0), reservedTo: days(10) }), showName: 'A' },
      { asset: booth(), reservation: res({ id: 'rB', showId: 'sB', reservedFrom: days(5), reservedTo: days(15) }), showName: 'B' },
    ];
    const forward = planClashAlert(findAssetClashes(rows)[0]);
    const backward = planClashAlert(findAssetClashes([rows[1], rows[0]])[0]);
    expect(forward.dedupeKey).toBe(backward.dedupeKey);
    expect(forward.severity).toBe('critical');
  });

  it('files a turnaround as information rather than an emergency', () => {
    const clash = findAssetClashes([
      { asset: booth(), reservation: res({ id: 'rA', showId: 'sA', reservedFrom: days(0), reservedTo: days(10) }), showName: 'A' },
      { asset: booth(), reservation: res({ id: 'rB', showId: 'sB', reservedFrom: days(11), reservedTo: days(20) }), showName: 'B' },
    ])[0];
    expect(planClashAlert(clash).severity).toBe('info');
  });
});

describe('planStockAlert', () => {
  it('says nothing when there is room', () => {
    expect(planStockAlert({ item: item(), standing: stockStanding(item(), []) })).toBeNull();
  });

  /** §5b's key shape: a quantity moves hourly, so the key carries a bucket. */
  it('keys low stock to a bucket rather than to the number', () => {
    const a = planStockAlert({ item: item(), standing: stockStanding(item(), [alloc()]) });
    const b = planStockAlert({
      item: item({ quantityOnHand: 641 }),
      standing: stockStanding(item({ quantityOnHand: 641 }), [alloc()]),
    });
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).not.toMatch(/\d{3}/);
  });

  it('separates oversubscribed from merely low', () => {
    const it2 = item({ quantityOnHand: 180 });
    const a = planStockAlert({
      item: it2,
      standing: stockStanding(it2, [alloc({ quantityAllocated: 220 })]),
    });
    expect(a?.reason).toBe('oversubscribed_stock');
    expect(a?.severity).toBe('critical');
    expect(a?.dedupeKey).toMatch(/:short$/);
  });
});

describe('planUnreconciledAlert', () => {
  const base = {
    itemId: 'i1',
    itemName: 'Branded water bottle',
    allocationId: 'al1',
    showId: 's1',
    showName: 'Automate 2025',
    quantityAllocated: 60,
  };

  it('waits until the show has been over a while', () => {
    expect(planUnreconciledAlert({ ...base, moveOutAt: days(-3) }, NOW)).toBeNull();
    expect(planUnreconciledAlert({ ...base, moveOutAt: days(-45) }, NOW)?.reason).toBe(
      'unreconciled_allocation',
    );
  });

  it('says nothing about a show with no move-out recorded', () => {
    expect(planUnreconciledAlert({ ...base, moveOutAt: null }, NOW)).toBeNull();
  });

  /** The app must not guess, and the alert says which two guesses it is refusing. */
  it('refuses both readings of a blank count out loud', () => {
    const a = planUnreconciledAlert({ ...base, moveOutAt: days(-45) }, NOW);
    expect(a?.body).toMatch(/writes off stock we still own/);
    expect(a?.body).toMatch(/ships the next show short/);
  });
});

/* ---------------------------------- board ---------------------------------- */

describe('the board', () => {
  const row = (over: Parameters<typeof buildAssetRow>[0]) => buildAssetRow(over, NOW);
  const item0 = {
    asset: booth(),
    costCenterCode: 'MKT',
    showId: 'show1',
    showName: 'Automate 2026',
    showTimezone: 'America/Detroit',
    moveInAt: days(2),
    holderId: null,
    holderName: null,
  };

  /**
   * Soonest obligation first, and the clock finds the emergency on its own.
   *
   * This reverses the assertion it replaces, and the reversal is instructive
   * rather than a loss. `gone` is still top — not because a rank put it there
   * but because a booth that was due back 45 days ago has the earliest
   * outstanding date on the board. `broken` moves *down*, and that is the real
   * trade: an unserviceable asset promised to a show three weeks out is a
   * genuine finding and it is not this week's work, so it is carried by the
   * alert and the row's tone rather than by displacing Thursday's crate.
   */
  it('puts the nearest obligation first, and an overdue one is nearest by definition', () => {
    const rows = [
      row({ ...item0, reservation: res({ id: 'planned', reservedFrom: days(1), reservedTo: days(9) }) }),
      row({
        ...item0,
        reservation: res({ id: 'gone', checkedOutAt: days(-60), reservedTo: days(-45) }),
      }),
      row({
        ...item0,
        asset: booth({ condition: 'damaged' }),
        reservation: res({ id: 'broken', reservedFrom: days(20), reservedTo: days(30) }),
      }),
    ];
    const order = orderAssets(rows).map((r) => r.reservation?.id);
    expect(order).toEqual(['gone', 'planned', 'broken']);
  });

  /**
   * The two-clock rule, which is what this board has and the others do not. A
   * booth already at a show is judged on when it comes *back*; one still in the
   * warehouse on when it has to leave. Sorting everything on the return date
   * buries the crate that has to be on a truck tomorrow under crates coming home
   * in November.
   */
  it('reads the date that is still ahead of the row, not one fixed column', () => {
    const out = row({
      ...item0,
      reservation: res({ id: 'out', checkedOutAt: days(-2), reservedFrom: days(-3), reservedTo: days(40) }),
    });
    const leavingTomorrow = row({
      ...item0,
      reservation: res({ id: 'leaving', reservedFrom: days(1), reservedTo: days(8) }),
    });
    expect(nextDueAt(out)).toEqual(days(40));
    expect(nextDueAt(leavingTomorrow)).toEqual(days(1));
    expect(orderAssets([out, leavingTomorrow]).map((r) => r.reservation?.id)).toEqual([
      'leaving',
      'out',
    ]);
  });

  /**
   * An asset with nothing booked is asked nothing, so it has no date and goes
   * last. Treating "nothing is asked" as "asked first" puts the whole idle
   * warehouse above this week's work — `Number(null)` in a comparator, the same
   * call the shipping board makes about a crate with no deadline.
   */
  it('sorts an asset with nothing booked last rather than first', () => {
    const idle = row({ ...item0, reservation: null, showId: null, showName: null, moveInAt: null });
    const booked = row({ ...item0, reservation: res({ id: 'booked', reservedFrom: days(30) }) });
    expect(nextDueAt(idle)).toBeNull();
    expect(orderAssets([idle, booked]).map((r) => r.reservation?.id)).toEqual([
      'booked',
      undefined,
    ]);
  });

  it('counts capital outside the building apart from capital nobody can find', () => {
    const rows = [
      row({ ...item0, reservation: res({ id: 'out', checkedOutAt: days(-2), reservedTo: days(5) }) }),
      row({
        ...item0,
        asset: booth({ id: 'a2', purchaseValueCents: 100_000 }),
        reservation: res({ id: 'gone', assetId: 'a2', checkedOutAt: days(-60), reservedTo: days(-45) }),
      }),
    ];
    const s = summarizeAssets(rows);
    expect(s.out).toBe(1);
    expect(s.atLargeCents).toBe(8_400_000);
    expect(s.missing).toBe(1);
    expect(s.missingCents).toBe(100_000);
    expect(s.assets).toBe(2);
  });

  it('gives an unreserved asset a row and no custody', () => {
    const r = row({
      ...item0,
      reservation: null,
      showId: null,
      showName: null,
      showTimezone: null,
      moveInAt: null,
    });
    expect(r.custody).toBeNull();
    expect(r.alert).toBeNull();
    expect(r.serviceability.kind).toBe('serviceable');
  });

  it('offers assets with a reason attached to every refusal', () => {
    const window = { from: days(20), to: days(30) };
    const options = offerAssets(
      [booth({ id: 'free' }), booth({ id: 'broken', condition: 'damaged' }), booth({ id: 'taken' })],
      new Map([['taken', [res({ assetId: 'taken', reservedFrom: days(22), reservedTo: days(40) })]]]),
      window,
    );
    expect(options[0].availability.kind).toBe('available');
    expect(options.map((o) => o.availability.kind)).toContain('committed');
    expect(options.map((o) => o.availability.kind)).toContain('unserviceable');
  });
});

/* ---------------------------------- edit ----------------------------------- */

describe('validation', () => {
  it('parses money as cents and never as a float', () => {
    expect(validateAsset({ name: 'Booth', kind: 'booth', condition: 'good', purchaseValue: '8400.10' })
      .purchaseValueCents).toBe(840_010);
    expect(() =>
      validateAsset({ name: 'Booth', kind: 'booth', condition: 'good', purchaseValue: '84oo' }),
    ).toThrow(AssetError);
  });

  it('refuses a reservation that comes back before it leaves', () => {
    expect(() =>
      validateReservation({
        assetId: 'a1',
        reservedFromDate: '2026-03-10',
        reservedToDate: '2026-03-09',
      }),
    ).toThrow(AssetError);
  });

  /** A check-in without a condition produces a log that cannot answer the question. */
  it('requires a condition on return', () => {
    expect(() => validateCheckIn({ conditionOnReturn: '', conditionOnCheckout: 'good' })).toThrow(
      AssetError,
    );
  });

  /** The written-reason rule, from a third direction. */
  it('requires a note when it comes back worse than it went', () => {
    expect(() =>
      validateCheckIn({ conditionOnReturn: 'damaged', conditionOnCheckout: 'good' }),
    ).toThrow(/Write down what happened/);
    expect(
      validateCheckIn({
        conditionOnReturn: 'damaged',
        conditionOnCheckout: 'good',
        note: 'Forklift.',
      }).note,
    ).toBe('Forklift.');
    // Coming back *better* is a repair, and needs no explanation.
    expect(
      validateCheckIn({ conditionOnReturn: 'good', conditionOnCheckout: 'damaged' }).note,
    ).toBeNull();
  });

  it('requires a reason on every ledger movement', () => {
    expect(() => validateMovement({ kind: 'received', quantity: '10' })).toThrow(/reason/);
    expect(validateMovement({ kind: 'received', quantity: '10', reason: 'Restock' }).quantity).toBe(10);
    // A count of zero is a real answer; a movement of zero is not a movement.
    expect(() => validateMovement({ kind: 'issued', quantity: '0', reason: 'x' })).toThrow(AssetError);
    expect(validateMovement({ kind: 'counted', quantity: '0', reason: 'Shelf empty' }).quantity).toBe(0);
  });

  it('reads a threshold as a whole number of items', () => {
    expect(validateCollateral({ name: 'Datasheet', lowStockThreshold: '250' }).lowStockThreshold).toBe(250);
    expect(() => validateCollateral({ name: 'Datasheet', lowStockThreshold: '25.5' })).toThrow(AssetError);
  });

  /** §5e's rule about un-staffing somebody, applied to a thing. */
  it('names what releasing a reservation does not cancel', () => {
    expect(describeReservationRelease({ assetName: 'Booth', checkedOut: false, shipmentCount: 0 })).toBeNull();
    const warning = describeReservationRelease({
      assetName: 'Booth',
      checkedOut: true,
      shipmentCount: 2,
    });
    expect(warning).toMatch(/signed out/);
    expect(warning).toMatch(/2 shipments/);
  });
});

/* ---------------------------------- access --------------------------------- */

describe('access', () => {
  /** §5g's rule, one layer up: the person who finds the crate is whoever is there. */
  it('lets anybody sign an asset out, check it in and count a shelf', () => {
    expect(canHandleAssets()).toBe(true);
    expect(canCountStock()).toBe(true);
  });

  it('keeps changing what is promised behind approval', () => {
    expect(canManageAssets(actor('member'))).toBe(false);
    expect(canReserveAssets(actor('member'))).toBe(false);
    expect(canReserveAssets(actor('travel_manager'))).toBe(true);
    expect(canManageAssets(actor('admin'))).toBe(true);
  });
});
