/**
 * Slack Web API wire types — only the fields we read.
 *
 * **Unverified against a live workspace**, in the same words the AeroAPI,
 * EasyPost and Salesforce adapters use, so that nobody reads the absence of a
 * warning as evidence. Written to the published reference for
 * `users.lookupByEmail`, `conversations.open` and `chat.postMessage`.
 *
 * There is one thing about this API that a fixture written from the docs *can*
 * catch, and it is the reason this file exists at all rather than the client
 * reading `res.json()` inline:
 *
 * **Slack answers a failure with HTTP 200.** Every response carries `ok`, and a
 * bad token, a user who is not in the workspace, an archived channel and a
 * malformed payload all arrive as `200 {"ok": false, "error": "…"}`. A client
 * that checks `res.ok` — which is what every other adapter in this codebase
 * correctly does, because every other provider uses status codes — reports all
 * of them as delivered. That failure has no symptom: the delivery log fills with
 * `sent`, the screen says everybody was told, and nobody's phone ever buzzed.
 * `ok` is therefore non-optional in these types, and `client.ts` reads it before
 * anything else.
 */

/** Every Web API response. `ok` is the status; HTTP 200 is not. */
export type SlackEnvelope = {
  ok: boolean;
  /** Slack's own error slug: `users_not_found`, `channel_not_found`, … */
  error?: string;
  /** Present on some errors and worth surfacing verbatim. */
  needed?: string;
  provided?: string;
  /** Set on a partial success — the message went, something else did not. */
  warning?: string;
};

export type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    real_name?: string | null;
    display_name?: string | null;
    email?: string | null;
  } | null;
};

export type SlackUsersLookupByEmail = SlackEnvelope & { user?: SlackUser };

export type SlackConversation = { id?: string; name?: string; is_archived?: boolean };

/** `conversations.open` on a single user id returns the DM channel to post to. */
export type SlackConversationsOpen = SlackEnvelope & { channel?: SlackConversation };

export type SlackChatPostMessage = SlackEnvelope & {
  channel?: string;
  /** The message timestamp, which is also its id. */
  ts?: string;
};

/**
 * Block Kit, reduced to the two blocks we compose. Anything richer is a
 * rendering decision, and rendering decisions do not belong in an adapter.
 */
export type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'divider' };
