import {
  AnthropicDeadlineExtractor,
  extractConfigFromEnv,
} from '@/lib/integrations/extract/anthropic/client';
import type { DeadlineExtractor } from '@/lib/integrations/extract/types';

/**
 * Environment → extractor. **No fallback, and no zero-key mode.**
 *
 * The other six selectors read a variable and answer `recorded` when explicitly
 * asked, so a clean clone can be shown working. This one cannot offer that, and
 * the absence is the design rather than a gap: a replayed extraction is a set of
 * assertions about a document the fixture never saw, landing on the screen where
 * a person confirms them into quoted penalties. `integrations/extract/types.ts`
 * has the long version.
 *
 * What a clean clone gets instead is an error naming the variable — the same
 * answer `selectProvider` gives for fares, and for a sharper reason. Nobody
 * spends money on a delay reading; the sentence this one produces is "the
 * warehouse cutoff is February 3."
 */
export function selectDeadlineExtractor(
  env: Record<string, string | undefined> = process.env,
): DeadlineExtractor {
  const config = extractConfigFromEnv(env);
  const extractor = new AnthropicDeadlineExtractor(config);
  if (!extractor.isConfigured()) {
    throw new Error(
      'Reading a service manual needs ANTHROPIC_API_KEY. There is no replayed extractor to ' +
        'fall back to: a canned deadline is a claim about a document nothing has read, on the ' +
        'screen where somebody confirms it into a figure the alert engine quotes in dollars.',
    );
  }
  return extractor;
}

export function extractorIsConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return new AnthropicDeadlineExtractor(extractConfigFromEnv(env)).isConfigured();
}
