import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETENTION_DAYS,
  basisOf,
  marketabilityOf,
  planRedaction,
  readBasis,
  retentionDueAt,
  retentionStandingOf,
  REDACTED_NAME,
} from './consent';
import { CsvError, inferMapping, parseCsv, planImport, type ColumnMapping } from './parse';
import { findMatch, findPossiblePairs, isBlocking, type DedupeCandidate } from './dedupe';
import { assessCoverage, mayQuotePerLead, type CountableLead } from './coverage';
import { planLeadAlerts, type AlertableShow } from './alerts';
import { validateLead, validateMeeting, validateRedactionReason, LeadError } from './edit';
import { hashToken, issueKey, KEY_PREFIX, readBearer } from './intake';
import {
  canCaptureLead,
  canManageIntakeKeys,
  canRedactLead,
  canSeeLeadCounts,
  canSeeLeadDetail,
} from './access';
import type { Actor } from '@/lib/auth/actor';

/**
 * The pure half of leads — no database, fixed clock.
 *
 * Almost nothing here tests that a lead is stored. Every assertion is about a
 * number or a permission that would read perfectly well and be wrong: a lawful
 * basis manufactured from a blank column, a duplicate that makes a show look
 * cheaper per lead than it was, a rejected CSV row that vanishes into a smaller
 * total, an erasure that silently moves last year's ROI, a per-lead figure
 * quoted over a denominator three of six staff never contributed to.
 */

const NOW = new Date('2026-09-01T12:00:00Z');

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 'u1',
  orgId: 'org',
  email: 'a@example.com',
  fullName: 'A',
  role: 'member',
  costCenterId: null,
  ...over,
});

/* --------------------------------- consent --------------------------------- */

describe('lawful basis', () => {
  it('never manufactures a basis out of an absent column', () => {
    expect(readBasis(null)).toBe('unknown');
    expect(readBasis('')).toBe('unknown');
    expect(basisOf(undefined)).toBe('unknown');
    // Anything unrecognised is unknown rather than a guess: a lead wrongly
    // marked unknown is chased by a person, one wrongly marked consented is a
    // regulatory finding.
    expect(readBasis('maybe?')).toBe('unknown');
    expect(readBasis('no')).toBe('unknown');
    expect(readBasis('Yes')).toBe('consent');
    expect(readBasis('business card')).toBe('legitimate_interest');
  });

  it('refuses to market a lead whose consent has no moment attached', () => {
    const claimed = marketabilityOf({
      basis: 'consent',
      consentCapturedAt: null,
      consentNotice: 'Booth notice',
      redactedAt: null,
    });
    expect(claimed.usable).toBe(false);
    // A checkbox ticked in a spreadsheet after the fact is a claim about
    // consent, not consent.
    expect(claimed).toMatchObject({ usable: false });
  });

  it('refuses consent with no record of what the person was told', () => {
    expect(
      marketabilityOf({
        basis: 'consent',
        consentCapturedAt: NOW,
        consentNotice: null,
        redactedAt: null,
      }).usable,
    ).toBe(false);
  });

  it('withholds an unknown-basis lead without deleting it, and says how to fix it', () => {
    const m = marketabilityOf({
      basis: 'unknown',
      consentCapturedAt: null,
      consentNotice: null,
      redactedAt: null,
    });
    expect(m.usable).toBe(false);
    if (!m.usable) expect(m.fix).toBeTruthy();
  });

  it('allows legitimate interest, which is what a business card actually is', () => {
    expect(
      marketabilityOf({
        basis: 'legitimate_interest',
        consentCapturedAt: null,
        consentNotice: null,
        redactedAt: null,
      }).usable,
    ).toBe(true);
  });

  it('never lets an erased lead back out, whatever basis it had', () => {
    expect(
      marketabilityOf({
        basis: 'consent',
        consentCapturedAt: NOW,
        consentNotice: 'Booth notice',
        redactedAt: NOW,
      }).usable,
    ).toBe(false);
  });
});

describe('retention', () => {
  it('gives an unset lead a finite period rather than forever', () => {
    const captured = new Date('2026-01-01T00:00:00Z');
    expect(retentionDueAt(captured, null).getTime()).toBe(
      captured.getTime() + DEFAULT_RETENTION_DAYS * 86_400_000,
    );
  });

  it('calls a lead past its date overdue — this is our own breach, not a supplier’s', () => {
    expect(
      retentionStandingOf(
        { capturedAt: new Date('2020-01-01T00:00:00Z'), deleteAfter: null, redactedAt: null },
        NOW,
      ),
    ).toBe('overdue');
  });

  it('warns before the date rather than after', () => {
    const due = new Date(NOW.getTime() + 10 * 86_400_000);
    expect(
      retentionStandingOf({ capturedAt: NOW, deleteAfter: due, redactedAt: null }, NOW),
    ).toBe('due_soon');
  });

  it('erasure nulls the person and keeps the shell, so the count cannot move', () => {
    const r = planRedaction('Erasure request received.', NOW);
    expect(r.fullName).toBe(REDACTED_NAME);
    expect(r.email).toBeNull();
    expect(r.notes).toBeNull();
    // The pointer into a system that still holds the record goes too, or our
    // erasure is a fiction with a footnote.
    expect(r.crmExternalId).toBeNull();
    // Nothing in the plan touches captured_at, captured_by_id or the show —
    // those are facts about our process and say nothing about any person.
    expect(Object.keys(r)).not.toContain('capturedAt');
    expect(Object.keys(r)).not.toContain('showId');
  });
});

/* ----------------------------------- CSV ----------------------------------- */

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and newlines, CRLF, and Excel’s BOM', () => {
    const rows = parseCsv('﻿Name,Company\r\n"Okafor, Jane","Acme\nWorks"\r\n');
    expect(rows[0]).toEqual(['Name', 'Company']);
    expect(rows[1]).toEqual(['Okafor, Jane', 'Acme\nWorks']);
  });

  it('treats a doubled quote as one', () => {
    expect(parseCsv('a\n"He said ""hi"""')[1]).toEqual(['He said "hi"']);
  });

  it('refuses a file that ends inside a quoted field rather than guessing', () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(CsvError);
  });

  it('does not turn a trailing newline into an empty record', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });
});

describe('column mapping', () => {
  it('proposes from the header names badge vendors actually ship', () => {
    const m = inferMapping(['Full Name', 'E-Mail', 'Badge ID', 'Booth']);
    expect(m['Full Name']).toBe('fullName');
    expect(m['E-Mail']).toBe('email');
    expect(m['Badge ID']).toBe('externalRef');
    // Unrecognised is offered as unmapped, never guessed into a field.
    expect(m['Booth']).toBeNull();
  });

  it('does not re-assign a field a header already claimed', () => {
    const m = inferMapping(['Name', 'Contact Name']);
    expect(m['Name']).toBe('fullName');
    expect(m['Contact Name']).toBeNull();
  });
});

describe('import planning', () => {
  const mapping: ColumnMapping = {
    Name: 'fullName',
    Email: 'email',
    Company: 'company',
  };
  const rows = [
    ['Name', 'Email', 'Company'],
    ['Jane Okafor', 'jane@acme.test', 'Acme'],
    ['', 'ghost@acme.test', 'Acme'],
    ['Tomás Ruiz', 'tomas@beta.test', 'Beta'],
    ['Jane Okafor', 'jane@acme.test', 'Acme'],
  ];

  it('accounts for every row read — accepted plus rejected plus duplicates', () => {
    const plan = planImport(rows, mapping);
    expect(plan.rowsRead).toBe(4);
    expect(plan.accepted.length + plan.rejected.length + plan.duplicates.length).toBe(4);
    // A parser that silently skipped the nameless row would report a smaller
    // number with the same confidence as a correct one.
    expect(plan.rejected).toEqual([{ row: 3, reason: 'No name.' }]);
    expect(plan.duplicates[0].row).toBe(5);
  });

  it('rejects a row whose column count does not match the header', () => {
    const plan = planImport([...rows.slice(0, 2), ['short']], mapping);
    expect(plan.rejected[0].reason).toContain('wrong places');
  });

  it('flags that no column carried a lawful basis, once, on the plan', () => {
    const plan = planImport(rows, mapping);
    expect(plan.basisUnmapped).toBe(true);
    expect(plan.accepted.every((a) => a.basis === 'unknown')).toBe(true);
  });

  it('refuses a mapping with no name column', () => {
    expect(() => planImport(rows, { Email: 'email' })).toThrow(CsvError);
  });

  it('asks the database about duplicates rather than deciding alone', () => {
    const plan = planImport(rows, mapping, {
      isDuplicate: (d) => (d.email === 'tomas@beta.test' ? 'Already on this show.' : null),
    });
    expect(plan.duplicates.map((d) => d.row).sort()).toEqual([4, 5]);
  });
});

/* ---------------------------------- dedupe --------------------------------- */

describe('duplicate detection', () => {
  const existing: DedupeCandidate[] = [
    {
      id: 'l1',
      fullName: 'Jane Okafor',
      email: 'jane@acme.test',
      company: 'Acme',
      externalRef: 'BADGE-9',
      capturedAt: NOW,
      capturedByName: 'Priya Raman',
    },
  ];

  it('treats the scanner’s own reference as identity — this is what makes intake idempotent', () => {
    const m = findMatch(
      { fullName: 'J. Okafor', email: null, company: null, externalRef: 'badge-9' },
      existing,
    );
    expect(m?.kind).toBe('same_scan');
    expect(isBlocking(m)).toBe(true);
  });

  it('treats an email as identity within a show, and names who already has it', () => {
    const m = findMatch(
      { fullName: 'Jane O', email: 'JANE@acme.test', company: null, externalRef: null },
      existing,
    );
    expect(m?.kind).toBe('same_email');
    expect(m?.reason).toContain('Priya Raman');
  });

  it('reports name-plus-company as a suspicion and never blocks on it', () => {
    const m = findMatch(
      { fullName: 'Dr. Jane Okafor', email: null, company: 'acme', externalRef: null },
      existing,
    );
    expect(m?.kind).toBe('possible');
    // Two people really can share a name at a big enough show, and silently
    // dropping a real second lead is the same failure pointing the other way.
    expect(isBlocking(m)).toBe(false);
  });

  it('offers every same-name-same-company pair for a person to settle', () => {
    const pairs = findPossiblePairs([
      ...existing,
      {
        id: 'l2',
        fullName: 'Dr. Jane Okafor',
        email: null,
        company: 'acme',
        externalRef: null,
        capturedAt: new Date(NOW.getTime() + 3_600_000),
        capturedByName: 'Tomás Iglesias',
      },
    ]);
    expect(pairs).toHaveLength(1);
    // The earlier capture is the conversation that happened first; the later
    // one is the re-scan, so that is the row that stops counting.
    expect(pairs[0].keep.id).toBe('l1');
    expect(pairs[0].other.id).toBe('l2');
  });

  it('offers nothing where the machine would already have refused the write', () => {
    // A same-scan or same-email pair cannot exist among stored leads: all three
    // write paths refuse those before anything is written.
    expect(
      findPossiblePairs([
        existing[0],
        { ...existing[0], id: 'l3', fullName: 'Someone Else', capturedAt: NOW },
      ]),
    ).toHaveLength(0);
  });

  it('finds nothing when there is nothing to match on', () => {
    expect(
      findMatch({ fullName: 'Jane Okafor', email: null, company: null, externalRef: null }, existing),
    ).toBeNull();
  });
});

/* --------------------------------- coverage -------------------------------- */

const lead = (over: Partial<CountableLead> = {}): CountableLead => ({
  id: Math.random().toString(36),
  capturedById: 'u1',
  capturedAt: NOW,
  deleteAfter: null,
  redactedAt: null,
  consentBasis: 'legitimate_interest',
  duplicateOfId: null,
  ...over,
});

const show = (over: Partial<{ startsOn: Date; endsOn: Date; status: string }> = {}) => ({
  startsOn: new Date('2026-08-20T00:00:00Z'),
  endsOn: new Date('2026-08-23T00:00:00Z'),
  status: 'complete',
  ...over,
});

const staff = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    userId: `u${i + 1}`,
    fullName: `Person ${i + 1}`,
    onBooth: true,
  }));

describe('capture coverage', () => {
  it('says "at least" and names who captured nothing', () => {
    const c = assessCoverage(
      { show: show(), staff: staff(6), leads: [lead(), lead(), lead({ capturedById: 'u2' })] },
      NOW,
    );
    expect(c.standing).toBe('partial');
    expect(c.isFloor).toBe(true);
    expect(c.headline).toBe('At least 3 leads, from 2 of 6 people on the booth.');
    expect(c.silent.map((s) => s.userId)).toEqual(['u3', 'u4', 'u5', 'u6']);
  });

  it('does not call a show thin before it opens', () => {
    const c = assessCoverage(
      { show: show({ startsOn: new Date('2026-12-01T00:00:00Z'), status: 'planning' }), staff: staff(4), leads: [] },
      NOW,
    );
    expect(c.standing).toBe('not_yet');
    expect(c.isFloor).toBe(false);
  });

  it('reports unknown rather than perfect when nobody is rostered on a shift', () => {
    const c = assessCoverage({ show: show(), staff: [], leads: [lead()] }, NOW);
    // 0 of 0 would render as full coverage, which is the reassurance nobody
    // goes back and checks.
    expect(c.standing).toBe('unknown');
    expect(c.isFloor).toBe(true);
  });

  it('keeps duplicates out of the count', () => {
    const c = assessCoverage(
      { show: show(), staff: staff(1), leads: [lead(), lead({ duplicateOfId: 'x' })] },
      NOW,
    );
    expect(c.leadCount).toBe(1);
    expect(c.duplicateCount).toBe(1);
  });

  it('counts lawful basis and retention beside the number', () => {
    const c = assessCoverage(
      {
        show: show(),
        staff: staff(1),
        leads: [
          lead({ consentBasis: 'consent' }),
          lead({ consentBasis: null }),
          lead({ capturedAt: new Date('2020-01-01T00:00:00Z') }),
        ],
      },
      NOW,
    );
    expect(c.basis.consent).toBe(1);
    expect(c.basis.unknown).toBe(1);
    expect(c.retentionOverdue).toBe(1);
  });

  it('does not count a redacted row’s basis, because it no longer has one', () => {
    const c = assessCoverage(
      { show: show(), staff: staff(1), leads: [lead({ redactedAt: NOW, consentBasis: 'consent' })] },
      NOW,
    );
    expect(c.basis.consent).toBe(0);
    // But it is still a lead that was captured, so the count holds.
    expect(c.leadCount).toBe(1);
  });
});

describe('cost per lead', () => {
  it('is withheld over a thin denominator rather than published with an asterisk', () => {
    const c = assessCoverage({ show: show(), staff: staff(6), leads: [lead()] }, NOW);
    const verdict = mayQuotePerLead(c);
    expect(verdict.ok).toBe(false);
    // Dividing by an undercount makes cost-per-lead too *high*, which reads as
    // a bad show — so the wrong decision it drives is cutting a show that worked.
    expect(verdict.reason).toContain('more expensive');
  });

  it('is quotable when everybody on the booth contributed', () => {
    const c = assessCoverage(
      { show: show(), staff: staff(2), leads: [lead(), lead({ capturedById: 'u2' })] },
      NOW,
    );
    expect(mayQuotePerLead(c).ok).toBe(true);
  });
});

/* ---------------------------------- alerts --------------------------------- */

const alertable = (over: Partial<AlertableShow> = {}): AlertableShow => ({
  showId: 'show-1',
  showName: 'Automate 2025',
  startsOn: new Date('2026-08-20T00:00:00Z'),
  endsOn: new Date('2026-08-23T00:00:00Z'),
  status: 'complete',
  coverage: assessCoverage({ show: show(), staff: staff(6), leads: [] }, NOW),
  ...over,
});

describe('lead alerts', () => {
  it('raises the alert that has no lead row behind it: a show that ran and recorded nothing', () => {
    const [a] = planLeadAlerts([alertable()], NOW);
    expect(a.reason).toBe('no_capture');
    expect(a.severity).toBe('critical');
    expect(a.dedupeKey).toContain(':after');
  });

  it('is quieter, and differently keyed, while the show is still on', () => {
    const during = new Date('2026-08-21T12:00:00Z');
    const [a] = planLeadAlerts([alertable()], during);
    expect(a.severity).toBe('warning');
    expect(a.dedupeKey).toContain(':during');
  });

  it('says nothing about a show that has not opened', () => {
    expect(
      planLeadAlerts(
        [
          alertable({
            startsOn: new Date('2026-12-01T00:00:00Z'),
            endsOn: new Date('2026-12-03T00:00:00Z'),
            status: 'planning',
            coverage: assessCoverage(
              { show: show({ startsOn: new Date('2026-12-01T00:00:00Z') }), staff: staff(6), leads: [] },
              NOW,
            ),
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('keys thin capture on how many people are silent, never on the lead count', () => {
    const coverage = assessCoverage(
      { show: show({ endsOn: NOW }), staff: staff(6), leads: [lead(), lead()] },
      NOW,
    );
    const [a] = planLeadAlerts([alertable({ endsOn: NOW, coverage })], NOW);
    expect(a.reason).toBe('thin_capture');
    // Keying on the count would raise a fresh alert per badge scanned.
    expect(a.dedupeKey.endsWith(':5')).toBe(true);
  });

  it('reports our own retention breach as critical, whatever the show’s date', () => {
    const coverage = assessCoverage(
      {
        show: show({ startsOn: new Date('2020-01-01T00:00:00Z'), endsOn: new Date('2020-01-03T00:00:00Z') }),
        staff: staff(1),
        leads: [lead({ capturedAt: new Date('2020-01-02T00:00:00Z') })],
      },
      NOW,
    );
    const plan = planLeadAlerts(
      [alertable({ startsOn: new Date('2020-01-01T00:00:00Z'), endsOn: new Date('2020-01-03T00:00:00Z'), coverage })],
      NOW,
    );
    const overdue = plan.find((a) => a.reason === 'retention_overdue');
    expect(overdue?.severity).toBe('critical');
  });

  it('reports missing lawful basis as a warning, not a crisis — the rows are still lawfully held', () => {
    const coverage = assessCoverage(
      { show: show(), staff: staff(1), leads: [lead({ consentBasis: null })] },
      NOW,
    );
    const a = planLeadAlerts([alertable({ coverage })], NOW).find(
      (x) => x.reason === 'basis_unrecorded',
    );
    expect(a?.severity).toBe('warning');
  });
});

/* ----------------------------------- edit ---------------------------------- */

describe('validation', () => {
  const base = {
    fullName: 'Jane Okafor',
    email: null,
    phone: null,
    company: null,
    title: null,
    notes: null,
    interests: null,
    externalRef: null,
    basis: null as string | null,
    consentNotice: null,
  };

  it('refuses a lead with no person', () => {
    expect(() => validateLead({ ...base, fullName: '  ' })).toThrow(LeadError);
  });

  it('refuses consent typed with no notice behind it', () => {
    expect(() => validateLead({ ...base, basis: 'consent' })).toThrow(LeadError);
  });

  it('records unknown when the form was left alone, rather than defaulting to consent', () => {
    expect(validateLead(base).basis).toBe('unknown');
  });

  it('refuses a meeting that both happened and was a no-show', () => {
    expect(() =>
      validateMeeting({
        subject: 'Demo',
        company: null,
        isExistingCustomer: false,
        scheduledAt: null,
        occurredAt: NOW,
        noShowAt: NOW,
        leadId: null,
        ownerId: null,
        notes: null,
      }),
    ).toThrow(LeadError);
  });

  it('refuses a meeting with no time on it at all', () => {
    expect(() =>
      validateMeeting({
        subject: 'Demo',
        company: null,
        isExistingCustomer: false,
        scheduledAt: null,
        occurredAt: null,
        noShowAt: null,
        leadId: null,
        ownerId: null,
        notes: null,
      }),
    ).toThrow(LeadError);
  });

  it('requires a written reason to erase — the fourth feature to land on this rule', () => {
    expect(() => validateRedactionReason('oops')).toThrow(LeadError);
    expect(validateRedactionReason('Erasure request by email.')).toBeTruthy();
  });
});

/* ---------------------------------- intake --------------------------------- */

describe('intake credentials', () => {
  it('stores only a hash, and the prefix is not a key', () => {
    const k = issueKey();
    expect(k.token.startsWith(KEY_PREFIX)).toBe(true);
    expect(k.tokenHash).toBe(hashToken(k.token));
    expect(k.tokenHash).not.toContain(k.token);
    expect(k.token.startsWith(k.tokenPrefix)).toBe(true);
    expect(k.tokenPrefix.length).toBeLessThan(k.token.length);
  });

  it('accepts both `Bearer x` and a bare token, because half the scanners send each', () => {
    const t = `${KEY_PREFIX}abc`;
    expect(readBearer(`Bearer ${t}`)).toBe(t);
    expect(readBearer(t)).toBe(t);
    expect(readBearer('Bearer something-else')).toBeNull();
    expect(readBearer(null)).toBeNull();
  });

  it('issues a different key every time', () => {
    expect(issueKey().token).not.toBe(issueKey().token);
  });
});

/* ---------------------------------- access --------------------------------- */

describe('access', () => {
  it('gives the count to everybody, because §8c’s whole fix is that thin is visible', () => {
    expect(canSeeLeadCounts()).toBe(true);
  });

  it('gives capture to everybody — a gated capture flow produces the bad number by construction', () => {
    expect(canCaptureLead()).toBe(true);
  });

  it('narrows a stranger’s PII to the person who captured it and their approvers', () => {
    const member = actor();
    expect(canSeeLeadDetail(member, 'u1')).toBe(true);
    expect(canSeeLeadDetail(member, 'u2')).toBe(false);
    expect(canSeeLeadDetail(actor({ role: 'travel_manager' }), 'u2')).toBe(true);
  });

  it('keeps erasure with changing the plan, not with reporting', () => {
    expect(canRedactLead(actor())).toBe(false);
    expect(canRedactLead(actor({ role: 'travel_manager' }))).toBe(true);
  });

  it('puts a credential one bar higher than the data it writes', () => {
    expect(canManageIntakeKeys(actor({ role: 'travel_manager' }))).toBe(false);
    expect(canManageIntakeKeys(actor({ role: 'admin' }))).toBe(true);
  });
});
