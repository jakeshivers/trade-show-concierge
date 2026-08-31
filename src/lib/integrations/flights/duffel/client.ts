import type {
  FlightProvider,
  SearchRequest,
  SearchResult,
  HoldRequest,
  HoldResult,
  PurchaseRequest,
  PurchaseResult,
} from '../types';
import {
  ProviderNotConfiguredError,
  ProviderError,
  DryRunError,
  PriceMovedError,
  ProviderCeilingError,
} from '../types';
import type {
  DuffelOffer,
  DuffelOfferRequestResponse,
  DuffelOfferResponse,
  DuffelOrder,
  DuffelOrderResponse,
  DuffelErrorResponse,
} from './wire';
import { normalizeOffers } from './normalize';
import { centsToDecimalString, decimalStringToCents } from '@/lib/money/decimal';

/**
 * Price the requested credits from the offer the provider just handed back.
 *
 * Three refusals live here, and each one is a purchase that would otherwise go
 * wrong quietly:
 *
 * - a credit id the offer does not carry — it has been spent, expired, or belongs
 *   to another traveler, and sending it would either fail or apply someone else's
 *   money;
 * - an offer that lists credit ids without their values — the payment amount is
 *   the fare *minus* the credits, so without the values there is no correct
 *   number to send, and a guessed one is a settlement failure;
 * - a credit priced in another currency, which no airline converts.
 *
 * Refusing is the right outcome for all three: the request escalates and a human
 * redeems the credit, rather than the org paying full fare and finding out at
 * the end of the quarter.
 */
function resolveCredits(
  offer: DuffelOffer,
  creditIds: string[],
): { id: string; amountCents: number }[] {
  if (creditIds.length === 0) return [];

  const priced = offer.available_airline_credits ?? [];
  if (priced.length === 0) {
    throw new ProviderError(
      `Offer ${offer.id} was asked to redeem ${creditIds.length} airline credit(s) but carries no ` +
        'credit values. The payment amount cannot be computed without them, and it will not be ' +
        'guessed. Redeem the credit with the airline instead.',
      'duffel',
    );
  }

  return creditIds.map((id) => {
    const match = priced.find((c) => c.id === id);
    if (!match) {
      throw new ProviderError(
        `Credit ${id} is not available on offer ${offer.id}. It may have been spent or expired ` +
          'since the search; refusing to purchase on a stale credit.',
        'duffel',
      );
    }
    if (match.credit_currency !== offer.total_currency) {
      throw new ProviderError(
        `Credit ${id} is held in ${match.credit_currency} but offer ${offer.id} is priced in ` +
          `${offer.total_currency}. Airlines do not convert credits.`,
        'duffel',
      );
    }
    return { id, amountCents: decimalStringToCents(match.credit_amount) };
  });
}

/**
 * Duffel adapter.
 *
 * Written against the published v2 schema. Until a test key is present,
 * `isConfigured()` is false and every call throws `ProviderNotConfiguredError`
 * rather than returning invented data.
 *
 * Docs: https://duffel.com/docs/api/v2/offers/schema
 */

const API_BASE = 'https://api.duffel.com';
const API_VERSION = 'v2';

export type DuffelConfig = {
  accessToken: string | undefined;
  /** Live purchasing is opt-in. Absent or false means dry run. SCOPE.md §6c. */
  liveBooking: boolean;
  /**
   * Rail 1's independent ceiling, in cents. Read from the environment rather
   * than from the policy the agent already consulted, and *required* whenever
   * live booking is on: an unbounded live purchaser is not a configuration this
   * adapter will accept.
   */
  hardCeilingCents: number | null;
};

/**
 * The env is a parameter rather than a global read so that a caller which was
 * itself handed an environment — `lib/travel/provider.ts` — can pass it through.
 * Defaulting to `process.env` keeps every existing caller unchanged.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): DuffelConfig {
  const raw = env.FLIGHT_BOOKING_MAX_CENTS;
  const ceiling = raw == null || raw.trim() === '' ? null : Number(raw);
  if (ceiling !== null && (!Number.isSafeInteger(ceiling) || ceiling <= 0)) {
    throw new Error(
      `FLIGHT_BOOKING_MAX_CENTS must be a positive integer number of cents, got "${raw}".`,
    );
  }
  return {
    accessToken: env.DUFFEL_ACCESS_TOKEN,
    liveBooking: env.FLIGHT_BOOKING_LIVE === 'true',
    hardCeilingCents: ceiling,
  };
}

export class DuffelProvider implements FlightProvider {
  readonly name = 'duffel';

  constructor(private readonly config: DuffelConfig = configFromEnv()) {}

  isConfigured(): boolean {
    return Boolean(this.config.accessToken);
  }

  private requireConfig(): string {
    if (!this.config.accessToken) {
      throw new ProviderNotConfiguredError('Duffel', ['DUFFEL_ACCESS_TOKEN']);
    }
    return this.config.accessToken;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const token = this.requireConfig();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Duffel-Version': API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Duffel dedupes on this key, which is what makes a retried purchase safe.
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

    const response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      let code: string | undefined;
      let requestId: string | undefined;
      try {
        const body = (await response.json()) as DuffelErrorResponse;
        const first = body.errors?.[0];
        if (first) {
          detail = `${first.title}: ${first.message}`;
          code = first.code;
        }
        requestId = body.meta?.request_id;
      } catch {
        // Non-JSON error body; the status alone is what we have.
      }
      throw new ProviderError(detail, 'duffel', response.status, requestId, code);
    }

    return (await response.json()) as T;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const { constraints, passengers, cabinClass, maxConnections } = request;

    const body = {
      data: {
        slices: [
          {
            origin: constraints.originAirport,
            destination: constraints.destinationAirport,
            departure_date: constraints.earliestDeparture.toISOString().slice(0, 10),
          },
          ...(constraints.returnEarliestDeparture
            ? [
                {
                  origin: constraints.destinationAirport,
                  destination: constraints.originAirport,
                  departure_date: constraints.returnEarliestDeparture.toISOString().slice(0, 10),
                },
              ]
            : []),
        ],
        passengers: passengers.map((p) => ({
          type: 'adult',
          given_name: p.givenName,
          family_name: p.familyName,
          loyalty_programme_accounts: p.loyaltyAccounts?.map((a) => ({
            airline_iata_code: a.airlineCode,
            account_number: a.accountNumber,
          })),
        })),
        cabin_class: cabinClass,
        max_connections: maxConnections,
        private_fares: request.corporateCodes?.length
          ? { corporate_code: request.corporateCodes[0] }
          : undefined,
      },
    };

    const response = await this.request<DuffelOfferRequestResponse>(
      '/air/offer_requests?return_offers=true',
      { method: 'POST', body },
    );

    return {
      offers: normalizeOffers(response.data.offers),
      searchId: response.data.id,
      searchedAt: new Date(response.data.created_at),
    };
  }

  /**
   * Reserve space without paying. Only some carriers permit it, so callers must
   * check `holdCapability(offer)` first rather than assuming.
   */
  async hold(request: HoldRequest): Promise<HoldResult> {
    const response = await this.request<{ data: Record<string, unknown> }>('/air/orders', {
      method: 'POST',
      idempotencyKey: request.idempotencyKey,
      body: {
        data: {
          type: 'hold',
          selected_offers: [request.offerId],
          passengers: request.passengers.map((p) => ({
            id: p.id,
            given_name: p.givenName,
            family_name: p.familyName,
            email: p.email,
            phone_number: p.phone,
            born_on: p.bornOn,
            gender: p.gender,
            title: p.title,
          })),
        },
      },
    });

    const data = response.data as {
      id: string;
      booking_reference: string;
      total_amount: string;
      total_currency: string;
      payment_status?: { payment_required_by: string | null; price_guarantee_expires_at: string | null };
    };

    return {
      orderId: data.id,
      bookingReference: data.booking_reference,
      payBy: data.payment_status?.payment_required_by
        ? new Date(data.payment_status.payment_required_by)
        : null,
      priceGuaranteedUntil: data.payment_status?.price_guarantee_expires_at
        ? new Date(data.payment_status.price_guarantee_expires_at)
        : null,
      totalCents: decimalStringToCents(data.total_amount),
      currency: data.total_currency,
    };
  }

  /**
   * Buy it.
   *
   * Two paths, because a held order is already a thing that exists: paying for
   * one is a payment against an order id, while an unheld offer becomes an
   * `instant` order and a payment in the same call.
   *
   * Both re-read the price from Duffel immediately beforehand. An offer is a
   * quote with a fuse on it, and the gap between "policy said yes" and "we paid"
   * is exactly where a fare change would otherwise be paid silently.
   */
  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    this.requireConfig();

    // Rail 4: dry run is the default, and this check sits below every caller —
    // an agent bug cannot route around it.
    if (!this.config.liveBooking) {
      throw new DryRunError(`purchase of ${request.amountCents} ${request.currency}`);
    }

    // Rail 1: the second, dumber ceiling. It knows nothing about the policy
    // engine, the traveler, or the verdict, which is the entire point.
    const ceiling = this.config.hardCeilingCents;
    if (ceiling === null) {
      throw new ProviderError(
        'Live booking is enabled but FLIGHT_BOOKING_MAX_CENTS is not set. Refusing to ' +
          'purchase without a hard ceiling that the application cannot raise.',
        'duffel',
      );
    }
    if (request.amountCents > ceiling) {
      throw new ProviderCeilingError('duffel', request.amountCents, ceiling);
    }

    // A credit can only be attached when the order is created. Paying off a hold
    // is a payment against an order that already exists at a fixed total, so a
    // credit arriving at that point has nowhere to go — and quietly dropping it
    // would be the exact loss §5b exists to stop.
    if (request.creditIds?.length && request.orderId) {
      throw new ProviderError(
        `Refusing to pay for held order ${request.orderId} while ignoring ` +
          `${request.creditIds.length} airline credit(s). A credit is applied when the order is ` +
          'created, not when it is paid for; hold this itinerary without a hold, or redeem the ' +
          'credit with the airline directly.',
        'duffel',
      );
    }

    const { order, creditAppliedCents } = request.orderId
      ? { order: await this.payForHeldOrder(request, request.orderId), creditAppliedCents: 0 }
      : await this.createInstantOrder(request);

    return {
      orderId: order.id,
      bookingReference: order.booking_reference,
      ticketNumbers: (order.documents ?? [])
        .filter((d) => d.type === 'electronic_ticket')
        .map((d) => d.unique_identifier),
      // With no credit, the order's own total is the truth. With one, it is the
      // fare we verified a moment earlier minus what the provider priced the
      // credit at — the two numbers this adapter actually controls. Reading a
      // credit-bearing order's `total_amount` and calling it spend would be
      // trusting a field whose meaning we have not confirmed.
      chargedCents:
        creditAppliedCents > 0
          ? request.amountCents - creditAppliedCents
          : decimalStringToCents(order.total_amount),
      creditAppliedCents,
      currency: order.total_currency,
      // Duffel's own word for it. A test key books real-looking orders with
      // `live_mode: false`, and those are not spend.
      liveMode: order.live_mode,
    };
  }

  /** Pay off a hold. The order already exists; only money is missing. */
  private async payForHeldOrder(
    request: PurchaseRequest,
    orderId: string,
  ): Promise<DuffelOrder> {
    const held = await this.request<DuffelOrderResponse>(`/air/orders/${orderId}`, {
      method: 'GET',
    });
    this.assertPriceUnchanged(request, held.data.total_amount, held.data.total_currency);

    await this.request('/air/payments', {
      method: 'POST',
      idempotencyKey: request.idempotencyKey,
      body: {
        data: {
          order_id: orderId,
          payment: {
            type: 'balance',
            amount: centsToDecimalString(request.amountCents),
            currency: request.currency,
          },
        },
      },
    });

    // Ticket numbers appear on the order, not on the payment response.
    const paid = await this.request<DuffelOrderResponse>(`/air/orders/${orderId}`, {
      method: 'GET',
    });
    return paid.data;
  }

  /** No hold: create the order and pay for it in one call. */
  private async createInstantOrder(
    request: PurchaseRequest,
  ): Promise<{ order: DuffelOrder; creditAppliedCents: number }> {
    if (!request.offerId) {
      throw new ProviderError('purchase needs either an offerId or a held orderId', 'duffel');
    }

    // Re-read the offer for two things at once: today's price, and the
    // passenger ids Duffel minted for it — an order's passengers must carry the
    // offer's own ids, which nothing upstream of the provider can know.
    const offer = await this.request<DuffelOfferResponse>(`/air/offers/${request.offerId}`, {
      method: 'GET',
    });
    this.assertPriceUnchanged(request, offer.data.total_amount, offer.data.total_currency);

    // The credits, priced by the provider. Never by us: our ledger's idea of a
    // credit's value is a cached number, and paying the airline based on it is
    // how a purchase gets rejected at settlement.
    const credits = resolveCredits(offer.data, request.creditIds ?? []);
    const creditCents = credits.reduce((sum, c) => sum + c.amountCents, 0);
    const payableCents = request.amountCents - creditCents;
    if (payableCents < 0) {
      throw new ProviderError(
        `Credits total ${creditCents} cents against a ${request.amountCents} cent fare on offer ` +
          `${request.offerId}. An airline does not give change; refusing rather than sending a ` +
          'negative payment.',
        'duffel',
      );
    }

    const supplied = request.passengers ?? [];
    const expected = offer.data.passengers ?? [];
    if (supplied.length !== expected.length) {
      throw new ProviderError(
        `Offer ${request.offerId} is for ${expected.length} passenger(s) but ${supplied.length} ` +
          'were supplied. Refusing to guess who is flying.',
        'duffel',
      );
    }

    const created = await this.request<DuffelOrderResponse>('/air/orders', {
      method: 'POST',
      idempotencyKey: request.idempotencyKey,
      body: {
        data: {
          type: 'instant',
          selected_offers: [request.offerId],
          // The credits ride on the order; the payment covers only the rest.
          ...(credits.length ? { airline_credits: credits.map((c) => ({ id: c.id })) } : {}),
          payments: [
            {
              type: 'balance',
              amount: centsToDecimalString(payableCents),
              currency: request.currency,
            },
          ],
          passengers: supplied.map((p, i) => ({
            id: expected[i].id,
            given_name: p.givenName,
            family_name: p.familyName,
            email: p.email,
            phone_number: p.phone,
            born_on: p.bornOn,
            gender: p.gender,
            title: p.title,
          })),
        },
      },
    });

    return { order: created.data, creditAppliedCents: creditCents };
  }

  private assertPriceUnchanged(
    request: PurchaseRequest,
    totalAmount: string,
    totalCurrency: string,
  ): void {
    const actual = decimalStringToCents(totalAmount);
    if (actual !== request.amountCents || totalCurrency !== request.currency) {
      throw new PriceMovedError('duffel', request.amountCents, actual, totalCurrency);
    }
  }

  async cancel(orderId: string, idempotencyKey: string): Promise<void> {
    await this.request(`/air/order_cancellations`, {
      method: 'POST',
      idempotencyKey,
      body: { data: { order_id: orderId } },
    });
  }
}
