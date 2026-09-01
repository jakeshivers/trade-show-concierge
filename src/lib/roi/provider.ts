import type { CrmProvider } from '@/lib/integrations/crm/types';
import { CrmNotConfiguredError, CrmNotImplementedError } from '@/lib/integrations/crm/types';
import { HubSpotCrmProvider } from '@/lib/integrations/crm/hubspot/client';
import { RecordedCrmProvider } from '@/lib/integrations/crm/recorded/provider';
import {
  SalesforceCrmProvider,
  salesforceConfigFromEnv,
} from '@/lib/integrations/crm/salesforce/client';

/**
 * Choosing the CRM from the environment. The fifth integration to follow
 * `travel/provider.ts`'s rule, and it is not negotiable at any of them: **no
 * fallback, ever.**
 *
 * The argument is the same one and it is sharper here than anywhere. For fares
 * the risk was spending money; for tracking it was "the booth will be there
 * before the doors open". Here it is a pipeline figure beside a cost figure,
 * which is the number a budget is set from — and a screen quietly serving
 * replayed opportunities is indistinguishable on that screen from a connected
 * CRM. So: Salesforce with credentials, `recorded` only when
 * `CRM_PROVIDER=recorded` says so out loud, and otherwise an error naming the
 * variable.
 *
 * HubSpot is a **named** choice rather than an unrecognised one. Asking for it
 * gets "declared and not built, here is what building it means" rather than
 * "that is not a CRM this app has", because the second sentence is false and
 * would send somebody to check their spelling.
 */

export type CrmChoice = {
  provider: CrmProvider;
  source: 'salesforce' | 'hubspot' | 'recorded';
  /** True when figures are replayed. Every screen showing them must say so, and
   *  every ratio derived from them is withheld — see `roi/rollup.ts`. */
  replayed: boolean;
};

export function selectCrmProvider(
  env: Record<string, string | undefined> = process.env,
  opts: { capturedAtFor?: (email: string) => Date | null } = {},
): CrmChoice {
  const explicit = env.CRM_PROVIDER?.trim();

  if (explicit === 'recorded') {
    return {
      provider: new RecordedCrmProvider(opts.capturedAtFor),
      source: 'recorded',
      replayed: true,
    };
  }
  if (explicit === 'hubspot') {
    const provider = new HubSpotCrmProvider();
    throw new CrmNotImplementedError(
      provider.name,
      'SCOPE §11.6 chose to build one CRM well rather than two adequately, and step 19 built ' +
        'Salesforce. The seam is in src/lib/integrations/crm/hubspot/client.ts and its header ' +
        'lists exactly what finishing it takes.',
    );
  }
  if (explicit && explicit !== 'salesforce') {
    throw new Error(
      `CRM_PROVIDER is "${explicit}", which is not a CRM this app has. ` +
        'Use "salesforce", "hubspot" (declared, not built), or "recorded" to replay a captured ' +
        'conversion shape with no network.',
    );
  }

  const salesforce = new SalesforceCrmProvider(salesforceConfigFromEnv(env));
  if (!salesforce.isConfigured()) {
    throw new CrmNotConfiguredError('Salesforce', [
      'SALESFORCE_INSTANCE_URL',
      'SALESFORCE_ACCESS_TOKEN',
      'or CRM_PROVIDER=recorded to replay a conversion shape instead',
    ]);
  }
  return { provider: salesforce, source: 'salesforce', replayed: false };
}

/**
 * The same choice as a value.
 *
 * The ROI screen has to render on an install with no CRM — the cost side is
 * entirely ours and is most of what §1 promises — and only the return column
 * should be unavailable, saying which variable would fill it. A show with a real
 * cost and no connected CRM is a legible state; a blank page is not.
 */
export function selectCrmProviderOrNull(
  env: Record<string, string | undefined> = process.env,
  opts: { capturedAtFor?: (email: string) => Date | null } = {},
): { choice: CrmChoice } | { unavailable: string } {
  try {
    return { choice: selectCrmProvider(env, opts) };
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}
