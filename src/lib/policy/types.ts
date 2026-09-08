/**
 * Travel policy types.
 *
 * Everything here is provider-agnostic: a Duffel offer, an Amadeus offer, and a
 * hand-entered flight all normalize into `Offer` before policy sees them. Policy
 * must never learn the shape of a vendor payload.
 *
 * See SCOPE.md §6a — this layer is deterministic. The LLM parses requests and
 * narrates outcomes; it never participates in the decision.
 */

export type Money = number; // always integer cents

export type Cabin = 'economy' | 'premium_economy' | 'business' | 'first';

/** Ordered cheapest-to-richest so ceilings can be compared numerically. */
export const CABIN_RANK: Record<Cabin, number> = {
  economy: 0,
  premium_economy: 1,
  business: 2,
  first: 3,
};

export type TripScope = 'domestic' | 'international';

/* --------------------------------- offers ---------------------------------- */

export type Segment = {
  /** Marketing carrier — whose flight number is on the ticket. */
  airlineCode: string;
  airlineName?: string;
  /**
   * Who actually flies it. US regulation requires this be shown prominently,
   * and it is frequently a different regional carrier.
   */
  operatingAirlineCode?: string;
  operatingAirlineName?: string;
  flightNumber: string;
  originAirport: string;
  originCountry: string;
  destinationAirport: string;
  destinationCountry: string;
  /**
   * The airports' IANA zones, when the provider carries them.
   *
   * Optional because policy never reads them — it compares instants, and a zone
   * would be a distraction in a rule. They ride along because the *provider* is
   * the only place they exist, and step 13 found that out the hard way: the
   * normalizer read `airport.time_zone` to build the instant and then dropped
   * it, so a flight board later had no way to say what time a departure is at
   * the airport the traveler is standing in.
   */
  originTimeZone?: string;
  destinationTimeZone?: string;
  departsAt: Date;
  arrivesAt: Date;
  cabin: Cabin;
};

export type Slice = {
  segments: Segment[];
};

export type Offer = {
  id: string;
  provider: string;
  /** Total price for the whole itinerary, all passengers. */
  totalCents: Money;
  currency: string;
  slices: Slice[];

  /**
   * Refundability is not a boolean at the source: carriers permit refunds *with
   * a penalty*. A "refundable" $500 fare carrying a $400 penalty is not
   * meaningfully refundable, so we keep the penalty and let policy judge.
   */
  refundable: boolean;
  refundPenaltyCents: Money | null;
  changeable: boolean;
  changePenaltyCents: Money | null;

  /** Offers expire in minutes; the engine must know when it is looking at a corpse. */
  expiresAt: Date | null;

  /**
   * When false, the offer can be *held* without payment — space reserved while an
   * approver decides. This is the mechanism that keeps an approval queue from
   * being defeated by offer expiry. See SCOPE.md §6b.
   */
  requiresInstantPayment: boolean;
  paymentRequiredBy: Date | null;
  /** When null, the space is held but the price may still move before payment. */
  priceGuaranteeExpiresAt: Date | null;

  /** Provider-side credits applicable to this offer. Feeds credit-first, SCOPE.md §5b. */
  availableCreditIds: string[];

  /** Negotiated corporate fare codes, when the offer came from one. */
  corporateFareCodes: string[];
};

/* ------------------------------- constraints -------------------------------- */

export type TravelConstraints = {
  originAirport: string;
  destinationAirport: string;
  /** Traveler must not depart before this. */
  earliestDeparture: Date;
  /** Traveler must be on the ground by this. */
  latestArrival: Date;
  returnEarliestDeparture?: Date;
  returnLatestArrival?: Date;
  cabinPreference?: Cabin;
};

/* --------------------------------- policy ---------------------------------- */

export type ApprovalBands = {
  /** At or below this, book without asking anyone. */
  autoApproveUnderCents: Money;
  /** Above this, no approver can authorize it. */
  denyOverCents: Money;
};

export type TravelPolicy = {
  id: string;
  version: number;
  /** Where this rule set came from, for the audit trail. */
  scope: 'org' | 'cost_center' | 'show' | 'role';
  scopeRef?: string;

  maxAirfareDomesticCents: Money;
  maxAirfareInternationalCents: Money;
  bands: ApprovalBands;

  maxCabinDomestic: Cabin;
  maxCabinInternational: Cabin;
  /** Long-haul flights may exceed the cabin ceiling above this duration. */
  premiumCabinAllowedOverHours: number | null;

  minAdvanceBookingDays: number;
  maxStops: number;
  minConnectionMinutes: number;
  /** Must be on the ground this long before the show's move-in time. */
  arrivalBufferHoursBeforeMoveIn: number;

  nonRefundableAllowedUnderCents: Money | null;
  /**
   * A refund penalty above this makes a nominally refundable fare count as
   * non-refundable. Null accepts any penalty.
   */
  maxAcceptableRefundPenaltyCents: Money | null;
  preferredAirlines: string[];
  blockedAirlines: string[];
  /**
   * The ceiling on how much more the agent may pay to stay on a carrier the
   * **org** prefers — a negotiated agreement rather than somebody's convenience,
   * which is why its cap is higher than the personal one. Null is a tie-break
   * only. Read by `rank.ts`; `airlineRules` still reports the advisory, and
   * still cannot deny anything.
   */
  preferredCarrierAllowanceCents: Money | null;
  /**
   * The ceiling on how much more the agent may pay to honour a *traveler's* own
   * carrier preference. Null is a tie-break only, and is the app declining to
   * spend money nobody authorized rather than a guessed default. Read by
   * `rank.ts` and by no rule — see `EvaluationContext.travelerPreferredAirlines`.
   */
  personalCarrierAllowanceCents: Money | null;

  maxHotelNightlyRateCents: Money | null;
  perShowTravelBudgetCents: Money | null;

  /** An eligible unused credit must be applied before new spend. SCOPE.md §5b. */
  requireCreditFirst: boolean;
};

/* -------------------------------- evaluation -------------------------------- */

export type EvaluationContext = {
  offer: Offer;
  constraints: TravelConstraints;
  policy: TravelPolicy;
  /** Passed in, never read from the clock — the engine must be deterministic. */
  now: Date;
  /** The show's move-in time, when the trip is tied to a show. */
  moveInAt?: Date;
  /** Spend already committed against this show's travel budget. */
  showTravelSpentCents?: Money;
  /** Credits this traveler could apply to this offer. */
  applicableCreditCents?: Money;
  /**
   * The carriers this *traveler* prefers, from their own profile.
   *
   * On the context rather than on the policy because it is a fact about a person
   * and not a rule about an org, and because putting it on `TravelPolicy` would
   * put it within reach of `evaluate()` — where the first reasonable-looking
   * change is a rule that escalates an off-preference fare, and a personal
   * preference has become a constraint the agent cannot find fares under.
   * Nothing in `rules.ts` reads this. `rank.ts` is its only consumer.
   */
  travelerPreferredAirlines?: string[];
};

export type RuleStatus = 'pass' | 'fail' | 'not_applicable';

/**
 * What a failure costs you. `deny` cannot be approved by anyone; `approval`
 * escalates to a human; `advisory` **never changes the verdict**.
 *
 * That last word used to be "ignored", and it was true until the org's carrier
 * list started paying for itself in `rank.ts`. It is worth being exact now:
 * `evaluate()` ignores advisories entirely — they never appear in `blockers`,
 * never move a decision, and never stop a booking. What reads an advisory's
 * *subject* is the separate ranking stage, which chooses among offers the
 * verdict has already allowed. The two stages stay apart on purpose; a severity
 * that could quietly become a blocker is the thing this split exists to prevent.
 */
export type RuleSeverity = 'deny' | 'approval' | 'advisory';

export type RuleResult = {
  ruleId: string;
  label: string;
  status: RuleStatus;
  severity: RuleSeverity;
  message: string;
  /**
   * Signed distance from the limit in the rule's own unit — negative is slack,
   * positive is overage. This is what makes the approval screen readable:
   * "$40 over the domestic cap" rather than "failed".
   */
  margin?: number;
  marginUnit?: 'cents' | 'hours' | 'days' | 'stops' | 'minutes';
};

export type Decision = 'auto_approve' | 'needs_approval' | 'deny';

export type PolicyVerdict = {
  decision: Decision;
  offerId: string;
  policyId: string;
  policyVersion: number;
  evaluatedAt: Date;
  results: RuleResult[];
  /** Convenience views over `results`; the full list is always the source of truth. */
  failures: RuleResult[];
  blockers: RuleResult[];
  reasons: string[];
};
