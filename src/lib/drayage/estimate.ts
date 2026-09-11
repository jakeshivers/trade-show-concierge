/**
 * Drayage — material handling — as a pure model.
 *
 * ## What this is a model of
 *
 * The carrier's freight charge gets a crate to a dock. **Drayage is everything
 * after that**: the general contractor takes it off the truck, moves it to the
 * booth, takes the empty away, stores it, brings it back at tear-down, and
 * carries it out. It is billed by the general contractor rather than the carrier,
 * on a rate card published in that show's exhibitor service manual, and on a
 * medium-sized booth it routinely costs more than the freight did.
 *
 * It is also the single largest **silent line** in `cost/rollup.ts`. A show can
 * carry six crates, every one with a carrier cost on the row, and still be
 * missing the biggest number in its shipping figure — and §8a's rule is that a
 * silent line is not a zero. This file is what turns that silence into either a
 * figure or a sentence saying why there is not one.
 *
 * ## How the charge actually works
 *
 * Weight, in **hundredweight** (CWT), **per shipment**:
 *
 *   billable pounds = max(actual, the card's minimum), rounded UP to the next 100
 *   charge          = (billable / 100) × the rate for that consignment
 *
 * with a surcharge for freight that is not crated, and another for freight
 * received outside straight time. Advance warehouse and show-site have different
 * rates, and most cards charge **round trip** on the way in — the crate going
 * home is already paid for.
 *
 * ## The six refusals
 *
 * 1. **No rate card, no number.** The rate is per show, per contractor, and lives
 *    in a PDF. Without it the answer is a sentence, never zero — a $0 drayage
 *    line on a show with six crates reads as "drayage was free", which is §5a's
 *    fabricated bill with the sign flipped.
 * 2. **Rounding is per shipment and never in aggregate**, and this is the one a
 *    reasonable implementation gets wrong silently and forever. Two 150 lb crates
 *    are two shipments: each takes the 200 lb minimum, so 400 lb is billable.
 *    Summing first gives 300 lb and bills three hundredweight — **25% light**, on
 *    a figure nobody has an invoice to check it against yet. It errs in the
 *    flattering direction, which §5j already named as the direction nobody
 *    audits.
 * 3. **A crate with no weight is not a weightless crate.** `weight_lb` is
 *    nullable and real freight records are full of nulls. Reading one as zero
 *    removes it from the estimate while the estimate still reads complete. It is
 *    counted, named, and it makes the figure a floor.
 * 4. **A round-trip card is one charge, not two.** Our `direction` column has an
 *    outbound crate and a return crate, and both are real rows. Estimating over
 *    both against a round-trip card doubles the largest line in the show. Which
 *    way a card works is **typed from the manual and never defaulted**, because
 *    guessing wrong is a 100% error either way.
 * 5. **Uncrated is a surcharge and `unknown` is not `crated`.** Loose,
 *    pad-wrapped or shrink-wrapped freight is surcharged 25–35%, and nothing in
 *    this app has ever recorded which a crate is. So `shipments.handling` has a
 *    real `unknown` value with no default — §5j's rule that a lawful basis is
 *    never manufactured out of an absent column, reaching freight — the surcharge
 *    is not applied to it, and the unknowns are named as a reason the figure is
 *    a floor.
 * 6. **An estimate is not an invoice, and it never joins the total.** It sits
 *    beside it the way `consumedCents` and `creditFundedCents` do, for a sharper
 *    version of their reason: those are real money in the wrong period, this is
 *    money nobody has been billed. Once the real bill arrives as an expense the
 *    estimate stays, next to it, which is where this feature earns its place —
 *    "estimated $2,400, billed $3,900" is a question worth asking, and the answer
 *    is usually refusal 5.
 */

/** A figure, or the sentence saying why there is not one. `roi/rollup.ts`'s. */
export type Quotable = { ok: true; cents: number } | { ok: false; reason: string };

/** Charged once on the way in, or separately each way. Typed, never guessed. */
export type DrayageBasis = 'round_trip' | 'each_way';

export type RateCard = {
  /** Per hundredweight, freight consigned to the advance warehouse. */
  advanceCwtCents: number | null;
  /** Per hundredweight, freight consigned direct to show site. */
  showSiteCwtCents: number | null;
  /** Pounds. Almost always 200; typed from the manual all the same. */
  minimumLb: number;
  basis: DrayageBasis;
  /** Percent added for freight that is not crated. Null when the card is silent. */
  specialHandlingPct: number | null;
  /** Percent added for receiving outside straight time. Null when unstated. */
  overtimePct: number | null;
  /** Null until somebody has checked this against *this year's* manual. */
  confirmedAt: Date | null;
};

export type HandlingKind = 'crated' | 'uncrated' | 'unknown';

export type EstimableShipment = {
  id: string;
  description: string;
  direction: 'outbound' | 'return';
  consignment: 'advance_warehouse' | 'show_site' | 'office';
  weightLb: number | null;
  handling: HandlingKind;
};

export type ShipmentEstimate = {
  shipmentId: string;
  description: string;
  /** What the card is charged against, after the minimum and the rounding. */
  billableLb: number;
  hundredweight: number;
  baseCents: number;
  specialHandlingCents: number;
  cents: number;
};

export type EstimateGap = {
  kind: 'unweighed' | 'unknown_handling' | 'no_rate' | 'unpriced_surcharge';
  what: string;
  count: number;
};

export type DrayageEstimate = {
  /** The figure, or why there is not one. Never a zero standing in for either. */
  total: Quotable;
  perShipment: ShipmentEstimate[];
  /** Rows the card cannot be applied to. Every shipment is in exactly one place. */
  gaps: EstimateGap[];
  /** Return legs a round-trip card already paid for. Counted, never charged. */
  coveredByRoundTrip: number;
  /**
   * Every freight row this looked at, priced or not.
   *
   * Carried because deriving a crate count from `perShipment` makes a show with
   * six crates and no rate card report **zero crates** — which reads as a show
   * with no freight, and those two must never look the same. It is
   * `leads/parse.ts`'s accounting rule reaching a different table:
   * `perShipment + coveredByRoundTrip + unweighed + unpriceable === considered`,
   * always.
   */
  considered: number;
  /**
   * Whether the card behind this figure has been checked against *this year's*
   * manual. Carried on the estimate rather than left for each caller to look up,
   * so a screen and the rollup cannot describe the same figure differently.
   */
  confirmed: boolean;
  /**
   * True when anything at all was left out. The caller must not print this
   * figure without the word — `cost/rollup.ts`'s "at least", one table over.
   */
  isFloor: boolean;
};

/** A hundredweight is 100 lb, and the billing always rounds up to a whole one. */
export const LB_PER_CWT = 100;

/**
 * Billable pounds for **one** shipment: the card's minimum first, then rounded
 * up to a whole hundredweight. Exported because refusal 2 is the thing most
 * worth having a test point directly at.
 */
export function billableWeight(weightLb: number, minimumLb: number): number {
  const atLeastMinimum = Math.max(weightLb, minimumLb);
  return Math.ceil(atLeastMinimum / LB_PER_CWT) * LB_PER_CWT;
}

/** Percent of a cents figure, rounded to the cent. Never floats into a total. */
function pctOf(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

function rateFor(card: RateCard, consignment: EstimableShipment['consignment']): number | null {
  // An `office` consignment is a crate coming home to us. It has no show floor
  // and therefore no drayage of its own; if the card charges each way, the
  // outbound leg's own row is what carries the charge.
  if (consignment === 'show_site') return card.showSiteCwtCents;
  if (consignment === 'advance_warehouse') return card.advanceCwtCents;
  return null;
}

export function estimateDrayage(
  card: RateCard | null,
  shipments: EstimableShipment[],
): DrayageEstimate {
  const gaps: EstimateGap[] = [];

  if (!card) {
    return {
      total: {
        ok: false,
        reason:
          shipments.length === 0
            ? 'No freight is recorded for this show, so there is nothing to handle.'
            : `${shipments.length} crate${shipments.length === 1 ? '' : 's'} and no rate card. ` +
              'Drayage is priced per show by the general contractor and the rates are in the ' +
              'exhibitor service manual — enter them and this becomes a figure. It is not zero.',
      },
      perShipment: [],
      gaps: shipments.length
        ? [{ kind: 'no_rate', what: 'No drayage rate card for this show', count: 1 }]
        : [],
      coveredByRoundTrip: 0,
      considered: shipments.length,
      confirmed: false,
      isFloor: shipments.length > 0,
    };
  }

  const perShipment: ShipmentEstimate[] = [];
  let coveredByRoundTrip = 0;
  let unweighed = 0;
  let unknownHandling = 0;
  let noRateForConsignment = 0;
  let uncratedButUnpriced = 0;

  for (const sh of shipments) {
    // Refusal 4. A round-trip card was paid on the way in; the crate coming home
    // is the same money. Counted so the screen can say so, never charged.
    if (card.basis === 'round_trip' && sh.direction === 'return') {
      coveredByRoundTrip += 1;
      continue;
    }

    // Refusal 3. Null is not zero, and a zero here would vanish silently.
    if (sh.weightLb === null) {
      unweighed += 1;
      continue;
    }

    const rate = rateFor(card, sh.consignment);
    if (rate === null) {
      noRateForConsignment += 1;
      continue;
    }

    // Refusal 2. Per shipment, every time. Never sum then round.
    const billableLb = billableWeight(sh.weightLb, card.minimumLb);
    const hundredweight = billableLb / LB_PER_CWT;
    const baseCents = hundredweight * rate;

    // Refusal 5. `unknown` never earns the surcharge, and never escapes notice.
    let specialHandlingCents = 0;
    if (sh.handling === 'uncrated') {
      if (card.specialHandlingPct === null) uncratedButUnpriced += 1;
      else specialHandlingCents = pctOf(baseCents, card.specialHandlingPct);
    } else if (sh.handling === 'unknown') {
      unknownHandling += 1;
    }

    perShipment.push({
      shipmentId: sh.id,
      description: sh.description,
      billableLb,
      hundredweight,
      baseCents,
      specialHandlingCents,
      cents: baseCents + specialHandlingCents,
    });
  }

  if (unweighed > 0) {
    gaps.push({
      kind: 'unweighed',
      what:
        `${unweighed} crate${unweighed === 1 ? '' : 's'} with no weight recorded — not ` +
        'weightless, just unmeasured, and drayage is billed on weight alone',
      count: unweighed,
    });
  }
  if (noRateForConsignment > 0) {
    gaps.push({
      kind: 'no_rate',
      what:
        `${noRateForConsignment} crate${noRateForConsignment === 1 ? '' : 's'} consigned ` +
        'somewhere this card does not price',
      count: noRateForConsignment,
    });
  }
  if (unknownHandling > 0) {
    gaps.push({
      kind: 'unknown_handling',
      what:
        `${unknownHandling} crate${unknownHandling === 1 ? '' : 's'} whose packing nobody has ` +
        'recorded — loose or pad-wrapped freight is surcharged and this figure assumes none of ' +
        'it is',
      count: unknownHandling,
    });
  }
  if (uncratedButUnpriced > 0) {
    gaps.push({
      kind: 'unpriced_surcharge',
      what:
        `${uncratedButUnpriced} uncrated crate${uncratedButUnpriced === 1 ? '' : 's'}, and the ` +
        'card does not state a special handling rate — the surcharge is real and is not here',
      count: uncratedButUnpriced,
    });
  }

  const cents = perShipment.reduce((sum, e) => sum + e.cents, 0);
  const isFloor = gaps.length > 0;

  return {
    total:
      perShipment.length === 0
        ? {
            ok: false,
            reason:
              shipments.length === 0
                ? 'No freight is recorded for this show, so there is nothing to handle.'
                : 'There is a rate card and no crate it can be applied to. See the gaps below; ' +
                  'this is not a show with no drayage.',
          }
        : { ok: true, cents },
    perShipment,
    gaps,
    coveredByRoundTrip,
    considered: shipments.length,
    confirmed: rateCardIsConfirmed(card),
    isFloor,
  };
}

/**
 * Is this figure allowed to be quoted as an established amount?
 *
 * The §5a rule, inherited rather than re-invented: a rate card nobody has checked
 * against *this year's* manual is a guess, and last year's card is the likeliest
 * thing to be sitting there — contractors re-price annually and the manual is
 * where they say so. An unconfirmed card still produces a figure, because
 * silence on the largest line in the show is the worse failure, but the figure is
 * introduced as an estimate from an unchecked card rather than as a number.
 */
export function rateCardIsConfirmed(card: RateCard | null): boolean {
  return card?.confirmedAt !== null && card?.confirmedAt !== undefined;
}
