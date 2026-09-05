import type { Offer, TravelConstraints, Cabin } from '@/lib/policy/types';

/**
 * Flight provider interface.
 *
 * Every integration has an explicit not-configured state. With no API key the
 * app still runs; it says "flight booking is not configured" and never invents
 * a fare. SCOPE.md non-negotiable #2.
 */

/**
 * A frequent-flyer number as a carrier is told about it.
 *
 * Named rather than inlined because it now rides on **both** requests, and the
 * two do different work: at search a member account can surface a fare nobody
 * else is offered, and at order create it is what actually credits the miles.
 * Sending it on only one of them is a half-feature that looks whole — the
 * traveler sees their number saved and earns nothing.
 */
export type LoyaltyAccount = { airlineCode: string; accountNumber: string };

export type SearchRequest = {
  constraints: TravelConstraints;
  passengers: { givenName: string; familyName: string; loyaltyAccounts?: LoyaltyAccount[] }[];
  cabinClass?: Cabin;
  maxConnections?: number;
  /** Negotiated fare codes to request, when the org has them. */
  corporateCodes?: string[];
};

export type SearchResult = {
  offers: Offer[];
  searchId: string;
  searchedAt: Date;
};

export type HoldRequest = {
  offerId: string;
  passengers: {
    id: string;
    givenName: string;
    familyName: string;
    email: string;
    phone: string;
    bornOn: string;
    gender?: string;
    title?: string;
    loyaltyAccounts?: LoyaltyAccount[];
  }[];
  /** One purchase per travel request, ever — retries must not double-book. */
  idempotencyKey: string;
};

export type HoldResult = {
  orderId: string;
  bookingReference: string;
  payBy: Date | null;
  priceGuaranteedUntil: Date | null;
  totalCents: number;
  currency: string;
};

export type PurchaseRequest = {
  orderId?: string;
  offerId?: string;
  passengers?: HoldRequest['passengers'];
  amountCents: number;
  currency: string;
  /** Credits to burn down before charging. SCOPE.md §5b. */
  creditIds?: string[];
  idempotencyKey: string;
};

export type PurchaseResult = {
  orderId: string;
  bookingReference: string;
  ticketNumbers: string[];
  /** New money that moved. Excludes anything paid with a credit. */
  chargedCents: number;
  /**
   * How much of the fare a credit covered, as the *provider* priced it.
   *
   * Reported rather than inferred from the order total, because what an order's
   * total means once a credit is attached is a provider-specific question, and
   * the ledger is only worth keeping while its numbers match the airline's.
   * SCOPE.md §5b.
   */
  creditAppliedCents: number;
  currency: string;
  /**
   * Whether the *provider* considers this a real booking — not whether we asked
   * for one. A Duffel test key produces orders with `live_mode: false`, and
   * recording those as live spend would quietly corrupt the true-cost rollup
   * that the whole ROI story rests on. The booking row is stamped from this,
   * never from our own intent.
   */
  liveMode: boolean;
};

export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: string, readonly missingEnv: string[]) {
    super(
      `${provider} is not configured. Set ${missingEnv.join(', ')}. ` +
        `Until then, flights can be recorded manually but not searched or booked.`,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The fare moved between the offer we judged and the moment of purchase.
 *
 * Offers are quotes, not prices. Paying the new number because it happened to
 * come back from the same endpoint would mean buying something no policy verdict
 * ever covered, so the purchase is refused and the request goes back through
 * evaluation.
 */
export class PriceMovedError extends Error {
  constructor(
    readonly provider: string,
    readonly expectedCents: number,
    readonly actualCents: number,
    readonly currency: string,
  ) {
    super(
      `${provider} now quotes ${(actualCents / 100).toFixed(2)} ${currency} for this itinerary, ` +
        `not the ${(expectedCents / 100).toFixed(2)} ${currency} that was authorized. ` +
        'Refusing to purchase at a price nothing approved.',
    );
    this.name = 'PriceMovedError';
  }
}

/**
 * The provider-level spend ceiling. Deliberately separate from the policy
 * engine's `denyOverCents`: SCOPE.md §6c rail 1 asks for a second, dumber check
 * at the moment of purchase that is independent of the agent's own reasoning,
 * and a ceiling that reads the same policy the agent read is not independent.
 */
export class ProviderCeilingError extends Error {
  constructor(
    readonly provider: string,
    readonly amountCents: number,
    readonly ceilingCents: number,
  ) {
    super(
      `${provider} refused a purchase of ${(amountCents / 100).toFixed(2)}: above the ` +
        `configured hard ceiling of ${(ceilingCents / 100).toFixed(2)} (FLIGHT_BOOKING_MAX_CENTS). ` +
        'Nothing in the application can raise this; change the environment.',
    );
    this.name = 'ProviderCeilingError';
  }
}

/**
 * Purchasing is guarded by a dry-run flag that defaults ON. Production booking
 * requires an explicit opt-in, so the first bug is never a real ticket.
 * SCOPE.md §6c.
 */
export class DryRunError extends Error {
  constructor(action: string) {
    super(`Dry run: ${action} was not executed. Set FLIGHT_BOOKING_LIVE=true to enable real purchases.`);
    this.name = 'DryRunError';
  }
}

export interface FlightProvider {
  readonly name: string;
  isConfigured(): boolean;
  search(request: SearchRequest): Promise<SearchResult>;
  /** Reserve space without paying, so an approval can outlive offer expiry. */
  hold(request: HoldRequest): Promise<HoldResult>;
  purchase(request: PurchaseRequest): Promise<PurchaseResult>;
  cancel(orderId: string, idempotencyKey: string): Promise<void>;
}
