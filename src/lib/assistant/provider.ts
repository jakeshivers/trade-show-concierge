import {
  ModelNotConfiguredError,
  type AssistantModel,
} from '@/lib/integrations/llm/types';
import {
  AnthropicAssistantModel,
  anthropicConfigFromEnv,
} from '@/lib/integrations/llm/anthropic/client';
import { ScriptedAssistantModel } from '@/lib/integrations/llm/scripted/provider';

/**
 * Choosing the model from the environment. The fourth application of
 * `travel/provider.ts`'s rule: **no fallback, ever.**
 *
 * The temptation is different in kind here. For fares the danger was replayed
 * availability passing as real; for delays, a replayed reading passing as a
 * carrier's. Prose has a worse version of the same problem, because a sentence
 * carries no provenance on its face — "MedTech's crate will not make the dock"
 * reads identically whether a model reasoned it out of live rows or a keyword
 * matcher guessed. So `scripted` is chosen only when asked for out loud, and
 * `ScriptedAssistantModel` is additionally built so that it *cannot* assert
 * anything: it plans tool calls and closes with a fixed disclosure.
 */

export type ModelChoice = {
  model: AssistantModel;
  source: 'anthropic' | 'scripted';
  /** True when no model reasoned. Every screen showing this must say so. */
  scripted: boolean;
};

export function selectAssistantModel(
  env: Record<string, string | undefined> = process.env,
): ModelChoice {
  const explicit = env.ASSISTANT_PROVIDER?.trim();

  if (explicit === 'scripted') {
    return { model: new ScriptedAssistantModel(), source: 'scripted', scripted: true };
  }
  if (explicit && explicit !== 'anthropic') {
    throw new Error(
      `ASSISTANT_PROVIDER is "${explicit}", which is not a model provider this app has. ` +
        'Use "anthropic", or "scripted" to run the loop against real tools with no key.',
    );
  }

  const claude = new AnthropicAssistantModel(anthropicConfigFromEnv(env));
  if (!claude.isConfigured()) {
    throw new ModelNotConfiguredError('Anthropic', [
      'ANTHROPIC_API_KEY',
      'or ASSISTANT_PROVIDER=scripted to run the tools with a keyword matcher instead',
    ]);
  }
  return { model: claude, source: 'anthropic', scripted: false };
}

/**
 * The same choice as a value. Unlike the flight board, there is no half of this
 * screen that still works without a provider — an assistant with no model is a
 * text box that does nothing — so the page renders the reason rather than a
 * degraded chat.
 */
export function selectAssistantModelOrNull(
  env: Record<string, string | undefined> = process.env,
): { choice: ModelChoice } | { unavailable: string } {
  try {
    return { choice: selectAssistantModel(env) };
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}
