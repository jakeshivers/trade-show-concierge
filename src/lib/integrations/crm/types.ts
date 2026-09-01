/**
 * CRM provider interface — the fifth integration behind this shape.
 *
 * Same posture as the four before it: with no API key the app still runs, says
 * the CRM is not connected, and never invents an opportunity. SCOPE.md
 * non-negotiable #2.
 *
 * And, as with `flightstatus/types.ts` and `shipping/types.ts`, **this interface
 * decides nothing.** It reports what a CRM says about records the CRM already
 * holds. Which show sourced an opportunity, whether that claim may be quoted,
 * and what a pipeline multiple is worth are all `src/lib/roi/`'s job, and those
 * files are pure — the provider is the least trustworthy and least testable
 * thing in the loop, so nothing that has to be right may live inside it.
 *
 * Two things are specific to this integration and neither is cosmetic.
 *
 * **1. The write is one field, and the interface says so by having one write
 * method.** §8b is explicit: read opportunities linked to leads we captured,
 * write a show attribution field back, and *never* sync contacts, own the
 * pipeline, or duplicate CRM objects. An interface with `upsertContact` on it
 * would be an invitation, and the second customer would ask for it. The way to
 * not become a CRM is to be structurally unable to.
 *
 * **2. Matching by email is an outbound transfer of personal data and matching
 * by id is not.** `matchByExternalId` takes an id the CRM itself gave us and
 * sends nothing about the person; `matchByEmail` sends a stranger's email
 * address to a third party. `roi/store.ts` gates the second on
 * `marketabilityOf` — step 18's refusal, biting on a number for the first time —
 * and the split is in the interface rather than in a comment so a future adapter
 * cannot quietly collapse them into one convenient `match()`.
 */

/** Where an opportunity actually is, normalized away from per-org stage names. */
export type OpportunityStageKind = 'open' | 'won' | 'lost';

export type CrmOpportunity = {
  externalId: string;
  name: string;
  /** The customer's own label, verbatim, so a person recognises it. */
  stage: string;
  stageKind: OpportunityStageKind;
  /** Integer cents. Providers send decimal strings; adapters parse, never `parseFloat`. */
  amountCents: number | null;
  currency: string;
  /** The contact or lead this opportunity hangs off, which is what joins it to us. */
  contactExternalId: string | null;
  /** When the CRM created it. First touch is measured from this and nothing else. */
  createdAt: Date | null;
  closeDate: Date | null;
  lastActivityAt: Date | null;
  ownerName: string | null;
};

/**
 * A CRM record we believe is the person we met.
 *
 * `confidence` exists because an email match is not a certainty — shared
 * mailboxes, role addresses, and a person who changed jobs between the show and
 * the sync all produce a plausible wrong answer. §5e's `certain` / `possible`
 * distinction, arriving in a fifth domain.
 */
export type CrmContactMatch = {
  externalId: string;
  objectType: 'contact' | 'lead';
  fullName: string | null;
  accountName: string | null;
  confidence: 'certain' | 'possible';
};

/**
 * The provider has no record of this person or id.
 *
 * Distinct from an error, exactly as `NoRecord` is for a flight and a crate.
 * "This email is in nobody's CRM" is an ordinary and expected answer about a
 * booth conversation that went nowhere; it is not a failure, and reporting it as
 * one would make a sync look broken on the shows where capture worked best.
 */
export type NoMatch = { noMatch: true; reason: string };

export type MatchLookup = CrmContactMatch | NoMatch;

export function isNoMatch(m: MatchLookup): m is NoMatch {
  return 'noMatch' in m;
}

/** What the attribution write puts on the record, and what came back. */
export type AttributionWrite = {
  objectType: 'contact' | 'lead';
  externalId: string;
  /** e.g. "Automate 2025 (2025-07-14)". One field, per §8b. */
  value: string;
};

export type AttributionResult =
  | { written: true; at: Date }
  /**
   * The field does not exist in this customer's org, or the connected user
   * cannot write it. Both are ordinary configuration and neither is a bug, so
   * they are a *result* rather than a thrown error — a sync that aborted the
   * whole run because one custom field was missing would leave every read it had
   * already done unrecorded.
   */
  | { written: false; reason: string };

export class CrmNotConfiguredError extends Error {
  constructor(readonly provider: string, readonly missingEnv: string[]) {
    super(
      `${provider} is not connected. Set ${missingEnv.join(', ')}. ` +
        'Until then a show has a cost and no return side, which the ROI screen says ' +
        'in those words rather than showing a pipeline of $0.',
    );
    this.name = 'CrmNotConfiguredError';
  }
}

/**
 * A provider this app knows the name of and has not built.
 *
 * Deliberately its own error rather than `NotConfigured`, and deliberately not
 * an adapter that returns empty arrays. An empty read is a *finding* — "we
 * captured 41 leads and the CRM knows none of them" is a real and alarming
 * answer — so an unbuilt adapter that returned `[]` would manufacture that
 * finding out of its own absence, which is §8a's fabricated bill wearing the
 * costume of a stub. Not-built and nothing-found have to stay different answers.
 */
export class CrmNotImplementedError extends Error {
  constructor(readonly provider: string, readonly detail: string) {
    super(
      `The ${provider} adapter is declared but not built. ${detail} ` +
        'It fails here rather than returning an empty result, because "no opportunities" ' +
        'is a finding and an unbuilt adapter must not be able to produce one.',
    );
    this.name = 'CrmNotImplementedError';
  }
}

export class CrmProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CrmProviderError';
  }
}

export interface CrmProvider {
  readonly name: string;
  isConfigured(): boolean;

  /**
   * Resolve a CRM record from an id the CRM gave us. Sends nothing about the
   * person, so it is never gated on consent.
   */
  matchByExternalId(externalId: string): Promise<MatchLookup>;

  /**
   * Resolve a CRM record from an email address. **This transmits personal data
   * to a third party**, so every caller must have checked `marketabilityOf`
   * first; the interface cannot enforce that and `roi/store.ts` is the one place
   * that calls it.
   */
  matchByEmail(email: string): Promise<MatchLookup>;

  /** Opportunities hanging off these contact ids. Read-only, per §8b. */
  opportunitiesFor(contactExternalIds: string[]): Promise<CrmOpportunity[]>;

  /** The one write. See the header. */
  writeAttribution(write: AttributionWrite): Promise<AttributionResult>;
}
