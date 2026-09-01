import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { ForbiddenError, type Actor } from '@/lib/auth/actor';
import { NotFoundError } from '@/lib/shows/store';
import { syncConditionAlerts, type AlertSyncResult, type AlertWrite } from '@/lib/alerts/store';
import {
  canCaptureLead,
  canManageIntakeKeys,
  canManageLeads,
  canRedactLead,
  canRecordMeeting,
  canSeeAllLeadDetail,
} from './access';
import {
  basisOf,
  marketabilityOf,
  planRedaction,
  retentionDueAt,
  retentionStandingOf,
  type LawfulBasis,
  type Marketability,
  type RetentionStanding,
} from './consent';
import { assessCoverage, type CapturingStaff, type CountableLead, type LeadCoverage } from './coverage';
import {
  findMatch,
  findPossiblePairs,
  isBlocking,
  type DedupeCandidate,
  type Match,
} from './dedupe';
import {
  LeadError,
  validateLead,
  validateMeeting,
  validateRedactionReason,
  type LeadDraft,
  type MeetingInput,
} from './edit';
import { planLeadAlerts, type AlertableShow, type PlannedLeadAlert } from './alerts';
import { hashToken, hashesMatch, issueKey, REFUSALS, type IntakePrincipal, type IntakeRefusal } from './intake';
import { inferMapping, parseCsv, planImport, type ColumnMapping, type ImportPlan } from './parse';

type Db = ReturnType<typeof getDb>;

/**
 * The rows half of leads. Org-scoped through the show, like shipping — the
 * subject is a show, and a lead has no life outside one.
 *
 * It decides nothing: consent, retention, duplication, coverage and the alerts
 * were all settled above it. What it holds is the two narrowings the pure layer
 * cannot express, and both matter.
 *
 * **PII is narrowed in the query, never in the markup.** A Member's read of a
 * show's leads returns the rows they captured. Not "returns everything and the
 * page hides the rest" — `travelerScope`'s posture, applied to a stranger's
 * phone number instead of a colleague's fare, and for a stronger reason: §9.8
 * makes this regulated data, and data minimisation is not satisfied by a
 * conditional in JSX.
 *
 * **The count is not narrowed.** `coverageFor` reads every lead on the show for
 * everybody, because a count is not personal data and §8c's entire mitigation is
 * that a thin number is visibly thin to the person who could fix it. The two
 * reads are separate functions rather than one function with a flag, so nothing
 * can accidentally serve the wrong one.
 */

export { LeadError };

/* ---------------------------------- shapes --------------------------------- */

export type LeadRow = {
  id: string;
  showId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  interests: string[] | null;
  externalRef: string | null;
  source: string;
  basis: LawfulBasis;
  consentCapturedAt: Date | null;
  consentNotice: string | null;
  capturedAt: Date;
  capturedById: string | null;
  capturedByName: string | null;
  deleteAfter: Date;
  retention: RetentionStanding;
  redactedAt: Date | null;
  redactionReason: string | null;
  duplicateOfId: string | null;
  /**
   * Whether this row may leave the building — a mailing list, a CRM sync, an
   * export. Computed here rather than at the point of export so the answer is on
   * the screen a person is looking at when they could still fix it, and so
   * §19's exporter reads a verdict rather than re-deriving one.
   */
  outbound: Marketability;
  /** True when this row's personal fields were withheld from this reader. */
  restricted: boolean;
};

export type MeetingRow = {
  id: string;
  showId: string;
  subject: string;
  company: string | null;
  isExistingCustomer: boolean;
  scheduledAt: Date | null;
  occurredAt: Date | null;
  noShowAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
  leadId: string | null;
  notes: string | null;
};

/* ---------------------------------- reading -------------------------------- */

async function showInOrg(actor: Actor, showId: string, db: Db) {
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, showId), eq(s.shows.orgId, actor.orgId)),
  });
  if (!show) throw new NotFoundError('show');
  return show;
}

function toLeadRow(
  row: typeof s.leads.$inferSelect,
  capturedByName: string | null,
  visible: boolean,
  asOf: Date,
): LeadRow {
  const deleteAfter = retentionDueAt(row.capturedAt, row.deleteAfter);
  const base = {
    id: row.id,
    showId: row.showId,
    externalRef: row.externalRef,
    source: row.source,
    basis: basisOf(row.consentBasis),
    consentCapturedAt: row.consentCapturedAt,
    capturedAt: row.capturedAt,
    capturedById: row.capturedById,
    capturedByName,
    deleteAfter,
    retention: retentionStandingOf(row, asOf),
    redactedAt: row.redactedAt,
    redactionReason: row.redactionReason,
    duplicateOfId: row.duplicateOfId,
    outbound: marketabilityOf({
      basis: basisOf(row.consentBasis),
      consentCapturedAt: row.consentCapturedAt,
      consentNotice: row.consentNotice,
      redactedAt: row.redactedAt,
    }),
  };
  if (!visible) {
    // Withheld, and *labelled* withheld. A blank name would be indistinguishable
    // from an erased row, and those are opposite facts about the same person.
    return {
      ...base,
      fullName: 'Withheld',
      email: null,
      phone: null,
      company: null,
      title: null,
      notes: null,
      interests: null,
      consentNotice: null,
      restricted: true,
    };
  }
  return {
    ...base,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    company: row.company,
    title: row.title,
    notes: row.notes,
    interests: row.interests,
    consentNotice: row.consentNotice,
    restricted: false,
  };
}

/**
 * A show's leads, narrowed. An approver gets every row whole; anybody else gets
 * their own whole and everybody else's as a labelled shell — present, counted,
 * unreadable.
 */
export async function listShowLeads(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<LeadRow[]> {
  await showInOrg(actor, showId, db);
  const seesAll = canSeeAllLeadDetail(actor);
  const rows = await db
    .select({ lead: s.leads, capturedByName: s.users.fullName })
    .from(s.leads)
    .leftJoin(s.users, eq(s.leads.capturedById, s.users.id))
    .where(eq(s.leads.showId, showId))
    .orderBy(desc(s.leads.capturedAt));

  return rows.map((r) =>
    toLeadRow(
      r.lead,
      r.capturedByName ?? null,
      seesAll || r.lead.capturedById === actor.userId,
      asOf,
    ),
  );
}

export async function listShowMeetings(
  actor: Actor,
  showId: string,
  db: Db = getDb(),
): Promise<MeetingRow[]> {
  await showInOrg(actor, showId, db);
  const rows = await db
    .select({ meeting: s.meetings, ownerName: s.users.fullName })
    .from(s.meetings)
    .leftJoin(s.users, eq(s.meetings.ownerId, s.users.id))
    .where(eq(s.meetings.showId, showId))
    .orderBy(asc(s.meetings.scheduledAt));
  return rows.map((r) => ({
    id: r.meeting.id,
    showId: r.meeting.showId,
    subject: r.meeting.subject,
    company: r.meeting.company,
    isExistingCustomer: r.meeting.isExistingCustomer,
    scheduledAt: r.meeting.scheduledAt,
    occurredAt: r.meeting.occurredAt,
    noShowAt: r.meeting.noShowAt,
    ownerId: r.meeting.ownerId,
    ownerName: r.ownerName ?? null,
    leadId: r.meeting.leadId,
    notes: r.meeting.notes,
  }));
}

/**
 * Every show's capture coverage, in a fixed number of queries.
 *
 * `cost/store.ts`'s shape and for its reason: the portfolio and a show's own tab
 * are the same code path, so they cannot disagree about whether a show's count
 * is thin. A per-show loop here would also be the sweep's inner loop, which is
 * how a nightly job becomes sixty round trips.
 */
export async function loadCoverage(
  orgId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<Map<string, { show: typeof s.shows.$inferSelect; coverage: LeadCoverage }>> {
  const shows = await db.select().from(s.shows).where(eq(s.shows.orgId, orgId));
  const out = new Map<string, { show: typeof s.shows.$inferSelect; coverage: LeadCoverage }>();
  if (shows.length === 0) return out;
  const ids = shows.map((sh) => sh.id);

  const [leadRows, rostered] = await Promise.all([
    db
      .select({
        id: s.leads.id,
        showId: s.leads.showId,
        capturedById: s.leads.capturedById,
        capturedAt: s.leads.capturedAt,
        deleteAfter: s.leads.deleteAfter,
        redactedAt: s.leads.redactedAt,
        consentBasis: s.leads.consentBasis,
        duplicateOfId: s.leads.duplicateOfId,
      })
      .from(s.leads)
      .where(inArray(s.leads.showId, ids)),

    // "On the booth" is a shift assignment, not attendance — see `coverage.ts`
    // for why counting every attendee makes every show look under-covered.
    db
      .selectDistinct({
        showId: s.boothShifts.showId,
        userId: s.shiftAssignments.userId,
        fullName: s.users.fullName,
      })
      .from(s.shiftAssignments)
      .innerJoin(s.boothShifts, eq(s.shiftAssignments.shiftId, s.boothShifts.id))
      .innerJoin(s.users, eq(s.shiftAssignments.userId, s.users.id))
      .where(inArray(s.boothShifts.showId, ids)),
  ]);

  for (const show of shows) {
    const leads: CountableLead[] = leadRows.filter((l) => l.showId === show.id);
    const staff: CapturingStaff[] = rostered
      .filter((r) => r.showId === show.id)
      .map((r) => ({ userId: r.userId, fullName: r.fullName, onBooth: true }));
    out.set(show.id, {
      show,
      coverage: assessCoverage({ show, staff, leads }, asOf),
    });
  }
  return out;
}

export type LeadPortfolioEntry = {
  showId: string;
  showName: string;
  status: string;
  startsOn: Date;
  endsOn: Date;
  timezone: string;
  coverage: LeadCoverage;
  meetingsHeld: number;
  meetingsBooked: number;
  meetingsNoShow: number;
};

/**
 * The portfolio, ordered worst-first for the sixth time: a show that ran and
 * recorded nothing outranks one running now that is merely thin, and a future
 * show with nothing yet sorts last because that is not a finding.
 */
export async function getLeadPortfolio(
  actor: Actor,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<LeadPortfolioEntry[]> {
  const coverage = await loadCoverage(actor.orgId, asOf, db);
  const ids = [...coverage.keys()];
  const meetings = ids.length
    ? await db
        .select({
          showId: s.meetings.showId,
          occurredAt: s.meetings.occurredAt,
          noShowAt: s.meetings.noShowAt,
        })
        .from(s.meetings)
        .where(inArray(s.meetings.showId, ids))
    : [];

  const entries: LeadPortfolioEntry[] = [];
  for (const [showId, { show, coverage: c }] of coverage) {
    // A prospect is absent rather than shown at zero — §8a's rule, because a
    // zero in a scoreboard reads as a failure instead of as an absence.
    if (show.status === 'prospect') continue;
    const mine = meetings.filter((m) => m.showId === showId);
    entries.push({
      showId,
      showName: show.name,
      status: show.status,
      startsOn: show.startsOn,
      endsOn: show.endsOn,
      timezone: show.timezone,
      coverage: c,
      meetingsHeld: mine.filter((m) => m.occurredAt).length,
      meetingsBooked: mine.filter((m) => !m.occurredAt && !m.noShowAt).length,
      meetingsNoShow: mine.filter((m) => m.noShowAt).length,
    });
  }

  const rank: Record<string, number> = {
    none: 0,
    unknown: 1,
    partial: 2,
    sound: 3,
    not_yet: 4,
  };
  return entries.sort((a, b) => {
    const d = rank[a.coverage.standing] - rank[b.coverage.standing];
    if (d !== 0) return d;
    if (a.coverage.retentionOverdue !== b.coverage.retentionOverdue) {
      return b.coverage.retentionOverdue - a.coverage.retentionOverdue;
    }
    return b.startsOn.getTime() - a.startsOn.getTime();
  });
}

export type LeadImportRow = {
  id: string;
  filename: string | null;
  importedByName: string | null;
  createdAt: Date;
  rowsRead: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  problems: { row: number; reason: string }[];
  mapping: Record<string, string | null> | null;
  notes: string | null;
};

export type PossiblePair = {
  keep: { id: string; fullName: string; capturedAt: Date; capturedByName: string | null };
  other: { id: string; fullName: string; capturedAt: Date; capturedByName: string | null };
  company: string | null;
};

export type LeadBoard = {
  show: typeof s.shows.$inferSelect;
  coverage: LeadCoverage;
  leads: LeadRow[];
  /**
   * Same name, same company, both admitted — the one match `dedupe.ts` refuses
   * to settle on its own. Offered to somebody who can, because the alternative
   * is that "surfaced and never auto-resolved" quietly means discarded.
   */
  possiblePairs: PossiblePair[];
  meetings: MeetingRow[];
  imports: LeadImportRow[];
  people: { id: string; fullName: string }[];
  may: {
    capture: boolean;
    manage: boolean;
    redact: boolean;
    seeAllDetail: boolean;
  };
};

/** Everything the show's Leads tab renders, in one read. */
export async function getLeadBoard(
  actor: Actor,
  showId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<LeadBoard> {
  const show = await showInOrg(actor, showId, db);
  const coverage = await loadCoverage(actor.orgId, asOf, db);
  const [leads, meetings, importRows, people] = await Promise.all([
    listShowLeads(actor, showId, asOf, db),
    listShowMeetings(actor, showId, db),
    db
      .select({ batch: s.leadImports, byName: s.users.fullName })
      .from(s.leadImports)
      .leftJoin(s.users, eq(s.leadImports.importedById, s.users.id))
      .where(eq(s.leadImports.showId, showId))
      .orderBy(desc(s.leadImports.createdAt)),
    db
      .select({ id: s.users.id, fullName: s.users.fullName })
      .from(s.users)
      .where(eq(s.users.orgId, actor.orgId))
      .orderBy(asc(s.users.fullName)),
  ]);

  // A pair somebody has already settled is not a question any more.
  const settled = new Set(leads.filter((l) => l.duplicateOfId).map((l) => l.id));
  const pairs = findPossiblePairs(
    (await dedupeCandidates(showId, db)).filter((c) => !settled.has(c.id)),
  );

  return {
    show,
    coverage: coverage.get(showId)!.coverage,
    leads,
    possiblePairs: pairs.map((p) => ({
      keep: {
        id: p.keep.id,
        fullName: p.keep.fullName,
        capturedAt: p.keep.capturedAt,
        capturedByName: p.keep.capturedByName,
      },
      other: {
        id: p.other.id,
        fullName: p.other.fullName,
        capturedAt: p.other.capturedAt,
        capturedByName: p.other.capturedByName,
      },
      company: p.keep.company,
    })),
    meetings,
    imports: importRows.map((r) => ({
      id: r.batch.id,
      filename: r.batch.filename,
      importedByName: r.byName ?? null,
      createdAt: r.batch.createdAt,
      rowsRead: r.batch.rowsRead,
      accepted: r.batch.accepted,
      rejected: r.batch.rejected,
      duplicates: r.batch.duplicates,
      problems: r.batch.problems ?? [],
      mapping: r.batch.mapping ?? null,
      notes: r.batch.notes,
    })),
    people,
    may: {
      capture: canCaptureLead(),
      manage: canManageLeads(actor),
      redact: canRedactLead(actor),
      seeAllDetail: canSeeAllLeadDetail(actor),
    },
  };
}

/* ---------------------------------- writing -------------------------------- */

async function dedupeCandidates(showId: string, db: Db): Promise<DedupeCandidate[]> {
  const rows = await db
    .select({
      id: s.leads.id,
      fullName: s.leads.fullName,
      email: s.leads.email,
      company: s.leads.company,
      externalRef: s.leads.externalRef,
      capturedAt: s.leads.capturedAt,
      capturedByName: s.users.fullName,
    })
    .from(s.leads)
    .leftJoin(s.users, eq(s.leads.capturedById, s.users.id))
    .where(eq(s.leads.showId, showId));
  return rows.map((r) => ({ ...r, capturedByName: r.capturedByName ?? null }));
}

type WriteLeadArgs = {
  showId: string;
  draft: LeadDraft;
  capturedById: string | null;
  source: 'manual' | 'csv' | 'api';
  importId?: string | null;
  now: Date;
};

async function insertLead(db: Db, a: WriteLeadArgs, duplicateOfId: string | null = null) {
  const [row] = await db
    .insert(s.leads)
    .values({
      showId: a.showId,
      capturedById: a.capturedById,
      fullName: a.draft.fullName,
      email: a.draft.email,
      phone: a.draft.phone,
      company: a.draft.company,
      title: a.draft.title,
      notes: a.draft.notes,
      interests: a.draft.interests,
      externalRef: a.draft.externalRef,
      source: a.source,
      importId: a.importId ?? null,
      duplicateOfId,
      consentBasis: a.draft.basis,
      // A timestamp only where there is something to timestamp. Stamping "now"
      // on an unknown basis would turn an absence into a record of an event.
      consentCapturedAt: a.draft.basis === 'unknown' ? null : a.now,
      consentNotice: a.draft.consentNotice,
      deleteAfter: retentionDueAt(a.now, null),
      capturedAt: a.now,
      updatedAt: a.now,
    })
    .returning();
  return row;
}

export type CaptureResult = {
  lead: typeof s.leads.$inferSelect | null;
  /** Set when a match was found. On a blocking match nothing was written. */
  match: Match | null;
};

/**
 * Capture one lead, by hand, at the booth.
 *
 * A blocking duplicate is refused rather than merged — the existing row is
 * returned so the person can be told which one and by whom, which is the
 * difference between "already captured, Priya got it an hour ago" and a silent
 * no-op that looks like the app losing their work.
 */
export async function captureLead(
  actor: Actor,
  showId: string,
  input: Parameters<typeof validateLead>[0],
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<CaptureResult> {
  if (!canCaptureLead()) throw new ForbiddenError('capture a lead');
  await showInOrg(actor, showId, db);
  const draft = validateLead(input);

  const match = findMatch(draft, await dedupeCandidates(showId, db));
  if (isBlocking(match)) return { lead: null, match };

  const lead = await insertLead(db, {
    showId,
    draft,
    capturedById: actor.userId,
    source: 'manual',
    now,
  });
  return { lead, match };
}

/**
 * Parse and plan a file without writing anything.
 *
 * The import is two steps because of `parse.ts`'s third rule: a mapping is
 * declared, not guessed. `inferMapping` proposes from the headers badge vendors
 * actually ship, and a person confirms it — the failure that avoids is a column
 * called `Company` that is really the *exhibitor's* company, silently filed as
 * every lead's employer, plausibly, forever.
 *
 * Duplicates are decided against the show's existing rows here rather than in
 * `parse.ts`, which is pure.
 */
export async function previewImport(
  actor: Actor,
  args: { showId: string; text: string; mapping?: ColumnMapping },
  db: Db = getDb(),
): Promise<{ headers: string[]; mapping: ColumnMapping; plan: ImportPlan }> {
  if (!canManageLeads(actor)) {
    throw new ForbiddenError('import leads — importing a file is a change to the plan');
  }
  await showInOrg(actor, args.showId, db);
  const rows = parseCsv(args.text);
  if (rows.length === 0) throw new LeadError('That file has no rows.');
  const headers = rows[0];
  const mapping = args.mapping ?? inferMapping(headers);
  const existing = await dedupeCandidates(args.showId, db);
  const plan = planImport(rows, mapping, {
    isDuplicate: (draft) => {
      const match = findMatch(draft, existing);
      return isBlocking(match) ? match.reason : null;
    },
  });
  return { headers, mapping, plan };
}

export type ImportResult = {
  importId: string;
  plan: ImportPlan;
  written: number;
};

/**
 * Write a planned import, and record the plan whole.
 *
 * The `lead_imports` row is written **whether or not anything was accepted**. An
 * import of a broken file that writes no leads and no record leaves a person
 * certain they imported and a screen certain they did not, which is the argument
 * they will not win.
 */
export async function commitImport(
  actor: Actor,
  args: {
    showId: string;
    plan: ImportPlan;
    mapping: ColumnMapping;
    filename: string | null;
    now?: Date;
  },
  db: Db = getDb(),
): Promise<ImportResult> {
  if (!canManageLeads(actor)) {
    throw new ForbiddenError('import leads — importing a file is a change to the plan');
  }
  const now = args.now ?? new Date();
  await showInOrg(actor, args.showId, db);
  const { plan } = args;

  const [batch] = await db
    .insert(s.leadImports)
    .values({
      orgId: actor.orgId,
      showId: args.showId,
      importedById: actor.userId,
      source: 'csv',
      filename: args.filename,
      mapping: args.mapping,
      rowsRead: plan.rowsRead,
      accepted: plan.accepted.length,
      rejected: plan.rejected.length,
      duplicates: plan.duplicates.length,
      problems: [...plan.rejected, ...plan.duplicates],
      notes: plan.basisUnmapped
        ? 'No column was mapped to a lawful basis, so every lead in this file was recorded with none.'
        : null,
      createdAt: now,
    })
    .returning();

  let written = 0;
  for (const draft of plan.accepted) {
    await insertLead(db, {
      showId: args.showId,
      draft: { ...draft },
      // An imported lead has no capturer. Attributing the file to whoever
      // uploaded it would make one person's coverage look perfect and everybody
      // else's look worse, which is exactly backwards.
      capturedById: null,
      source: 'csv',
      importId: batch.id,
      now,
    });
    written += 1;
  }

  return { importId: batch.id, plan, written };
}

export async function recordMeeting(
  actor: Actor,
  showId: string,
  input: MeetingInput,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<typeof s.meetings.$inferSelect> {
  if (!canRecordMeeting()) throw new ForbiddenError('record a meeting');
  await showInOrg(actor, showId, db);
  const draft = validateMeeting(input);
  if (draft.leadId) {
    const lead = await db.query.leads.findFirst({
      where: and(eq(s.leads.id, draft.leadId), eq(s.leads.showId, showId)),
    });
    if (!lead) throw new LeadError('That lead is not on this show.');
  }
  const [row] = await db
    .insert(s.meetings)
    .values({
      showId,
      subject: draft.subject,
      company: draft.company,
      isExistingCustomer: draft.isExistingCustomer,
      scheduledAt: draft.scheduledAt,
      occurredAt: draft.occurredAt,
      noShowAt: draft.noShowAt,
      ownerId: draft.ownerId ?? actor.userId,
      leadId: draft.leadId,
      notes: draft.notes,
      createdById: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

/**
 * Two rows, one person — said by somebody who would know.
 *
 * `dedupe.ts` refuses to merge a name-plus-company match because two people
 * really can share a name at a big enough show, and silently dropping a real
 * second lead is the same failure as counting a fake one. That refusal is only
 * honest if something later *asks*, which is what this is.
 *
 * It sits with changing the plan rather than with reporting, for one reason:
 * marking a duplicate **moves the lead count**, and therefore moves every figure
 * §19 will divide by it. Same bar as skipping a task, waiving a deadline, or
 * erasing a lead.
 *
 * Nothing is deleted and nothing is merged. The row keeps its own capture, its
 * own consent record and its own retention clock — it is simply not counted
 * twice — so the decision is reversible by the next person who looks, which is
 * exactly what a judgement call about two strangers with the same name should be.
 */
export async function markDuplicate(
  actor: Actor,
  leadId: string,
  ofLeadId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canManageLeads(actor)) {
    throw new ForbiddenError('mark a lead as a duplicate — it moves the count, so it is a change to the plan');
  }
  if (leadId === ofLeadId) throw new LeadError('A lead cannot be a duplicate of itself.');

  const rows = await db
    .select({ lead: s.leads })
    .from(s.leads)
    .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
    .where(and(inArray(s.leads.id, [leadId, ofLeadId]), eq(s.shows.orgId, actor.orgId)));
  const lead = rows.find((r) => r.lead.id === leadId)?.lead;
  const target = rows.find((r) => r.lead.id === ofLeadId)?.lead;
  if (!lead || !target) throw new NotFoundError('lead');
  if (lead.showId !== target.showId) {
    // §5j: the same person met at two shows is two engagements with two costs.
    throw new LeadError(
      'Those leads are on different shows. Meeting the same person twice is two conversations with two costs, and collapsing them would hand one show credit for the other’s.',
    );
  }
  if (target.duplicateOfId) {
    // No chains: a duplicate of a duplicate makes "how many leads" depend on
    // the order somebody clicked in.
    throw new LeadError(
      'That lead is itself marked as a duplicate. Point this one at the original instead.',
    );
  }
  await db
    .update(s.leads)
    .set({ duplicateOfId: ofLeadId, updatedAt: now })
    .where(eq(s.leads.id, leadId));
}

/** Two people after all. The row goes back into the count. */
export async function unmarkDuplicate(
  actor: Actor,
  leadId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canManageLeads(actor)) {
    throw new ForbiddenError('unmark a lead as a duplicate — it moves the count, so it is a change to the plan');
  }
  const rows = await db
    .select({ id: s.leads.id })
    .from(s.leads)
    .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
    .where(and(eq(s.leads.id, leadId), eq(s.shows.orgId, actor.orgId)));
  if (rows.length === 0) throw new NotFoundError('lead');
  await db
    .update(s.leads)
    .set({ duplicateOfId: null, updatedAt: now })
    .where(eq(s.leads.id, leadId));
}

/**
 * Erase a person, and keep the fact that a conversation happened.
 *
 * `consent.ts` has the argument. The one thing enforced here that it cannot be:
 * a redaction is idempotent and a second one is refused, because re-redacting
 * would overwrite the original reason and the original date — and "when did we
 * erase this" is the only evidence that we honoured the request on time.
 */
export async function redactLead(
  actor: Actor,
  leadId: string,
  reason: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canRedactLead(actor)) {
    throw new ForbiddenError('erase a lead — erasure is permanent, so it sits with changing the plan');
  }
  const written = validateRedactionReason(reason);
  const row = await db
    .select({ lead: s.leads })
    .from(s.leads)
    .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
    .where(and(eq(s.leads.id, leadId), eq(s.shows.orgId, actor.orgId)));
  if (row.length === 0) throw new NotFoundError('lead');
  if (row[0].lead.redactedAt) {
    throw new LeadError(
      'This lead was already erased. Erasing again would overwrite the date and reason of the first erasure, which is the evidence that it was honoured.',
    );
  }
  await db
    .update(s.leads)
    .set({ ...planRedaction(written, now), redactedById: actor.userId, updatedAt: now })
    .where(eq(s.leads.id, leadId));
}

export type RetentionSweepResult = {
  examined: number;
  erased: number;
  shows: { showId: string; showName: string; count: number }[];
};

/**
 * Erase everything past its date.
 *
 * This is the function that makes `delete_after` a policy rather than a column.
 * A retention limit nothing enforces is worse than none — it is a documented
 * commitment being documented-ly broken, which is what the `retention_overdue`
 * alert exists to say out loud until somebody runs this.
 *
 * It plans over every unredacted lead in the org, not over what changed, for the
 * reason `alerts/store.ts` states: absence from tonight's plan is what resolves
 * the alert, and an engine that looked at a subset would close rows it never
 * examined.
 */
export async function sweepLeadRetention(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<RetentionSweepResult> {
  const rows = await db
    .select({ lead: s.leads, showName: s.shows.name })
    .from(s.leads)
    .innerJoin(s.shows, eq(s.leads.showId, s.shows.id))
    .where(and(eq(s.shows.orgId, orgId), isNull(s.leads.redactedAt)));

  const byShow = new Map<string, { showId: string; showName: string; count: number }>();
  let erased = 0;
  for (const { lead, showName } of rows) {
    if (retentionStandingOf(lead, now) !== 'overdue') continue;
    await db
      .update(s.leads)
      .set({
        ...planRedaction('Retention period ended.', now),
        redactedById: null,
        updatedAt: now,
      })
      .where(eq(s.leads.id, lead.id));
    erased += 1;
    const entry = byShow.get(lead.showId) ?? { showId: lead.showId, showName, count: 0 };
    entry.count += 1;
    byShow.set(lead.showId, entry);
  }

  return { examined: rows.length, erased, shows: [...byShow.values()] };
}

/* ---------------------------------- alerts --------------------------------- */

export type LeadSweepResult = AlertSyncResult & { planned: PlannedLeadAlert[] };

/**
 * Tonight's lead alerts.
 *
 * All four are addressed to whoever runs the show rather than to a person, and
 * that is `deadlines/alerts.ts`'s unowned-deadline correction arriving from a
 * sixth direction: three of the four conditions are *about somebody having done
 * nothing*, so an alert addressed to the natural owner would be addressed to
 * whoever failed to act, which is the audience least likely to act now.
 */
export async function planShowAlerts(
  orgId: string,
  asOf: Date = new Date(),
  db: Db = getDb(),
): Promise<PlannedLeadAlert[]> {
  const coverage = await loadCoverage(orgId, asOf, db);
  const shows: AlertableShow[] = [...coverage.values()].map(({ show, coverage: c }) => ({
    showId: show.id,
    showName: show.name,
    startsOn: show.startsOn,
    endsOn: show.endsOn,
    status: show.status,
    coverage: c,
  }));
  return planLeadAlerts(shows, asOf);
}

export async function sweepLeadAlerts(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<LeadSweepResult> {
  const planned = await planShowAlerts(orgId, now, db);
  const runners = await db
    .select({ id: s.users.id })
    .from(s.users)
    .where(and(eq(s.users.orgId, orgId), inArray(s.users.role, ['travel_manager', 'admin'])));

  const writes: AlertWrite[] = [];
  for (const alert of planned) {
    const recipients = new Set<string>(runners.map((r) => r.id));
    if (alert.userId) recipients.add(alert.userId);
    for (const userId of recipients) {
      writes.push({
        showId: alert.showId,
        userId,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        dedupeKey: `${alert.dedupeKey}:${userId}`,
      });
    }
  }

  const result = await syncConditionAlerts(db, { orgId, source: 'lead', writes, now });
  return { ...result, planned };
}

/* ------------------------------- intake keys ------------------------------- */

export type IntakeKeyRow = {
  id: string;
  label: string;
  tokenPrefix: string;
  showId: string | null;
  showName: string | null;
  createdAt: Date;
  createdByName: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

export async function listIntakeKeys(
  actor: Actor,
  db: Db = getDb(),
): Promise<IntakeKeyRow[]> {
  if (!canManageIntakeKeys(actor)) {
    throw new ForbiddenError('manage intake keys — a key is a credential, which is an admin act');
  }
  const rows = await db
    .select({ key: s.intakeKeys, showName: s.shows.name, createdByName: s.users.fullName })
    .from(s.intakeKeys)
    .leftJoin(s.shows, eq(s.intakeKeys.showId, s.shows.id))
    .leftJoin(s.users, eq(s.intakeKeys.createdById, s.users.id))
    .where(eq(s.intakeKeys.orgId, actor.orgId))
    .orderBy(desc(s.intakeKeys.createdAt));
  return rows.map((r) => ({
    id: r.key.id,
    label: r.key.label,
    tokenPrefix: r.key.tokenPrefix,
    showId: r.key.showId,
    showName: r.showName ?? null,
    createdAt: r.key.createdAt,
    createdByName: r.createdByName ?? null,
    lastUsedAt: r.key.lastUsedAt,
    revokedAt: r.key.revokedAt,
  }));
}

/** The plaintext is returned here and never again. Nothing stores it. */
export async function createIntakeKey(
  actor: Actor,
  args: { label: string; showId: string | null },
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<{ token: string; id: string }> {
  if (!canManageIntakeKeys(actor)) {
    throw new ForbiddenError('manage intake keys — a key is a credential, which is an admin act');
  }
  const label = args.label.trim();
  if (!label) throw new LeadError('Give the key a name, so a person can tell which scanner it is.');
  if (args.showId) await showInOrg(actor, args.showId, db);

  const issued = issueKey();
  const [row] = await db
    .insert(s.intakeKeys)
    .values({
      orgId: actor.orgId,
      showId: args.showId,
      label,
      tokenPrefix: issued.tokenPrefix,
      tokenHash: issued.tokenHash,
      createdById: actor.userId,
      createdAt: now,
    })
    .returning();
  return { token: issued.token, id: row.id };
}

export async function revokeIntakeKey(
  actor: Actor,
  keyId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<void> {
  if (!canManageIntakeKeys(actor)) {
    throw new ForbiddenError('manage intake keys — a key is a credential, which is an admin act');
  }
  const row = await db.query.intakeKeys.findFirst({
    where: and(eq(s.intakeKeys.id, keyId), eq(s.intakeKeys.orgId, actor.orgId)),
  });
  if (!row) throw new NotFoundError('intake key');
  if (row.revokedAt) return;
  await db
    .update(s.intakeKeys)
    .set({ revokedAt: now, revokedById: actor.userId })
    .where(eq(s.intakeKeys.id, keyId));
}

/**
 * Token → principal, or a refusal.
 *
 * The lookup is by hash, so the plaintext never appears in a query; the
 * constant-time compare afterwards is belt and braces against a database that
 * matched on a prefix index. A revoked key is told it was revoked — see
 * `intake.ts` for why this is the one place in the product that does not
 * deliberately blur a refusal.
 */
export async function resolveIntakeKey(
  token: string,
  db: Db = getDb(),
): Promise<{ principal: IntakePrincipal } | { refusal: IntakeRefusal }> {
  const hash = hashToken(token);
  const row = await db.query.intakeKeys.findFirst({ where: eq(s.intakeKeys.tokenHash, hash) });
  if (!row || !hashesMatch(row.tokenHash, hash)) return { refusal: REFUSALS.unknownKey() };
  if (row.revokedAt) return { refusal: REFUSALS.revoked(row.revokedAt) };
  return {
    principal: { keyId: row.id, orgId: row.orgId, showId: row.showId, label: row.label },
  };
}

export type IntakeOutcome =
  | { kind: 'created'; leadId: string }
  /** The same scan, already here. A retry, and a 200 rather than an error. */
  | { kind: 'duplicate'; leadId: string; reason: string }
  | { kind: 'refused'; refusal: IntakeRefusal };

/**
 * The one thing an intake key may do.
 *
 * Note what it does *not* take: an `Actor`. A scanner is not a person, so it
 * cannot reach anything an actor can reach, and that is a type-level fact rather
 * than a check somebody has to remember to write. See `intake.ts`.
 *
 * A duplicate is a **success**. A scanner retrying a request it never saw the
 * response to is the ordinary case on convention-centre wifi, and answering 409
 * teaches the integration to treat a correctly-recorded lead as a failure — at
 * which point somebody writes a retry loop that creates the duplicates this is
 * preventing.
 */
export async function intakeLead(
  principal: IntakePrincipal,
  args: { showId: string; input: Parameters<typeof validateLead>[0] },
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<IntakeOutcome> {
  if (principal.showId && principal.showId !== args.showId) {
    return { kind: 'refused', refusal: REFUSALS.wrongShow() };
  }
  const show = await db.query.shows.findFirst({
    where: and(eq(s.shows.id, args.showId), eq(s.shows.orgId, principal.orgId)),
  });
  // Not-found and wrong-org are one answer here, deliberately: a caller
  // enumerating show ids must not learn which of them exist in another
  // workspace. §3's rule about a Member loading a colleague's request.
  if (!show) return { kind: 'refused', refusal: REFUSALS.wrongShow() };

  let draft: LeadDraft;
  try {
    draft = validateLead(args.input);
  } catch (err) {
    if (err instanceof LeadError) return { kind: 'refused', refusal: REFUSALS.invalid(err.message) };
    throw err;
  }

  const match = findMatch(draft, await dedupeCandidates(args.showId, db));
  await db
    .update(s.intakeKeys)
    .set({ lastUsedAt: now })
    .where(eq(s.intakeKeys.id, principal.keyId));

  if (isBlocking(match)) {
    return { kind: 'duplicate', leadId: match.lead.id, reason: match.reason };
  }

  const lead = await insertLead(db, {
    showId: args.showId,
    draft,
    capturedById: null,
    source: 'api',
    now,
  });
  return { kind: 'created', leadId: lead.id };
}
