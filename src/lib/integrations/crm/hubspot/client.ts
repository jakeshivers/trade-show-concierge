import type {
  AttributionResult,
  CrmOpportunity,
  CrmProvider,
  MatchLookup,
} from '../types';
import { CrmNotImplementedError } from '../types';

/**
 * HubSpot — declared, not built. SCOPE.md §11.6.
 *
 * §11.6 says to build one CRM well rather than two adequately, and step 19 built
 * Salesforce. This file exists because "some customers use HubSpot" is a fact
 * about the market rather than a fact about our roadmap, and the cheapest moment
 * to find out whether the `CrmProvider` interface can hold a second CRM is
 * before the first one is load-bearing. Writing the seam now cost an afternoon;
 * discovering at customer number four that `opportunitiesFor` assumes
 * Salesforce's contact-role join would cost a rewrite of `roi/store.ts`.
 *
 * **Every method throws, and that is the design.** The obvious stub returns
 * empty arrays and `noMatch`, and it would be actively dangerous here: "we
 * captured 41 leads and the CRM knows none of them" is a real, alarming, and
 * *correct* finding this product is built to surface, so a stub that produced it
 * out of its own absence would be manufacturing evidence — §8a's fabricated
 * bill, wearing the costume of a placeholder, on the one screen where a wrong
 * number gets a show cut. Not-built and nothing-found have to stay different
 * answers, and the only way to guarantee that is to make the unbuilt path
 * incapable of returning a result.
 *
 * What the seam already establishes, and what building it would need:
 *
 * - **The object model differs and the interface survives it.** HubSpot has
 *   contacts and *deals* joined through the v4 associations API, not
 *   Salesforce's `OpportunityContactRole`. Both are "opportunities hanging off
 *   these people", which is what `opportunitiesFor` asks for — so the interface
 *   holds, and the join lives in the adapter where it belongs.
 * - **`dealstage` is a pipeline-scoped id, not a name**, so HubSpot's normalizer
 *   needs `GET /crm/v3/pipelines/deals` to learn which stage ids are
 *   `closedwon` / `closedlost`. That is the same problem Salesforce's
 *   `IsWon`/`IsClosed` solves for free, and it is the reason `stageKind` is
 *   normalized in the interface rather than left to the reader.
 * - **The attribution write is a custom property**, created by the customer,
 *   named by them, and never defaulted — identical to
 *   `SALESFORCE_ATTRIBUTION_FIELD` and for the identical reason.
 * - **HubSpot has a free developer tier**, which means it — unlike AeroAPI,
 *   EasyPost and Salesforce — could realistically get the capture script §12.5
 *   built for Duffel. If that happens first, HubSpot becomes the *verified*
 *   adapter and Salesforce the unverified one, which would be an argument for
 *   building this next rather than a reason it is stubbed now.
 */

const DETAIL =
  'Building it means the HubSpot CRM v3 objects API for contacts and deals, the v4 ' +
  'associations API for the join, GET /crm/v3/pipelines/deals to resolve stage ids to ' +
  'won/lost, and a custom property for the attribution write. See the header of this file. ' +
  'Set CRM_PROVIDER=salesforce, or CRM_PROVIDER=recorded to replay a shape with no network.';

export class HubSpotCrmProvider implements CrmProvider {
  readonly name = 'hubspot';

  /**
   * False regardless of whether a key is present.
   *
   * A key does not make an unbuilt adapter work, and returning true would let
   * `selectCrmProvider` hand this to a sync that then throws deep inside a
   * loop — where the failure reads as a CRM outage rather than as a provider
   * this app has not written.
   */
  isConfigured(): boolean {
    return false;
  }

  async matchByExternalId(): Promise<MatchLookup> {
    throw new CrmNotImplementedError('HubSpot', DETAIL);
  }

  async matchByEmail(): Promise<MatchLookup> {
    throw new CrmNotImplementedError('HubSpot', DETAIL);
  }

  async opportunitiesFor(): Promise<CrmOpportunity[]> {
    throw new CrmNotImplementedError('HubSpot', DETAIL);
  }

  async writeAttribution(): Promise<AttributionResult> {
    throw new CrmNotImplementedError('HubSpot', DETAIL);
  }
}
