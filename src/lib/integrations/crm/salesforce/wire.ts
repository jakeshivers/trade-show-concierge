/**
 * Salesforce REST API v60 wire types — only the fields we read.
 *
 * **Unverified against a live org**, and this file says so where anybody
 * choosing to trust it will read it. It is written to the published REST and
 * SOQL reference for `/services/data/v60.0/query` and
 * `/services/data/v60.0/sobjects`, which is the position the AeroAPI and
 * EasyPost adapters are still in and the position Duffel was in before step 12.5
 * built `pnpm duffel:capture`. The lesson from that step is worth repeating
 * verbatim: a fixture written from documentation proves internal consistency and
 * structurally cannot catch a wrong field name.
 *
 * Two things about Salesforce specifically make that risk higher here than it
 * was for a carrier, and they are the two things a capture script would settle
 * first:
 *
 * 1. **Half of what we read is per-org.** Stage names, record types, and the
 *    attribution field itself are configured by the customer, not by Salesforce.
 *    `normalize.ts` therefore refuses to hardcode a stage vocabulary and reads
 *    `IsWon` / `IsClosed` from the `OpportunityStage` metadata instead, which is
 *    the only part of it Salesforce guarantees.
 * 2. **`Amount` is a decimal number in JSON, not a string.** Duffel and EasyPost
 *    send decimal *strings*; Salesforce sends a JSON number, which is a float,
 *    which is exactly the thing `money/decimal.ts` exists to keep away from
 *    money. It is stringified before parsing rather than multiplied by 100.
 */

/** The envelope every SOQL query comes back in. */
export type SalesforceQueryResult<T> = {
  totalSize?: number;
  done?: boolean;
  /** Present when the result was paginated. A path we follow rather than ignore. */
  nextRecordsUrl?: string | null;
  records?: T[] | null;
};

export type SalesforceAttributes = {
  type?: string | null;
  url?: string | null;
};

export type SalesforceContactRecord = {
  attributes?: SalesforceAttributes;
  Id?: string | null;
  Name?: string | null;
  Email?: string | null;
  /** Present on Contact; absent on Lead, which carries `Company` instead. */
  Account?: { Name?: string | null } | null;
  Company?: string | null;
};

export type SalesforceOpportunityRecord = {
  attributes?: SalesforceAttributes;
  Id?: string | null;
  Name?: string | null;
  StageName?: string | null;
  /**
   * Salesforce sends `Amount` as a JSON number. See the header: it is
   * stringified and parsed as a decimal rather than arithmetic'd into cents.
   */
  Amount?: number | string | null;
  CurrencyIsoCode?: string | null;
  IsWon?: boolean | null;
  IsClosed?: boolean | null;
  CreatedDate?: string | null;
  CloseDate?: string | null;
  LastActivityDate?: string | null;
  Owner?: { Name?: string | null } | null;
  /** The junction back to the person, via OpportunityContactRole. */
  ContactId?: string | null;
};

/**
 * A row of the OpportunityContactRole query, which is how an opportunity is
 * actually joined to a contact in Salesforce.
 *
 * Worth stating because it is the shape most easily got wrong from memory: an
 * Opportunity has **no** `ContactId`. It has an Account, and a set of contact
 * *roles*. Reading `Opportunity.ContactId` would compile, return `undefined`
 * forever, and produce a dashboard where nothing is ever attributed — the
 * quietest possible failure, and one a fixture we wrote ourselves would happily
 * confirm.
 */
export type SalesforceContactRoleRecord = {
  attributes?: SalesforceAttributes;
  ContactId?: string | null;
  Role?: string | null;
  IsPrimary?: boolean | null;
  Opportunity?: SalesforceOpportunityRecord | null;
};

export type SalesforceErrorBody = {
  message?: string | null;
  errorCode?: string | null;
  fields?: string[] | null;
};
