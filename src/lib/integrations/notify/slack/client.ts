import type {
  AddressLookup,
  AddressQuery,
  DeliveryReceipt,
  NotificationTransport,
  OutboundMessage,
} from '../types';
import { TransportError, TransportNotConfiguredError } from '../types';
import type {
  SlackBlock,
  SlackChatPostMessage,
  SlackConversationsOpen,
  SlackEnvelope,
  SlackUsersLookupByEmail,
} from './wire';

/**
 * Slack Web API — the real notification transport.
 *
 * **Never run against a live workspace**, recorded here where anybody choosing
 * to trust it will read it, in the same words the AeroAPI, EasyPost and
 * Salesforce clients use. The types are written from the published reference and
 * the tests run against a mock transport we wrote ourselves; a closed loop like
 * that proves internal consistency and structurally cannot catch a wrong field
 * name. `SLACK_BOT_TOKEN` is the arbiter when somebody has one.
 *
 * What is *not* unverified is the failure shape, and it is the one thing about
 * this API worth writing down twice: **Slack answers failures with HTTP 200 and
 * `{"ok": false}`.** `wire.ts` has the long version. Every response here goes
 * through `call()`, which reads `ok` before anything else, so there is exactly
 * one place that can get it wrong.
 *
 * Three scopes are needed and the settings screen names them:
 * `users:read.email` (to turn a colleague's email into a member id),
 * `chat:write` (to post) and `im:write` (to open the DM). We ask for no history
 * scope and read no messages — this transport is write-only, and a bot that can
 * read a workspace's conversations is a much larger thing to install than one
 * that can post to them.
 */

const BASE_URL = 'https://slack.com/api';

export type SlackConfig = {
  botToken?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export function slackConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SlackConfig {
  return { botToken: env.SLACK_BOT_TOKEN, baseUrl: env.SLACK_BASE_URL };
}

/**
 * Slack error slugs we can say something useful about.
 *
 * The rest are surfaced verbatim rather than rewritten into a friendly
 * sentence: a slug a person can search for beats a paraphrase that loses it.
 */
const NOT_RETRYABLE = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'missing_scope',
  'channel_not_found',
  'is_archived',
  'user_not_found',
  'users_not_found',
  'not_in_channel',
  'restricted_action',
  'invalid_arguments',
]);

export class SlackTransport implements NotificationTransport {
  readonly name = 'slack';
  readonly reachesPeople = true;

  constructor(private readonly config: SlackConfig = slackConfigFromEnv()) {}

  isConfigured(): boolean {
    return Boolean(this.config.botToken);
  }

  /**
   * One person's email → their member id.
   *
   * This is the only thing about a colleague that leaves the building on this
   * path, and it leaves it to a workspace they are already a member of. That is
   * worth stating because §5j's rule — a stranger's details must not travel
   * somewhere they were never collected for — is what gates *lead* email
   * matching in `roi/store.ts`. It does not bite here: these are our own
   * employees' work addresses, going to the chat tool their employer already
   * runs. A lead's email never reaches this file, and there is no code path by
   * which it could, because `plan.ts` composes from alerts and an alert body is
   * written by an engine.
   */
  async resolveAddress(query: AddressQuery): Promise<AddressLookup> {
    const body = await this.call<SlackUsersLookupByEmail>('users.lookupByEmail', {
      email: query.email,
    });

    if (!body.ok) {
      if (body.error === 'users_not_found') {
        return {
          noAddress: true,
          reason:
            `Slack has no member with the address ${query.email}. Either they are not in ` +
            'this workspace, or their Slack account uses a different email than their ' +
            'account here — both are ordinary, and neither is an error to retry.',
        };
      }
      throw this.errorFor(body, 'users.lookupByEmail');
    }

    const user = body.user;
    if (!user?.id) {
      throw new TransportError(
        'Slack returned ok with no user id for users.lookupByEmail.',
        this.name,
        false,
      );
    }
    // A deactivated account is a real row that cannot be reached. Reporting it
    // as an address would leave every message to that person recorded as sent.
    if (user.deleted) {
      return {
        noAddress: true,
        reason: `${query.email} is a deactivated Slack account.`,
      };
    }

    return {
      address: user.id,
      kind: 'dm',
      label: user.profile?.display_name || user.profile?.real_name || user.real_name || null,
    };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    // A DM is posted to a *conversation*, not to a user id, so a member id has
    // to be opened first. `chat.postMessage` accepts a `U…` and opens the DM
    // itself, but only sometimes and not for every app configuration, so this
    // does it explicitly rather than depending on the convenience.
    let channel = message.address;
    if (message.kind === 'dm') {
      const opened = await this.call<SlackConversationsOpen>('conversations.open', {
        users: message.address,
      });
      if (!opened.ok) throw this.errorFor(opened, 'conversations.open');
      if (!opened.channel?.id) {
        throw new TransportError(
          'Slack opened a conversation with no channel id.',
          this.name,
          false,
        );
      }
      channel = opened.channel.id;
    }

    const posted = await this.call<SlackChatPostMessage>('chat.postMessage', {
      channel,
      text: clamp(message.text, TEXT_LIMIT),
      blocks: blocksFor(message),
      // Every link in an alert is to our own app, and unfurling them would
      // either leak a page title into the channel or, more likely, render a
      // sign-in page as a preview under every message.
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!posted.ok) throw this.errorFor(posted, 'chat.postMessage');

    return {
      transport: this.name,
      outcome: 'sent',
      providerMessageId: posted.ts ?? null,
      detail: posted.warning ?? null,
    };
  }

  private async call<T extends SlackEnvelope>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const token = this.config.botToken;
    if (!token) throw new TransportNotConfiguredError('Slack', ['SLACK_BOT_TOKEN']);

    const doFetch = this.config.fetch ?? fetch;
    const res = await doFetch(`${this.config.baseUrl ?? BASE_URL}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    // An HTTP-level failure is real and separate: 429 with `Retry-After`, and
    // 5xx. Everything else Slack reports inside the body, which is what `ok` is
    // for and why this cannot end at `res.ok`.
    if (res.status === 429) {
      throw new TransportError(
        `Slack rate-limited ${method}; retry after ${res.headers.get('retry-after') ?? '?'}s.`,
        this.name,
        true,
        429,
      );
    }
    if (!res.ok) {
      throw new TransportError(`Slack returned ${res.status} for ${method}.`, this.name, res.status >= 500, res.status);
    }
    return (await res.json()) as T;
  }

  private errorFor(body: SlackEnvelope, method: string): TransportError {
    const slug = body.error ?? 'unknown_error';
    const scope =
      slug === 'missing_scope' && body.needed
        ? ` This app is missing the ${body.needed} scope (it has ${body.provided ?? 'none listed'}).`
        : '';
    return new TransportError(
      `Slack refused ${method}: ${slug}.${scope}`,
      this.name,
      !NOT_RETRYABLE.has(slug),
      200,
    );
  }
}

/**
 * Block Kit for the same content `text` already carries.
 *
 * Deliberately a second rendering of one message rather than the only one: a
 * Slack notification preview, a screen reader and a search result all read
 * `text`, and an app that puts its content only in blocks is an app whose
 * notifications say "sent a message".
 */
export function blocksFor(message: OutboundMessage): SlackBlock[] | undefined {
  if (!message.sections?.length) return undefined;
  const blocks: SlackBlock[] = [];
  for (const s of message.sections) {
    if (blocks.length) blocks.push({ type: 'divider' });
    const heading = s.url ? `*<${s.url}|${escapeMrkdwn(s.title)}>*` : `*${escapeMrkdwn(s.title)}*`;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clamp(`${heading}\n${escapeMrkdwn(s.body)}`, SECTION_LIMIT) },
    });
  }
  // Slack rejects a payload over 50 blocks outright, which would turn a busy
  // night into no message at all — the one outcome worse than a long one.
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * Slack's two hard limits, and the reason they are enforced here rather than in
 * the planner.
 *
 * A section over 3,000 characters and a payload over 50 blocks are both **hard
 * rejections**, not truncations — the whole message fails with `invalid_blocks`,
 * so one wordy alert takes every other alert in the digest down with it. The
 * engines here write long, deliberately: `assets/alerts.ts` explains an
 * insurance conversation in a paragraph because a shorter sentence would be
 * read as a reminder. Neither of them should have to know a chat vendor's
 * character count, and a planner that trimmed to Slack's numbers would be
 * trimming the *console* transport's output too. So the limits live in the
 * adapter that has them, `text` carries the untruncated message, and what is cut
 * is cut visibly.
 */
const SECTION_LIMIT = 2_900;
const MAX_BLOCKS = 50;
/** `text` is capped at 40,000; well under it, and a digest is not an essay. */
const TEXT_LIMIT = 35_000;

export function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Named rather than an ellipsis: somebody reading a truncated alert has to be
  // able to tell it was truncated by us and not written that way by the engine.
  return `${text.slice(0, limit - 40)}\n… trimmed — open it in the app.`;
}

/** Slack's three reserved characters. Everything else is literal. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
