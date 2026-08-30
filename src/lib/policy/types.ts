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
  airlineCode: string;
  flightNumber: string;
  originAirport: string;
  originCountry: string;
  destinationAirport: string;
  destinationCountry: string;
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
  refundable: boolean;
  changeable: boolean;
  /** Offers expire in minutes; the engine must know when it is looking at a corpse. */
  expiresAt: Date | null;
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
  preferredAirlines: string[];
  blockedAirlines: string[];

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
};

export type RuleStatus = 'pass' | 'fail' | 'not_applicable';

/**
 * What a failure costs you. `deny` cannot be approved by anyone; `approval`
 * escalates to a human; `advisory` is recorded and ignored.
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
