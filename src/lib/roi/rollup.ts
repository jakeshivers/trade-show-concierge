import type { ShowCost } from '@/lib/cost/rollup';
import type { LeadCoverage } from '@/lib/leads/coverage';
import { mayQuotePerLead } from '@/lib/leads/coverage';
import type { AttributionSettings, ShowAttribution } from './attribution';
import { MODEL_LABEL } from './attribution';

/**
 * "Was it worth it?" — §8, the third north-star job, and the first arithmetic in
 * this product where two honest numbers can produce a dishonest one.
 *
 * Pure. Everything it divides was built to refuse: `/cost` says **at least**
 * when a figure is a floor, `/leads` says **at least** when a count is, and
 * `mayQuotePerLead` already withholds cost per lead over a thin denominator.
 * Step 19's job is to *obey* those rather than route around them, which is
 * harder than it sounds, because the whole point of a dashboard is to produce a
 * single number and every refusal here is a hole in one.
 *
 * Six refusals, and the first three are the reason this file exists at all.
 *
 * **1. Two floors in a quotient do not cancel.** A cost floor makes cost-per-lead
 * too *low*; a lead floor makes it too *high*. It is tempting to read that as
 * errors that offset, and it is the most dangerous available mistake: neither
 * magnitude is known, so their sum is not "roughly right", it is unbounded in
 * both directions while *looking* better-founded than either input. A figure
 * built from two floors is withheld, not averaged, not caveated.
 *
 * **2. A replayed pipeline is not a pipeline.** The other three `recorded`
 * providers replay a shape and a banner is enough. An opportunity has no shape
 * separable from its claim — "$340,000 sourced" is a sentence about this
 * company — so every ratio derived from replayed figures is withheld as well as
 * labelled. A reader who has learned to skim a banner has not learned to skim a
 * multiple.
 *
 * **3. Attribution coverage is a third floor, and it is the one nobody expects.**
 * Pipeline is only as complete as the fraction of leads that could be matched to
 * a CRM record — and step 18 guarantees that fraction is *never* 100%, because a
 * lead with no recorded lawful basis is deliberately never sent to a third
 * party, and an erased lead has had its `crm_external_id` nulled on purpose. So
 * the return side has structural holes that the cost side does not, they are the
 * direct consequence of two decisions this product is proud of, and the honest
 * move is to name them rather than to quietly shrink the denominator.
 *
 * **4. §8e's maturity rule is enforced, not printed.** A show scored the week it
 * ends always looks like a loss; that is a reporting artifact, not a finding,
 * and a dashboard that ranks shows by pipeline multiple would put every recent
 * show at the bottom and get one cancelled. A show inside the maturity horizon
 * reports its figures and **withholds its verdict**.
 *
 * **5. A show with no cost figure has no ROI**, however much pipeline it has. A
 * multiple over an unrecorded cost is division by an absence, and it comes out
 * spectacular.
 *
 * **6. Every figure carries its `asOf`.** §8e: ROI is not final for 6-12 months,
 * so a number without a date on it is a number that will be quoted next year.
 */

/** §8e: how long after a show closes its figures are still moving too much to judge. */
export const MATURITY_DAYS = 90;

/** After this, closed-won is a real answer rather than a leading indicator. */
export const FULL_MATURITY_DAYS = 365;

const DAY = 86_400_000;

export type Maturity =
  /** The show has not happened. Nothing to say. */
  | 'future'
  /** Inside the maturity horizon. Figures yes, verdict no. */
  | 'immature'
  /** Past it, and before revenue has had a year to land. */
  | 'maturing'
  /** Old enough that closed-won means what it says. */
  | 'mature';

/**
 * The word each standing gets, computed once so the CLI, the portfolio and the
 * show's own tab cannot disagree — `cost/_present.tsx`'s rule about the word in
 * front of a number, applied to the word beside one.
 *
 * `future` earns a careful sentence. It covers a show that has not opened *and*
 * a show that is running right now, and the obvious label — "has not happened
 * yet" — is plainly false on the second, which is the show somebody is standing
 * in. What is true of both is that it is not over, so there is nothing to score.
 */
export const MATURITY_LABEL: Record<Maturity, string> = {
  future: 'not over yet — nothing to score',
  immature: 'too recent to score: figures shown, verdict withheld',
  maturing: 'old enough to score; revenue still landing',
  mature: 'old enough that closed-won means what it says',
};

export function maturityOf(show: { endsOn: Date }, asOf: Date): Maturity {
  const days = (asOf.getTime() - show.endsOn.getTime()) / DAY;
  if (days < 0) return 'future';
  if (days < MATURITY_DAYS) return 'immature';
  if (days < FULL_MATURITY_DAYS) return 'maturing';
  return 'mature';
}

/**
 * A number this page will not print, and why.
 *
 * The reason is mandatory and is written for the person reading the dashboard,
 * not for a log. `mayQuotePerLead` established the shape at step 18; this is the
 * same object used for four more figures, so that a withheld ratio always looks
 * the same wherever it appears.
 */
export type Quotable =
  | { ok: true; cents: number }
  | { ok: false; reason: string };

export type MatchCoverage = {
  leads: number;
  matched: number;
  /** Never sent: no lawful basis recorded, per §5j. Ours, not the CRM's. */
  withheld: number;
  /** Sent and the CRM did not know them. An ordinary outcome. */
  unmatched: number;
  /** Erased, so the link is gone by design. */
  erased: number;
  /** Never offered to a CRM at all — no sync has run over them. */
  unsynced: number;
};

export type RoiGap = {
  kind: 'cost' | 'leads' | 'matching' | 'maturity' | 'replay' | 'disagreement';
  what: string;
};

export type ShowRoi = {
  showId: string;
  showName: string;
  status: string;
  startsOn: Date;
  endsOn: Date;
  maturity: Maturity;
  asOf: Date;
  settings: AttributionSettings;

  cost: ShowCost;
  leads: LeadCoverage;
  meetingsHeld: number;
  attribution: ShowAttribution;
  matching: MatchCoverage;

  /** The headline pipeline figure, in the configured model. */
  pipelineCents: number;
  /** The other model, always reported beside it. §8b: show both. */
  otherModelCents: number;

  costPerLead: Quotable;
  costPerMeeting: Quotable;
  costPerOpportunity: Quotable;
  /** Pipeline ÷ cost. §8d's single headline number, and the easiest to fake. */
  pipelineMultiple: { ok: true; multiple: number } | { ok: false; reason: string };
  closedWon: Quotable;

  gaps: RoiGap[];
  /** True when any figure on this row is a floor. */
  isFloor: boolean;
};

export type RoiInputs = {
  show: { id: string; name: string; status: string; startsOn: Date; endsOn: Date };
  cost: ShowCost;
  leads: LeadCoverage;
  meetingsHeld: number;
  attribution: ShowAttribution;
  matching: MatchCoverage;
  /** A pipeline figure somebody typed, when one exists. Never merged — see below. */
  typedPipelineCents: number | null;
};

export function rollUpShowRoi(
  input: RoiInputs,
  settings: AttributionSettings,
  asOf: Date,
): ShowRoi {
  const { show, cost, leads, attribution, matching } = input;
  const maturity = maturityOf(show, asOf);
  const gaps: RoiGap[] = [];

  const pipelineCents =
    settings.model === 'sourced' ? attribution.sourcedCents : attribution.influencedCents;
  const otherModelCents =
    settings.model === 'sourced' ? attribution.influencedCents : attribution.sourcedCents;

  /* --- the reasons a figure may not be quoted, gathered once --- */

  if (cost.isFloor) {
    gaps.push({
      kind: 'cost',
      what:
        `The cost is a floor: ${cost.coverage.verdict === 'empty' ? 'nothing is recorded' : `${cost.coverage.gaps.length} named gap${cost.coverage.gaps.length === 1 ? '' : 's'}`}. ` +
        'Every per-unit figure below it would come out too low.',
    });
  }
  const perLead = mayQuotePerLead(leads);
  if (!perLead.ok) {
    gaps.push({ kind: 'leads', what: perLead.reason! });
  }
  if (attribution.replayed) {
    gaps.push({
      kind: 'replay',
      what:
        'These pipeline figures are replayed from a recorded shape, not read from a CRM. They ' +
        'describe how booth conversations convert in general and assert nothing about this ' +
        'company’s pipeline, so no ratio is computed from them.',
    });
  }
  const matchGap = describeMatching(matching);
  if (matchGap) gaps.push(matchGap);
  if (maturity === 'immature') {
    gaps.push({
      kind: 'maturity',
      what:
        `This show ended ${Math.max(0, Math.round((asOf.getTime() - show.endsOn.getTime()) / DAY))} days ago. ` +
        `Pipeline takes months to appear and revenue 6-12, so figures are shown and no verdict is drawn ` +
        `before ${MATURITY_DAYS} days — a show scored the week it ends always looks like a loss, and that is ` +
        'a reporting artifact rather than a finding.',
    });
  }
  if (attribution.undecidable > 0) {
    gaps.push({
      kind: 'matching',
      what:
        `${attribution.undecidable} opportunit${attribution.undecidable === 1 ? 'y' : 'ies'} came back with no ` +
        'creation date, so whether this show came first cannot be established. Not counted either way.',
    });
  }
  if (attribution.unvalued > 0) {
    gaps.push({
      kind: 'matching',
      what:
        `${attribution.unvalued} attributed opportunit${attribution.unvalued === 1 ? 'y has' : 'ies have'} no amount in the CRM. ` +
        'Counted in the opportunity count and worth nothing to the pipeline figure, which is therefore a floor.',
    });
  }
  // Two clocks on one number: §5e's room-block cutoff, in the money.
  if (input.typedPipelineCents !== null && attribution.influencedCount > 0) {
    gaps.push({
      kind: 'disagreement',
      what:
        `A pipeline figure of ${(input.typedPipelineCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} ` +
        'was typed onto this show and a synced figure was derived from the CRM. Both are shown and neither ' +
        'overwrites the other: two editable copies of one number is how the number gets wrong, and only a ' +
        'person knows which of these two was meant.',
    });
  }

  /* --- the ratios, each withheld for its own set of reasons --- */

  const costUnusable = cost.isFloor
    ? 'The cost figure is a floor, so any per-unit number computed from it is too low.'
    : cost.coverage.verdict === 'empty'
      ? 'Nothing is recorded against this show’s cost, so there is nothing to divide.'
      : null;

  const replayUnusable = attribution.replayed
    ? 'The pipeline behind this is replayed rather than read from a CRM, so the ratio would be a fact about a fixture.'
    : null;

  const costPerLead: Quotable = !perLead.ok
    ? { ok: false, reason: perLead.reason! }
    : costUnusable
      ? { ok: false, reason: costUnusable }
      : { ok: true, cents: Math.round(cost.totalCents / leads.leadCount) };

  const costPerMeeting: Quotable =
    input.meetingsHeld === 0
      ? { ok: false, reason: 'No meetings are recorded as having happened.' }
      : costUnusable
        ? { ok: false, reason: costUnusable }
        : { ok: true, cents: Math.round(cost.totalCents / input.meetingsHeld) };

  const costPerOpportunity: Quotable =
    replayUnusable
      ? { ok: false, reason: replayUnusable }
      : attribution.sourcedCount === 0
        ? { ok: false, reason: 'No opportunity is attributed to this show under the sourced model.' }
        : costUnusable
          ? { ok: false, reason: costUnusable }
          : { ok: true, cents: Math.round(cost.totalCents / attribution.sourcedCount) };

  const multipleReason =
    replayUnusable ??
    (cost.totalCents === 0
      ? 'This show has no recorded cost. A multiple over an absence comes out spectacular and means nothing.'
      : cost.isFloor
        ? 'The cost is a floor, so the multiple over it is a ceiling — it flatters the show by exactly the amount nobody has entered.'
        : maturity === 'immature'
          ? `Too early. Pipeline from this show is still appearing, and a multiple computed now understates it by an unknown amount (§8e).`
          : matching.matched === 0
            ? 'No lead from this show is linked to a CRM record, so there is no attributed pipeline to divide.'
            : null);

  const pipelineMultiple: ShowRoi['pipelineMultiple'] = multipleReason
    ? { ok: false, reason: multipleReason }
    : { ok: true, multiple: pipelineCents / cost.totalCents };

  const closedWon: Quotable = replayUnusable
    ? { ok: false, reason: replayUnusable }
    : maturity === 'future' || maturity === 'immature'
      ? {
          ok: false,
          reason:
            'Closed-won revenue lags a show by 6-12 months. Reporting it now would report a zero, and a ' +
            'zero here reads as a failed show rather than as a deal that has not closed yet.',
        }
      : { ok: true, cents: attribution.wonCents };

  return {
    showId: show.id,
    showName: show.name,
    status: show.status,
    startsOn: show.startsOn,
    endsOn: show.endsOn,
    maturity,
    asOf,
    settings,
    cost,
    leads,
    meetingsHeld: input.meetingsHeld,
    attribution,
    matching,
    pipelineCents,
    otherModelCents,
    costPerLead,
    costPerMeeting,
    costPerOpportunity,
    pipelineMultiple,
    closedWon,
    gaps,
    isFloor: cost.isFloor || leads.isFloor || matching.matched < matching.leads,
  };
}

/**
 * What the matching left behind — and the sentence that has to distinguish our
 * refusals from the CRM's answers.
 *
 * `withheld` and `unmatched` are deliberately never added together. Withheld is
 * a decision this product made on purpose (§5j: no lawful basis, so nothing
 * leaves the building) and unmatched is the customer's CRM not knowing somebody.
 * Collapsing them into "43 of 61 leads matched" would make step 18's refusal
 * look like a data-quality problem with the vendor, which is precisely the
 * misreading that would get it removed.
 */
export function describeMatching(m: MatchCoverage): RoiGap | null {
  const parts: string[] = [];
  if (m.withheld > 0) {
    parts.push(
      `${m.withheld} ${m.withheld === 1 ? 'was' : 'were'} never sent, because no lawful basis was recorded at the booth — ` +
        'that is this app refusing, not the CRM failing, and the fix is on the lead',
    );
  }
  if (m.erased > 0) {
    parts.push(
      `${m.erased} ${m.erased === 1 ? 'has' : 'have'} been erased, so the link to the CRM is gone by design`,
    );
  }
  if (m.unmatched > 0) {
    parts.push(`${m.unmatched} ${m.unmatched === 1 ? 'is' : 'are'} in no CRM record we could find`);
  }
  if (m.unsynced > 0) {
    parts.push(`${m.unsynced} ${m.unsynced === 1 ? 'has' : 'have'} never been offered to a CRM at all`);
  }
  if (parts.length === 0) return null;
  return {
    kind: 'matching',
    what: `${m.matched} of ${m.leads} leads are linked to a CRM record. Of the rest, ${parts.join('; ')}.`,
  };
}

/* ------------------------------- the portfolio ----------------------------- */

export type RoiPortfolio = {
  shows: ShowRoi[];
  settings: AttributionSettings;
  asOf: Date;
  totalCostCents: number;
  /** Sourced pipeline sums honestly: one opportunity, one show. */
  sourcedPipelineCents: number;
  /**
   * The value of the **distinct** opportunities any show influenced — not the
   * sum of the per-show influenced figures, which triple-counts a deal three
   * shows touched. See `attribution.ts` refusal 3.
   */
  distinctInfluencedCents: number;
  /** Shows too recent to judge. Counting them is what stops the ranking lying. */
  immature: number;
  /** Shows whose numbers are floors. */
  incomplete: number;
  replayed: boolean;
  portfolioMultiple: { ok: true; multiple: number } | { ok: false; reason: string };
};

export function summarizeRoiPortfolio(
  shows: ShowRoi[],
  settings: AttributionSettings,
  distinctInfluencedCents: number,
  asOf: Date,
): RoiPortfolio {
  const judged = shows.filter((s) => s.maturity === 'maturing' || s.maturity === 'mature');
  const totalCostCents = shows.reduce((n, s) => n + s.cost.totalCents, 0);
  const sourcedPipelineCents = shows.reduce((n, s) => n + s.attribution.sourcedCents, 0);
  const replayed = shows.some((s) => s.attribution.replayed);

  const judgedCost = judged.reduce((n, s) => n + s.cost.totalCents, 0);
  const judgedPipeline = judged.reduce((n, s) => n + s.attribution.sourcedCents, 0);

  const portfolioMultiple: RoiPortfolio['portfolioMultiple'] = replayed
    ? {
        ok: false,
        reason: 'The pipeline behind this is replayed rather than read from a CRM.',
      }
    : judged.length === 0
      ? {
          ok: false,
          reason: `No show on this calendar has been closed for ${MATURITY_DAYS} days, so nothing here is old enough to score.`,
        }
      : judgedCost === 0
        ? { ok: false, reason: 'No cost is recorded against the shows old enough to score.' }
        : { ok: true, multiple: judgedPipeline / judgedCost };

  return {
    // Worst-first is wrong here and best-first is worse. Ordered by cost,
    // biggest first: a portfolio is read to decide what to keep doing, and the
    // expensive shows are the decisions. Ranking by multiple would put every
    // recent show at the bottom for the reason §8e names, and somebody would
    // cancel one.
    shows: [...shows].sort((a, b) => b.cost.totalCents - a.cost.totalCents),
    settings,
    asOf,
    totalCostCents,
    sourcedPipelineCents,
    distinctInfluencedCents,
    immature: shows.filter((s) => s.maturity === 'immature').length,
    incomplete: shows.filter((s) => s.isFloor).length,
    replayed,
    portfolioMultiple,
  };
}

/** The label a figure carries, so the window is never implicit. §8e. */
export function figureLabel(settings: AttributionSettings): string {
  return `${MODEL_LABEL[settings.model]}, ${settings.windowDays}-day attribution window`;
}
