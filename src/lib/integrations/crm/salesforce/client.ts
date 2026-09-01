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

  private async query<T>(soql: string): Promise<T[]> {
    const result = await this.request<SalesforceQueryResult<T>>(
      `/query?q=${encodeURIComponent(soql)}`,
    );
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
    return result.records;
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

  async opportunitiesFor(contactExternalIds: string[]): Promise<CrmOpportunity[]> {
    if (contactExternalIds.length === 0) return [];
    const ids = contactExternalIds.map(soqlQuote).join(', ');
    const roles = await this.query<SalesforceContactRoleRecord>(
      'SELECT ContactId, Role, IsPrimary, ' +
        'Opportunity.Id, Opportunity.Name, Opportunity.StageName, Opportunity.Amount, ' +
        'Opportunity.CurrencyIsoCode, Opportunity.IsWon, Opportunity.IsClosed, ' +
        'Opportunity.CreatedDate, Opportunity.CloseDate, Opportunity.LastActivityDate, ' +
        'Opportunity.Owner.Name ' +
        `FROM OpportunityContactRole WHERE ContactId IN (${ids}) ` +
        'ORDER BY IsPrimary DESC',
    );
    const opps = roles
      .map(normalizeContactRole)
      .filter((o): o is CrmOpportunity => o !== null);
    return dedupeOpportunities(opps);
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
