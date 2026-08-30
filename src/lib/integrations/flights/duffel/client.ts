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
  DuffelOfferRequestResponse,
  DuffelOfferResponse,
  DuffelOrder,
  DuffelOrderResponse,
  DuffelErrorResponse,
} from './wire';
import { normalizeOffers } from './normalize';
import { centsToDecimalString, decimalStringToCents } from '@/lib/money/decimal';

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

export function configFromEnv(): DuffelConfig {
  const raw = process.env.FLIGHT_BOOKING_MAX_CENTS;
  const ceiling = raw == null || raw.trim() === '' ? null : Number(raw);
  if (ceiling !== null && (!Number.isSafeInteger(ceiling) || ceiling <= 0)) {
    throw new Error(
      `FLIGHT_BOOKING_MAX_CENTS must be a positive integer number of cents, got "${raw}".`,
    );
  }
  return {
    accessToken: process.env.DUFFEL_ACCESS_TOKEN,
    liveBooking: process.env.FLIGHT_BOOKING_LIVE === 'true',
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

    if (request.creditIds?.length) {
      throw new ProviderError(
        `Refusing to purchase while ignoring ${request.creditIds.length} applicable airline ` +
          'credit(s): paying full fare over an unused credit is a real loss. The credit ' +
          'ledger is step 6.',
        'duffel',
      );
    }

    const order = request.orderId
      ? await this.payForHeldOrder(request, request.orderId)
      : await this.createInstantOrder(request);

    return {
      orderId: order.id,
      bookingReference: order.booking_reference,
      ticketNumbers: (order.documents ?? [])
        .filter((d) => d.type === 'electronic_ticket')
        .map((d) => d.unique_identifier),
      chargedCents: decimalStringToCents(order.total_amount),
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
  private async createInstantOrder(request: PurchaseRequest): Promise<DuffelOrder> {
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
          payments: [
            {
              type: 'balance',
              amount: centsToDecimalString(request.amountCents),
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

    return created.data;
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
