import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { listShows, NotFoundError } from '@/lib/shows/store';
import {
  captureLead,
  updateLead,
  commitImport,
  createIntakeKey,
  getLeadBoard,
  getLeadPortfolio,
  intakeLead,
  listShowLeads,
  markDuplicate,
  previewImport,
  recordMeeting,
  redactLead,
  resolveIntakeKey,
  revokeIntakeKey,
  sweepLeadAlerts,
  sweepLeadRetention,
  unmarkDuplicate,
  LeadError,
} from '@/lib/leads/store';
import { REDACTED_NAME } from '@/lib/leads/consent';

/**
 * Step 18 against the real database.
 *
 * The pure half — consent, retention, the CSV parser, dedupe, coverage and the
 * alerts — is tested with no database in `src/lib/leads/leads.test.ts`. What can
 * only be checked here is what touches rows: that a Member reads a colleague's
 * captured lead as a labelled shell rather than as personal data, that the
 * unique index makes a scanner's retry idempotent rather than merely
 * discouraged, that erasure leaves the count exactly where it was, and that an
 * intake key is a principal that cannot reach anything but one show's leads.
 */

const db = getDb();
const scratch: string[] = [];
const keys: string[] = [];
const scratchOrgs: string[] = [];

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

let shelley: Actor;
let marcus: Actor;
let priya: Actor;
let dmwestId: string;

beforeAll(async () => {
  shelley = await actorFor('shelley@northwindrobotics.test');
  marcus = await actorFor('marcus@northwindrobotics.test');
  priya = await actorFor('priya@northwindrobotics.test');
  const shows = await listShows(shelley);
  dmwestId = shows.find((sh) => sh.name.startsWith('Design & Manufacturing'))!.id;
});

afterAll(async () => {
  if (scratch.length) await db.delete(s.shows).where(inArray(s.shows.id, scratch));
  if (keys.length) await db.delete(s.intakeKeys).where(inArray(s.intakeKeys.id, keys));
  if (scratchOrgs.length) {
    await db.delete(s.organizations).where(inArray(s.organizations.id, scratchOrgs));
  }
});

/**
 * A whole throwaway workspace.
 *
 * The retention sweep needs one, and the reason is the finding step 15 recorded
 * about the assistant's own test cleanup: `sweepLeadRetention` is org-wide by
 * design — an engine that erased a subset would leave a documented commitment
 * half-kept — so running it against the seeded org would permanently erase the
 * seeded overdue leads and leave `pnpm db:reset && pnpm test` with a *worse*
 * demo than `pnpm db:reset` alone. Green suite, degraded workspace, and nothing
 * to notice it. So the destructive sweep gets its own org.
 */
async function scratchWorkspace(): Promise<{ actor: Actor; showId: string }> {
  const [org] = await db
    .insert(s.organizations)
    .values({ name: 'Retention scratch workspace' })
    .returning({ id: s.organizations.id });
  scratchOrgs.push(org.id);
  const [user] = await db
    .insert(s.users)
    .values({
      orgId: org.id,
      email: `retention-${org.id}@scratch.test`,
      fullName: 'Retention Admin',
      role: 'admin',
    })
    .returning();
  const [show] = await db
    .insert(s.shows)
    .values({
      orgId: org.id,
      name: 'Retention scratch show',
      status: 'live',
      timezone: 'UTC',
      startsOn: new Date(Date.now() - 86_400_000),
      endsOn: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: s.shows.id });
  return {
    actor: {
      userId: user.id,
      orgId: org.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      costCenterId: user.costCenterId,
    },
    showId: show.id,
  };
}

/** A throwaway show, so the seeded ones stay readable. */
async function scratchShow(name: string): Promise<string> {
  const [row] = await db
    .insert(s.shows)
    .values({
      orgId: shelley.orgId,
      name,
      status: 'live',
      timezone: 'America/Los_Angeles',
      startsOn: new Date(Date.now() - 86_400_000),
      endsOn: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: s.shows.id });
  scratch.push(row.id);
  return row.id;
}

const draft = (over: Record<string, unknown> = {}) => ({
  fullName: 'Jane Okafor',
  email: null,
  phone: null,
  company: null,
  title: null,
  notes: null,
  interests: null,
  externalRef: null,
  basis: null,
  consentNotice: null,
  ...over,
}) as Parameters<typeof captureLead>[2];

describe('capture', () => {
  it('is available to a Member, because a gated capture flow produces the bad count', async () => {
    const showId = await scratchShow('Capture scratch');
    const result = await captureLead(priya, showId, draft({ email: 'a@x.test' }));
    expect(result.lead).not.toBeNull();
    expect(result.lead!.capturedById).toBe(priya.userId);
    // Nothing was said about consent, so nothing is recorded — and no timestamp
    // is stamped either, or an absence becomes a record of an event.
    expect(result.lead!.consentBasis).toBe('unknown');
    expect(result.lead!.consentCapturedAt).toBeNull();
  });

  it('refuses a duplicate email on the same show and names who already has it', async () => {
    const showId = await scratchShow('Duplicate scratch');
    await captureLead(priya, showId, draft({ email: 'dup@x.test' }));
    const second = await captureLead(marcus, showId, draft({ email: 'DUP@x.test' }));
    expect(second.lead).toBeNull();
    expect(second.match?.kind).toBe('same_email');
    expect(second.match?.reason).toContain('Priya');
  });

  it('lets the same person be captured at two different shows', async () => {
    const a = await scratchShow('Cross-show A');
    const b = await scratchShow('Cross-show B');
    await captureLead(priya, a, draft({ email: 'both@x.test' }));
    const second = await captureLead(priya, b, draft({ email: 'both@x.test' }));
    // Two shows, two real engagements, two costs. Collapsing them would hand
    // one show credit for the other's conversation.
    expect(second.lead).not.toBeNull();
  });

  it('refuses a show in another workspace as not found', async () => {
    await expect(
      captureLead(priya, '00000000-0000-0000-0000-000000000000', draft()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('correcting a lead', () => {
  it('records consent after the fact, and stamps when it was recorded rather than when they met', async () => {
    const showId = await scratchShow('Edit consent scratch');
    const { lead } = await captureLead(priya, showId, draft({ email: 'later@x.test' }));
    expect(lead!.consentBasis).toBe('unknown');

    // The edit this form mostly exists for: `consent.ts` withholds an
    // unknown-basis row from everything outbound, and two lines on the tab tell
    // the reader to come here and fix it.
    const after = new Date(lead!.capturedAt.getTime() + 6 * 3_600_000);
    const saved = await updateLead(
      priya,
      lead!.id,
      draft({ email: 'later@x.test', basis: 'consent', consentNotice: 'Told at the booth.' }),
      after,
    );
    expect(saved.lead!.consentBasis).toBe('consent');
    // Six hours after the conversation, not at it. Back-dating this would
    // manufacture evidence the notice was given at the booth.
    expect(saved.lead!.consentCapturedAt!.getTime()).toBe(after.getTime());
    expect(saved.lead!.capturedAt.getTime()).toBe(lead!.capturedAt.getTime());
  });

  it('clears the consent timestamp when the basis goes back to unknown', async () => {
    const showId = await scratchShow('Edit downgrade scratch');
    const { lead } = await captureLead(
      priya,
      showId,
      draft({ email: 'down@x.test', basis: 'consent', consentNotice: 'Told something.' }),
    );
    expect(lead!.consentCapturedAt).not.toBeNull();
    const saved = await updateLead(priya, lead!.id, draft({ email: 'down@x.test', basis: null }));
    // A timestamp on an absence turns "nobody has said" into a record of an event.
    expect(saved.lead!.consentBasis).toBe('unknown');
    expect(saved.lead!.consentCapturedAt).toBeNull();
  });

  it('leaves the consent timestamp alone when the edit is not about consent', async () => {
    const showId = await scratchShow('Edit phone scratch');
    const { lead } = await captureLead(
      priya,
      showId,
      draft({ email: 'phone@x.test', basis: 'consent', consentNotice: 'Told something.' }),
    );
    const saved = await updateLead(
      priya,
      lead!.id,
      draft({ email: 'phone@x.test', phone: '+1 555 0100', basis: 'consent', consentNotice: 'Told something.' }),
      new Date(Date.now() + 3_600_000),
    );
    expect(saved.lead!.phone).toBe('+1 555 0100');
    expect(saved.lead!.consentCapturedAt!.getTime()).toBe(lead!.consentCapturedAt!.getTime());
  });

  it('refuses an edit that would make two rows the same person', async () => {
    // `dedupe.ts` says a same_email pair "cannot exist among stored leads,
    // because all three write paths refuse those". This is the fourth path, and
    // one that skipped the check would falsify that sentence silently.
    const showId = await scratchShow('Edit collide scratch');
    await captureLead(priya, showId, draft({ email: 'first@x.test' }));
    const { lead } = await captureLead(priya, showId, draft({ email: 'second@x.test' }));
    const saved = await updateLead(priya, lead!.id, draft({ email: 'first@x.test' }));
    expect(saved.lead).toBeNull();
    expect(saved.match?.kind).toBe('same_email');
  });

  it('does not collide a lead with itself', async () => {
    const showId = await scratchShow('Edit self scratch');
    const { lead } = await captureLead(priya, showId, draft({ email: 'self@x.test' }));
    const saved = await updateLead(priya, lead!.id, draft({ email: 'self@x.test', title: 'VP Ops' }));
    expect(saved.lead!.title).toBe('VP Ops');
  });

  it('refuses a Member editing a lead somebody else captured, and allows their own', async () => {
    const showId = await scratchShow('Edit reach scratch');
    const { lead: theirs } = await captureLead(marcus, showId, draft({ email: 'theirs@x.test' }));
    const { lead: mine } = await captureLead(priya, showId, draft({ email: 'mine2@x.test' }));
    await expect(
      updateLead(priya, theirs!.id, draft({ email: 'theirs@x.test', title: 'x' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Their own, though — the person who was standing there is the one who knows
    // what the notice was.
    const saved = await updateLead(priya, mine!.id, draft({ email: 'mine2@x.test', title: 'ok' }));
    expect(saved.lead!.title).toBe('ok');
  });

  it('refuses to edit an erased lead', async () => {
    const showId = await scratchShow('Edit erased scratch');
    const { lead } = await captureLead(priya, showId, draft({ email: 'gone@x.test' }));
    await redactLead(marcus, lead!.id, 'Erasure requested by the person.');
    await expect(
      updateLead(marcus, lead!.id, draft({ fullName: 'Back Again', email: 'gone@x.test' })),
    ).rejects.toThrow(/erased/i);
  });

  it('carries the scanner reference through rather than reading it from the form', async () => {
    // It is the idempotency rail a badge scanner retries against. Editing it
    // either collides with a real row or orphans the retry.
    const showId = await scratchShow('Edit ref scratch');
    const { lead } = await captureLead(priya, showId, draft({ externalRef: 'SCAN-1' }));
    const saved = await updateLead(priya, lead!.id, draft({ externalRef: null, title: 'Buyer' }));
    expect(saved.lead!.externalRef).toBe('SCAN-1');
  });

  it('refuses a lead in another workspace as not found', async () => {
    await expect(
      updateLead(priya, '00000000-0000-0000-0000-000000000000', draft()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('who reads the person behind the lead', () => {
  it('gives a Member the count and withholds a colleague’s capture', async () => {
    const showId = await scratchShow('PII scratch');
    await captureLead(marcus, showId, draft({ fullName: 'Held Back', email: 'pii@x.test' }));
    await captureLead(priya, showId, draft({ fullName: 'Priya’s Own', email: 'mine@x.test' }));

    const asMember = await listShowLeads(priya, showId);
    expect(asMember).toHaveLength(2);
    const theirs = asMember.find((l) => l.capturedById === marcus.userId)!;
    // Withheld and *labelled* withheld: a blank name would be indistinguishable
    // from an erased row, and those are opposite facts about the same person.
    expect(theirs.restricted).toBe(true);
    expect(theirs.email).toBeNull();
    expect(theirs.fullName).toBe('Withheld');
    expect(asMember.find((l) => l.capturedById === priya.userId)!.email).toBe('mine@x.test');

    const asApprover = await listShowLeads(shelley, showId);
    expect(asApprover.every((l) => !l.restricted)).toBe(true);
  });

  it('still counts a withheld lead in the coverage a Member sees', async () => {
    const showId = await scratchShow('Count scratch');
    await captureLead(marcus, showId, draft({ email: 'counted@x.test' }));
    const board = await getLeadBoard(priya, showId);
    expect(board.coverage.leadCount).toBe(1);
  });
});

describe('erasure', () => {
  it('nulls the person, keeps the count, and cannot be done twice', async () => {
    const showId = await scratchShow('Erasure scratch');
    const { lead } = await captureLead(priya, showId, draft({ email: 'erase@x.test' }));
    const before = (await getLeadBoard(shelley, showId)).coverage.leadCount;

    await redactLead(shelley, lead!.id, 'Erasure request received by email.');
    const row = await db.query.leads.findFirst({ where: eq(s.leads.id, lead!.id) });
    expect(row!.fullName).toBe(REDACTED_NAME);
    expect(row!.email).toBeNull();
    expect(row!.redactedAt).not.toBeNull();
    // The whole reason erasure is redaction: every ROI figure this show has
    // produced must not move months later, silently.
    expect((await getLeadBoard(shelley, showId)).coverage.leadCount).toBe(before);

    // A second erasure would overwrite the date and reason of the first, which
    // is the evidence the request was honoured on time.
    await expect(redactLead(shelley, lead!.id, 'Erasure request, again.')).rejects.toBeInstanceOf(
      LeadError,
    );
  });

  it('is not a Member’s to do, and needs a written reason from anybody', async () => {
    const showId = await scratchShow('Erasure permission scratch');
    const { lead } = await captureLead(priya, showId, draft({ email: 'perm@x.test' }));
    await expect(redactLead(priya, lead!.id, 'A good enough reason.')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(redactLead(shelley, lead!.id, 'oops')).rejects.toBeInstanceOf(LeadError);
  });

  it('sweeps everything past its date, and only in its own workspace', async () => {
    const { actor, showId } = await scratchWorkspace();
    const { lead } = await captureLead(actor, showId, draft({ email: 'stale@x.test' }));
    const { lead: kept } = await captureLead(actor, showId, draft({ email: 'fresh@x.test' }));
    await db
      .update(s.leads)
      .set({ deleteAfter: new Date(Date.now() - 86_400_000) })
      .where(eq(s.leads.id, lead!.id));

    const before = (await getLeadBoard(actor, showId)).coverage.leadCount;
    const result = await sweepLeadRetention(actor.orgId);
    expect(result.erased).toBe(1);

    const erased = await db.query.leads.findFirst({ where: eq(s.leads.id, lead!.id) });
    expect(erased!.fullName).toBe(REDACTED_NAME);
    expect(erased!.redactionReason).toContain('Retention');
    // Nothing within its period is touched.
    const untouched = await db.query.leads.findFirst({ where: eq(s.leads.id, kept!.id) });
    expect(untouched!.email).toBe('fresh@x.test');
    // And the whole reason it is redaction: the count does not move.
    expect((await getLeadBoard(actor, showId)).coverage.leadCount).toBe(before);
  });
});

describe('CSV import', () => {
  const csv = [
    'Name,Email,Company',
    'Ada Lovelace,ada@x.test,Analytical',
    ',orphan@x.test,Nowhere',
    'Ada Lovelace,ada@x.test,Analytical',
  ].join('\n');

  it('previews without writing, and every row read lands in exactly one bucket', async () => {
    const showId = await scratchShow('Import preview scratch');
    const { plan, mapping } = await previewImport(shelley, { showId, text: csv });
    expect(mapping['Name']).toBe('fullName');
    expect(plan.rowsRead).toBe(3);
    expect(plan.accepted.length + plan.rejected.length + plan.duplicates.length).toBe(3);
    expect(await listShowLeads(shelley, showId)).toHaveLength(0);
  });

  it('writes the batch record even when it rejects rows, with the problems kept', async () => {
    const showId = await scratchShow('Import commit scratch');
    const { plan, mapping } = await previewImport(shelley, { showId, text: csv });
    const result = await commitImport(shelley, { showId, plan, mapping, filename: 'scan.csv' });
    expect(result.written).toBe(1);

    const [batch] = await db
      .select()
      .from(s.leadImports)
      .where(eq(s.leadImports.showId, showId));
    expect(batch.rowsRead).toBe(3);
    expect(batch.accepted + batch.rejected + batch.duplicates).toBe(3);
    expect(batch.problems!.some((p) => p.reason === 'No name.')).toBe(true);
    // No column carried a lawful basis, and the record says so rather than
    // leaving the reader to notice every lead is `unknown`.
    expect(batch.notes).toContain('lawful basis');
  });

  it('attributes an imported lead to nobody, so one person’s coverage is not inflated', async () => {
    const showId = await scratchShow('Import attribution scratch');
    const { plan, mapping } = await previewImport(shelley, { showId, text: csv });
    await commitImport(shelley, { showId, plan, mapping, filename: null });
    const leads = await listShowLeads(shelley, showId);
    expect(leads[0].capturedById).toBeNull();
  });

  it('is not a Member’s to run', async () => {
    const showId = await scratchShow('Import permission scratch');
    await expect(previewImport(priya, { showId, text: csv })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('catches a row that duplicates something already on the show', async () => {
    const showId = await scratchShow('Import dedupe scratch');
    await captureLead(priya, showId, draft({ fullName: 'Ada Lovelace', email: 'ada@x.test' }));
    const { plan } = await previewImport(shelley, { showId, text: csv });
    expect(plan.accepted).toHaveLength(0);
    expect(plan.duplicates).toHaveLength(2);
  });
});

describe('intake keys', () => {
  it('resolves to a principal that is scoped to one show, and refuses another', async () => {
    const other = await scratchShow('Intake other-show scratch');
    const { token, id } = await createIntakeKey(shelley, {
      label: 'Test scanner',
      showId: dmwestId,
    });
    keys.push(id);

    const resolved = await resolveIntakeKey(token);
    expect('principal' in resolved).toBe(true);
    if (!('principal' in resolved)) return;

    const wrong = await intakeLead(resolved.principal, {
      showId: other,
      input: draft({ email: 'wrong@x.test' }),
    });
    expect(wrong.kind).toBe('refused');
    if (wrong.kind === 'refused') expect(wrong.refusal.kind).toBe('wrong_show');
  });

  it('is idempotent on the scanner’s own reference — a retry is a success, not a conflict', async () => {
    const showId = await scratchShow('Intake idempotency scratch');
    const { token, id } = await createIntakeKey(shelley, { label: 'Retry scanner', showId });
    keys.push(id);
    const resolved = await resolveIntakeKey(token);
    if (!('principal' in resolved)) throw new Error('key did not resolve');

    const first = await intakeLead(resolved.principal, {
      showId,
      input: draft({ fullName: 'Retry Person', email: 'retry@x.test', externalRef: 'REF-1' }),
    });
    const second = await intakeLead(resolved.principal, {
      showId,
      input: draft({ fullName: 'Retry Person', email: 'retry@x.test', externalRef: 'REF-1' }),
    });
    expect(first.kind).toBe('created');
    expect(second.kind).toBe('duplicate');
    if (second.kind === 'duplicate' && first.kind === 'created') {
      expect(second.leadId).toBe(first.leadId);
    }
    expect(await listShowLeads(shelley, showId)).toHaveLength(1);
  });

  it('records the lead as `api` with no capturer and no assumed consent', async () => {
    const showId = await scratchShow('Intake source scratch');
    const { token, id } = await createIntakeKey(shelley, { label: 'Source scanner', showId });
    keys.push(id);
    const resolved = await resolveIntakeKey(token);
    if (!('principal' in resolved)) throw new Error('key did not resolve');
    await intakeLead(resolved.principal, {
      showId,
      input: draft({ email: 'api@x.test', externalRef: 'REF-API' }),
    });
    const [lead] = await listShowLeads(shelley, showId);
    expect(lead.source).toBe('api');
    expect(lead.capturedById).toBeNull();
    expect(lead.basis).toBe('unknown');
  });

  it('returns the validation sentence a person would have been shown', async () => {
    const showId = await scratchShow('Intake validation scratch');
    const { token, id } = await createIntakeKey(shelley, { label: 'Bad scanner', showId });
    keys.push(id);
    const resolved = await resolveIntakeKey(token);
    if (!('principal' in resolved)) throw new Error('key did not resolve');
    const outcome = await intakeLead(resolved.principal, {
      showId,
      input: draft({ fullName: '  ' }),
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.status).toBe(422);
      expect(outcome.refusal.message).toContain('name');
    }
  });

  it('stops working when revoked, and says it was revoked rather than unknown', async () => {
    const { token, id } = await createIntakeKey(shelley, { label: 'Doomed', showId: dmwestId });
    keys.push(id);
    await revokeIntakeKey(shelley, id);
    const resolved = await resolveIntakeKey(token);
    expect('refusal' in resolved).toBe(true);
    if ('refusal' in resolved) expect(resolved.refusal.kind).toBe('revoked');
  });

  it('refuses an unrecognised token without saying anything else', async () => {
    const resolved = await resolveIntakeKey('tsc_lead_nonsense');
    if ('refusal' in resolved) expect(resolved.refusal.kind).toBe('unknown_key');
    else throw new Error('a nonsense token resolved');
  });

  it('is not a Travel Manager’s to issue — a credential is one bar above the data', async () => {
    await expect(
      createIntakeKey(marcus, { label: 'Nope', showId: dmwestId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the pair only a person can settle', () => {
  async function twoOfTheSameName() {
    const showId = await scratchShow('Possible duplicate scratch');
    const first = await captureLead(
      priya,
      showId,
      draft({ fullName: 'Dana Whitfield', company: 'Lakeside', email: 'dana@x.test' }),
      new Date(Date.now() - 3_600_000),
    );
    const second = await captureLead(
      marcus,
      showId,
      draft({ fullName: 'Dana Whitfield', company: 'Lakeside' }),
    );
    return { showId, first: first.lead!, second: second.lead! };
  }

  it('admits the pair, surfaces it, and counts both until somebody says otherwise', async () => {
    const { showId, first, second } = await twoOfTheSameName();
    const board = await getLeadBoard(shelley, showId);
    // Admitted on purpose: two people really can share a name, and silently
    // dropping a real second lead is the same failure as counting a fake one.
    expect(board.coverage.leadCount).toBe(2);
    expect(board.possiblePairs).toHaveLength(1);
    expect(board.possiblePairs[0].keep.id).toBe(first.id);
    expect(board.possiblePairs[0].other.id).toBe(second.id);
  });

  it('drops the count by one when marked, and deletes nothing', async () => {
    const { showId, first, second } = await twoOfTheSameName();
    await markDuplicate(shelley, second.id, first.id);

    const board = await getLeadBoard(shelley, showId);
    expect(board.coverage.leadCount).toBe(1);
    expect(board.coverage.duplicateCount).toBe(1);
    // Settled is not a question any more.
    expect(board.possiblePairs).toHaveLength(0);
    // And nothing was merged away: the row keeps its own consent record and its
    // own retention clock.
    const row = await db.query.leads.findFirst({ where: eq(s.leads.id, second.id) });
    expect(row).toBeTruthy();
    expect(row!.fullName).toBe('Dana Whitfield');
    expect(row!.deleteAfter).not.toBeNull();
  });

  it('is reversible, because it was a judgement about two strangers', async () => {
    const { showId, first, second } = await twoOfTheSameName();
    await markDuplicate(shelley, second.id, first.id);
    await unmarkDuplicate(shelley, second.id);
    expect((await getLeadBoard(shelley, showId)).coverage.leadCount).toBe(2);
  });

  it('is not a Member’s to do — it moves the count', async () => {
    const { second, first } = await twoOfTheSameName();
    await expect(markDuplicate(priya, second.id, first.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a chain, so the count does not depend on click order', async () => {
    const { showId, first, second } = await twoOfTheSameName();
    await markDuplicate(shelley, second.id, first.id);
    const third = await captureLead(
      priya,
      showId,
      draft({ fullName: 'Dana Whitfield', company: 'Lakeside', email: 'third@x.test' }),
    );
    await expect(markDuplicate(shelley, third.lead!.id, second.id)).rejects.toBeInstanceOf(
      LeadError,
    );
  });

  it('refuses to collapse the same person across two shows', async () => {
    const a = await scratchShow('Cross-show dupe A');
    const b = await scratchShow('Cross-show dupe B');
    const one = await captureLead(priya, a, draft({ email: 'x1@x.test' }));
    const two = await captureLead(priya, b, draft({ email: 'x2@x.test' }));
    // Two engagements with two costs; collapsing them hands one show credit for
    // the other's conversation.
    await expect(
      markDuplicate(shelley, two.lead!.id, one.lead!.id),
    ).rejects.toBeInstanceOf(LeadError);
  });

  it('refuses a lead as a duplicate of itself', async () => {
    const { first } = await twoOfTheSameName();
    await expect(markDuplicate(shelley, first.id, first.id)).rejects.toBeInstanceOf(LeadError);
  });
});

describe('the outbound verdict', () => {
  it('travels on the row, so the answer is where somebody could still fix it', async () => {
    const showId = await scratchShow('Outbound scratch');
    await captureLead(priya, showId, draft({ email: 'nobasis@x.test' }));
    await captureLead(
      priya,
      showId,
      draft({ email: 'li@x.test', basis: 'legitimate_interest' }),
    );
    const leads = await listShowLeads(shelley, showId);
    const withheld = leads.find((l) => l.email === 'nobasis@x.test')!;
    const usable = leads.find((l) => l.email === 'li@x.test')!;

    expect(usable.outbound.usable).toBe(true);
    expect(withheld.outbound.usable).toBe(false);
    // The verdict and the thing to do about it, not just a refusal.
    if (!withheld.outbound.usable) expect(withheld.outbound.fix).toBeTruthy();
  });

  it('never lets an erased lead out, whatever basis it had', async () => {
    const showId = await scratchShow('Outbound erasure scratch');
    const { lead } = await captureLead(
      priya,
      showId,
      draft({ email: 'gone@x.test', basis: 'legitimate_interest' }),
    );
    await redactLead(shelley, lead!.id, 'Erasure request received.');
    const [row] = await listShowLeads(shelley, showId);
    expect(row.outbound.usable).toBe(false);
  });
});

describe('meetings', () => {
  it('keeps a no-show out of the count of meetings held', async () => {
    const showId = await scratchShow('Meeting scratch');
    const when = new Date();
    await recordMeeting(priya, showId, {
      subject: 'Held one',
      company: null,
      isExistingCustomer: false,
      scheduledAt: when,
      occurredAt: when,
      noShowAt: null,
      leadId: null,
      ownerId: null,
      notes: null,
    });
    await recordMeeting(priya, showId, {
      subject: 'Nobody came',
      company: null,
      isExistingCustomer: false,
      scheduledAt: when,
      occurredAt: null,
      noShowAt: when,
      leadId: null,
      ownerId: null,
      notes: null,
    });
    const portfolio = await getLeadPortfolio(shelley);
    const row = portfolio.find((r) => r.showId === showId)!;
    expect(row.meetingsHeld).toBe(1);
    expect(row.meetingsNoShow).toBe(1);
    expect(row.meetingsBooked).toBe(0);
  });

  it('refuses to link a lead from another show', async () => {
    const a = await scratchShow('Meeting link A');
    const b = await scratchShow('Meeting link B');
    const { lead } = await captureLead(priya, a, draft({ email: 'link@x.test' }));
    await expect(
      recordMeeting(priya, b, {
        subject: 'Wrong show',
        company: null,
        isExistingCustomer: false,
        scheduledAt: new Date(),
        occurredAt: null,
        noShowAt: null,
        leadId: lead!.id,
        ownerId: null,
        notes: null,
      }),
    ).rejects.toBeInstanceOf(LeadError);
  });
});

describe('the sixth engine', () => {
  it('raises the alert with no lead row behind it, and resolves it when leads arrive', async () => {
    const showId = await scratchShow('Silent show');
    const [shift] = await db
      .insert(s.boothShifts)
      .values({
        showId,
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        targetStaff: 1,
      })
      .returning({ id: s.boothShifts.id });
    await db.insert(s.shiftAssignments).values({ shiftId: shift.id, userId: priya.userId });

    const raised = await sweepLeadAlerts(shelley.orgId);
    const noCapture = raised.planned.find(
      (a) => a.showId === showId && a.reason === 'no_capture',
    );
    expect(noCapture).toBeTruthy();

    await captureLead(priya, showId, draft({ email: 'finally@x.test' }));
    const after = await sweepLeadAlerts(shelley.orgId);
    expect(after.planned.some((a) => a.showId === showId && a.reason === 'no_capture')).toBe(false);
    const rows = await db
      .select()
      .from(s.alerts)
      .where(and(eq(s.alerts.showId, showId), eq(s.alerts.source, 'lead')));
    // Resolution is absence from tonight's plan, not a person clearing a board.
    const closed = rows.filter((r) => r.dedupeKey.includes('no_capture'));
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((r) => r.resolvedAt !== null)).toBe(true);
    // And the lead that resolved it brought its own condition with it: it
    // carries no lawful basis, which is a different sentence and still open.
    const open = rows.filter((r) => r.resolvedAt === null);
    expect(open.every((r) => r.dedupeKey.includes('basis_unrecorded'))).toBe(true);
  });
});
