/**
 * EasyPost Tracker API v2 wire types — only the fields we read.
 *
 * **Unverified against a live key**, and this file says so where anybody
 * choosing to trust it will read it. It is written to the published v2 schema
 * for `GET /v2/trackers`, which is the position the AeroAPI adapter is still in
 * and the position the Duffel adapter was in before step 12.5 built
 * `pnpm duffel:capture`. The lesson from that step is worth repeating verbatim:
 * a fixture written from documentation proves internal consistency and
 * structurally cannot catch a wrong field name.
 *
 * Everything below is `| undefined`-tolerant and `normalize.ts` fails loudly on
 * anything it cannot read, so the failure mode is an error naming the field
 * rather than a crate quietly reported as in transit.
 */

export type EasyPostTrackingLocation = {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zip?: string | null;
};

export type EasyPostTrackingDetail = {
  /** ISO-8601. EasyPost sends these with a `Z` or an offset. */
  datetime?: string | null;
  message?: string | null;
  /** `pre_transit`, `in_transit`, `out_for_delivery`, `delivered`, … */
  status?: string | null;
  status_detail?: string | null;
  source?: string | null;
  tracking_location?: EasyPostTrackingLocation | null;
};

export type EasyPostCarrierDetail = {
  service?: string | null;
  container_type?: string | null;
  /** Naive local date-time at the destination. Read only as a fallback. */
  est_delivery_date_local?: string | null;
  est_delivery_time_local?: string | null;
  origin_location?: string | null;
  destination_location?: string | null;
  guaranteed_delivery_date?: string | null;
  alternate_identifier?: string | null;
  initial_delivery_attempt?: string | null;
};

export type EasyPostTracker = {
  id?: string;
  object?: string;
  mode?: string;
  tracking_code?: string;
  carrier?: string;
  /**
   * `pre_transit | in_transit | out_for_delivery | delivered |
   *  available_for_pickup | return_to_sender | failure | cancelled | error |
   *  unknown`.
   */
  status?: string | null;
  status_detail?: string | null;
  signed_by?: string | null;
  weight?: number | null;
  est_delivery_date?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  tracking_details?: EasyPostTrackingDetail[] | null;
  carrier_detail?: EasyPostCarrierDetail | null;
};

/** `GET /v2/trackers` is a collection even when you filter to one code. */
export type EasyPostTrackerList = {
  trackers?: EasyPostTracker[];
  has_more?: boolean;
};
