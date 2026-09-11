import type {
  AddressLookup,
  AddressQuery,
  DeliveryReceipt,
  NotificationTransport,
  OutboundMessage,
} from '../types';

/**
 * The zero-key transport, and the one place in this codebase where the
 * `recorded` pattern could not be reused.
 *
 * Every other integration has a replay: `recorded` Duffel offers, AeroAPI
 * readings, EasyPost scans, a CRM conversion shape, a scripted tool plan. All
 * five obey one rule — **describe a shape, never assert a fact about this
 * workspace** — and all five work because the thing being replayed is an
 * *answer* from a supplier. A transport has no answer to replay. What it
 * produces is an event in the world: somebody's phone buzzed. There is no shape
 * of that which is not simply a claim, and a transport that returned `sent`
 * because a fixture said so would fill the delivery log with the one lie this
 * whole feature exists to make impossible — a screen saying everybody was told,
 * on a workspace where nothing has ever been carried anywhere.
 *
 * So this is not a replay. It composes the real message, from the real alerts,
 * with the real planner, and then delivers it **to nobody**, and says so:
 * `outcome: 'rendered'`. The delivery log is honest, `/settings/notifications`
 * can print "no message has ever left this workspace", and `pnpm nightly` prints
 * the messages verbatim — which is the only way to read what a colleague would
 * actually receive without installing a Slack app first.
 *
 * `reachesPeople` is false, and every screen that shows a delivery reads it.
 */
export class ConsoleTransport implements NotificationTransport {
  readonly name = 'console';
  readonly reachesPeople = false;

  /** Messages this process composed, in order. `pnpm nightly` prints these. */
  readonly outbox: OutboundMessage[] = [];

  constructor(private readonly log: ((message: OutboundMessage) => void) | null = null) {}

  isConfigured(): boolean {
    return true;
  }

  /**
   * An address that is deliberately not a Slack id.
   *
   * It resolves — the settings screen and the planner have to be exercisable
   * with no keys, and a transport whose address lookup always failed would make
   * every person permanently `undeliverable`, which is a different wrong answer.
   * But the value is prefixed and unmistakable, so a row written under this
   * transport can never be confused for one that could reach a person, in a
   * query or on a screen. The `dryrun:` order-id rule, on the way out.
   */
  async resolveAddress(query: AddressQuery): Promise<AddressLookup> {
    return { address: `console:${query.email}`, kind: 'dm', label: query.email };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.outbox.push(message);
    this.log?.(message);
    return {
      transport: this.name,
      outcome: 'rendered',
      providerMessageId: null,
      detail: 'Composed and delivered to nobody: no transport is configured.',
    };
  }
}
