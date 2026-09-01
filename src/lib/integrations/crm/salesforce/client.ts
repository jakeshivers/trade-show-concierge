import type {
  AttributionResult,
  AttributionWrite,
  CrmOpportunity,
  CrmProvider,
  MatchLookup,
} from '../types';
import { CrmNotConfiguredError, CrmProviderError } from '../types';
import type {
  SalesforceContactRecord,
  SalesforceContactRoleRecord,
  SalesforceErrorBody,
  SalesforceQueryResult,
} from './wire';
import { dedupeOpportunities, normalizeContact, normalizeContactRole } from './normalize';

/**
 * Salesforce REST API v60 — the real CRM provider. SCOPE.md §8b, §11.6.
 *
 * **Verified against nothing yet**, and recorded here in the same words the
 * AeroAPI and EasyPost clients use so nobody reads the absence of a warning as
 * evidence: the wire types are written from the published REST/SOQL reference,
 * the tests run against fixtures we wrote ourselves, and a closed loop like that
 * proves internal consistency and cannot catch a wrong field name. A connected
 * org is the arbiter, and `pnpm duffel:capture` is the shape of the script that
 * should exist here before this is trusted with a customer's pipeline.
 *
 * The risk is higher here than it was for a carrier, for a reason worth stating
 * plainly: a wrong field name on a tracking payload produces a crate with no
 * scans, which looks wrong immediately. A wrong field name here produces a
 * dashboard where **nothing is ever attributed** — every show shows a real cost
 * and $0 of pipeline — and that is indistinguishable from the honest finding
 * §8c says is the normal case. The failure would look like the truth. So the
 * three places it could happen are called out in `wire.ts`, and
 * `opportunitiesFor` fails loudly on a malformed envelope rather than returning
 * an empty array.
 *
 * Authentication is a connected-app access token supplied through the
 * environment. A full OAuth refresh dance belongs with hosting (step 21) — there
 * is nowhere to store a refresh token in a workspace with no deployment — so a
 * 401 is reported as an expired token naming the variable to replace, rather
 * than being retried into a loop.
 */

const API_VERSION = 'v60.0';

/**
 * Contact ids per SOQL request. SOQL itself allows a 100,000-character query,
 * but it rides in the query string of a GET and Salesforce's URL cap is far
 * lower — so the binding limit is the URL, not the language.
 */
const ID_CHUNK = 200;

/** A guard against looping on a paginating API, not a cap on a customer's data. */
const MAX_PAGES = 50;

/**
 * Whether an error is Salesforce refusing a field the org does not have.
 *
 * Matched on `errorCode` and the field name rather than on the message, because
 * the message is localised to the connected user's language and the code is not.
 */
function isUnknownField(err: unknown, field: string): boolean {
  return (
    err instanceof CrmProviderError &&
    err.status === 400 &&
    /INVALID_FIELD/.test(err.message) &&
    err.message.includes(field)
  );
}

export type SalesforceConfig = {
  instanceUrl?: string;
  accessToken?: string;
  /**
   * The API name of the field the attribution write targets, e.g.
   * `Trade_Show_Source__c`. **Never defaulted.** A custom field is created by
   * the customer's admin and we cannot know its name; guessing one produces a
   * write that fails on every record, or — worse — succeeds against a field that
   * means something else in their org and overwrites it.
   */
  attributionField?: string;
  fetch?: typeof fetch;
};

export function salesforceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SalesforceConfig {
  return {
    instanceUrl: env.SALESFORCE_INSTANCE_URL,
    accessToken: env.SALESFORCE_ACCESS_TOKEN,
    attributionField: env.SALESFORCE_ATTRIBUTION_FIELD,
  };
}

/** SOQL has no bound parameters. Escaping is the whole defence. */
export function soqlQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export class SalesforceCrmProvider implements CrmProvider {
  readonly name = 'salesforce';
  private readonly http: typeof fetch;
  /** Undefined until probed; see `contactRoles`. */
  private multiCurrency: boolean | undefined;
  private cachedOrgCurrency: string | undefined;

  constructor(private readonly config: SalesforceConfig) {
    this.http = config.fetch ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.config.instanceUrl && this.config.accessToken);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new CrmNotConfiguredError('Salesforce', [
        'SALESFORCE_INSTANCE_URL',
        'SALESFORCE_ACCESS_TOKEN',
        'or CRM_PROVIDER=recorded to replay a captured shape with no network',
      ]);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    this.assertConfigured();
    const url = `${this.config.instanceUrl!.replace(/\/$/, '')}/services/data/${API_VERSION}${path}`;
    const res = await this.http(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401) {
      throw new CrmProviderError(
        'Salesforce rejected the access token. Replace SALESFORCE_ACCESS_TOKEN — this adapter ' +
          'does not refresh tokens, because there is nowhere in this workspace to keep a refresh ' +
          'token yet (SCOPE §10 step 21).',
        this.name,
        401,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as SalesforceErrorBody[] | null;
      const first = Array.isArray(body) ? body[0] : null;
      throw new CrmProviderError(
        `Salesforce ${res.status}: ${first?.errorCode ?? 'unknown'} — ${first?.message ?? res.statusText}`,
        this.name,
        res.status,
      );
    }
    // 204 on a successful PATCH, which has no body to parse.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * A SOQL query, **followed to the end**.
   *
   * Salesforce pages at 2,000 records and hands back `nextRecordsUrl`. Reading
   * only the first page is the §5j import failure arriving in an adapter: a
   * smaller number reported with exactly the same confidence as a correct one,
   * on the screen a budget is set from, with nothing to re-count against
   * afterwards. It is also invisible until a customer is big enough to matter —
   * which is to say, until it matters. `wire.ts` already described
   * `nextRecordsUrl` as "a path we follow rather than ignore"; this is the code
   * catching up with its own comment.
   *
   * The page cap is a guard rather than a limit: at 50 pages something has gone
   * wrong with the query rather than with the customer, and looping forever
   * against a paginating API is a worse failure than stopping loudly.
   */
  private async query<T>(soql: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `/query?q=${encodeURIComponent(soql)}`;
    let pages = 0;

    while (next) {
      const result: SalesforceQueryResult<T> = await this.request<SalesforceQueryResult<T>>(next);
      if (!result || !Array.isArray(result.records)) {
        // Loudly, per the header: an empty array here is a finding, and a
        // malformed envelope must not be able to manufacture one.
        throw new CrmProviderError(
          'Salesforce returned a query result with no `records` array. That is a shape this ' +
            'adapter does not understand, and it is reported rather than read as "no results" — ' +
            'an empty pipeline is a claim about the customer, not a parse failure.',
          this.name,
        );
      }
      out.push(...result.records);

      if (!result.nextRecordsUrl || result.done === true) break;
      if (++pages >= MAX_PAGES) {
        throw new CrmProviderError(
          `Salesforce paginated past ${MAX_PAGES} pages (${out.length} records). Stopping rather ` +
            'than looping — and rather than returning a partial answer, which would be a pipeline ' +
            'figure that is quietly short.',
          this.name,
        );
      }
      // `nextRecordsUrl` arrives absolute from the API root and already carries
      // the version segment, so the version prefix `request` adds has to come
      // off it. Passing it through unchanged yields /services/data/v60.0/services/…
      next = result.nextRecordsUrl.replace(`/services/data/${API_VERSION}`, '');
    }

    return out;
  }

  /**
   * The org's own currency, for the single-currency case below.
   *
   * Read rather than defaulted. `USD` would be right most of the time, and a
   * currency that is right most of the time is a money figure this codebase does
   * not get to invent — the same rule that keeps a loaded rate out of §8a and a
   * placeholder date of birth off a ticket. Cached for the life of the provider:
   * an org's default currency does not change during a sync.
   */
  private async orgCurrency(): Promise<string> {
    if (this.cachedOrgCurrency) return this.cachedOrgCurrency;
    const rows = await this.query<{ DefaultCurrencyIsoCode?: string | null }>(
      'SELECT DefaultCurrencyIsoCode FROM Organization LIMIT 1',
    );
    const iso = rows[0]?.DefaultCurrencyIsoCode;
    if (!iso) {
      throw new CrmProviderError(
        'Salesforce would not say what currency this org uses, and this adapter does not guess ' +
          'one. Every amount it reads is money, and a wrong currency label on a pipeline figure ' +
          'is worse than no figure.',
        this.name,
      );
    }
    this.cachedOrgCurrency = iso;
    return iso;
  }

  async matchByExternalId(externalId: string): Promise<MatchLookup> {
    const records = await this.query<SalesforceContactRecord>(
      `SELECT Id, Name, Email, Account.Name FROM Contact WHERE Id = ${soqlQuote(externalId)} LIMIT 1`,
    );
    if (records.length === 0) {
      return {
        noMatch: true,
        reason:
          `Salesforce has no Contact with id ${externalId}. The record was probably merged or ` +
          'deleted after we linked it; the lead is still ours and still counted.',
      };
    }
    // An id the CRM gave us resolving to a record is as certain as this gets.
    return normalizeContact(records[0], 'contact', 'certain');
  }

  async matchByEmail(email: string): Promise<MatchLookup> {
    const records = await this.query<SalesforceContactRecord>(
      `SELECT Id, Name, Email, Account.Name FROM Contact WHERE Email = ${soqlQuote(email)} LIMIT 2`,
    );
    if (records.length === 0) {
      return {
        noMatch: true,
        reason: 'No Salesforce contact has this email address.',
      };
    }
    if (records.length > 1) {
      return {
        noMatch: true,
        reason:
          'More than one Salesforce contact shares this email address — a shared mailbox, or a ' +
          'duplicate the CRM has not merged. Guessing between them would attribute a show’s ' +
          'pipeline to whichever record happened to sort first.',
      };
    }
    // Never `certain`: a person changes jobs, a role address is shared, and an
    // email is the CRM's identifier for a mailbox rather than for a human.
    return normalizeContact(records[0], 'contact', 'possible');
  }

  /**
   * Opportunities hanging off these contacts — in chunks, and tolerant of an org
   * that has never heard of `CurrencyIsoCode`.
   *
   * **Chunked**, because SOQL travels in the query string of a GET and
   * Salesforce caps a URL well below the SOQL length limit. This is called with
   * every matched lead in the workspace, so it is fine on the eighteen in the
   * seed and breaks at exactly the customer size where the feature starts
   * earning its place. 200 ids per request is comfortably inside both limits.
   *
   * **`CurrencyIsoCode` only exists in a multi-currency org**, and selecting a
   * field an org does not have is a hard `INVALID_FIELD` rather than a null — so
   * the obvious query fails outright on the majority of Salesforce orgs, which
   * are single-currency. There is no way to know which kind an org is without
   * asking, so this asks the cheapest way there is: try it, and if that is the
   * error, remember and fall back to the org's own default currency. The
   * fallback reads the currency rather than assuming `USD`, because a currency
   * label on a pipeline figure is part of the figure.
   */
  async opportunitiesFor(contactExternalIds: string[]): Promise<CrmOpportunity[]> {
    if (contactExternalIds.length === 0) return [];

    const opps: CrmOpportunity[] = [];
    for (let i = 0; i < contactExternalIds.length; i += ID_CHUNK) {
      const ids = contactExternalIds.slice(i, i + ID_CHUNK).map(soqlQuote).join(', ');
      const roles = await this.contactRoles(ids);
      for (const role of roles) {
        const opp = normalizeContactRole(role);
        if (opp) opps.push(opp);
      }
    }
    // Deduped across chunks as well as within one: two people we met from the
    // same buying committee can land in different chunks, and counting their one
    // shared deal twice is §5j's flattering-direction inflation arriving on the
    // pipeline side, where the number is larger.
    const deduped = dedupeOpportunities(opps);

    if (!this.multiCurrency) {
      const iso = await this.orgCurrency();
      return deduped.map((o) => ({ ...o, currency: iso }));
    }
    return deduped;
  }

  private async contactRoles(quotedIds: string): Promise<SalesforceContactRoleRecord[]> {
    const soql = (withCurrency: boolean) =>
      'SELECT ContactId, Role, IsPrimary, ' +
      'Opportunity.Id, Opportunity.Name, Opportunity.StageName, Opportunity.Amount, ' +
      (withCurrency ? 'Opportunity.CurrencyIsoCode, ' : '') +
      'Opportunity.IsWon, Opportunity.IsClosed, ' +
      'Opportunity.CreatedDate, Opportunity.CloseDate, Opportunity.LastActivityDate, ' +
      'Opportunity.Owner.Name ' +
      `FROM OpportunityContactRole WHERE ContactId IN (${quotedIds}) ` +
      'ORDER BY IsPrimary DESC';

    if (this.multiCurrency === false) {
      return this.query<SalesforceContactRoleRecord>(soql(false));
    }
    try {
      const rows = await this.query<SalesforceContactRoleRecord>(soql(true));
      this.multiCurrency = true;
      return rows;
    } catch (err) {
      if (!isUnknownField(err, 'CurrencyIsoCode')) throw err;
      // Single-currency org. Remembered, so the probe happens once per sync
      // rather than once per chunk.
      this.multiCurrency = false;
      return this.query<SalesforceContactRoleRecord>(soql(false));
    }
  }

  async writeAttribution(write: AttributionWrite): Promise<AttributionResult> {
    const field = this.config.attributionField;
    if (!field) {
      return {
        written: false,
        reason:
          'No attribution field is configured. Set SALESFORCE_ATTRIBUTION_FIELD to the API name ' +
          'of the custom field on Contact — it is never defaulted, because a guessed field name ' +
          'either fails on every record or writes over something that means something else.',
      };
    }
    const object = write.objectType === 'lead' ? 'Lead' : 'Contact';
    try {
      await this.request<void>(`/sobjects/${object}/${write.externalId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: write.value }),
      });
      return { written: true, at: new Date() };
    } catch (err) {
      if (err instanceof CrmProviderError && (err.status === 400 || err.status === 403)) {
        // Configuration, not a bug, and not a reason to abandon the run: the
        // reads already done are worth keeping. See `AttributionResult`.
        return { written: false, reason: err.message };
      }
      throw err;
    }
  }
}
