import type { ShipmentTrackingProvider } from '@/lib/integrations/shipping/types';
import { TrackingProviderNotConfiguredError } from '@/lib/integrations/shipping/types';
import {
  EasyPostTrackingProvider,
  easyPostConfigFromEnv,
} from '@/lib/integrations/shipping/easypost/client';
import { RecordedTrackingProvider } from '@/lib/integrations/shipping/recorded/provider';

/**
 * Choosing the tracking provider from the environment. The third integration to
 * follow `travel/provider.ts`'s rule, and it is not negotiable at any of them:
 * **no fallback, ever.**
 *
 * The temptation is at its strongest here. Nobody spends money on a tracking
 * reading, the data is not personal, and a wrong one seems cheap. But the
 * sentence this produces is "the booth will be there before the doors open",
 * and a screen quietly replaying fixtures is indistinguishable on that screen
 * from a carrier feed. So: EasyPost with a key, `recorded` only when
 * `SHIPMENT_TRACKING_PROVIDER=recorded` says so out loud, and otherwise an error
 * naming the variable.
 */

export type TrackingProviderChoice = {
  provider: ShipmentTrackingProvider;
  source: 'easypost' | 'recorded';
  /** True when readings are replayed. Every screen showing them must say so. */
  replayed: boolean;
};

export function selectTrackingProvider(
  env: Record<string, string | undefined> = process.env,
): TrackingProviderChoice {
  const explicit = env.SHIPMENT_TRACKING_PROVIDER?.trim();

  if (explicit === 'recorded') {
    return { provider: new RecordedTrackingProvider(), source: 'recorded', replayed: true };
  }
  if (explicit && explicit !== 'easypost') {
    throw new Error(
      `SHIPMENT_TRACKING_PROVIDER is "${explicit}", which is not a tracking provider this app has. ` +
        'Use "easypost", or "recorded" to replay captured payloads with no network.',
    );
  }

  const easypost = new EasyPostTrackingProvider(easyPostConfigFromEnv(env));
  if (!easypost.isConfigured()) {
    throw new TrackingProviderNotConfiguredError('EasyPost', [
      'EASYPOST_API_KEY',
      'or SHIPMENT_TRACKING_PROVIDER=recorded to replay captured payloads instead',
    ]);
  }
  return { provider: easypost, source: 'easypost', replayed: false };
}

/**
 * The same choice as a value. The board must render on an install with no key —
 * the shipments are ours, the *scans* are the carrier's — and only the live
 * column should be unavailable, saying which variable would fill it.
 */
export function selectTrackingProviderOrNull(
  env: Record<string, string | undefined> = process.env,
): { choice: TrackingProviderChoice } | { unavailable: string } {
  try {
    return { choice: selectTrackingProvider(env) };
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}
