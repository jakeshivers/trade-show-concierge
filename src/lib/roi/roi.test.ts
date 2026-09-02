import { describe, it, expect } from 'vitest';
import type { ShowCost } from '@/lib/cost/rollup';
import type { LeadCoverage } from '@/lib/leads/coverage';
import type { Actor } from '@/lib/auth/actor';
import {
  DEFAULT_SETTINGS,
  attributeAll,
  summarizeAttribution,
  summarizeShow,
  type AttributableLead,
  type AttributableOpportunity,
} from './attribution';
import {
  MATURITY_DAYS,
  describeMatching,
  maturityOf,
  rollUpShowRoi,
  summarizeRoiPortfolio,
  type MatchCoverage,
  type RoiInputs,
} from './rollup';
import { planRoiAlerts } from './alerts';
import { canManageCrm, canSeeRoi } from './access';
import { selectCrmProvider, selectCrmProviderOrNull } from './provider';
import { RecordedCrmProvider, scenarioFor } from '@/lib/integrations/crm/recorded/provider';
import { amountToCents, stageKindOf } from '@/lib/integrations/crm/salesforce/normalize';
import { SalesforceCrmProvider, soqlQuote } from '@/lib/integrations/crm/salesforce/client';
import { HubSpotCrmProvider } from '@/lib/integrations/crm/hubspot/client';
import { CrmNotImplementedError, isNoMatch } from '@/lib/integrations/crm/types';

/**
 * The pure half of ROI — no database, fixed clock.
 *
 * Almost nothing here tests arithmetic. Dividing cost by leads is one line, and
 * it is the least interesting line in the step. Every assertion below is about a
 * number that would read perfectly well and be wrong: a show credited with a
 * deal that was already in the pipeline before anybody met the buyer, the newest
 * show quietly taking every recurring customer's opportunity off the show that
 * actually met them first, a cost-per-lead built from two floors pointing in
 * opposite directions, and a fixture's pipeline appearing beside a real cost
 * under the app's own byline.
 */

const NOW = new Date('2026-09-01T12:00:00Z');
const DAY = 86_400_000;
const d = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

const lead = (over: Partial<AttributableLead> = {}): AttributableLead => ({
  leadId: 'lead-1',
  showId: 'show-a',
  capturedAt: d(-200),
  contactExternalId: 'contact-1',
  ...over,
});

const opp = (over: Partial<AttributableOpportunity> = {}): AttributableOpportunity => ({
  externalId: 'opp-1',
  contactExternalId: 'contact-1',
  amountCents: 10_000_00,
  stageKind: 'open',
  crmCreatedAt: d(-160),
  closeDate: d(30),
  replayed: false,
  ...over,
});

/* ------------------------------- attribution ------------------------------- */

describe('attribution — sourced means first touch, anywhere', () => {
  it('credits the show that met them, when the opportunity opened after', () => {
    const [a] = attributeAll([lead()], [opp()]);
    expect(a.sourcedShowId).toBe('show-a');
    expect(a.verdicts.get('show-a')).toMatchObject({ kind: 'sourced', daysAfter: 40 });
  });

  it('refuses to source a deal that already existed when we met them', () => {
    // The flattering failure: a six-figure deal already in the pipeline, a booth
    // conversation with the same buyer, and a show that appears to have
    // originated it. Influenced is the honest answer and it is not nothing.
    const [a] = attributeAll([lead()], [opp({ crmCreatedAt: d(-260) })]);
    expect(a.sourcedShowId).toBeNull();
    expect(a.verdicts.get('show-a')).toMatchObject({ kind: 'influenced' });
    expect(a.influencedShowIds).toEqual(['show-a']);
  });

  it('gives first touch to the earlier show, not to the most recent one', () => {
    // The second year of any recurring calendar. A naive "created after this
    // show, inside the window" test hands the opportunity to the newest show
    // every year, silently, because the newest show always passes it too.
    const [a] = attributeAll(
      [
        lead({ leadId: 'l1', showId: 'show-old', capturedAt: d(-100) }),
        lead({ leadId: 'l2', showId: 'show-new', capturedAt: d(-40) }),
      ],
      [opp({ crmCreatedAt: d(-20) })],
    );
    expect(a.sourcedShowId).toBe('show-old');
    expect(a.verdicts.get('show-new')).toMatchObject({ kind: 'influenced' });
    expect(a.influencedShowIds).toContain('show-new');
  });

  it('lets nobody source it when first touch falls outside the window', () => {
    // Refusal 5, and it was found by a test written to assert something else.
    // The runner-up does not inherit an opportunity the show that actually met
    // them first is too old to claim — that is refusal 1's failure arriving by a
    // route that looks like generosity. It stays visible in influenced.
    const [a] = attributeAll(
      [
        lead({ leadId: 'l1', showId: 'show-old', capturedAt: d(-300) }),
        lead({ leadId: 'l2', showId: 'show-new', capturedAt: d(-40) }),
      ],
      [opp({ crmCreatedAt: d(-20) })],
    );
    expect(a.sourcedShowId).toBeNull();
    expect(a.verdicts.get('show-old')).toMatchObject({ kind: 'none' });
    expect(a.verdicts.get('show-new')).toMatchObject({ kind: 'influenced' });
    expect(a.influencedShowIds).toEqual(['show-new']);
  });

  it('one opportunity is sourced to at most one show, ever', () => {
    const [a] = attributeAll(
      [
        lead({ leadId: 'l1', showId: 'show-a', capturedAt: d(-300) }),
        lead({ leadId: 'l2', showId: 'show-b', capturedAt: d(-290) }),
        lead({ leadId: 'l3', showId: 'show-c', capturedAt: d(-280) }),
      ],
      [opp({ crmCreatedAt: d(-260) })],
    );
    const sourced = [...a.verdicts.values()].filter((v) => v.kind === 'sourced');
    expect(sourced).toHaveLength(1);
    expect(a.sourcedShowId).toBe('show-a');
  });

  it('drops an opportunity that opened outside the window, with the reason', () => {
    const [a] = attributeAll([lead({ capturedAt: d(-400) })], [opp({ crmCreatedAt: d(-100) })]);
    expect(a.sourcedShowId).toBeNull();
    expect(a.verdicts.get('show-a')).toMatchObject({ kind: 'none' });
    expect((a.verdicts.get('show-a') as { reason: string }).reason).toContain('180-day window');
  });

  it('reports a missing creation date as undecidable rather than as nothing', () => {
    // A decision and an absence of data are different findings, and a coverage
    // model that cannot tell them apart reports a clean sheet on a broken sync.
    const [a] = attributeAll([lead()], [opp({ crmCreatedAt: null })]);
    expect(a.verdicts.get('show-a')).toMatchObject({ kind: 'undecidable' });
    expect(summarizeShow('show-a', [a]).undecidable).toBe(1);
    expect(summarizeShow('show-a', [a]).sourcedCount).toBe(0);
  });

  it('attributes nothing to a lead that never linked to a CRM record', () => {
    const [a] = attributeAll([lead({ contactExternalId: null })], [opp()]);
    expect(a.sourcedShowId).toBeNull();
    expect(a.verdicts.size).toBe(0);
  });
});

describe('attribution — the aggregates', () => {
  const attributions = attributeAll(
    [
      lead({ leadId: 'l1', showId: 'show-a', contactExternalId: 'c1', capturedAt: d(-300) }),
      lead({ leadId: 'l2', showId: 'show-b', contactExternalId: 'c1', capturedAt: d(-100) }),
      lead({ leadId: 'l3', showId: 'show-b', contactExternalId: 'c2', capturedAt: d(-100) }),
    ],
    [
      opp({ externalId: 'o1', contactExternalId: 'c1', crmCreatedAt: d(-280), amountCents: 100_00 }),
      opp({
        externalId: 'o2',
        contactExternalId: 'c2',
        crmCreatedAt: d(-90),
        amountCents: 400_00,
        stageKind: 'won',
      }),
    ],
  );

  it('sums sourced honestly — one opportunity, one show', () => {
    expect(summarizeShow('show-a', attributions).sourcedCents).toBe(100_00);
    expect(summarizeShow('show-b', attributions).sourcedCents).toBe(400_00);
    expect(summarizeAttribution(attributions).sourcedCents).toBe(500_00);
  });

  it('does not let the per-show influenced figures be added up', () => {
    // show-b influenced o1 without sourcing it, so the per-show influenced
    // figures total 600 while only 500 of pipeline exists. The distinct figure
    // is the only one a portfolio may print.
    const perShow =
      summarizeShow('show-a', attributions).influencedCents +
      summarizeShow('show-b', attributions).influencedCents;
    expect(perShow).toBe(600_00);
    expect(summarizeAttribution(attributions).distinctInfluencedCents).toBe(500_00);
  });

  it('counts a win only on the show that sourced it', () => {
    expect(summarizeShow('show-b', attributions).wonCents).toBe(400_00);
    // show-a influenced o1 and sourced nothing that won.
    expect(summarizeShow('show-a', attributions).wonCents).toBe(0);
  });
});

/* ---------------------------------- rollup --------------------------------- */

const cost = (over: Partial<ShowCost> = {}): ShowCost =>
  ({
    showId: 'show-a',
    showName: 'Automate 2025',
    lines: [],
    totalCents: 100_000_00,
    paidCents: 100_000_00,
    committedCents: 0,
    creditFundedCents: 0,
    consumedCents: 0,
    attendeeDays: 12,
    coverage: { verdict: 'complete', gaps: [], silent: [] },
    isFloor: false,
    ...over,
  }) as ShowCost;

const coverage = (over: Partial<LeadCoverage> = {}): LeadCoverage =>
  ({
    leadCount: 50,
    duplicateCount: 0,
    boothStaff: 3,
    capturingStaff: 3,
    silent: [],
    standing: 'sound',
    isFloor: false,
    headline: '50 leads, from all 3 people on the booth.',
    basis: { consent: 50, legitimate_interest: 0, unknown: 0 },
    retentionOverdue: 0,
    retentionDueSoon: 0,
    ...over,
  }) as LeadCoverage;

const matching = (over: Partial<MatchCoverage> = {}): MatchCoverage => ({
  leads: 50,
  matched: 50,
  withheld: 0,
  unmatched: 0,
  erased: 0,
  unsynced: 0,
  ...over,
});

const roiInputs = (over: Partial<RoiInputs> = {}): RoiInputs => ({
  show: {
    id: 'show-a',
    name: 'Automate 2025',
    status: 'complete',
    startsOn: d(-200),
    endsOn: d(-197),
  },
  cost: cost(),
  leads: coverage(),
  meetingsHeld: 10,
  attribution: {
    showId: 'show-a',
    sourcedCents: 400_000_00,
    sourcedCount: 8,
    influencedCents: 600_000_00,
    influencedCount: 12,
    wonCents: 90_000_00,
    wonCount: 2,
    openCents: 310_000_00,
    lostCount: 1,
    unvalued: 0,
    undecidable: 0,
    replayed: false,
  },
  matching: matching(),
  typedPipelineCents: null,
  ...over,
});

describe('the ratios, and what they refuse', () => {
  it('quotes cost per lead when both inputs are complete', () => {
    const roi = rollUpShowRoi(roiInputs(), DEFAULT_SETTINGS, NOW);
    expect(roi.costPerLead).toEqual({ ok: true, cents: 200_000 });
    expect(roi.pipelineMultiple).toEqual({ ok: true, multiple: 4 });
  });

  it('obeys mayQuotePerLead rather than routing around it', () => {
    // Step 18's refusal, arriving at the division it was written for.
    const roi = rollUpShowRoi(
      roiInputs({
        leads: coverage({
          standing: 'partial',
          isFloor: true,
          silent: [{ userId: 'u1', fullName: 'Tomás' }],
          capturingStaff: 2,
        }),
      }),
      DEFAULT_SETTINGS,
      NOW,
    );
    expect(roi.costPerLead.ok).toBe(false);
    expect((roi.costPerLead as { reason: string }).reason).toContain('overstates cost per lead');
  });

  it('withholds cost per lead over a cost floor too, in the opposite direction', () => {
    // A lead floor makes the figure too high; a cost floor makes it too low.
    // Neither magnitude is known, so they do not offset — they widen.
    const roi = rollUpShowRoi(
      roiInputs({
        cost: cost({ isFloor: true, coverage: { verdict: 'thin', gaps: [], silent: ['space'] } }),
      }),
      DEFAULT_SETTINGS,
      NOW,
    );
    expect(roi.costPerLead.ok).toBe(false);
    expect((roi.costPerLead as { reason: string }).reason).toContain('too low');
    expect(roi.pipelineMultiple.ok).toBe(false);
    expect((roi.pipelineMultiple as { reason: string }).reason).toContain('ceiling');
  });

  it('withholds every ratio derived from a replayed pipeline', () => {
    // A banner is enough for a replayed crate. "$400,000 sourced" is a sentence
    // about this company, so the derived number is withheld as well as labelled.
    const roi = rollUpShowRoi(
      roiInputs({ attribution: { ...roiInputs().attribution, replayed: true } }),
      DEFAULT_SETTINGS,
      NOW,
    );
    expect(roi.pipelineMultiple.ok).toBe(false);
    expect(roi.costPerOpportunity.ok).toBe(false);
    expect(roi.closedWon.ok).toBe(false);
    expect(roi.gaps.some((g) => g.kind === 'replay')).toBe(true);
    // Cost per lead survives: neither of its inputs came from the CRM.
    expect(roi.costPerLead.ok).toBe(true);
  });

  it('refuses a multiple over an unrecorded cost, which comes out spectacular', () => {
    const roi = rollUpShowRoi(
      roiInputs({ cost: cost({ totalCents: 0, isFloor: true, coverage: { verdict: 'empty', gaps: [], silent: [] } }) }),
      DEFAULT_SETTINGS,
      NOW,
    );
    expect(roi.pipelineMultiple.ok).toBe(false);
  });

  it('reports figures and withholds the verdict inside the maturity horizon', () => {
    const roi = rollUpShowRoi(
      roiInputs({
        show: { ...roiInputs().show, endsOn: d(-10) },
      }),
      DEFAULT_SETTINGS,
      NOW,
    );
    expect(roi.maturity).toBe('immature');
    expect(roi.pipelineCents).toBe(400_000_00);
    expect(roi.pipelineMultiple.ok).toBe(false);
    expect(roi.closedWon.ok).toBe(false);
    expect((roi.closedWon as { reason: string }).reason).toContain('reads as a failed show');
  });

  it('reports both models, always', () => {
    const roi = rollUpShowRoi(roiInputs(), DEFAULT_SETTINGS, NOW);
    expect(roi.pipelineCents).toBe(400_000_00);
    expect(roi.otherModelCents).toBe(600_000_00);
  });

  it('names a typed pipeline figure as a disagreement rather than resolving it', () => {
    const roi = rollUpShowRoi(roiInputs({ typedPipelineCents: 41_000_000 }), DEFAULT_SETTINGS, NOW);
    expect(roi.gaps.some((g) => g.kind === 'disagreement')).toBe(true);
  });
});

describe('maturity', () => {
  it('is a real horizon rather than a footnote', () => {
    expect(maturityOf({ endsOn: d(10) }, NOW)).toBe('future');
    expect(maturityOf({ endsOn: d(-1) }, NOW)).toBe('immature');
    expect(maturityOf({ endsOn: d(-MATURITY_DAYS - 1) }, NOW)).toBe('maturing');
    expect(maturityOf({ endsOn: d(-400) }, NOW)).toBe('mature');
  });
});

describe('match coverage — our refusals and the CRM’s answers stay apart', () => {
  it('never adds withheld to unmatched', () => {
    const gap = describeMatching(matching({ matched: 30, withheld: 12, unmatched: 8 }))!;
    expect(gap.what).toContain('30 of 50');
    expect(gap.what).toContain('this app refusing, not the CRM failing');
    expect(gap.what).toContain('8 are in no CRM record');
  });

  it('says nothing when everything matched', () => {
    expect(describeMatching(matching())).toBeNull();
  });

  it('keeps "never asked" apart from "they said no"', () => {
    const gap = describeMatching(matching({ matched: 0, unsynced: 50 }))!;
    expect(gap.what).toContain('never been offered to a CRM');
  });
});

describe('the portfolio', () => {
  const mature = rollUpShowRoi(roiInputs(), DEFAULT_SETTINGS, NOW);
  const immature = rollUpShowRoi(
    roiInputs({
      show: { id: 'show-b', name: 'DMW 2026', status: 'complete', startsOn: d(-4), endsOn: d(-2) },
      cost: cost({ showId: 'show-b', totalCents: 40_000_00 }),
    }),
    DEFAULT_SETTINGS,
    NOW,
  );

  it('excludes immature shows from the portfolio multiple', () => {
    const p = summarizeRoiPortfolio([mature, immature], DEFAULT_SETTINGS, 600_000_00, NOW);
    expect(p.immature).toBe(1);
    // 400,000 sourced over the 100,000 cost of the one show old enough to judge.
    expect(p.portfolioMultiple).toEqual({ ok: true, multiple: 4 });
  });

  /**
   * Most recent show first, and cost — never the multiple — breaks the tie.
   *
   * The ordering moved to the clock on 2026-09-02 with every other board, and
   * this page has the strongest claim to the *retrospective* direction of it:
   * §8e says a verdict is not final for six to twelve months, so this is a
   * report on what already happened and the nearest thing to now is the show
   * that just closed. What has not changed is the refusal underneath: ranking by
   * multiple puts every recent show last by construction, and somebody cancels
   * one.
   */
  it('orders by how recently a show closed, not by its multiple', () => {
    const p = summarizeRoiPortfolio([mature, immature], DEFAULT_SETTINGS, 0, NOW);
    // show-b ended two days ago; show-a sixty. The four-times multiple on show-a
    // does not lift it, and neither does its cost.
    expect(p.shows.map((sh) => sh.showId)).toEqual(['show-b', 'show-a']);
  });

  it('breaks a tie between two shows of the same age on cost', () => {
    const cheap = rollUpShowRoi(
      roiInputs({
        show: { id: 'cheap', name: 'Cheap', status: 'complete', startsOn: d(-4), endsOn: d(-2) },
        cost: cost({ showId: 'cheap', totalCents: 10_000_00 }),
      }),
      DEFAULT_SETTINGS,
      NOW,
    );
    const p = summarizeRoiPortfolio([cheap, immature], DEFAULT_SETTINGS, 0, NOW);
    expect(p.shows.map((sh) => sh.showId)).toEqual(['show-b', 'cheap']);
  });

  it('refuses a portfolio multiple when nothing is old enough to score', () => {
    const p = summarizeRoiPortfolio([immature], DEFAULT_SETTINGS, 0, NOW);
    expect(p.portfolioMultiple.ok).toBe(false);
  });
});

/* ---------------------------------- alerts --------------------------------- */

const alertable = {
  showId: 'show-a',
  showName: 'Automate 2025',
  endsOn: d(-60),
  status: 'complete',
  maturity: 'immature' as const,
  leadCount: 50,
  matching: matching({ matched: 0, unsynced: 50 }),
  attributionsUnwritten: 0,
  replayed: false,
  costCents: 100_000_00,
};

describe('the seventh engine', () => {
  it('reports a show with a cost and no return side', () => {
    const planned = planRoiAlerts([alertable], null, NOW);
    expect(planned.map((p) => p.reason)).toContain('never_synced');
  });

  it('says nothing about a show that closed last week', () => {
    const planned = planRoiAlerts([{ ...alertable, endsOn: d(-3) }], null, NOW);
    expect(planned).toHaveLength(0);
  });

  it('never alerts on a low multiple', () => {
    // Deliberate. Alerting on the headline number is this product telling
    // somebody to cut a show over a figure §8e says is not final for a year.
    const planned = planRoiAlerts([alertable], null, NOW);
    expect(planned.every((p) => !/multiple|ratio|worth it/i.test(p.title))).toBe(true);
  });

  it('escalates only a repeated sync failure', () => {
    const once = planRoiAlerts([], { provider: 'salesforce', reason: 'timeout', count: 1 }, NOW);
    const twice = planRoiAlerts([], { provider: 'salesforce', reason: 'timeout', count: 3 }, NOW);
    expect(once[0].severity).toBe('warning');
    expect(twice[0].severity).toBe('critical');
    // One key for the outage, not one per message: a token expiry followed by a
    // rate limit is one problem to whoever has to fix it.
    expect(once[0].dedupeKey).toBe(twice[0].dedupeKey);
  });

  it('says nothing about an unwritten attribution when the links are replayed', () => {
    // A replay cannot write. Asking for one would fire on every show on a
    // zero-key clone and name a fix nobody can perform.
    const shown = { ...alertable, attributionsUnwritten: 4, matching: matching({ matched: 4 }) };
    expect(
      planRoiAlerts([shown], null, NOW).some((p) => p.reason === 'attribution_unwritten'),
    ).toBe(true);
    expect(
      planRoiAlerts([{ ...shown, replayed: true }], null, NOW).some(
        (p) => p.reason === 'attribution_unwritten',
      ),
    ).toBe(false);
  });

  it('writes the unmatchable-leads alert in the past tense', () => {
    const planned = planRoiAlerts(
      [{ ...alertable, matching: matching({ matched: 30, withheld: 20, unsynced: 0 }) }],
      null,
      NOW,
    );
    const alert = planned.find((p) => p.reason === 'unmatchable_leads')!;
    expect(alert.body).toContain('permanently outside');
    expect(alert.severity).toBe('info');
  });
});

/* -------------------------------- the adapter ------------------------------ */

describe('the Salesforce normalizer', () => {
  it('parses an Amount without floating-point arithmetic', () => {
    // amount * 100 on 8618.36 is 861835.9999999999.
    expect(amountToCents(8618.36)).toBe(861836);
    expect(amountToCents('8618.36')).toBe(861836);
    expect(amountToCents(null)).toBeNull();
  });

  it('reads IsWon/IsClosed rather than matching stage names', () => {
    // Stage names are per-org free text. A string match is a dashboard that is
    // silently wrong at customer number two.
    expect(stageKindOf({ StageName: '6 - Closed/Won', IsWon: true, IsClosed: true })).toBe('won');
    expect(stageKindOf({ StageName: 'Perdida', IsWon: false, IsClosed: true })).toBe('lost');
    expect(stageKindOf({ StageName: 'Anything at all' })).toBe('open');
  });

  it('escapes SOQL, which has no bound parameters', () => {
    expect(soqlQuote("o'brien@x.test")).toBe("'o\\'brien@x.test'");
  });
});

describe('the Salesforce client — the three things a fixture cannot catch', () => {
  type Call = { url: string; init?: RequestInit };

  function provider(handler: (call: Call, n: number) => { status: number; body: unknown }) {
    const calls: Call[] = [];
    const http = (async (url: string | URL, init?: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      const { status, body } = handler(call, calls.length);
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'x',
        json: async () => body,
      } as Response;
    }) as unknown as typeof fetch;
    return {
      calls,
      sf: new SalesforceCrmProvider({
        instanceUrl: 'https://x.my.salesforce.com',
        accessToken: 'tok',
        fetch: http,
      }),
    };
  }

  const role = (oppId: string, contactId: string) => ({
    ContactId: contactId,
    IsPrimary: true,
    Opportunity: {
      Id: oppId,
      Name: oppId,
      StageName: 'Qualification',
      Amount: 100,
      IsWon: false,
      IsClosed: false,
      CreatedDate: '2026-01-01T00:00:00.000+0000',
      CloseDate: '2026-06-30',
    },
  });

  it('follows nextRecordsUrl instead of reporting the first page', async () => {
    // The §5j import failure in an adapter: a smaller number with exactly the
    // same confidence, invisible until a customer is big enough to matter.
    const { sf, calls } = provider((_call, n) =>
      n === 1
        ? {
            status: 200,
            body: {
              done: false,
              nextRecordsUrl: '/services/data/v60.0/query/01g000-2000',
              records: [role('opp-1', 'c1')],
            },
          }
        : { status: 200, body: { done: true, records: [role('opp-2', 'c1')] } },
    );
    const opps = await sf.opportunitiesFor(['c1']);
    // Two pages fetched, and the second page's URL is not double-prefixed with
    // the version segment. No org-currency lookup: the first query kept
    // `CurrencyIsoCode` and succeeded, so this is a multi-currency org.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://x.my.salesforce.com/services/data/v60.0/query/01g000-2000');
    expect(opps.map((o) => o.externalId)).toEqual(['opp-1', 'opp-2']);
  });

  it('chunks the contact ids, because SOQL rides in a GET query string', async () => {
    const { sf, calls } = provider(() => ({ status: 200, body: { done: true, records: [] } }));
    await sf.opportunitiesFor(Array.from({ length: 450 }, (_, i) => `003${i}`));
    // 450 ids at 200 per request is three chunks. Without chunking this is one
    // URL long enough for Salesforce to refuse outright.
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.url.length).toBeLessThan(16_000);
  });

  it('survives a single-currency org rather than failing every sync on one', async () => {
    // `CurrencyIsoCode` only exists in a multi-currency org, and selecting a
    // field an org does not have is a hard INVALID_FIELD rather than a null. The
    // obvious query therefore fails outright on most Salesforce orgs.
    const { sf, calls } = provider((call, n) => {
      if (n === 1) {
        return {
          status: 400,
          body: [
            {
              errorCode: 'INVALID_FIELD',
              message: "No such column 'CurrencyIsoCode' on entity 'Opportunity'.",
            },
          ],
        };
      }
      if (call.url.includes('Organization')) {
        return { status: 200, body: { done: true, records: [{ DefaultCurrencyIsoCode: 'EUR' }] } };
      }
      return { status: 200, body: { done: true, records: [role('opp-1', 'c1')] } };
    });

    const opps = await sf.opportunitiesFor(['c1']);
    expect(opps).toHaveLength(1);
    // And the currency is *read*, not defaulted to USD — a currency label on a
    // pipeline figure is part of the figure.
    expect(opps[0].currency).toBe('EUR');
    expect(calls[1].url).not.toContain('CurrencyIsoCode');
  });

  it('does not re-probe the currency shape on every chunk', async () => {
    let currencyAttempts = 0;
    // Organization is matched first: `DefaultCurrencyIsoCode` contains
    // `CurrencyIsoCode` as a substring, so the order of these branches matters.
    const { sf } = provider((call) => {
      if (call.url.includes('Organization')) {
        return { status: 200, body: { done: true, records: [{ DefaultCurrencyIsoCode: 'GBP' }] } };
      }
      if (call.url.includes('CurrencyIsoCode')) {
        currencyAttempts += 1;
        return {
          status: 400,
          body: [{ errorCode: 'INVALID_FIELD', message: "No such column 'CurrencyIsoCode'." }],
        };
      }
      return { status: 200, body: { done: true, records: [] } };
    });
    await sf.opportunitiesFor(Array.from({ length: 450 }, (_, i) => `003${i}`));
    expect(currencyAttempts).toBe(1);
  });

  it('refuses to invent a currency when the org will not say', async () => {
    const { sf } = provider((call) => {
      // The org answers the currency question with nothing at all.
      if (call.url.includes('Organization')) {
        return { status: 200, body: { done: true, records: [] } };
      }
      if (call.url.includes('CurrencyIsoCode')) {
        return {
          status: 400,
          body: [{ errorCode: 'INVALID_FIELD', message: "No such column 'CurrencyIsoCode'." }],
        };
      }
      return { status: 200, body: { done: true, records: [] } };
    });
    await expect(sf.opportunitiesFor(['c1'])).rejects.toThrow(/does not guess one/);
  });

  it('reports a malformed envelope rather than reading it as no results', async () => {
    // An empty pipeline is a claim about the customer, not a parse failure.
    const { sf } = provider(() => ({ status: 200, body: { done: true } }));
    await expect(sf.opportunitiesFor(['c1'])).rejects.toThrow(/no `records` array/);
  });

  it('does not swallow a real error as a missing field', async () => {
    const { sf } = provider(() => ({
      status: 400,
      body: [{ errorCode: 'MALFORMED_QUERY', message: 'unexpected token' }],
    }));
    await expect(sf.opportunitiesFor(['c1'])).rejects.toThrow(/MALFORMED_QUERY/);
  });
});

describe('the HubSpot seam', () => {
  it('is declared and refuses rather than returning empty', () => {
    // An empty read is a *finding* — "we captured 41 leads and the CRM knows
    // none of them" — so an unbuilt adapter must be incapable of producing one.
    const provider = new HubSpotCrmProvider();
    expect(provider.isConfigured()).toBe(false);
    return expect(provider.opportunitiesFor()).rejects.toBeInstanceOf(CrmNotImplementedError);
  });

  it('is a named choice rather than an unrecognised one', () => {
    expect(() => selectCrmProvider({ CRM_PROVIDER: 'hubspot' })).toThrow(CrmNotImplementedError);
  });
});

describe('choosing a CRM', () => {
  it('never falls back', () => {
    expect(() => selectCrmProvider({})).toThrow(/SALESFORCE_INSTANCE_URL/);
    expect(() => selectCrmProvider({ CRM_PROVIDER: 'pipedrive' })).toThrow(/not a CRM this app has/);
  });

  it('replays only when asked out loud', () => {
    expect(selectCrmProvider({ CRM_PROVIDER: 'recorded' })).toMatchObject({
      source: 'recorded',
      replayed: true,
    });
    expect(
      selectCrmProvider({
        SALESFORCE_INSTANCE_URL: 'https://x.my.salesforce.com',
        SALESFORCE_ACCESS_TOKEN: 'tok',
      }),
    ).toMatchObject({ source: 'salesforce', replayed: false });
  });

  it('reports unavailability as a value, so the cost half still renders', () => {
    const choice = selectCrmProviderOrNull({});
    expect('unavailable' in choice).toBe(true);
  });
});

describe('the recorded provider', () => {
  it('invents no people — it answers only about who it was asked', async () => {
    const provider = new RecordedCrmProvider(() => d(-200));
    expect(await provider.opportunitiesFor(['003REPLAYDEADBEEF'])).toEqual([]);
  });

  it('replays a conversion shape, and most conversations convert to nothing', async () => {
    const provider = new RecordedCrmProvider(() => d(-200));
    const emails = Array.from({ length: 40 }, (_, i) => `person${i}@example.test`);
    const ids: string[] = [];
    for (const email of emails) {
      const m = await provider.matchByEmail(email);
      if (!isNoMatch(m)) ids.push(m.externalId);
    }
    const opps = await provider.opportunitiesFor(ids);
    expect(opps.length).toBeGreaterThan(0);
    expect(opps.length).toBeLessThan(emails.length);
  });

  it('is deterministic, so a figure does not move on reload', () => {
    expect(scenarioFor('a@b.test')).toBe(scenarioFor('a@b.test'));
  });

  it('can produce an opportunity that predates the show, or `sourced` is untestable', async () => {
    const provider = new RecordedCrmProvider(() => d(-200));
    const predating = Array.from({ length: 60 }, (_, i) => `p${i}@example.test`).find(
      (e) => scenarioFor(e) === 'predates',
    )!;
    const m = await provider.matchByEmail(predating);
    const [o] = await provider.opportunitiesFor([(m as { externalId: string }).externalId]);
    expect(o.createdAt!.getTime()).toBeLessThan(d(-200).getTime());
  });

  it('refuses to report a write it did not make', async () => {
    // The one lie a replay can tell that survives contact with the outside
    // world: somebody goes looking in Salesforce for a field nothing ever set.
    const result = await new RecordedCrmProvider().writeAttribution();
    expect(result.written).toBe(false);
  });
});

/* ---------------------------------- access --------------------------------- */

const actor = (role: Actor['role']): Actor => ({
  userId: 'u1',
  orgId: 'o1',
  email: 'x@y.test',
  fullName: 'X',
  role,
  costCenterId: null,
});

describe('who reads ROI', () => {
  it('inherits the cost gate rather than choosing a new one', () => {
    expect(canSeeRoi(actor('member'))).toBe(false);
    expect(canSeeRoi(actor('travel_manager'))).toBe(true);
    expect(canSeeRoi(actor('admin'))).toBe(true);
  });

  it('puts connecting a CRM one bar higher, because a token is a credential', () => {
    expect(canManageCrm(actor('travel_manager'))).toBe(false);
    expect(canManageCrm(actor('admin'))).toBe(true);
  });
});
