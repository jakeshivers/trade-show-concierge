/**
 * Notification transport interface — the sixth integration behind this shape,
 * and the first one that carries something *out* of the workspace rather than
 * asking a supplier a question.
 *
 * That inverts the risk every other adapter here manages. Duffel, AeroAPI,
 * EasyPost, Salesforce and Anthropic can all report something false; the
 * discipline in those files is about never letting an invented answer reach a
 * screen. A transport cannot report a false crate. What it can do is put a
 * colleague's fare, a stranger's name, or somebody's personal flight home in a
 * room that was never entitled to it — and unlike a wrong reading, that cannot
 * be corrected on the next poll.
 *
 * So the interface is deliberately narrow in a direction none of the others are:
 * it takes a **resolved address and a rendered message** and does nothing else.
 * It does not know what an alert is, cannot look up a person, cannot decide who
 * an audience is, and has no access to the database. Every one of those
 * decisions was made by an engine that knew what the alert was about, and
 * `notify/plan.ts` is the pure function that turns them into messages. As with
 * `flightstatus/types.ts`: the provider is the least testable thing in the loop,
 * so nothing that has to be right may live inside it.
 *
 * The one lookup it does own is `resolveAddress`, and only because an address is
 * transport-specific in a way nothing else in the app can know — a Slack member
 * id is not an email, and asking a person to paste one is how it stays wrong.
 */

/** A person's email → a transport address. Nothing else about them is sent. */
export type AddressQuery = { email: string };

export type ResolvedAddress = {
  /** Slack's `U…`, or whatever the transport calls one person. */
  address: string;
  kind: 'dm' | 'channel';
  /** What to show a person on a settings screen. */
  label: string | null;
};

/**
 * The transport has no such user.
 *
 * Distinct from an error, exactly as `NoRecord` is for a flight and a crate.
 * "This person is not in the Slack workspace" is an ordinary, actionable fact
 * about a contractor who was never invited; "Slack returned 500" is not, and
 * collapsing them means a settings screen that tells somebody to join a
 * workspace they are already in.
 */
export type NoAddress = { noAddress: true; reason: string };

export type AddressLookup = ResolvedAddress | NoAddress;

export function isNoAddress(r: AddressLookup): r is NoAddress {
  return 'noAddress' in r;
}

/**
 * One message, already rendered and already addressed.
 *
 * `text` is the whole message as plain text and is never optional: a transport
 * that renders only rich blocks is a transport whose notification previews,
 * screen readers and search results are blank.
 */
export type OutboundMessage = {
  address: string;
  kind: 'dm' | 'channel';
  text: string;
  /** Optional richer rendering. A transport that cannot do this ignores it. */
  sections?: { title: string; body: string; url?: string }[];
};

export type DeliveryReceipt = {
  transport: string;
  /**
   * `sent` means the transport says a person can now see it. `rendered` means
   * the message was composed and went nowhere — the console transport's only
   * possible answer, and it must never be dressed up as the first one. The
   * `recorded` flight provider may replay an offer and may not report a
   * purchase; the same line, drawn on the way out.
   */
  outcome: 'sent' | 'rendered';
  providerMessageId: string | null;
  detail: string | null;
};

export class TransportNotConfiguredError extends Error {
  constructor(readonly transport: string, readonly missingEnv: string[]) {
    super(
      `${transport} is not configured. Set ${missingEnv.join(', ')}. ` +
        'Until then every alert is still recorded and still readable on /alerts, ' +
        'and nothing is carried anywhere — which is the state this workspace has ' +
        'been in for twenty steps and says so on the page.',
    );
    this.name = 'TransportNotConfiguredError';
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly transport: string,
    /**
     * Whether the same message could plausibly succeed later. A rate limit is
     * retryable; an archived channel is not, and retrying it forever is the
     * badge that is always on.
     */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface NotificationTransport {
  readonly name: string;
  isConfigured(): boolean;
  /** True when nothing this transport does reaches a human. */
  readonly reachesPeople: boolean;
  resolveAddress(query: AddressQuery): Promise<AddressLookup>;
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
}
