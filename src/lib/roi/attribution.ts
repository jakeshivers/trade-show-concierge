import type { OpportunityStageKind } from '@/lib/integrations/crm/types';

/**
 * Which show gets the credit — §8b, and the honest hard part.
 *
 * Pure. A lead met at a booth in March that closes in November had a dozen other
 * touches, and no arithmetic settles that. §8b's answer is to refuse to pick:
 * compute **both** defensible models, label the window on every figure, and
 * default to the conservative one because it is the number a CFO will not
 * discount. §11.7 chose **sourced, 180 days** (2026-09-01).
 *
 * Four refusals live here, and three of them are the reason this file is not
 * three lines of date comparison.
 *
 * **1. Sourced means first touch, and first touch is a fact about our own data
 * before it is a fact about the CRM.** An opportunity created after we met
 * somebody is not sourced by the show that met them if an *earlier* show already
 * met the same person. That is not a hypothetical: it is the second year of any
 * recurring calendar, where the same buyer walks the same booth annually, and a
 * naive "created after this show, within the window" test hands every one of
 * those opportunities to the most recent show — the newest show always wins,
 * every year, silently. So sourcing is decided against the **earliest capture of
 * that person anywhere in the workspace**, which is the only place that fact
 * exists. §5j's dedupe rule pointed the other way and for the same reason:
 * identity is within a show for *counting*, and across shows for *crediting*.
 *
 * **2. One opportunity is sourced to at most one show, ever.** Otherwise the
 * portfolio's sourced pipeline exceeds the pipeline, which is a number a
 * finance reader will spot in about four seconds and never trust again.
 *
 * **3. Influenced deliberately does not sum, and the portfolio has to say so.**
 * The same opportunity is legitimately influenced by three shows; that is what
 * the model means. Adding the influenced figures across a calendar therefore
 * triple-counts, and a portfolio total for influenced pipeline is a number with
 * no referent. `summarizeAttribution` returns the *distinct* influenced total
 * and the per-show figures separately, and never a sum of the latter.
 *
 * **4. An opportunity created before we met the person is influenced at most,
 * never sourced** — even if it closed the week after the show. This is the one
 * the window does not catch, and the one that inflates most flatteringly: a
 * six-figure deal already in the pipeline, a booth conversation with the same
 * buyer, and a show that appears to have originated it.
 *
 * **5. When first touch falls outside the window, nobody sources the
 * opportunity — the runner-up does not inherit it.** This one was found by a
 * test written to assert something else, and it is the sharpest consequence of
 * refusals 1 and 3 meeting. We met somebody at a show 300 days ago and again 40
 * days ago; a deal opens 20 days later. The recent show is inside the window and
 * did not originate the relationship; the show that did is outside it. The
 * tempting answer is to credit the recent show, because *some* show clearly
 * ought to get it and that one is at least in range — and it is the same
 * silently-favours-the-newest-show failure as refusal 1, arriving by a route
 * that looks like generosity rather than sloppiness. Sourced is the conservative
 * model on purpose: an opportunity nobody may honestly claim is claimed by
 * nobody, and it stays visible in the influenced figure beside it.
 */

export type AttributionModel = 'sourced' | 'influenced';

/** §11.7, resolved 2026-09-01. Recommended in §8b for the reason above. */
export const DEFAULT_MODEL: AttributionModel = 'sourced';
export const DEFAULT_WINDOW_DAYS = 180;

export const MODEL_LABEL: Record<AttributionModel, string> = {
  sourced: 'Sourced',
  influenced: 'Influenced',
};

const DAY = 86_400_000;

/** A lead, reduced to what attribution actually needs. */
export type AttributableLead = {
  leadId: string;
  showId: string;
  capturedAt: Date;
  /** The CRM record this lead is linked to. Null means unattributable, by construction. */
  contactExternalId: string | null;
};

export type AttributableOpportunity = {
  externalId: string;
  contactExternalId: string | null;
  amountCents: number | null;
  stageKind: OpportunityStageKind;
  /** When the CRM created it. Null makes sourcing undecidable — see `Undecidable`. */
  crmCreatedAt: Date | null;
  closeDate: Date | null;
  replayed: boolean;
};

export type AttributionVerdict =
  /** This show met the person first, and the opportunity opened inside the window after. */
  | { kind: 'sourced'; showId: string; daysAfter: number }
  /** The show touched the opportunity's life without originating it. */
  | { kind: 'influenced'; showId: string; reason: string }
  /** Neither. Kept rather than dropped, because "why is this not counted" is a real question. */
  | { kind: 'none'; reason: string }
  /**
   * The CRM did not say when the opportunity was created, so first touch cannot
   * be established at all. Deliberately its own verdict rather than folded into
   * `none`: one is a decision and the other is an absence of data, and a
   * coverage model that cannot tell them apart reports a clean sheet on a broken
   * sync.
   */
  | { kind: 'undecidable'; reason: string };

export type OpportunityAttribution = {
  opportunity: AttributableOpportunity;
  /** Every show that touched it, in the influenced sense. May be several. */
  influencedShowIds: string[];
  /** At most one, ever. See refusal 2. */
  sourcedShowId: string | null;
  verdicts: Map<string, AttributionVerdict>;
};

export type AttributionSettings = {
  model: AttributionModel;
  windowDays: number;
};

export const DEFAULT_SETTINGS: AttributionSettings = {
  model: DEFAULT_MODEL,
  windowDays: DEFAULT_WINDOW_DAYS,
};

/**
 * Attribute every opportunity across the whole portfolio at once.
 *
 * Portfolio-wide rather than per show, and that is forced rather than
 * convenient: refusal 1 needs the earliest capture of a person *anywhere*, and
 * refusal 2 needs to know that no other show has already claimed the
 * opportunity. A per-show function would be structurally incapable of either,
 * and would be wrong in the flattering direction — which is the direction
 * nobody audits.
 */
export function attributeAll(
  leads: AttributableLead[],
  opportunities: AttributableOpportunity[],
  settings: AttributionSettings = DEFAULT_SETTINGS,
): OpportunityAttribution[] {
  /** contact id → every capture of that person, oldest first. */
  const byContact = new Map<string, AttributableLead[]>();
  for (const lead of leads) {
    if (!lead.contactExternalId) continue;
    const list = byContact.get(lead.contactExternalId) ?? [];
    list.push(lead);
    byContact.set(lead.contactExternalId, list);
  }
  for (const list of byContact.values()) {
    list.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }

  const out: OpportunityAttribution[] = [];
  for (const opp of opportunities) {
    out.push(attributeOne(opp, byContact.get(opp.contactExternalId ?? '') ?? [], settings));
  }
  return out;
}

function attributeOne(
  opp: AttributableOpportunity,
  captures: AttributableLead[],
  settings: AttributionSettings,
): OpportunityAttribution {
  const verdicts = new Map<string, AttributionVerdict>();
  const influenced: string[] = [];
  let sourcedShowId: string | null = null;

  if (captures.length === 0) {
    return { opportunity: opp, influencedShowIds: [], sourcedShowId: null, verdicts };
  }

  const window = settings.windowDays * DAY;
  // Refusal 1: the earliest capture anywhere, not the earliest on this show.
  const firstTouch = captures[0];

  for (const lead of captures) {
    const showId = lead.showId;
    if (verdicts.has(showId)) continue;

    if (!opp.crmCreatedAt) {
      verdicts.set(showId, {
        kind: 'undecidable',
        reason:
          'The CRM did not say when this opportunity was created, so whether the show came ' +
          'first cannot be established. It is not counted as sourced and it is not counted as ' +
          'nothing.',
      });
      continue;
    }

    const gap = opp.crmCreatedAt.getTime() - lead.capturedAt.getTime();

    if (gap < 0) {
      // Refusal 4. Still influenced: the conversation happened while the
      // opportunity was live, which is exactly what influenced means.
      verdicts.set(showId, {
        kind: 'influenced',
        showId,
        reason: 'The opportunity already existed when we met them. A show cannot source a deal it walked into.',
      });
      influenced.push(showId);
      continue;
    }

    if (gap > window) {
      verdicts.set(showId, {
        kind: 'none',
        reason: `The opportunity opened ${Math.round(gap / DAY)} days after the show, outside the ${settings.windowDays}-day window.`,
      });
      continue;
    }

    if (showId !== firstTouch.showId) {
      verdicts.set(showId, {
        kind: 'influenced',
        showId,
        reason:
          'We met this person at an earlier show, so first touch belongs there. This show ' +
          'touched the opportunity without originating it.',
      });
      influenced.push(showId);
      continue;
    }

    // Refusal 2: first claim wins and there can be no second, because
    // `firstTouch.showId` is a single value.
    verdicts.set(showId, { kind: 'sourced', showId, daysAfter: Math.round(gap / DAY) });
    sourcedShowId = showId;
    influenced.push(showId);
  }

  return { opportunity: opp, influencedShowIds: influenced, sourcedShowId, verdicts };
}

/* ------------------------------ the aggregates ----------------------------- */

export type ShowAttribution = {
  showId: string;
  sourcedCents: number;
  sourcedCount: number;
  influencedCents: number;
  influencedCount: number;
  wonCents: number;
  wonCount: number;
  openCents: number;
  lostCount: number;
  /** Opportunities with no amount on them. Real, and worth nothing to a total. */
  unvalued: number;
  /** Opportunities whose creation date the CRM withheld. */
  undecidable: number;
  /** True when any figure here came from a replay rather than from a CRM. */
  replayed: boolean;
};

export function summarizeShow(
  showId: string,
  attributions: OpportunityAttribution[],
): ShowAttribution {
  const out: ShowAttribution = {
    showId,
    sourcedCents: 0,
    sourcedCount: 0,
    influencedCents: 0,
    influencedCount: 0,
    wonCents: 0,
    wonCount: 0,
    openCents: 0,
    lostCount: 0,
    unvalued: 0,
    undecidable: 0,
    replayed: false,
  };

  for (const a of attributions) {
    const verdict = a.verdicts.get(showId);
    if (!verdict) continue;
    if (verdict.kind === 'undecidable') {
      out.undecidable += 1;
      if (a.opportunity.replayed) out.replayed = true;
      continue;
    }
    if (verdict.kind === 'none') continue;

    if (a.opportunity.replayed) out.replayed = true;
    const amount = a.opportunity.amountCents;
    if (amount === null) out.unvalued += 1;

    out.influencedCount += 1;
    out.influencedCents += amount ?? 0;

    if (a.sourcedShowId === showId) {
      out.sourcedCount += 1;
      out.sourcedCents += amount ?? 0;
    }

    // Won / open / lost are reported on the *sourced* set only. On the
    // influenced set they would double-count a win across every show that
    // touched it, and "closed-won revenue attributed" (§8d) is the figure most
    // likely to be quoted out of context.
    if (a.sourcedShowId !== showId) continue;
    if (a.opportunity.stageKind === 'won') {
      out.wonCount += 1;
      out.wonCents += amount ?? 0;
    } else if (a.opportunity.stageKind === 'lost') {
      out.lostCount += 1;
    } else {
      out.openCents += amount ?? 0;
    }
  }

  return out;
}

/**
 * Portfolio totals — and the one place refusal 3 is enforced rather than stated.
 *
 * `influencedCents` here is the value of the **distinct** opportunities any show
 * influenced, not the sum of the per-show influenced figures. Those two numbers
 * differ by however much overlap the calendar has, the second is always the
 * larger, and it is the one a spreadsheet would produce.
 */
export function summarizeAttribution(attributions: OpportunityAttribution[]): {
  sourcedCents: number;
  distinctInfluencedCents: number;
  opportunities: number;
  unsourced: number;
} {
  let sourcedCents = 0;
  let distinctInfluencedCents = 0;
  let unsourced = 0;
  for (const a of attributions) {
    const amount = a.opportunity.amountCents ?? 0;
    if (a.sourcedShowId) sourcedCents += amount;
    else if (a.influencedShowIds.length > 0) unsourced += 1;
    if (a.influencedShowIds.length > 0) distinctInfluencedCents += amount;
  }
  return {
    sourcedCents,
    distinctInfluencedCents,
    opportunities: attributions.length,
    unsourced,
  };
}
