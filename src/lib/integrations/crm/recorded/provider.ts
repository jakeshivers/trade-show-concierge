import type {
  AttributionResult,
  CrmOpportunity,
  CrmProvider,
  MatchLookup,
} from '../types';
import { normalizeContact, normalizeContactRole } from '../salesforce/normalize';
import type { SalesforceContactRoleRecord } from '../salesforce/wire';

/**
 * A CRM provider that replays a recorded *shape* instead of asking Salesforce —
 * and the one `recorded` provider in this product that had to be argued about
 * rather than copied.
 *
 * The other three replays obey one rule: **describe a shape, never assert a fact
 * about this workspace.** EasyPost's projects a recorded journey ("stalled",
 * "two days late") onto the crate's real transit window. AeroAPI's projects a
 * block time onto the leg being asked about. The scripted model replays which
 * *tools* to call and writes no prose, because a canned sentence about this
 * company would land on screen under the app's byline.
 *
 * A CRM has no obvious shape to separate from its claim. "$340,000 sourced by
 * MedTech Summit" is not a shape; it is a sentence about this company's
 * pipeline, and it would land beside a real cost, in the headline, on the one
 * screen where a wrong number gets a show cut. So this file does three things
 * the other replays did not need:
 *
 * 1. **It invents no people.** It answers only about email addresses it is
 *    *given*, which are leads this workspace actually captured. It cannot
 *    produce a contact nobody met.
 * 2. **It replays a conversion shape, not a pipeline.** Which fraction of booth
 *    conversations become opportunities, how long after the show, roughly how
 *    large, and where they end up — that genuinely is a shape, and it is
 *    projected onto the lead's own capture date the way a transit shape is
 *    projected onto a crate's real window. What it must not do is decide that
 *    *this* show did well.
 * 3. **Everything it returns is stamped replayed, all the way to the screen**,
 *    and `roi/rollup.ts` withholds every ratio derived from it — the pipeline
 *    multiple, cost per opportunity, the closed-won verdict. A banner is what
 *    the other replays needed; money needs the derived number withheld too,
 *    because a reader who has learned to skim a banner has not learned to skim a
 *    multiple.
 *
 * The scenario is chosen by hashing the email, so the same person tells the same
 * story on every run and across a re-sync — which is what makes an attribution
 * figure stable enough to test at all. A random draw would be a dashboard that
 * says something different on every reload, which is indistinguishable from a
 * bug.
 *
 * Payloads are Salesforce-shaped and go through the **real** normalizer, so
 * everything from the wire format inward is production code.
 */

export type ConversionScenario =
  /** The booth conversation went nowhere. The commonest outcome, and it is not a failure. */
  | 'no_opportunity'
  /** An opportunity opened weeks later and is still open. */
  | 'open_soon'
  /** Opened late in the attribution window — the case the window itself decides. */
  | 'open_late'
  /** Opened and won. */
  | 'won'
  /** Opened and lost. Reported, because a pipeline of only wins is a lie by omission. */
  | 'lost'
  /** Opened *before* we ever met them: this show did not source it. */
  | 'predates';

/**
 * Weighted so that most conversations produce nothing.
 *
 * That is the shape worth replaying. A fixture where every lead converts would
 * make the withheld-ratio machinery unreachable and would teach a reader that
 * booth capture is a pipeline faucet, which is the belief §8c exists to correct.
 */
const CYCLE: ConversionScenario[] = [
  'no_opportunity',
  'open_soon',
  'no_opportunity',
  'won',
  'no_opportunity',
  'open_late',
  'no_opportunity',
  'lost',
  'no_opportunity',
  'predates',
];

export function scenarioFor(key: string): ConversionScenario {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}

/** A stable pseudo-amount in cents, so the same person is always worth the same. */
function amountFor(key: string, floorCents: number, spanCents: number): number {
  let h = 7;
  for (const ch of key) h = (h * 37 + ch.charCodeAt(0)) >>> 0;
  return floorCents + (h % spanCents);
}

const DAY = 86_400_000;

type Recall = { email: string; externalId: string; capturedAt: Date };

export class RecordedCrmProvider implements CrmProvider {
  readonly name = 'recorded';

  /**
   * Everybody this replay has been *asked* about, and when we met them.
   *
   * It is a memory of the questions rather than a database of people, which is
   * the mechanical form of "it invents no people": `opportunitiesFor` can only
   * answer about ids this instance itself handed out.
   */
  private readonly seen = new Map<string, Recall>();

  constructor(
    private readonly capturedAtFor: (email: string) => Date | null = () => null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async matchByExternalId(externalId: string): Promise<MatchLookup> {
    const recall = [...this.seen.values()].find((r) => r.externalId === externalId);
    if (!recall) {
      return {
        noMatch: true,
        reason:
          'This replay has not been asked about that id in this run. It answers only about ' +
          'people this workspace actually captured; it holds no directory of its own.',
      };
    }
    return normalizeContact(
      { Id: externalId, Name: null, Email: recall.email, Account: null },
      'contact',
      'certain',
    );
  }

  /**
   * Always a match, including for the people who converted to nothing.
   *
   * Deliberate: plenty of real contacts sit in a CRM with no opportunity on
   * them, and collapsing "the CRM has never heard of them" into "they produced
   * no pipeline" would erase the distinction the ROI coverage model is built to
   * report. Only the id-space is invented here; the person is one this workspace
   * actually met.
   */
  async matchByEmail(email: string): Promise<MatchLookup> {
    return this.remember(email, 'possible');
  }

  private remember(email: string, confidence: 'certain' | 'possible'): MatchLookup {
    const externalId = `003REPLAY${hash8(email)}`;
    this.seen.set(externalId, {
      email,
      externalId,
      capturedAt: this.capturedAtFor(email) ?? new Date(),
    });
    return normalizeContact(
      { Id: externalId, Name: null, Email: email, Account: null },
      'contact',
      confidence,
    );
  }

  async opportunitiesFor(contactExternalIds: string[]): Promise<CrmOpportunity[]> {
    const out: CrmOpportunity[] = [];
    for (const id of contactExternalIds) {
      const recall = this.seen.get(id);
      // No recall means we were never asked about this person in this run, and
      // the honest answer is silence rather than an invented deal.
      if (!recall) continue;
      const record = this.build(recall);
      if (!record) continue;
      const opp = normalizeContactRole(record);
      if (opp) out.push(opp);
    }
    return out;
  }

  /**
   * The projection: a conversion shape laid over the date we actually met this
   * person, exactly as the EasyPost replay lays a journey over a crate's real
   * transit window. Nothing here knows which show it is, what the show cost, or
   * how many leads it produced — which is what keeps it from having an opinion
   * about whether the show was worth doing.
   */
  private build(recall: Recall): SalesforceContactRoleRecord | null {
    const scenario = scenarioFor(recall.email);
    if (scenario === 'no_opportunity') return null;

    const met = recall.capturedAt.getTime();
    const amountCents = amountFor(recall.email, 1_800_000, 24_200_000);

    const plans: Record<
      Exclude<ConversionScenario, 'no_opportunity'>,
      { createdOffset: number; closeOffset: number; stage: string; won: boolean; closed: boolean }
    > = {
      open_soon: { createdOffset: 21, closeOffset: 150, stage: 'Qualification', won: false, closed: false },
      open_late: { createdOffset: 164, closeOffset: 300, stage: 'Value Proposition', won: false, closed: false },
      won: { createdOffset: 34, closeOffset: 128, stage: 'Closed Won', won: true, closed: true },
      lost: { createdOffset: 26, closeOffset: 96, stage: 'Closed Lost', won: false, closed: true },
      // Created before we met them. The single most important scenario in this
      // file: it is what makes `sourced` mean anything, because a model that
      // cannot produce an opportunity it did not source cannot be tested for
      // refusing to claim one.
      predates: { createdOffset: -75, closeOffset: 90, stage: 'Negotiation', won: false, closed: false },
    };
    const plan = plans[scenario];
    const createdAt = new Date(met + plan.createdOffset * DAY);

    // Hands back only what has already happened — the EasyPost replay's rule,
    // and it is not a nicety here. A conversion shape says "an opportunity opens
    // about three weeks later", and projected onto a lead captured at a show
    // that is running *right now* that lands three weeks in the future. A CRM
    // cannot have created a record it has not created yet, and a live show
    // reporting sourced pipeline before its own doors close is the most obvious
    // possible tell that a number came from a fixture.
    if (createdAt.getTime() > this.now().getTime()) return null;

    return {
      ContactId: recall.externalId,
      Role: 'Decision Maker',
      IsPrimary: true,
      Opportunity: {
        Id: `006REPLAY${hash8(recall.email)}`,
        Name: `Replayed opportunity · ${recall.email.split('@')[1] ?? 'account'}`,
        StageName: plan.stage,
        Amount: amountCents / 100,
        CurrencyIsoCode: 'USD',
        IsWon: plan.won,
        IsClosed: plan.closed,
        CreatedDate: createdAt.toISOString(),
        CloseDate: new Date(met + plan.closeOffset * DAY).toISOString().slice(0, 10),
        LastActivityDate: new Date(met + Math.max(1, plan.createdOffset) * DAY).toISOString(),
        Owner: { Name: 'Replayed owner' },
      },
    };
  }

  /**
   * The write is refused rather than faked.
   *
   * Every other method here replays a shape that came from somewhere. A write
   * has no shape to replay: reporting `written: true` would mean this app told a
   * person their CRM now carries the attribution, when nothing was told to
   * anybody. That is the one lie a replay can tell that survives contact with
   * the outside world — somebody goes looking in Salesforce for a field we said
   * we wrote.
   */
  async writeAttribution(): Promise<AttributionResult> {
    return {
      written: false,
      reason:
        'The recorded provider does not write. There is no CRM on the other end of it, and ' +
        'reporting a successful write would send somebody looking in Salesforce for a field ' +
        'nothing ever set.',
    };
  }
}

function hash8(input: string): string {
  let h = 2166136261;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').toUpperCase();
}
