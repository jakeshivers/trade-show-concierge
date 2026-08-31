import type { FlightProvider } from '@/lib/integrations/flights/types';
import { ProviderNotConfiguredError } from '@/lib/integrations/flights/types';
import { DuffelProvider, configFromEnv } from '@/lib/integrations/flights/duffel/client';
import { RecordedFlightProvider } from '@/lib/integrations/flights/recorded/provider';

/**
 * Choosing the flight provider from the environment.
 *
 * This did not exist before step 9, and the reason is worth writing down: until
 * there were screens, every caller was a script or a test, and each one
 * constructed the provider it wanted by hand — the dry-run script names
 * `RecordedFlightProvider` in its own source, which is honest, because a script
 * called `booking:dry-run` is allowed to say what it is. A web request has
 * nobody to name it, so the choice moves into configuration, and configuration
 * is exactly where "no fake data behind a real integration" is easiest to
 * violate by accident.
 *
 * The rule this file enforces: **the app never silently substitutes replayed
 * offers for real ones.** There is no fallback. With `DUFFEL_ACCESS_TOKEN` set
 * we use Duffel; with `FLIGHT_PROVIDER=recorded` explicitly set we replay; with
 * neither, searching throws an error naming the variable to set. A default that
 * quietly served recorded fixtures to a production screen would be indis-
 * tinguishable, on that screen, from real availability — and someone would plan
 * a trip around a fare that no airline ever quoted.
 *
 * SCOPE.md §6c rail 4, and the "no fake data behind a real integration"
 * non-negotiable.
 */

/** Only the handful of keys this file reads; `process.env` satisfies it. */
export type ProviderEnv = Record<string, string | undefined>;

export type ProviderChoice = {
  provider: FlightProvider;
  /** How it was chosen, for the banner every screen that searches has to show. */
  source: 'duffel' | 'recorded';
  /**
   * True when offers come from replayed payloads rather than an airline. Screens
   * must say so; a fare is not a fare if nobody is selling it.
   */
  replayed: boolean;
};

/**
 * The one place that reads the environment. Never called at module scope — a
 * provider captured at import time would outlive an env change and, worse,
 * would be constructed during the build.
 */
export function selectProvider(env: ProviderEnv = process.env): ProviderChoice {
  const explicit = env.FLIGHT_PROVIDER?.trim();

  if (explicit === 'recorded') {
    return { provider: new RecordedFlightProvider(), source: 'recorded', replayed: true };
  }

  if (explicit && explicit !== 'duffel') {
    throw new Error(
      `FLIGHT_PROVIDER is "${explicit}", which is not a provider this app has. ` +
        'Use "duffel", or "recorded" to replay captured payloads with no network.',
    );
  }

  const duffel = new DuffelProvider(configFromEnv(env));
  if (!duffel.isConfigured()) {
    // Deliberately the same error the provider itself raises, rather than a
    // quiet downgrade to `recorded`. The missing thing is a key, and the message
    // has to name it.
    throw new ProviderNotConfiguredError('Duffel', [
      'DUFFEL_ACCESS_TOKEN',
      'or FLIGHT_PROVIDER=recorded to replay captured payloads instead',
    ]);
  }
  return { provider: duffel, source: 'duffel', replayed: false };
}

/**
 * The same choice as a value rather than a throw, for screens that need to
 * render *before* anyone asks them to search. A travel request list must load on
 * an unconfigured install — the requests are ours, not the provider's — and only
 * the search button should be unavailable.
 */
export function selectProviderOrNull(
  env: ProviderEnv = process.env,
): { choice: ProviderChoice } | { unavailable: string } {
  try {
    return { choice: selectProvider(env) };
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}
