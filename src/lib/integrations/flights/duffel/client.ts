import type {
  FlightProvider,
  SearchRequest,
  SearchResult,
  HoldRequest,
  HoldResult,
  PurchaseRequest,
  PurchaseResult,
} from '../types';
import { ProviderNotConfiguredError, ProviderError, DryRunError } from '../types';
import type { DuffelOfferRequestResponse, DuffelErrorResponse } from './wire';
import { normalizeOffers } from './normalize';

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
};

export function configFromEnv(): DuffelConfig {
  return {
    accessToken: process.env.DUFFEL_ACCESS_TOKEN,
    liveBooking: process.env.FLIGHT_BOOKING_LIVE === 'true',
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

    const { decimalStringToCents } = await import('@/lib/money/decimal');
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

  async purchase(request: PurchaseRequest): Promise<PurchaseResult> {
    this.requireConfig();
    // The second, dumber check. Independent of any policy verdict upstream.
    if (!this.config.liveBooking) {
      throw new DryRunError(`purchase of ${request.amountCents} ${request.currency}`);
    }
    throw new ProviderError(
      'Live purchase is not implemented yet — build step 5.',
      'duffel',
    );
  }

  async cancel(orderId: string, idempotencyKey: string): Promise<void> {
    await this.request(`/air/order_cancellations`, {
      method: 'POST',
      idempotencyKey,
      body: { data: { order_id: orderId } },
    });
  }
}
