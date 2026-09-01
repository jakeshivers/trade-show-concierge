/**
 * Record what Salesforce actually says. SCOPE.md §8b, §11.6, CLAUDE.md
 * "Outstanding".
 *
 *   pnpm salesforce:capture              # probe everything, write fixtures/live-salesforce/
 *   pnpm salesforce:capture --read-only  # skip the attribution write
 *
 * ## Why this exists
 *
 * `salesforce/wire.ts` is written from the published REST and SOQL reference by
 * the same person who wrote the code that reads it, and the unit tests run
 * against fixtures from the same source. That is the closed loop step 12.5
 * named: it proves internal consistency, which is worth having, and it
 * structurally cannot detect a wrong field name.
 *
 * **The loop is worse here than it was for a carrier, and that is the reason
 * this script exists rather than a note saying it should.** A wrong field on a
 * tracking payload produces a crate with no scans, which looks broken within a
 * minute. A wrong field here produces a dashboard where nothing is ever
 * attributed — every show showing a real cost and no pipeline — which is
 * *indistinguishable from the honest finding §8c says is the normal case at most
 * companies*. The failure would look exactly like the truth, on the screen a
 * budget gets set from.
 *
 * ## What it is trying to find out
 *
 * Four questions, each one a specific way the adapter could be quietly wrong.
 * They are asserted by name in `tests/salesforce-conformance.test.ts`, and each
 * failure there names the file, the line and the fix.
 *
 *   Q1. **Does an Opportunity carry `ContactId`?** It should not — the join is
 *       `OpportunityContactRole` — and `normalize.ts` is written that way. But
 *       reading `Opportunity.ContactId` would *compile*, return `undefined`
 *       forever, and attribute nothing. This is the question whose wrong answer
 *       is invisible, so it is asked first.
 *   Q2. **Are `IsWon` and `IsClosed` queryable on Opportunity, and do they agree
 *       with the org's stage names?** `stageKindOf` reads them precisely because
 *       stage *names* are per-org free text. If they are not selectable in a real
 *       org, every won deal reads as open.
 *   Q3. **What type is `Amount` on the wire — a JSON number or a string?** Every
 *       other provider in this codebase sends decimal strings; `normalize.ts`
 *       stringifies through `money/decimal.ts` on the assumption this one sends a
 *       float. And what shape is `CloseDate` — a bare date, which `closeDate()`
 *       anchors at midday so no zone offset can push it into the previous
 *       quarter?
 *   Q4. **Does this org have `CurrencyIsoCode` at all?** It exists only in
 *       multi-currency orgs, and selecting a field an org lacks is a hard
 *       `INVALID_FIELD` rather than a null. `client.ts` probes and falls back to
 *       `Organization.DefaultCurrencyIsoCode`; this records which kind of org
 *       answered, and confirms the error code the probe matches on.
 *
 * ## How it answers them
 *
 * By driving the **real** `SalesforceCrmProvider` through a recording `fetch`
 * wherever it can, so what lands on disk is our own outbound SOQL beside the
 * response it got — and by raw probes for the two questions the adapter is
 * written not to ask (Q1 and Q4's error shape), because an adapter cannot
 * capture the evidence that it is wrong about something it never sends.
 *
 * **A failed call is a successful capture.** An `INVALID_FIELD` on
 * `Opportunity.ContactId` is precisely the answer to Q1, so every probe records
 * its response and carries on rather than aborting the run.
 *
 * ## Safety
 *
 * Reads only, unless `SALESFORCE_ATTRIBUTION_FIELD` is set *and* `--read-only`
 * is absent — the write half of §8b is the one thing here that touches a
 * database we do not own, so it is opt-in twice. Use a sandbox or a Developer
 * Edition org. `Authorization` is redacted before anything touches the disk, and
 * so are the email addresses and personal names in every response body: the
 * whole point of §5j is that a stranger's details do not end up somewhere they
 * were never meant to go, and a fixtures directory in a git repository is
 * exactly such a place.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SalesforceCrmProvider,
  salesforceConfigFromEnv,
} from '../src/lib/integrations/crm/salesforce/client';

const OUT_DIR = path.resolve(import.meta.dirname, '../fixtures/live-salesforce');
const API_VERSION = 'v60.0';

type Capture = {
  step: string;
  question: string;
  note: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; ok: boolean; body: unknown };
  capturedAt: string;
};

const captures: Capture[] = [];
let currentStep = 'unattributed';
let currentQuestion = '';
let currentNote = '';

/* ------------------------------- redaction --------------------------------- */

const PII_KEYS = new Set([
  'Email',
  'Name',
  'FirstName',
  'LastName',
  'Phone',
  'MobilePhone',
  'Title',
  'MailingStreet',
  'MailingCity',
]);

/**
 * Strip the token, and strip the people.
 *
 * A conformance fixture needs to know that `Email` *is a string that is present*
 * — never what the string is. `Account.Name` and `Owner.Name` are company and
 * colleague names rather than lead PII, and they are redacted anyway: the rule
 * this product spent step 18 establishing is that personal data does not travel
 * to places it was not collected for, and a fixtures directory in a git
 * repository is the purest example of such a place. The *shape* survives — a
 * redacted value keeps its type and a marker — which is everything the
 * assertions need.
 */
function scrub(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, k);
    return out;
  }
  if (key && PII_KEYS.has(key) && typeof value === 'string') return '[redacted]';
  return value;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? 'Bearer [redacted]' : v;
  }
  return out;
}

/**
 * Wrap the global `fetch` so every call is teed to disk.
 *
 * `SalesforceCrmProvider` accepts an injected `fetch`, and the probes below use
 * the global — so both are wrapped, and the same recorder sees our adapter's own
 * outbound SOQL and the raw probes side by side. `Response.json()` is
 * single-use and the client consumes it, so a **clone** is read and the
 * untouched original handed back.
 */
function recordingFetch(real: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const response = await real(input as never, init as never);

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      body = await response.clone().text();
    }

    captures.push({
      step: currentStep,
      question: currentQuestion,
      note: currentNote,
      request: {
        method: init?.method ?? 'GET',
        url: decodeURIComponent(url),
        headers: redactHeaders((init?.headers ?? {}) as Record<string, string>),
        body: init?.body ? scrub(safeParse(String(init.body))) : undefined,
      },
      response: { status: response.status, ok: response.ok, body: scrub(body) },
      capturedAt: new Date().toISOString(),
    });

    return response;
  }) as typeof fetch;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function step(name: string, question: string, note: string) {
  currentStep = name;
  currentQuestion = question;
  currentNote = note;
  console.log(`\n· ${name}${question ? `  [${question}]` : ''}\n  ${note}`);
}

/* --------------------------------- probes ---------------------------------- */

const config = salesforceConfigFromEnv();

async function soql(query: string): Promise<{ status: number; body: unknown }> {
  const url =
    `${config.instanceUrl!.replace(/\/$/, '')}/services/data/${API_VERSION}` +
    `/query?q=${encodeURIComponent(query)}`;
  const res = await globalThis.fetch(url, {
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  console.log(`  → ${res.status}${res.ok ? '' : `  ${JSON.stringify(body).slice(0, 160)}`}`);
  return { status: res.status, body };
}

async function main() {
  if (!config.instanceUrl || !config.accessToken) {
    throw new Error(
      'Set SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN. Use a sandbox or a Developer\n' +
        'Edition org — this script reads real records, and with SALESFORCE_ATTRIBUTION_FIELD set\n' +
        'it will write one custom field back on one contact.',
    );
  }
  const readOnly = process.argv.includes('--read-only');
  globalThis.fetch = recordingFetch(globalThis.fetch);

  console.log(`\nCapturing from ${config.instanceUrl} (${API_VERSION})`);

  step(
    'describe-opportunity',
    'Q1/Q2',
    'The field list Salesforce says an Opportunity has. Settles whether ContactId exists (it ' +
      'should not) and whether IsWon/IsClosed do (they must).',
  );
  const describeUrl =
    `${config.instanceUrl.replace(/\/$/, '')}/services/data/${API_VERSION}` +
    '/sobjects/Opportunity/describe';
  await globalThis.fetch(describeUrl, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });

  step(
    'opportunity-contactid',
    'Q1',
    'Selecting Opportunity.ContactId directly. An INVALID_FIELD here is the *answer*: it ' +
      'confirms the join has to be OpportunityContactRole, which is what normalize.ts assumes ' +
      'and what a hand-written fixture could never have contradicted.',
  );
  await soql('SELECT Id, ContactId FROM Opportunity LIMIT 1');

  step(
    'opportunity-shape',
    'Q2/Q3',
    'One opportunity with every field the adapter reads. Settles the JSON type of Amount, the ' +
      'shape of CloseDate, and whether IsWon/IsClosed are selectable.',
  );
  await soql(
    'SELECT Id, Name, StageName, Amount, IsWon, IsClosed, CreatedDate, CloseDate, ' +
      'LastActivityDate, Owner.Name FROM Opportunity LIMIT 3',
  );

  step(
    'currency-probe',
    'Q4',
    'Selecting CurrencyIsoCode. Success means a multi-currency org; INVALID_FIELD means a ' +
      'single-currency one, and confirms the error code client.ts probes on.',
  );
  await soql('SELECT Id, CurrencyIsoCode FROM Opportunity LIMIT 1');

  step(
    'org-currency',
    'Q4',
    'The fallback client.ts uses when the org is single-currency. It reads the currency rather ' +
      'than assuming USD, so this has to work in every org.',
  );
  await soql('SELECT DefaultCurrencyIsoCode FROM Organization LIMIT 1');

  step(
    'stage-metadata',
    'Q2',
    'Every stage this org defines, with its own IsWon/IsClosed. This is what makes the claim ' +
      '"stage names are per-org free text" checkable rather than asserted.',
  );
  await soql('SELECT MasterLabel, IsWon, IsClosed, IsActive FROM OpportunityStage');

  /* --- the adapter's own calls, through the same recorder --- */

  const provider = new SalesforceCrmProvider({ ...config, fetch: globalThis.fetch });

  step(
    'adapter-contact-roles',
    'Q1/Q3',
    'The real opportunitiesFor(), against real contact ids. This is the one capture that ' +
      'records our own outbound SOQL beside the response it got, so a wrong field name shows up ' +
      'as a diff rather than as an empty dashboard.',
  );
  const contacts = await soql('SELECT Id FROM Contact LIMIT 25');
  const ids = extractIds(contacts.body);
  if (ids.length === 0) {
    console.log('  (no contacts in this org — opportunitiesFor cannot be exercised)');
  } else {
    try {
      const opps = await provider.opportunitiesFor(ids);
      console.log(`  ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} normalized`);
    } catch (err) {
      // Recorded, not fatal: the capture of the failure is the deliverable.
      console.log(`  ✗ ${(err as Error).message}`);
    }
  }

  step(
    'adapter-match-by-email',
    '',
    'matchByEmail through the real adapter. The email is taken from the org’s own data rather ' +
      'than invented, and is redacted before anything is written.',
  );
  const emails = await soql('SELECT Id, Email FROM Contact WHERE Email != null LIMIT 1');
  const email = extractEmail(emails.body);
  if (email) {
    try {
      const found = await provider.matchByEmail(email);
      console.log(`  ${'noMatch' in found ? 'no match' : `matched ${found.confidence}`}`);
    } catch (err) {
      console.log(`  ✗ ${(err as Error).message}`);
    }
  } else {
    console.log('  (no contact with an email — skipped)');
  }

  if (!readOnly && config.attributionField && ids.length > 0) {
    step(
      'adapter-write-attribution',
      '',
      `PATCH ${config.attributionField} on one Contact. The only call here that changes anything ` +
        'in a database we do not own, which is why it needs the variable set *and* --read-only ' +
        'absent.',
    );
    const result = await provider.writeAttribution({
      objectType: 'contact',
      externalId: ids[0],
      value: 'Trade Show Concierge capture probe',
    });
    console.log(`  ${result.written ? 'written' : `not written — ${result.reason}`}`);
  } else {
    console.log(
      '\n· attribution write skipped' +
        (readOnly
          ? ' (--read-only)'
          : config.attributionField
            ? ' (no contacts)'
            : ' (SALESFORCE_ATTRIBUTION_FIELD unset — it is never defaulted)'),
    );
  }

  await writeCaptures();
}

function extractIds(body: unknown): string[] {
  const records = (body as { records?: { Id?: string }[] } | null)?.records ?? [];
  return records.map((r) => r.Id).filter((v): v is string => Boolean(v));
}

function extractEmail(body: unknown): string | null {
  const records = (body as { records?: { Email?: string }[] } | null)?.records ?? [];
  return records[0]?.Email ?? null;
}

async function writeCaptures() {
  if (captures.length === 0) {
    console.log('\nNothing captured.\n');
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });

  const index: Record<string, unknown>[] = [];
  for (const [i, c] of captures.entries()) {
    const slug = `${String(i + 1).padStart(3, '0')}-${c.step}`;
    await writeFile(path.join(OUT_DIR, `${slug}.json`), `${JSON.stringify(c, null, 2)}\n`);
    index.push({
      file: `${slug}.json`,
      step: c.step,
      question: c.question,
      status: c.response.status,
    });
  }
  await writeFile(
    path.join(OUT_DIR, 'index.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), captures: index }, null, 2)}\n`,
  );

  console.log(`\n${captures.length} captures written to fixtures/live-salesforce/\n`);
  for (const c of index) {
    console.log(
      `  ${String(c.status).padEnd(4)} ${String(c.question).padEnd(6)} ${String(c.step)}`,
    );
  }
  console.log('\n  Next: pnpm test — the conformance suite reads these instead of skipping.\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  },
);
