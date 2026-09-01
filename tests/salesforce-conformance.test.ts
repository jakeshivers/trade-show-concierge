import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  amountToCents,
  normalizeContactRole,
  stageKindOf,
} from '@/lib/integrations/crm/salesforce/normalize';
import type { SalesforceContactRoleRecord } from '@/lib/integrations/crm/salesforce/wire';

/**
 * The captured half of the Salesforce adapter's test suite.
 *
 * `roi.test.ts` asserts that our code behaves correctly *given* payloads we
 * wrote from the published reference — a closed loop that proves internal
 * consistency and cannot, even in principle, catch a wrong field name. This file
 * is the other half: it reads whatever `pnpm salesforce:capture` recorded from a
 * real org and asks whether our types and our normalizer survive it.
 *
 * **It matters more here than it did for Duffel, and the reason is worth stating
 * where somebody will read it.** A wrong field name on a fare or a tracking
 * payload produces an obvious hole — no offers, no scans. A wrong field name
 * here produces a dashboard where *nothing is ever attributed*: every show
 * showing a real cost and no pipeline. That is indistinguishable from the honest
 * finding §8c says is the normal case at most companies. The failure would look
 * exactly like the truth, on the screen a budget gets set from, and nobody would
 * go looking.
 *
 * **It skips itself when there are no captures**, which is the point rather than
 * a compromise: SCOPE §9 requires `pnpm db:reset && pnpm test` to pass on a clean
 * clone with zero keys, and a suite that failed without a Salesforce org would
 * quietly make one mandatory. A clean clone sees these skipped; anyone with a
 * Developer Edition org sees them run.
 *
 * Several may fail the first time this is run against a real org. That is the
 * deliverable, not a defect — each failure names the file, the assumption, and
 * the fix.
 */

const LIVE_DIR = path.resolve(import.meta.dirname, '../fixtures/live-salesforce');

type Capture = {
  step: string;
  question: string;
  note: string;
  request: { method: string; url: string; body: unknown };
  response: { status: number; ok: boolean; body: unknown };
};

function loadCaptures(): Capture[] {
  if (!existsSync(LIVE_DIR)) return [];
  return readdirSync(LIVE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(LIVE_DIR, f), 'utf8')) as Capture);
}

const captures = loadCaptures();
const rec = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

const byStep = (step: string) => captures.find((c) => c.step === step);
const recordsOf = (c: Capture | undefined) => (c ? arr(rec(c.response.body).records) : []);
const errorCodeOf = (c: Capture | undefined) =>
  c && Array.isArray(c.response.body)
    ? String((c.response.body[0] as { errorCode?: string })?.errorCode ?? '')
    : '';

const withCaptures = captures.length > 0 ? describe : describe.skip;

describe('captured Salesforce payloads', () => {
  it('reports whether any captures exist', () => {
    if (captures.length === 0) {
      console.log(
        '\n  No fixtures/live-salesforce/ captures — conformance checks skipped.\n' +
          '  `pnpm salesforce:capture` with a Developer Edition org opens the loop.\n' +
          '  Until then the Salesforce adapter is verified only against payloads we wrote\n' +
          '  ourselves, which proves internal consistency and nothing about field names.\n',
      );
    }
    expect(captures.length).toBeGreaterThanOrEqual(0);
  });
});

/* --------- Q1: the join is a role, and Opportunity has no ContactId --------- */

withCaptures('Q1 — the contact join', () => {
  it('Opportunity does not carry ContactId, which is why the join is a role', () => {
    // The question whose wrong answer is *invisible*: reading
    // `Opportunity.ContactId` compiles, returns undefined forever, and
    // attributes nothing — which looks like a company whose shows produce no
    // pipeline. An INVALID_FIELD here is the confirmation, not a failure.
    const probe = byStep('opportunity-contactid');
    if (!probe) return;
    if (probe.response.ok) {
      throw new Error(
        'Salesforce accepted SELECT ContactId FROM Opportunity. If that field is real in this\n' +
          'org, salesforce/wire.ts’s comment about OpportunityContactRole is wrong and\n' +
          'normalize.ts is joining the long way round for no reason. Check what it returns\n' +
          'before changing anything — a custom field of the same name is the likelier answer.',
      );
    }
    expect(errorCodeOf(probe)).toMatch(/INVALID_FIELD/);
  });

  it('the describe call agrees, and lists the fields normalize.ts reads', () => {
    const describe_ = byStep('describe-opportunity');
    if (!describe_ || !describe_.response.ok) return;
    const fields = arr(rec(describe_.response.body).fields).map((f) => String(f.name));
    if (fields.length === 0) return;
    for (const required of ['Id', 'Name', 'StageName', 'Amount', 'IsWon', 'IsClosed', 'CloseDate']) {
      expect(fields, `Opportunity has no ${required} — normalize.ts reads it`).toContain(required);
    }
    expect(fields, 'Opportunity does carry ContactId after all — see wire.ts').not.toContain(
      'ContactId',
    );
  });

  it('normalizes every captured contact role without throwing', () => {
    const roles = recordsOf(byStep('adapter-contact-roles'));
    for (const role of roles) {
      expect(() => normalizeContactRole(role as SalesforceContactRoleRecord)).not.toThrow();
    }
  });
});

/* ------------- Q2: won/lost is metadata, never a stage name ---------------- */

withCaptures('Q2 — where an opportunity actually is', () => {
  it('IsWon and IsClosed are selectable, or every won deal reads as open', () => {
    const shape = byStep('opportunity-shape');
    if (!shape) return;
    expect(
      shape.response.ok,
      'Selecting IsWon/IsClosed failed. stageKindOf reads them precisely because stage names ' +
        'are per-org free text; without them there is no org-independent way to classify a ' +
        'stage, and a name match would be wrong at the second customer.',
    ).toBe(true);
    for (const r of recordsOf(shape)) {
      expect(typeof r.IsWon, 'IsWon is not a boolean').toBe('boolean');
      expect(typeof r.IsClosed, 'IsClosed is not a boolean').toBe('boolean');
    }
  });

  it('this org’s stage names would have defeated a string match', () => {
    // Not a correctness assertion so much as evidence for one: it prints the
    // org's own vocabulary, which is the argument for reading the metadata.
    const stages = recordsOf(byStep('stage-metadata'));
    if (stages.length === 0) return;
    const won = stages.filter((s) => s.IsWon === true).map((s) => String(s.MasterLabel));
    expect(won.length, 'this org defines no won stage at all').toBeGreaterThan(0);
    console.log(`\n  Stages this org calls won: ${won.join(' · ')}`);
  });

  it('stageKindOf agrees with the metadata on every captured opportunity', () => {
    for (const r of recordsOf(byStep('opportunity-shape'))) {
      const kind = stageKindOf(r);
      if (r.IsWon === true) expect(kind).toBe('won');
      else if (r.IsClosed === true) expect(kind).toBe('lost');
      else expect(kind).toBe('open');
    }
  });
});

/* ------------------ Q3: the two money-and-date shapes ---------------------- */

withCaptures('Q3 — Amount and CloseDate on the wire', () => {
  it('Amount is a JSON number, which is why it is stringified before parsing', () => {
    const rows = recordsOf(byStep('opportunity-shape')).filter((r) => r.Amount !== null);
    if (rows.length === 0) return;
    for (const r of rows) {
      const t = typeof r.Amount;
      expect(
        t === 'number' || t === 'string',
        `Amount arrived as ${t}. normalize.ts handles number and string; anything else is money ` +
          'this adapter cannot read, and it must fail loudly rather than round.',
      ).toBe(true);
      // Whichever it is, the parse must survive it without float arithmetic.
      expect(() => amountToCents(r.Amount as number | string)).not.toThrow();
    }
  });

  it('CloseDate is a bare date, which is why closeDate() anchors it at midday', () => {
    const rows = recordsOf(byStep('opportunity-shape')).filter((r) => r.CloseDate);
    if (rows.length === 0) return;
    for (const r of rows) {
      expect(
        String(r.CloseDate),
        'CloseDate is not a bare YYYY-MM-DD. If Salesforce now sends a datetime, closeDate()’s ' +
          'midday anchor is unnecessary but harmless; if it sends a date, parsing it with ' +
          'new Date() would put it at UTC midnight and land it in the previous quarter in every ' +
          'American time zone.',
      ).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('CreatedDate parses, because sourced attribution is measured from it', () => {
    for (const r of recordsOf(byStep('opportunity-shape'))) {
      if (!r.CreatedDate) continue;
      expect(Number.isNaN(new Date(String(r.CreatedDate)).getTime())).toBe(false);
    }
  });
});

/* -------------------- Q4: whether this org has currencies ------------------ */

withCaptures('Q4 — single-currency versus multi-currency', () => {
  it('records which kind of org answered, and confirms the probe’s error code', () => {
    const probe = byStep('currency-probe');
    if (!probe) return;
    if (probe.response.ok) {
      console.log('\n  Multi-currency org: CurrencyIsoCode is selectable.');
      return;
    }
    console.log('\n  Single-currency org: CurrencyIsoCode is not a field here.');
    expect(
      errorCodeOf(probe),
      'A single-currency org refused CurrencyIsoCode with something other than INVALID_FIELD. ' +
        'client.ts’s isUnknownField() matches on that code, so the fallback would not fire and ' +
        'every sync against this org would fail outright.',
    ).toMatch(/INVALID_FIELD/);
  });

  it('the fallback query works in this org, whichever kind it is', () => {
    // The fallback reads the currency rather than assuming USD, so it has to
    // work everywhere — a currency label on a pipeline figure is part of the
    // figure.
    const org = byStep('org-currency');
    if (!org) return;
    expect(
      org.response.ok,
      'SELECT DefaultCurrencyIsoCode FROM Organization failed. That is client.ts’s only way to ' +
        'label money in a single-currency org without inventing a currency.',
    ).toBe(true);
    const iso = recordsOf(org)[0]?.DefaultCurrencyIsoCode;
    if (iso !== undefined) expect(String(iso)).toMatch(/^[A-Z]{3}$/);
  });
});

/* ----------------------- the write half of §8b ----------------------------- */

withCaptures('the attribution write', () => {
  it('records what the PATCH did, including a refusal', () => {
    const write = byStep('adapter-write-attribution');
    if (!write) return;
    if (write.response.ok) {
      expect([200, 204]).toContain(write.response.status);
      return;
    }
    // A missing custom field is configuration rather than a bug, and
    // `writeAttribution` is written to return it as a result rather than throw —
    // a sync that abandoned its reads over one field would be worse.
    expect([400, 403]).toContain(write.response.status);
  });
});

/* ------------------------- no PII on the disk ------------------------------ */

withCaptures('the captures themselves', () => {
  it('carry no bearer token and no personal data', () => {
    // The capture script redacts; this is the assertion that says so out loud,
    // because a fixtures directory in a git repository is exactly the place §5j
    // spends its length keeping a stranger's details out of.
    const raw = JSON.stringify(captures);
    expect(raw).not.toMatch(/Bearer (?!\[redacted\])\S/);
    expect(raw, 'an email address reached the fixtures directory').not.toMatch(
      /"Email":\s*"(?!\[redacted\])[^"]*@/,
    );
  });
});
