import type { FlightStatusProvider } from '@/lib/integrations/flightstatus/types';
import { StatusProviderNotConfiguredError } from '@/lib/integrations/flightstatus/types';
import {
  AeroApiStatusProvider,
  aeroApiConfigFromEnv,
} from '@/lib/integrations/flightstatus/aeroapi/client';
import { RecordedStatusProvider } from '@/lib/integrations/flightstatus/recorded/provider';

/**
 * Choosing the status provider from the environment. `travel/provider.ts`'s
 * rule, applied to the second integration: **no fallback, ever.**
 *
 * The temptation is stronger here than it was for fares, because a status
 * provider looks harmless — nobody spends money on a delay reading. But the
 * output of this one lands in an alert that says a colleague will or will not
 * make move-in, and a screen quietly replaying fixtures is indistinguishable on
 * that screen from a carrier feed. So: AeroAPI with a key, `recorded` only when
 * `FLIGHT_STATUS_PROVIDER=recorded` says so out loud, and otherwise an error
 * naming the variable.
 */

export type StatusProviderChoice = {
  provider: FlightStatusProvider;
  source: 'aeroapi' | 'recorded';
  /** True when readings are replayed. Every screen showing them must say so. */
  replayed: boolean;
};

export function selectStatusProvider(
  env: Record<string, string | undefined> = process.env,
): StatusProviderChoice {
  const explicit = env.FLIGHT_STATUS_PROVIDER?.trim();

  if (explicit === 'recorded') {
    return { provider: new RecordedStatusProvider(), source: 'recorded', replayed: true };
  }
  if (explicit && explicit !== 'aeroapi') {
    throw new Error(
      `FLIGHT_STATUS_PROVIDER is "${explicit}", which is not a status provider this app has. ` +
        'Use "aeroapi", or "recorded" to replay captured payloads with no network.',
    );
  }

  const aero = new AeroApiStatusProvider(aeroApiConfigFromEnv(env));
  if (!aero.isConfigured()) {
    throw new StatusProviderNotConfiguredError('AeroAPI', [
      'AEROAPI_KEY',
      'or FLIGHT_STATUS_PROVIDER=recorded to replay captured payloads instead',
    ]);
  }
  return { provider: aero, source: 'aeroapi', replayed: false };
}

/**
 * The same choice as a value. The board must render on an install with no key —
 * the flights are ours, the *readings* are the provider's — and only the live
 * column should be unavailable, saying which variable would fill it.
 */
export function selectStatusProviderOrNull(
  env: Record<string, string | undefined> = process.env,
): { choice: StatusProviderChoice } | { unavailable: string } {
  try {
    return { choice: selectStatusProvider(env) };
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}
