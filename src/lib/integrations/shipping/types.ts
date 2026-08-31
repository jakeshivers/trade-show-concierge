/**
 * Shipment tracking provider interface.
 *
 * The third integration behind this shape, and it is deliberately the same
 * shape: with no API key the app still runs, says shipment tracking is not
 * configured, and never invents a scan. SCOPE.md non-negotiable #2.
 *
 * As with `flightstatus/types.ts`, this interface **decides nothing**. It
 * reports what a carrier says about one tracking number at one moment. Whether
 * that is a delay, a stall, a crate about to be refused at a dock, or nothing
 * worth anybody's evening is `src/lib/shipping/status.ts`'s job, and that file
 * is pure — the provider is the least trustworthy and least testable thing in
 * the loop, so nothing that has to be right may live inside it.
 */

/** Enough to identify one shipment to a carrier's data. */
export type TrackingQuery = {
  carrier: string;
  trackingNumber: string;
  /**
   * The deadline this crate is judged against, when there is one. No live
   * tracker needs it — it is here because a *replay* does, for the reason
   * `StatusQuery.scheduledArrival` exists: a recorded payload describes a shape
   * ("two days late", "stalled in Memphis") and has to be projected onto the
   * shipment being asked about, or a canned transit time reports a week-long
   * delay on a crate going across town.
   */
  mustArriveBy?: Date | null;
  /** When the label was made, for the same projection reason. */
  shippedAt?: Date | null;
};

/**
 * What a carrier says a shipment is doing.
 *
 * `unknown` is a record with no usable state, and is not the same as `NoRecord`.
 * `returned` covers both return-to-sender and a refused delivery, which are the
 * same fact from our side: it is not where it was going and it is coming back.
 */
export type TrackingPhase =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned'
  | 'cancelled'
  | 'unknown';

/**
 * One scan. `fingerprint` is the provider's job because only the provider knows
 * what identifies a scan in its own feed; `schema.ts` explains why appending
 * without one turns a nightly poll into a timeline that doubles every night.
 */
export type TrackingScan = {
  occurredAt: Date;
  phase: TrackingPhase;
  message: string;
  location: string | null;
  fingerprint: string;
};

export type TrackingReport = {
  provider: string;
  observedAt: Date;
  phase: TrackingPhase;

  /** What the carrier currently expects. Null when it will not say. */
  estimatedDelivery: Date | null;
  /**
   * What the carrier promised at label creation, when the provider still
   * carries it. Most do not, which is why `store.ts` captures our own copy the
   * first time it sees an estimate rather than depending on this.
   */
  promisedDelivery: Date | null;
  deliveredAt: Date | null;
  signedBy: string | null;

  /** The whole history the provider returned, oldest first. */
  scans: TrackingScan[];
};

/**
 * The provider has no record of this tracking number.
 *
 * Distinct from `phase: 'unknown'`, exactly as it is for flights. "We have never
 * heard of this number" is almost always our data being wrong — a transposed
 * digit, a label voided and re-cut, a number belonging to a different carrier —
 * and that is a different thing to tell somebody than "the crate is somewhere in
 * Ohio and nobody has scanned it since Tuesday".
 */
export type NoRecord = { noRecord: true; provider: string; observedAt: Date; reason: string };

export type TrackingLookup = TrackingReport | NoRecord;

export function isNoRecord(r: TrackingLookup): r is NoRecord {
  return 'noRecord' in r;
}

export class TrackingProviderNotConfiguredError extends Error {
  constructor(readonly provider: string, readonly missingEnv: string[]) {
    super(
      `${provider} is not configured. Set ${missingEnv.join(', ')}. ` +
        'Until then shipments show what was entered by hand, and no crate will ever ' +
        'read as moving on the strength of nobody having checked.',
    );
    this.name = 'TrackingProviderNotConfiguredError';
  }
}

export class TrackingProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'TrackingProviderError';
  }
}

export interface ShipmentTrackingProvider {
  readonly name: string;
  isConfigured(): boolean;
  lookup(query: TrackingQuery): Promise<TrackingLookup>;
}
