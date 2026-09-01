import { optionalDecimalToCents } from '@/lib/money/decimal';
import type {
  CrmContactMatch,
  CrmOpportunity,
  OpportunityStageKind,
} from '../types';
import { CrmProviderError } from '../types';
import type {
  SalesforceContactRecord,
  SalesforceContactRoleRecord,
  SalesforceOpportunityRecord,
} from './wire';

/**
 * Salesforce payload → our types. Pure, so the part that has to be right is
 * testable without an org — the split `duffel/normalize.ts` established and the
 * three adapters after it repeated.
 */

const PROVIDER = 'salesforce';

function instant(iso: string | null | undefined, field: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new CrmProviderError(`Salesforce sent an unparseable ${field}: "${iso}"`, PROVIDER);
  }
  return d;
}

/**
 * `CloseDate` is a **date**, not a datetime: Salesforce sends "2026-11-30" with
 * no zone, because a close date is a day in the sales rep's calendar rather than
 * an instant. Parsing it with `new Date()` puts it at UTC midnight, which in
 * every American time zone is the *previous* day — so a close date on the last
 * day of a quarter lands in the quarter before, which is the one figure a sales
 * organisation checks. It is anchored at midday instead, which no zone offset
 * can push across a date boundary.
 *
 * The same failure as `toISOString().slice(0, 10)` on a 5pm-Pacific deadline
 * (§11.11's second correction), pointing the other way.
 */
function closeDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      throw new CrmProviderError(`Salesforce sent an unparseable CloseDate: "${raw}"`, PROVIDER);
    }
    return d;
  }
  return instant(raw, 'CloseDate');
}

/**
 * `Amount` → integer cents.
 *
 * Salesforce sends a JSON number here where Duffel and EasyPost send a decimal
 * string, and a JSON number is a float. `amount * 100` on 8618.36 is
 * 861835.9999999999 — the exact error `money/decimal.ts` exists to prevent — so
 * the number is stringified first and run through the same parser everything
 * else in this codebase uses. `toFixed(2)` rather than `String()` because
 * JavaScript renders large floats in exponential notation, which the parser
 * correctly refuses.
 */
export function amountToCents(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return optionalDecimalToCents(raw);
  if (!Number.isFinite(raw)) {
    throw new CrmProviderError(`Salesforce sent a non-finite Amount: ${raw}`, PROVIDER);
  }
  return optionalDecimalToCents(raw.toFixed(2));
}

/**
 * Where an opportunity is, without knowing the customer's stage vocabulary.
 *
 * This is the one normalization in the adapter that a naive version gets wrong
 * on the first real customer. Stage *names* are configured per org — "Closed
 * Won", "6 - Closed/Won", "Won - Renewal", and plenty in languages other than
 * English — so a string match against a list of names is a dashboard that is
 * silently wrong at customer number two, reporting every won deal as still open.
 * `IsWon` and `IsClosed` are the only two things Salesforce guarantees about a
 * stage regardless of what anybody called it.
 *
 * And the fallback is deliberately `open` rather than a thrown error: a stage we
 * cannot classify is a real opportunity that should still be counted somewhere,
 * and `open` is the answer that does not credit a show with a win it may not
 * have.
 */
export function stageKindOf(rec: SalesforceOpportunityRecord): OpportunityStageKind {
  if (rec.IsWon === true) return 'won';
  if (rec.IsClosed === true) return 'lost';
  return 'open';
}

export function normalizeOpportunity(
  rec: SalesforceOpportunityRecord,
  contactExternalId: string | null,
): CrmOpportunity {
  if (!rec.Id) {
    throw new CrmProviderError('Salesforce returned an Opportunity with no Id', PROVIDER);
  }
  return {
    externalId: rec.Id,
    name: rec.Name ?? '(unnamed opportunity)',
    stage: rec.StageName ?? '(no stage)',
    stageKind: stageKindOf(rec),
    amountCents: amountToCents(rec.Amount),
    currency: rec.CurrencyIsoCode ?? 'USD',
    contactExternalId,
    createdAt: instant(rec.CreatedDate, 'CreatedDate'),
    closeDate: closeDate(rec.CloseDate),
    lastActivityAt: instant(rec.LastActivityDate, 'LastActivityDate'),
    ownerName: rec.Owner?.Name ?? null,
  };
}

/**
 * An OpportunityContactRole row → the opportunity, carrying the contact it came
 * through.
 *
 * The join is a role rather than a foreign key on the opportunity (see
 * `wire.ts`), and one opportunity legitimately has several contacts on it. That
 * means the same opportunity can arrive here more than once, so
 * `dedupeOpportunities` exists and is not an optimisation: counting one
 * $340,000 deal twice because we met two people from the same buying committee
 * is the flattering-direction inflation §5j found in duplicate leads, arriving
 * on the pipeline side where the number is larger.
 */
export function normalizeContactRole(rec: SalesforceContactRoleRecord): CrmOpportunity | null {
  if (!rec.Opportunity || !rec.ContactId) return null;
  return normalizeOpportunity(rec.Opportunity, rec.ContactId);
}

export function dedupeOpportunities(opps: CrmOpportunity[]): CrmOpportunity[] {
  const seen = new Map<string, CrmOpportunity>();
  for (const o of opps) {
    // First writer wins, and the primary contact role is queried first, so the
    // contact kept is the one the CRM itself calls primary.
    if (!seen.has(o.externalId)) seen.set(o.externalId, o);
  }
  return [...seen.values()];
}

export function normalizeContact(
  rec: SalesforceContactRecord,
  objectType: 'contact' | 'lead',
  confidence: 'certain' | 'possible',
): CrmContactMatch {
  if (!rec.Id) {
    throw new CrmProviderError('Salesforce returned a record with no Id', PROVIDER);
  }
  return {
    externalId: rec.Id,
    objectType,
    fullName: rec.Name ?? null,
    accountName: rec.Account?.Name ?? rec.Company ?? null,
    confidence,
  };
}
