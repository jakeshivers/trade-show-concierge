import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { getCostPortfolio, getShowCost } from '@/lib/cost/store';
import { basisOf, marketabilityOf } from '@/lib/leads/consent';
import { loadCoverage } from '@/lib/leads/store';
import type { CrmProvider } from '@/lib/integrations/crm/types';
import { isNoMatch } from '@/lib/integrations/crm/types';
import { syncConditionAlerts, type AlertSyncResult } from '@/lib/alerts/store';
import {
  DEFAULT_SETTINGS,
  attributeAll,
  summarizeAttribution,
  summarizeShow,
  type AttributableLead,
  type AttributableOpportunity,
  type AttributionSettings,
} from './attribution';
import { planRoiAlerts, type PlannedRoiAlert, type RoiAlertableShow } from './alerts';
import {
  maturityOf,
  rollUpShowRoi,
  summarizeRoiPortfolio,
  type MatchCoverage,
  type RoiPortfolio,
  type ShowRoi,
} from './rollup';
import { canSeeRoi, canSyncCrm } from './access';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of ROI: matching leads to CRM records, caching what the CRM
 * says, and assembling both halves of §8's question into one read.
 *
 * Org-scoped through the show, as everywhere the subject is a show. It loads
 * every show's inputs in a fixed number of queries for `cost/store.ts`'s reason,
 * which matters more here than anywhere: the portfolio and a show's own tab
 * compute the same multiple, and a show whose page says 3.4× while the portfolio
 * says 2.9× is worse than either number alone.
 *
 * **The one thing this file decides, and it decides it in one place:** whether a
 * lead's personal data may be sent to a third party in order to match it. That
 * is `marketabilityOf` — step 18's refusal — and step 19 is where it stops being
 * a badge on a screen and starts being the reason a number is smaller. It is
 * checked here rather than in the adapter because an adapter that knew about
 * lawful bases would be an adapter that could be written not to.
 */

/* ---------------------------------- syncing -------------------------------- */

export type SyncOutcome = {
  runId: string;
  provider: string;
  replayed: boolean;
  leadsConsidered: number;
  matched: number;
  unmatched: number;
  withheld: number;
  opportunitiesRead: number;
  attributionsWritten: number;
  problems: { leadId: string | null; reason: string }[];
  failedReason: string | null;
};

/**
 * Match this org's leads against the CRM, cache the opportunities, and — when
 * asked — write the attribution field back.
 *
 * The accounting rule is `lead_imports`', from a fifth direction: **matched +
 * unmatched + withheld always equals `leadsConsidered`.** A sync that reports
 * "41 matched" while nine leads fell out of a `continue` is a pipeline figure
 * wrong in the direction nobody checks, and unlike an import there is nothing to
 * re-count against afterwards.
 */
export async function syncCrm(
  actor: Actor,
  provider: CrmProvider,
  opts: { replayed?: boolean; writeAttribution?: boolean; now?: Date } = {},
  db: Db = getDb(),
): Promise<SyncOutcome> {
  if (!canSyncCrm(actor)) {
    throw new ForbiddenError('Syncing a CRM reads a customer’s pipeline and writes back into it.');
  }
  const now = opts.now ?? new Date();
  const replayed = opts.replayed ?? false;

  const [run] = await db
    .insert(s.crmSyncRuns)
    .values({
      orgId: actor.orgId,
      provider: provider.name,
      replayed,
      startedById: actor.userId,
      startedAt: now,
    })
    .returning();

  const problems: { leadId: string | null; reason: string }[] = [];
  let matched = 0;
  let unmatched = 0;
  let withheld = 0;
  let opportunitiesRead = 0;
  let attributionsWritten = 0;
  let failedReason: string | null = null;

  // Every non-redacted lead in the org, through the show, with the show's name
  // for the attribution value.
  const leads = await db
    .select({
      id: s.leads.id,
      showId: s.leads.showId,
      showName: s.shows.name,
      showStartsOn: s.shows.startsOn,
      email: s.leads.email,
      crmExternalId: s.leads.crmExternalId,
      capturedAt: s.leads.capturedAt,
      consentBasis: s.leads.consentBasis,
      consentCapturedAt: s.leads.consentCapturedAt,
      consentNotice: s.leads.consentNotice,
      redactedAt: s.leads.redactedAt,
      duplicateOfId: s.leads.duplicateOfId,
    })
    .from(s.leads)
    .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
    .where(eq(s.shows.orgId, actor.orgId));

  // A row marked as a duplicate of another is deliberately skipped rather than
  // counted as withheld: it is not a second person, and matching it would put
  // one conversation on two CRM records — §5j's flattering-direction inflation,
  // arriving on the pipeline side where the number is larger.
  const considered = leads.filter((l) => l.duplicateOfId === null);

  const links = new Map<string, typeof s.crmLinks.$inferSelect>();
  for (const link of await db
    .select()
    .from(s.crmLinks)
    .where(eq(s.crmLinks.orgId, actor.orgId))) {
    links.set(link.leadId, link);
  }

  const contactIds = new Set<string>();

  try {
    for (const lead of considered) {
      const existing = links.get(lead.id);
      if (existing) {
        matched += 1;
        contactIds.add(existing.externalId);
        continue;
      }

      if (lead.redactedAt) {
        // Erased on purpose. Not a failure, and not a hole somebody can fix.
        withheld += 1;
        problems.push({
          leadId: lead.id,
          reason: 'Erased. The link to any CRM record was removed deliberately, and nothing about this person leaves here.',
        });
        continue;
      }

      // An id the CRM itself gave us: no personal data is transmitted, so
      // consent does not gate it. See `crm/types.ts`.
      if (lead.crmExternalId) {
        const found = await provider.matchByExternalId(lead.crmExternalId);
        if (isNoMatch(found)) {
          unmatched += 1;
          problems.push({ leadId: lead.id, reason: found.reason });
          continue;
        }
        await recordLink(db, actor.orgId, lead.id, provider.name, found, 'external_id', replayed, now);
        matched += 1;
        contactIds.add(found.externalId);
        continue;
      }

      // Matching by email sends a stranger's address to a third party. This is
      // the gate, and it is the whole reason step 18 came before step 19.
      const marketable = marketabilityOf({
        basis: basisOf(lead.consentBasis),
        consentCapturedAt: lead.consentCapturedAt,
        consentNotice: lead.consentNotice,
        redactedAt: lead.redactedAt,
      });
      if (!marketable.usable) {
        withheld += 1;
        problems.push({ leadId: lead.id, reason: marketable.reason });
        continue;
      }
      if (!lead.email) {
        unmatched += 1;
        problems.push({
          leadId: lead.id,
          reason: 'No email and no CRM id, so there is nothing to match on. A name is not an identifier.',
        });
        continue;
      }

      const found = await provider.matchByEmail(lead.email);
      if (isNoMatch(found)) {
        unmatched += 1;
        problems.push({ leadId: lead.id, reason: found.reason });
        continue;
      }
      await recordLink(db, actor.orgId, lead.id, provider.name, found, 'email', replayed, now);
      matched += 1;
      contactIds.add(found.externalId);
    }

    /* --- the read: opportunities hanging off everybody we matched --- */
    if (contactIds.size > 0) {
      const opps = await provider.opportunitiesFor([...contactIds]);
      opportunitiesRead = opps.length;
      for (const opp of opps) {
        await db
          .insert(s.crmOpportunities)
          .values({
            orgId: actor.orgId,
            provider: provider.name,
            externalId: opp.externalId,
            name: opp.name,
            stage: opp.stage,
            stageKind: opp.stageKind,
            amountCents: opp.amountCents,
            currency: opp.currency,
            contactExternalId: opp.contactExternalId,
            crmCreatedAt: opp.createdAt,
            closeDate: opp.closeDate,
            lastActivityAt: opp.lastActivityAt,
            ownerName: opp.ownerName,
            replayed,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [s.crmOpportunities.orgId, s.crmOpportunities.provider, s.crmOpportunities.externalId],
            set: {
              name: opp.name,
              stage: opp.stage,
              stageKind: opp.stageKind,
              amountCents: opp.amountCents,
              currency: opp.currency,
              contactExternalId: opp.contactExternalId,
              crmCreatedAt: opp.createdAt,
              closeDate: opp.closeDate,
              lastActivityAt: opp.lastActivityAt,
              ownerName: opp.ownerName,
              replayed,
              syncedAt: now,
            },
          });
      }
    }

    /* --- the write: one field, per §8b --- */
    if (opts.writeAttribution) {
      const fresh = await db
        .select({ link: s.crmLinks, lead: s.leads, show: s.shows })
        .from(s.crmLinks)
        .innerJoin(s.leads, eq(s.crmLinks.leadId, s.leads.id))
        .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
        .where(and(eq(s.crmLinks.orgId, actor.orgId), isNull(s.crmLinks.attributionWrittenAt)));

      for (const row of fresh) {
        const value = `${row.show.name} (${row.show.startsOn.toISOString().slice(0, 10)})`;
        const result = await provider.writeAttribution({
          objectType: row.link.objectType === 'lead' ? 'lead' : 'contact',
          externalId: row.link.externalId,
          value,
        });
        if (!result.written) {
          problems.push({ leadId: row.lead.id, reason: `Attribution not written: ${result.reason}` });
          continue;
        }
        await db
          .update(s.crmLinks)
          .set({ attributionWrittenAt: result.at, attributionValue: value, updatedAt: now })
          .where(eq(s.crmLinks.id, row.link.id));
        attributionsWritten += 1;
      }
    }
  } catch (err) {
    // The run is recorded as failed and everything it managed before the failure
    // is kept. A half-run that reported success is how a board goes quiet
    // (`alerts/sweep.ts`); a half-run that discarded its own reads would make
    // every transient outage cost a full re-sync.
    failedReason = (err as Error).message;
  }

  await db
    .update(s.crmSyncRuns)
    .set({
      leadsConsidered: considered.length,
      matched,
      unmatched,
      withheld,
      opportunitiesRead,
      attributionsWritten,
      problems,
      failedReason,
      finishedAt: new Date(),
    })
    .where(eq(s.crmSyncRuns.id, run.id));

  return {
    runId: run.id,
    provider: provider.name,
    replayed,
    leadsConsidered: considered.length,
    matched,
    unmatched,
    withheld,
    opportunitiesRead,
    attributionsWritten,
    problems,
    failedReason,
  };
}

async function recordLink(
  db: Db,
  orgId: string,
  leadId: string,
  provider: string,
  found: { externalId: string; objectType: 'contact' | 'lead' },
  matchMethod: 'external_id' | 'email' | 'manual',
  replayed: boolean,
  now: Date,
): Promise<void> {
  await db
    .insert(s.crmLinks)
    .values({
      orgId,
      leadId,
      provider,
      objectType: found.objectType,
      externalId: found.externalId,
      matchMethod,
      matchedAt: now,
      replayed,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: s.crmLinks.leadId,
      set: { externalId: found.externalId, matchMethod, matchedAt: now, replayed, updatedAt: now },
    });
}

/* ---------------------------------- reading -------------------------------- */

type RoiRows = {
  leads: AttributableLead[];
  matching: Map<string, MatchCoverage>;
  opportunities: AttributableOpportunity[];
  meetingsHeld: Map<string, number>;
  typedPipeline: Map<string, number | null>;
  attributionsUnwritten: Map<string, number>;
  everSynced: boolean;
  /** True when any link in this org came from a replay rather than from a CRM. */
  replayedLinks: boolean;
};

async function loadRoiRows(orgId: string, showIds: string[], db: Db): Promise<RoiRows> {
  const empty: RoiRows = {
    leads: [],
    matching: new Map(),
    opportunities: [],
    meetingsHeld: new Map(),
    typedPipeline: new Map(),
    attributionsUnwritten: new Map(),
    everSynced: false,
    replayedLinks: false,
  };
  if (showIds.length === 0) return empty;

  const [leadRows, linkRows, oppRows, meetingRows, outcomeRows, runRows] = await Promise.all([
    db
      .select({
        id: s.leads.id,
        showId: s.leads.showId,
        capturedAt: s.leads.capturedAt,
        email: s.leads.email,
        crmExternalId: s.leads.crmExternalId,
        consentBasis: s.leads.consentBasis,
        consentCapturedAt: s.leads.consentCapturedAt,
        consentNotice: s.leads.consentNotice,
        redactedAt: s.leads.redactedAt,
        duplicateOfId: s.leads.duplicateOfId,
      })
      .from(s.leads)
      .where(inArray(s.leads.showId, showIds)),
    db.select().from(s.crmLinks).where(eq(s.crmLinks.orgId, orgId)),
    db.select().from(s.crmOpportunities).where(eq(s.crmOpportunities.orgId, orgId)),
    db
      .select({ showId: s.meetings.showId, occurredAt: s.meetings.occurredAt })
      .from(s.meetings)
      .where(inArray(s.meetings.showId, showIds)),
    db.select().from(s.showOutcomes).where(inArray(s.showOutcomes.showId, showIds)),
    db
      .select()
      .from(s.crmSyncRuns)
      .where(eq(s.crmSyncRuns.orgId, orgId))
      .orderBy(desc(s.crmSyncRuns.startedAt))
      .limit(1),
  ]);

  const linkByLead = new Map(linkRows.map((l) => [l.leadId, l]));

  const attributable: AttributableLead[] = [];
  const matching = new Map<string, MatchCoverage>();
  const unwritten = new Map<string, number>();
  for (const id of showIds) {
    matching.set(id, { leads: 0, matched: 0, withheld: 0, unmatched: 0, erased: 0, unsynced: 0 });
    unwritten.set(id, 0);
  }

  const everSynced = runRows.length > 0;

  for (const lead of leadRows) {
    // A duplicate is not a second person: it is out of the lead count (§5j) and
    // it is out of the matching denominator for the same reason.
    if (lead.duplicateOfId !== null) continue;
    const m = matching.get(lead.showId);
    if (!m) continue;
    m.leads += 1;

    const link = linkByLead.get(lead.id);
    if (link) {
      m.matched += 1;
      attributable.push({
        leadId: lead.id,
        showId: lead.showId,
        capturedAt: lead.capturedAt,
        contactExternalId: link.externalId,
      });
      if (!link.attributionWrittenAt) unwritten.set(lead.showId, (unwritten.get(lead.showId) ?? 0) + 1);
      continue;
    }

    if (lead.redactedAt) {
      m.erased += 1;
      continue;
    }
    if (!everSynced) {
      // Never offered to a CRM at all. Kept apart from `unmatched`, which is the
      // CRM's answer: "we have not asked" and "they said no" are opposite
      // findings, and only one of them is fixable by pressing a button.
      m.unsynced += 1;
      continue;
    }
    const marketable = marketabilityOf({
      basis: basisOf(lead.consentBasis),
      consentCapturedAt: lead.consentCapturedAt,
      consentNotice: lead.consentNotice,
      redactedAt: lead.redactedAt,
    });
    if (!marketable.usable && !lead.crmExternalId) m.withheld += 1;
    else m.unmatched += 1;
  }

  return {
    leads: attributable,
    matching,
    opportunities: oppRows.map((o) => ({
      externalId: o.externalId,
      contactExternalId: o.contactExternalId,
      amountCents: o.amountCents,
      stageKind: o.stageKind as AttributableOpportunity['stageKind'],
      crmCreatedAt: o.crmCreatedAt,
      closeDate: o.closeDate,
      replayed: o.replayed,
    })),
    meetingsHeld: countBy(meetingRows.filter((m) => m.occurredAt !== null).map((m) => m.showId)),
    typedPipeline: new Map(
      outcomeRows.map((o) => [
        o.showId,
        o.source === 'manual' ? (o.pipelineSourcedCents ?? null) : null,
      ]),
    ),
    attributionsUnwritten: unwritten,
    everSynced,
    replayedLinks: linkRows.some((l) => l.replayed),
  };
}

function countBy(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

const EMPTY_MATCHING: MatchCoverage = {
  leads: 0,
  matched: 0,
  withheld: 0,
  unmatched: 0,
  erased: 0,
  unsynced: 0,
};

export async function getRoiPortfolio(
  actor: Actor,
  opts: { asOf?: Date; settings?: AttributionSettings } = {},
  db: Db = getDb(),
): Promise<RoiPortfolio> {
  if (!canSeeRoi(actor)) {
    throw new ForbiddenError('An ROI figure contains a cost figure, which is every colleague’s fare.');
  }
  const asOf = opts.asOf ?? new Date();
  const settings = opts.settings ?? DEFAULT_SETTINGS;

  const [costs, coverage] = await Promise.all([
    getCostPortfolio(actor, { asOf }, db),
    loadCoverage(actor.orgId, asOf, db),
  ]);
  const showIds = costs.shows.map((c) => c.showId);
  const rows = await loadRoiRows(actor.orgId, showIds, db);

  const attributions = attributeAll(rows.leads, rows.opportunities, settings);
  const totals = summarizeAttribution(attributions);

  const shows: ShowRoi[] = costs.shows.map((cost) => {
    const cov = coverage.get(cost.showId)!;
    return rollUpShowRoi(
      {
        show: {
          id: cost.showId,
          name: cost.showName,
          status: costs.statuses.get(cost.showId) ?? 'committed',
          startsOn: cov.show.startsOn,
          endsOn: cov.show.endsOn,
        },
        cost,
        leads: cov.coverage,
        meetingsHeld: rows.meetingsHeld.get(cost.showId) ?? 0,
        attribution: summarizeShow(cost.showId, attributions),
        matching: rows.matching.get(cost.showId) ?? EMPTY_MATCHING,
        typedPipelineCents: rows.typedPipeline.get(cost.showId) ?? null,
      },
      settings,
      asOf,
    );
  });

  return summarizeRoiPortfolio(shows, settings, totals.distinctInfluencedCents, asOf);
}

export async function getShowRoi(
  actor: Actor,
  showId: string,
  opts: { asOf?: Date; settings?: AttributionSettings } = {},
  db: Db = getDb(),
): Promise<ShowRoi> {
  if (!canSeeRoi(actor)) {
    throw new ForbiddenError('An ROI figure contains a cost figure, which is every colleague’s fare.');
  }
  const asOf = opts.asOf ?? new Date();
  const settings = opts.settings ?? DEFAULT_SETTINGS;

  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');

  const [cost, coverage] = await Promise.all([
    getShowCost(actor, showId, { asOf }, db),
    loadCoverage(actor.orgId, asOf, db),
  ]);

  // Portfolio-wide, deliberately: `attributeAll` needs the earliest capture of a
  // person *anywhere* to decide first touch, and needs to know no other show has
  // already claimed an opportunity. Loading only this show's leads would give
  // the newest show every recurring buyer, silently and flatteringly.
  const allShows = await db
    .select({ id: s.shows.id })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId));
  const rows = await loadRoiRows(actor.orgId, allShows.map((r) => r.id), db);
  const attributions = attributeAll(rows.leads, rows.opportunities, settings);

  return rollUpShowRoi(
    {
      show: {
        id: show.id,
        name: show.name,
        status: show.status,
        startsOn: show.startsOn,
        endsOn: show.endsOn,
      },
      cost,
      leads: coverage.get(showId)!.coverage,
      meetingsHeld: rows.meetingsHeld.get(showId) ?? 0,
      attribution: summarizeShow(showId, attributions),
      matching: rows.matching.get(showId) ?? EMPTY_MATCHING,
      typedPipelineCents: rows.typedPipeline.get(showId) ?? null,
    },
    settings,
    asOf,
  );
}

/** The opportunities behind one show's figure, so a number can be opened. */
export type ShowOpportunityRow = {
  externalId: string;
  name: string;
  stage: string;
  stageKind: string;
  amountCents: number | null;
  verdict: string;
  verdictKind: string;
  replayed: boolean;
  leadName: string | null;
};

export async function listShowOpportunities(
  actor: Actor,
  showId: string,
  opts: { settings?: AttributionSettings } = {},
  db: Db = getDb(),
): Promise<ShowOpportunityRow[]> {
  if (!canSeeRoi(actor)) {
    throw new ForbiddenError('An ROI figure contains a cost figure.');
  }
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const allShows = await db
    .select({ id: s.shows.id })
    .from(s.shows)
    .where(eq(s.shows.orgId, actor.orgId));
  const rows = await loadRoiRows(actor.orgId, allShows.map((r) => r.id), db);
  const attributions = attributeAll(rows.leads, rows.opportunities, settings);

  const detail = await db
    .select({ externalId: s.crmOpportunities.externalId, name: s.crmOpportunities.name, stage: s.crmOpportunities.stage })
    .from(s.crmOpportunities)
    .where(eq(s.crmOpportunities.orgId, actor.orgId));
  const names = new Map(detail.map((d) => [d.externalId, d]));

  const out: ShowOpportunityRow[] = [];
  for (const a of attributions) {
    const verdict = a.verdicts.get(showId);
    if (!verdict || verdict.kind === 'none') continue;
    const d = names.get(a.opportunity.externalId);
    out.push({
      externalId: a.opportunity.externalId,
      name: d?.name ?? a.opportunity.externalId,
      stage: d?.stage ?? '—',
      stageKind: a.opportunity.stageKind,
      amountCents: a.opportunity.amountCents,
      verdictKind: verdict.kind,
      verdict:
        verdict.kind === 'sourced'
          ? `Sourced — opened ${verdict.daysAfter} days after this show, and this is where we met them first.`
          : verdict.kind === 'influenced'
            ? verdict.reason
            : verdict.reason,
      replayed: a.opportunity.replayed,
      leadName: null,
    });
  }
  return out.sort((x, y) => (y.amountCents ?? 0) - (x.amountCents ?? 0));
}

export async function listSyncRuns(
  actor: Actor,
  limit = 10,
  db: Db = getDb(),
): Promise<(typeof s.crmSyncRuns.$inferSelect & { startedByName: string | null })[]> {
  if (!canSeeRoi(actor)) throw new ForbiddenError('CRM sync history sits with the ROI figures.');
  const rows = await db
    .select({ run: s.crmSyncRuns, name: s.users.fullName })
    .from(s.crmSyncRuns)
    .leftJoin(s.users, eq(s.crmSyncRuns.startedById, s.users.id))
    .where(eq(s.crmSyncRuns.orgId, actor.orgId))
    .orderBy(desc(s.crmSyncRuns.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.run, startedByName: r.name }));
}

/* ---------------------------------- the sweep ------------------------------ */

export type RoiSweepResult = AlertSyncResult & { planned: PlannedRoiAlert[] };

/**
 * Tonight's ROI alerts, planned over **every** show rather than over what
 * changed — `alerts/store.ts` resolves by absence from the plan, and an engine
 * that planned over a subset would silently close every row it did not look at.
 */
export async function planRoiSweep(
  orgId: string,
  now: Date,
  db: Db,
): Promise<PlannedRoiAlert[]> {
  const shows = await db.select().from(s.shows).where(eq(s.shows.orgId, orgId));
  const showIds = shows.map((sh) => sh.id);
  const rows = await loadRoiRows(orgId, showIds, db);

  // Cost is wanted here only for the sentence inside one alert, so this is
  // deliberately the cheap version — recorded expenses — rather than the full
  // rollup. It is a figure a reader recognises, and the alert says "recorded
  // cost" rather than "true cost" so the two cannot be confused.
  const expenses = showIds.length
    ? await db
        .select({ showId: s.expenses.showId, amountCents: s.expenses.amountCents })
        .from(s.expenses)
        .where(inArray(s.expenses.showId, showIds))
    : [];
  const recordedCost = new Map<string, number>();
  for (const e of expenses) {
    recordedCost.set(e.showId, (recordedCost.get(e.showId) ?? 0) + e.amountCents);
  }

  const alertable: RoiAlertableShow[] = shows.map((show) => ({
    showId: show.id,
    showName: show.name,
    endsOn: show.endsOn,
    status: show.status,
    maturity: maturityOf(show, now),
    leadCount: rows.matching.get(show.id)?.leads ?? 0,
    matching: rows.matching.get(show.id) ?? EMPTY_MATCHING,
    attributionsUnwritten: rows.attributionsUnwritten.get(show.id) ?? 0,
    replayed: rows.replayedLinks,
    costCents: recordedCost.get(show.id) ?? 0,
  }));

  // The consecutive-failure run, newest first. One failed sync is a network and
  // the second is a problem, which is why the count and not the last message
  // decides the severity.
  const recent = await db
    .select()
    .from(s.crmSyncRuns)
    .where(eq(s.crmSyncRuns.orgId, orgId))
    .orderBy(desc(s.crmSyncRuns.startedAt))
    .limit(5);

  let failures: { provider: string; reason: string; count: number } | null = null;
  if (recent[0]?.failedReason) {
    let count = 0;
    for (const r of recent) {
      if (!r.failedReason) break;
      count += 1;
    }
    failures = { provider: recent[0].provider, reason: recent[0].failedReason, count };
  }

  return planRoiAlerts(alertable, failures, now);
}

export async function sweepRoiAlerts(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<RoiSweepResult> {
  const planned = await planRoiSweep(orgId, now, db);
  const result = await syncConditionAlerts(db, {
    orgId,
    source: 'roi',
    writes: planned.map((p) => ({
      showId: p.showId,
      userId: p.userId,
      severity: p.severity,
      title: p.title,
      body: p.body,
      dedupeKey: p.dedupeKey,
    })),
    now,
  });
  return { ...result, planned };
}
