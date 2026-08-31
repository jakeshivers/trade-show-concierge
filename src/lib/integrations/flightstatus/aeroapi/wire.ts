/**
 * FlightAware AeroAPI v4 wire types — only the fields we read.
 *
 * **Unverified against a live key**, and this file says so where somebody
 * choosing to trust it will read it. It is written to the published v4 schema
 * for `GET /flights/{ident}`, which is exactly the position the Duffel adapter
 * was in before step 12.5 built `pnpm duffel:capture` — and the lesson from that
 * step is the one worth repeating here: a fixture written from documentation
 * proves internal consistency and structurally cannot catch a wrong field name.
 * Everything below is `| undefined`-tolerant and `normalize.ts` fails loudly on
 * anything it cannot read, so the failure mode is an error naming the field
 * rather than a flight quietly reported as on time.
 */

export type AeroAirport = {
  code?: string;
  code_iata?: string;
  code_icao?: string;
  name?: string;
  city?: string;
  /** IANA zone. The one field here nothing else in the app can source. */
  timezone?: string;
};

export type AeroFlight = {
  ident?: string;
  ident_iata?: string;
  fa_flight_id?: string;
  operator?: string;
  operator_iata?: string;
  flight_number?: string;

  origin?: AeroAirport | null;
  destination?: AeroAirport | null;

  /** ISO-8601 with an explicit offset. Never naive, unlike Duffel's. */
  scheduled_out?: string | null;
  estimated_out?: string | null;
  actual_out?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;

  /** Seconds, signed. Read for cross-checking only; we compute our own. */
  departure_delay?: number | null;
  arrival_delay?: number | null;

  cancelled?: boolean;
  diverted?: boolean;
  /** Human-facing: "Scheduled", "En Route / On Time", "Arrived / Gate Arrival". */
  status?: string;
  progress_percent?: number | null;
  /**
   * A position-only record is radar with no schedule attached. It is not a
   * flight we can say anything useful about, and treating it as one would put a
   * blank schedule on the board.
   */
  position_only?: boolean;

  gate_origin?: string | null;
  terminal_origin?: string | null;
  gate_destination?: string | null;
  terminal_destination?: string | null;
};

export type AeroFlightsResponse = {
  flights?: AeroFlight[];
  num_pages?: number;
};
