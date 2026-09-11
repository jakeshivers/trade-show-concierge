import type { NotificationTransport } from '@/lib/integrations/notify/types';
import { SlackTransport, slackConfigFromEnv } from '@/lib/integrations/notify/slack/client';
import { ConsoleTransport } from '@/lib/integrations/notify/console/provider';

/**
 * Choosing the transport from the environment. The sixth integration to follow
 * `travel/provider.ts`'s rule, and it holds here for a reason that is the
 * *inverse* of everywhere else.
 *
 * For the other five, the danger of a silent fallback is that a screen shows
 * replayed data indistinguishable from a supplier's answer. Here there is no
 * screen to fool: the danger is that the app claims to have told somebody
 * something. So the rule holds and the shape is slightly different — there is no
 * "not configured" error to throw, because **a workspace with no transport is a
 * legitimate, fully working state and has been this product's state for twenty
 * steps.** Every alert is still recorded, still readable on `/alerts`, and still
 * counted; it is simply carried nowhere.
 *
 * What must never happen is that state being indistinguishable from a delivered
 * one. So the fallback is not a silent one: `console` composes the real message
 * and reports `rendered`, never `sent`, and `reachesPeople` is false on it, so
 * every screen and every log row can say plainly that nothing has left the
 * building. An unnamed `NOTIFY_TRANSPORT` still throws, because a typo must not
 * quietly resolve to the transport that reaches nobody.
 */

export type TransportChoice = {
  transport: NotificationTransport;
  source: 'slack' | 'console';
  /** True when messages actually reach a person. */
  live: boolean;
};

export function selectTransport(
  env: Record<string, string | undefined> = process.env,
): TransportChoice {
  const explicit = env.NOTIFY_TRANSPORT?.trim();

  if (explicit === 'console') {
    return { transport: new ConsoleTransport(), source: 'console', live: false };
  }
  if (explicit && explicit !== 'slack') {
    throw new Error(
      `NOTIFY_TRANSPORT is "${explicit}", which is not a transport this app has. ` +
        'Use "slack", or "console" to compose messages and deliver them to nobody.',
    );
  }

  const slack = new SlackTransport(slackConfigFromEnv(env));
  if (slack.isConfigured()) return { transport: slack, source: 'slack', live: true };

  if (explicit === 'slack') {
    // Asked for by name and not configured. This one is an error rather than a
    // fallback: somebody set the variable expecting messages to arrive.
    throw new Error(
      'NOTIFY_TRANSPORT=slack, but SLACK_BOT_TOKEN is not set. Nothing would be delivered, ' +
        'and it would be recorded as though something had been.',
    );
  }

  return { transport: new ConsoleTransport(), source: 'console', live: false };
}

/** Where a link in a message points. Null on a workspace with no public origin. */
export function appBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  return env.APP_BASE_URL?.trim() || null;
}
