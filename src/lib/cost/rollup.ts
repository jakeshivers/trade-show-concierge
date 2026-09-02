/**
 * True cost — §8a, and the reason §1 says job 3 is nearly free.
 *
 * Everything here is pure. The claim the whole ROI story rests on is that a
 * show's cost is a *query* rather than a week of spreadsheet archaeology,
 * because this app booked the flights and tracked the crates. That is true, and
 * it is exactly why the interesting work is not the addition.
 *
 * **A total that does not say what it is missing is a fabricated bill.** §5a
 * refuses to quote a penalty behind a date nobody confirmed, for a stated
 * reason: one wrong figure under the app's own byline teaches a team to distrust
 * every figure after it. A cost rollup is the same object at a larger scale. If
 * three of eight travellers drove and nobody recorded it, the honest output is
 * "$41,300 across everything recorded, and here is what is not recorded" — not
 * "$41,300", which is a smaller number wearing the authority of a computed one.
 * So every line carries its coverage, the total is a **floor** whenever coverage
 * is incomplete, and `isFloor` is not decoration a screen may drop.
 *
 * Six things this file refuses to do, each a way the number would be wrong:
 *
 * 1. **A dry run is not spend.** `bookings.live` is the provider's word (§6c) and
 *    exists precisely to protect this rollup — a Duffel *test* key issues orders
 *    that look real in every respect. The seeded workspace is made entirely of
 *    dry runs, so a rollup that summed charged amounts without reading `live`
 *    would have looked plausible and been fiction from its first day.
 * 2. **A credit is not a discount, and a credit-funded trip is not a free one.**
 *    `chargedCents` is new money; the credit covered the rest and was paid for
 *    last year, on a ticket for a trip somebody cancelled. Counting the fare here
 *    would charge the same dollars to two shows. Counting only the cash and
 *    saying nothing would make a show that flew entirely on credit look free.
 *    So cash is the line and the credit is a **memo beside it**.
 * 3. **Stock consumed is not stock bought, and only one of them is money.** A
 *    print run is an outlay, on the show that ordered it. What a later show
 *    takes off the shelf is a *valuation* of things already paid for — real, and
 *    worth knowing, and not a second payment. Adding both would charge the
 *    datasheets to two shows the way counting a credit as a discount charges the
 *    fare to two. So consumption is a memo beside the total, never inside it,
 *    and the overlap is named rather than silently resolved.
 * 4. **A lodging row is one reservation.** `lodging/store.ts` already refuses to
 *    invent a room count, so nights × rate is per reservation. A block recorded
 *    as one row with four guests is therefore an undercount — named, not fixed,
 *    because the fix is a room count somebody has to type.
 * 5. **Committed is not paid.** `expenses.paid` is the only tense marker in the
 *    money, and before a show most of the cost is a commitment. §5a's rule about
 *    "at risk" versus "incurred", one table over.
 * 6. **Staff time is days, not dollars.** §11.8 is an open decision and there is
 *    no loaded rate anywhere in this workspace. Attendee-days we know; a dollar
 *    figure would be a number we made up, which is the thing this file exists to
 *    not do. So it is reported in days, outside the total, and says why.
 */

import { distanceToNow } from '@/lib/shows/proximity';
import type { DrayageEstimate, Quotable } from '@/lib/drayage/estimate';

export type CostCategory =
  | 'space'
  | 'services'
  | 'travel'
  | 'lodging'
  | 'shipping'
  | 'collateral'
  | 'other';

export const CATEGORY_LABEL: Record<CostCategory, string> = {
  space: 'Booth & space',
  services: 'Booth services',
  travel: 'Travel',
  lodging: 'Lodging',
  shipping: 'Shipping',
  collateral: 'Collateral & print',
  other: 'Everything else',
};

/** The order §8a lists them in, which is the order a finance person reads. */
export const CATEGORY_ORDER: CostCategory[] = [
  'space',
  'services',
  'travel',
  'lodging',
  'shipping',
  'collateral',
  'other',
];

export type GapKind =
  /** A row that belongs in this line and carries no figure. */
  | 'unpriced'
  /** Something that should exist and does not — the expensive kind. */
  | 'absent'
  /** A figure we can compute only by assuming something. */
  | 'assumption'
  /** Two real figures that may be the same money. */
  | 'double_count';

export type CoverageGap = {
  category: CostCategory | null;
  kind: GapKind;
  /** Written for a person, in the tense the thing is actually in. */
  what: string;
  count: number;
};

export type CostLine = {
  category: CostCategory;
  cents: number;
  /** Of that, money that has actually left. */
  paidCents: number;
  /** Rows that produced the figure. */
  counted: number;
  gaps: CoverageGap[];
};

export type CoverageVerdict =
  /** Every row that exists carries a figure, and nothing structural is missing. */
  | 'complete'
  /** Enough of the shape is here to be worth reading, with named holes. */
  | 'partial'
  /** Most of a show's cost is not in these numbers. */
  | 'thin'
  /** Nothing has been recorded at all. */
  | 'empty';

export type Coverage = {
  verdict: CoverageVerdict;
  gaps: CoverageGap[];
  /** The §8a categories with no figure at all. */
  silent: CostCategory[];
};

/**
 * The drayage estimate, **beside the total and never inside it**.
 *
 * `creditFundedCents` and `consumedCents` are already outside `totalCents`
 * because they are real money in the wrong period. This is outside for a sharper
 * reason: it is money **nobody has been billed**, and the one thing this page
 * exists to refuse is a made-up number in the figure people quote. So it is
 * reported, labelled, and never added.
 *
 * `billedCents` is what makes it worth keeping after the invoice lands. See
 * `isDrayageCategory`.
 */
export type DrayageMemo = {
  /** A figure, or the sentence saying why there is not one. Never a zero. */
  estimate: Quotable;
  /** Something was left out — an unweighed crate, an unrecorded packing. */
  isFloor: boolean;
  /** Whether the card has been checked against *this year's* manual. */
  confirmed: boolean;
  /** The contractor's actual bill, if it has been filed. Inside the total. */
  billedCents: number | null;
};

export type ShowCost = {
  showId: string;
  showName: string;
  /**
   * Carried so the portfolio can order on the clock without loading the shows a
   * second time — and so the page and the rollup cannot end up with two
   * different ideas of when a show is.
   */
  startsOn: Date;
  endsOn: Date;
  lines: CostLine[];
  /** The sum. A floor, not a total, whenever coverage is not `complete`. */
  totalCents: number;
  paidCents: number;
  /** Recorded and not yet paid. Before a show this is most of it. */
  committedCents: number;
  /**
   * Fare covered by credits from earlier cancellations. Deliberately outside
   * `totalCents`: those dollars were spent on a different show's ticket, and
   * charging them here would bill them twice across the portfolio.
   */
  creditFundedCents: number;
  /**
   * Stock issued to this show, valued at unit cost. **Outside `totalCents`** —
   * see the header: it is a valuation of things bought earlier, and the money
   * for them is already an expense somewhere.
   */
  consumedCents: number;
  /** §11.8 is open, so this is a count of days and never a sum of money. */
  attendeeDays: number | null;
  /** Outside `totalCents`, deliberately. See `DrayageMemo`. */
  drayage: DrayageMemo;
  coverage: Coverage;
  isFloor: boolean;
};

/* -------------------------------- the inputs ------------------------------- */

export type CostInputs = {
  show: { id: string; name: string; startsOn: Date; endsOn: Date };
  expenses: { category: string; amountCents: number; paid: boolean }[];
  /** Every booking against this show, live and dry-run alike; the filter is here. */
  bookings: {
    chargedCents: number | null;
    creditAppliedCents: number | null;
    live: boolean;
    cancelledAt: Date | null;
  }[];
  /** Flights nobody bought through this app. Their price is somebody's typing. */
  enteredFlights: { priceCents: number | null }[];
  lodgings: { nightlyRateCents: number | null; nights: number | null; guests: number }[];
  shipments: { costCents: number | null; direction: string }[];
  /**
   * What `lib/drayage/estimate.ts` made of this show's freight, or null where
   * nothing asked it. Passed in rather than computed here so the portfolio and
   * the show's tab cannot produce two different figures — `store.ts`'s rule.
   */
  drayage: DrayageEstimate | null;
  /** What came off the shelf for this show, and what a unit costs. */
  collateral: { issued: number; unitCostCents: number | null }[];
  attendees: {
    confirmed: boolean;
    arrivesOn: Date | null;
    departsOn: Date | null;
    /** A booking, a flight, or a lodging row — anything saying how they got there. */
    hasTravel: boolean;
  }[];
};

/* ------------------------------- the buckets ------------------------------- */

/**
 * Expense categories are free text — they are typed by whoever files the
 * expense — so this maps rather than switches, and anything unrecognised lands
 * in `other` rather than being dropped. A cost line that silently discards rows
 * is worse than an untidy one.
 */
/**
 * Is this expense the general contractor's material-handling bill?
 *
 * Free text, like every other category here, so this matches rather than
 * switches. It exists for one reason: once the real bill is filed, the estimate
 * beside it stops being a prediction and becomes a **comparison**, and that is
 * the most useful thing this feature produces. "Estimated $2,400, billed $3,900"
 * is a question worth asking, and the answer is usually freight that went in
 * pad-wrapped.
 */
export function isDrayageCategory(category: string): boolean {
  const c = category.toLowerCase();
  return c.includes('drayage') || c.includes('material handling');
}

export function bucketExpense(category: string): CostCategory {
  const c = category.toLowerCase();
  if (c.includes('space') || c.includes('booth fee') || c.includes('sponsor')) return 'space';
  if (
    c.includes('service') ||
    c.includes('drayage') ||
    c.includes('electric') ||
    c.includes('rigging') ||
    c.includes('carpet') ||
    c.includes('labor') ||
    c.includes('av')
  ) {
    return 'services';
  }
  if (c.includes('collateral') || c.includes('print') || c.includes('swag')) return 'collateral';
  if (isDrayageCategory(c)) return 'shipping';
  if (c.includes('freight') || c.includes('ship')) return 'shipping';
  if (c.includes('hotel') || c.includes('lodging')) return 'lodging';
  if (c.includes('travel') || c.includes('flight') || c.includes('air')) return 'travel';
  return 'other';
}

/* -------------------------------- the rollup ------------------------------- */

function emptyLine(category: CostCategory): CostLine {
  return { category, cents: 0, paidCents: 0, counted: 0, gaps: [] };
}

export function rollUpShowCost(input: CostInputs, asOf: Date = new Date()): ShowCost {
  const lines = new Map<CostCategory, CostLine>(
    CATEGORY_ORDER.map((c) => [c, emptyLine(c)] as const),
  );
  const line = (c: CostCategory) => lines.get(c)!;

  /* expenses — the only rows that carry their own paid/unpaid tense */
  for (const e of input.expenses) {
    const l = line(bucketExpense(e.category));
    l.cents += e.amountCents;
    if (e.paid) l.paidCents += e.amountCents;
    l.counted += 1;
  }
  const expenseCollateralCents = line('collateral').cents;

  /* travel — cash, and only from bookings the provider called real */
  let creditFundedCents = 0;
  let dryRuns = 0;
  const travel = line('travel');
  for (const b of input.bookings) {
    if (b.cancelledAt) continue;
    if (!b.live) {
      dryRuns += 1;
      continue;
    }
    travel.cents += b.chargedCents ?? 0;
    // A ticket is paid at the moment it is issued; there is no unpaid ticket.
    travel.paidCents += b.chargedCents ?? 0;
    travel.counted += 1;
    creditFundedCents += b.creditAppliedCents ?? 0;
  }
  let unpricedFlights = 0;
  for (const f of input.enteredFlights) {
    if (f.priceCents === null) {
      unpricedFlights += 1;
      continue;
    }
    travel.cents += f.priceCents;
    travel.paidCents += f.priceCents;
    travel.counted += 1;
  }
  if (unpricedFlights > 0) {
    travel.gaps.push({
      category: 'travel',
      kind: 'unpriced',
      what: `${unpricedFlights} flight${unpricedFlights === 1 ? '' : 's'} recorded by hand with no fare on the row`,
      count: unpricedFlights,
    });
  }
  if (dryRuns > 0) {
    travel.gaps.push({
      category: 'travel',
      kind: 'absent',
      what:
        `${dryRuns} booking${dryRuns === 1 ? '' : 's'} for this show ${dryRuns === 1 ? 'is a' : 'are'} dry run` +
        `${dryRuns === 1 ? '' : 's'} and ${dryRuns === 1 ? 'is' : 'are'} not spend. The itinerary exists; the money never moved.`,
      count: dryRuns,
    });
  }
  const travelless = input.attendees.filter((a) => a.confirmed && !a.hasTravel).length;
  if (travelless > 0) {
    travel.gaps.push({
      category: 'travel',
      kind: 'absent',
      what:
        `${travelless} confirmed attendee${travelless === 1 ? '' : 's'} with no travel recorded. ` +
        'They may have driven — this is a hole in the number, not necessarily in the plan.',
      count: travelless,
    });
  }

  /* lodging — nights × rate, per reservation, because rooms are not modelled */
  const lodging = line('lodging');
  let unpricedStays = 0;
  let blockRows = 0;
  for (const l of input.lodgings) {
    if (l.guests > 1) blockRows += 1;
    if (l.nightlyRateCents === null || l.nights === null) {
      unpricedStays += 1;
      continue;
    }
    lodging.cents += l.nightlyRateCents * l.nights;
    lodging.counted += 1;
  }
  if (unpricedStays > 0) {
    lodging.gaps.push({
      category: 'lodging',
      kind: 'unpriced',
      what: `${unpricedStays} hotel row${unpricedStays === 1 ? '' : 's'} with no nightly rate or no dates`,
      count: unpricedStays,
    });
  }
  if (blockRows > 0) {
    lodging.gaps.push({
      category: 'lodging',
      kind: 'assumption',
      what:
        `${blockRows} hotel row${blockRows === 1 ? '' : 's'} covering more than one guest, counted once. ` +
        'A reservation is one row here and rooms are not modelled, so a room block is an undercount.',
      count: blockRows,
    });
  }

  /* shipping — and the leg that goes missing is also the cost that goes missing */
  const shipping = line('shipping');
  let unpricedCrates = 0;
  let outbound = 0;
  let inbound = 0;
  for (const sh of input.shipments) {
    if (sh.direction === 'outbound') outbound += 1;
    if (sh.direction === 'return') inbound += 1;
    if (sh.costCents === null) {
      unpricedCrates += 1;
      continue;
    }
    shipping.cents += sh.costCents;
    shipping.counted += 1;
  }
  if (unpricedCrates > 0) {
    shipping.gaps.push({
      category: 'shipping',
      kind: 'unpriced',
      what: `${unpricedCrates} shipment${unpricedCrates === 1 ? '' : 's'} with no freight cost on the row`,
      count: unpricedCrates,
    });
  }
  // The largest silent line there is, named on the line a reader is actually
  // looking at. A memo underneath the total is not where somebody reading the
  // shipping figure will find out that the contractor's charge — routinely more
  // than the freight itself — is not in it.
  if (input.shipments.length > 0 && input.drayage && !input.drayage.total.ok) {
    shipping.gaps.push({
      category: 'shipping',
      kind: 'absent',
      what:
        'Drayage is not in this figure — the general contractor’s charge for moving freight ' +
        'between the dock and the booth, which on most shows costs more than the freight did',
      count: 1,
    });
  }
  // Only once the show is over. Before that a missing return crate is not
  // missing — nobody books the leg home in February — and §5g's own alert waits
  // for move-out for the same reason. A gap that fires on every future show is
  // a gap nobody reads on the one show that has actually lost a booth.
  if (outbound > 0 && inbound === 0 && input.show.endsOn.getTime() < asOf.getTime()) {
    shipping.gaps.push({
      category: 'shipping',
      kind: 'absent',
      what:
        'Freight went out and nothing is recorded coming back, so the return leg is missing from ' +
        'this figure as well as from the board. §5g says most companies miss shipping entirely; ' +
        'this is how.',
      count: 1,
    });
  }

  /* collateral consumed — a memo, valued at unit cost, never added */
  const collateral = line('collateral');
  let unvalued = 0;
  let consumedCents = 0;
  for (const c of input.collateral) {
    if (c.issued <= 0) continue;
    if (c.unitCostCents === null) {
      unvalued += 1;
      continue;
    }
    consumedCents += c.issued * c.unitCostCents;
  }
  if (unvalued > 0) {
    collateral.gaps.push({
      category: 'collateral',
      kind: 'unpriced',
      what: `${unvalued} item${unvalued === 1 ? '' : 's'} issued to this show with no unit cost, so what it consumed cannot be valued`,
      count: unvalued,
    });
  }
  if (consumedCents > 0 && expenseCollateralCents > 0) {
    collateral.gaps.push({
      category: 'collateral',
      kind: 'double_count',
      what:
        'This show both ordered print and issued stock off the shelf. The order is in the total ' +
        'and the stock is not, because the second is a valuation of things already paid for — ' +
        'but if the print run *was* this stock, the two describe one purchase.',
      count: 2,
    });
  }

  /* staff time — days, never dollars */
  const attendeeDays = staffDays(input);

  const ordered = CATEGORY_ORDER.map((c) => line(c));
  const totalCents = ordered.reduce((n, l) => n + l.cents, 0);
  const paidCents = ordered.reduce((n, l) => n + l.paidCents, 0);
  const drayage = drayageMemo(input);
  const coverage = assessCoverage(ordered, input);

  return {
    showId: input.show.id,
    showName: input.show.name,
    startsOn: input.show.startsOn,
    endsOn: input.show.endsOn,
    lines: ordered,
    totalCents,
    paidCents,
    committedCents: totalCents - paidCents,
    creditFundedCents,
    consumedCents,
    attendeeDays,
    drayage,
    coverage,
    isFloor: coverage.verdict !== 'complete',
  };
}

/**
 * The drayage line, as a memo rather than a number in the total.
 *
 * Two things fall out of putting it here rather than in the shipping line. The
 * estimate never touches `totalCents`, which is the point. And when there is
 * freight and no quotable estimate, the *shipping* line gains a gap — because
 * the reader who needs to know that drayage is missing is looking at the
 * shipping figure, not at a memo underneath it. §8a's rule that a silent line is
 * not a zero, applied to the largest silent line there is.
 */
function drayageMemo(input: CostInputs): DrayageMemo {
  const billed = input.expenses.filter((e) => isDrayageCategory(e.category));
  const billedCents = billed.length
    ? billed.reduce((n, e) => n + e.amountCents, 0)
    : null;

  if (!input.drayage) {
    return {
      estimate: {
        ok: false,
        reason:
          'Drayage has not been estimated for this show. It is the general contractor’s ' +
          'charge for moving freight between the dock and the booth, and on most shows it is ' +
          'the largest cost nobody has a figure for.',
      },
      isFloor: false,
      confirmed: false,
      billedCents,
    };
  }

  return {
    estimate: input.drayage.total,
    isFloor: input.drayage.isFloor,
    confirmed: input.drayage.confirmed,
    billedCents,
  };
}

/**
 * Attendee-days, counted on the travel window where there is one and on the show
 * where there is not — the same fallback `team/conflicts.ts` makes, and the same
 * honesty about it: a person who was there for one day of a three-day show is
 * counted for three unless somebody recorded when they arrived.
 */
function staffDays(input: CostInputs): number | null {
  const going = input.attendees.filter((a) => a.confirmed);
  if (going.length === 0) return null;
  const showDays = Math.max(
    1,
    Math.round((input.show.endsOn.getTime() - input.show.startsOn.getTime()) / 86_400_000) + 1,
  );
  let days = 0;
  for (const a of going) {
    days +=
      a.arrivesOn && a.departsOn
        ? Math.max(1, Math.round((a.departsOn.getTime() - a.arrivesOn.getTime()) / 86_400_000) + 1)
        : showDays;
  }
  return days;
}

/**
 * What the number is worth.
 *
 * Not a percentage. A percentage of coverage would itself be a computed-looking
 * figure over an unknown denominator — we do not know what a show *should* have
 * cost, which is the entire problem — so this reports the shape instead: which
 * of §8a's categories are silent, and what specifically is missing from the ones
 * that are not.
 *
 * `space` is the one category whose silence is decisive. Every trade show has a
 * booth fee; it is usually the largest single line, and it is invoiced months
 * ahead. A rollup with no space cost is not a cheap show, it is a show nobody
 * has entered the invoice for.
 */
export function assessCoverage(lines: CostLine[], input: CostInputs): Coverage {
  const gaps = lines.flatMap((l) => l.gaps);
  const silent = lines
    .filter((l) => l.cents === 0 && l.counted === 0)
    // `other` is the catch-all, so its silence says nothing: a show with no
    // miscellaneous expenses is not a show missing a figure, and listing it
    // every time is how a reader learns to skip the list.
    .filter((l) => l.category !== 'other')
    .map((l) => l.category);
  const anything = lines.some((l) => l.cents > 0);

  // Categories with nothing to record are not silences. A show with no freight
  // is not missing a shipping figure, and flagging it would teach a reader to
  // ignore the flag on the show that *is* missing one.
  const expected = new Set<CostCategory>(['space', 'other']);
  if (input.attendees.some((a) => a.confirmed)) {
    expected.add('travel');
    expected.add('lodging');
  }
  if (input.shipments.length > 0) expected.add('shipping');
  const missing = silent.filter((c) => expected.has(c) && c !== 'other');

  if (!anything) return { verdict: 'empty', gaps, silent };
  if (gaps.length === 0 && missing.length === 0) return { verdict: 'complete', gaps, silent };
  if (missing.includes('space') || missing.length >= 2) return { verdict: 'thin', gaps, silent };
  return { verdict: 'partial', gaps, silent };
}

/* ------------------------------- the portfolio ----------------------------- */

export type PortfolioCost = {
  shows: ShowCost[];
  totalCents: number;
  paidCents: number;
  creditFundedCents: number;
  consumedCents: number;
  /** Shows whose figure is a floor. Counting them is the honesty indicator. */
  incomplete: number;
  /** Shows with nothing recorded at all — not cheap shows. */
  unrecorded: number;
};

export function summarizePortfolio(shows: ShowCost[], asOf: Date = new Date()): PortfolioCost {
  return {
    // Nearest show first, in either direction, with the biggest figure breaking
    // ties. Cost is the one page here that is neither purely prospective nor
    // purely retrospective — most of a show's spend is committed before it opens
    // and the invoices land after it closes — so neither of the two orders the
    // other boards use is right, and proximity is what "the show I am spending
    // on" actually means. Biggest-first was the old key and is still what
    // separates two shows the same distance away.
    shows: [...shows].sort(
      (a, b) =>
        distanceToNow(a, asOf) - distanceToNow(b, asOf) ||
        b.totalCents - a.totalCents,
    ),
    totalCents: shows.reduce((n, s) => n + s.totalCents, 0),
    paidCents: shows.reduce((n, s) => n + s.paidCents, 0),
    creditFundedCents: shows.reduce((n, s) => n + s.creditFundedCents, 0),
    consumedCents: shows.reduce((n, s) => n + s.consumedCents, 0),
    incomplete: shows.filter((s) => s.isFloor).length,
    unrecorded: shows.filter((s) => s.coverage.verdict === 'empty').length,
  };
}
