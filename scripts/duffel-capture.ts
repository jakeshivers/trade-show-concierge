/**
 * Record what Duffel actually says. SCOPE.md §6d, CLAUDE.md "Outstanding".
 *
 *   pnpm duffel:capture           # run the whole sequence, write fixtures/live/
 *   pnpm duffel:capture --search  # stop after search; create no orders
 *
 * ## Why this exists
 *
 * `duffel/fixtures.ts` is the single source feeding the unit tests, the
 * `recorded` provider, and — through it — the seed's travel requests. So
 * `pnpm test`, `pnpm booking:dry-run`, and every seeded booking all validate
 * against payloads *we invented* from the published schema. That is a closed
 * loop. It proves internal consistency, which is worth having, and it
 * structurally cannot detect a wrong field name. `wire.ts` says so itself:
 * "Unverified against a live response."
 *
 * This script is the thing that opens the loop.
 *
 * ## What it is trying to find out
 *
 * Planning research turned the general risk into three specific questions, all
 * on the credit path — SCOPE.md §5b, the differentiator:
 *
 *   Q1. Does an offer carry `available_airline_credit_ids` (string ids), or
 *       `available_airline_credits` (objects with values), or both? `wire.ts`
 *       declares both and hedges. `normalize.ts` reads the first;
 *       `client.ts:resolveCredits` reads *only* the second and throws when it is
 *       empty. If the second is fictional, every credit-first purchase has always
 *       escalated to a human and §5b has never once fired.
 *   Q2. How are credits applied on order create — a top-level `airline_credits`
 *       array (what we send), or an entry in `payments` with
 *       `type: "airline_credit"` (what the docs describe)?
 *   Q3. What does the order response say was actually charged to the credit? The
 *       ground rule is that `creditAppliedCents` comes from the provider and
 *       never from our own arithmetic, and today it is our arithmetic.
 *
 * ## How it answers them
 *
 * Mostly with **raw probes**, deliberately. Driving `DuffelProvider` would be
 * circular for Q1–Q3: `resolveCredits` throws before the interesting request is
 * ever sent, so the adapter cannot capture the evidence that would show it is
 * wrong. So the harness talks to the API directly for orchestration and for the
 * credit questions, and separately runs the real `provider.search()` through the
 * same recording `fetch` so we also capture *our own* outbound body and can diff
 * it against what Duffel accepts.
 *
 * **A failed call is a successful capture.** A 422 explaining that
 * `airline_credits` is not a valid field is precisely the answer to Q2, so every
 * step records its response and carries on rather than aborting the run.
 *
 * ## Safety
 *
 * Test keys only unless `--allow-live` is passed, which nothing in this repo
 * should ever need. Orders created here come back `live_mode: false`, which
 * `purchase()` already records as not-spend. `Authorization` is redacted before
 * anything touches the disk.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuffelProvider, configFromEnv } from '../src/lib/integrations/flights/duffel/client';

const OUT_DIR = path.resolve(import.meta.dirname, '../fixtures/live');
const API = 'https://api.duffel.com';

/* ------------------------------- recording --------------------------------- */

type Capture = {
  step: string;
  note: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; ok: boolean; body: unknown };
  capturedAt: string;
};

const captures: Capture[] = [];
let currentStep = 'unattributed';
let currentNote = '';

/**
 * Wrap the global `fetch` so every call is teed to disk.
 *
 * `client.ts` calls the bare global with no injection point (and the existing
 * unit tests stub it the same way), so this is the only seam. The subtlety is
 * that `Response.json()` is single-use and `client.ts` consumes it — so we read
 * a **clone** and hand the untouched original back, rather than reconstructing a
 * Response and hoping we got every field right.
 */
function installRecordingFetch(): () => void {
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
      note: currentNote,
      request: {
        method: init?.method ?? 'GET',
        url,
        headers: redact((init?.headers ?? {}) as Record<string, string>),
        body: init?.body ? safeParse(String(init.body)) : undefined,
      },
      response: { status: response.status, ok: response.ok, body },
      capturedAt: new Date().toISOString(),
    });

    return response;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = real;
  };
}

/** The token never reaches the disk. Everything else is useful evidence. */
function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? 'Bearer [redacted]' : v;
  }
  return out;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ------------------------------- raw probes -------------------------------- */

function token(): string {
  const t = process.env.DUFFEL_ACCESS_TOKEN?.trim();
  if (!t) {
    throw new Error(
      'DUFFEL_ACCESS_TOKEN is not set. This script exists to talk to the real Duffel API; ' +
        'there is nothing useful it can do without a key, and it will not invent one.\n' +
        'Get a free test key from https://app.duffel.com and put it in .env.local.',
    );
  }
  if (!t.includes('test') && !process.argv.includes('--allow-live')) {
    throw new Error(
      `DUFFEL_ACCESS_TOKEN does not look like a test key (expected "test" in it, got "${t.slice(0, 12)}…"). ` +
        'This script creates orders. Refusing to run against what may be a live key. ' +
        'Pass --allow-live only if you genuinely mean it.',
    );
  }
  return t;
}

/** Same headers `client.ts` sends, so captures are comparable to its traffic. */
async function raw(method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Duffel-Version': 'v2',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Run one probe. Never throws: a 4xx body is the answer to a question, and an
 * exception here would discard the captures taken after it.
 */
async function step<T>(name: string, note: string, fn: () => Promise<T>): Promise<T | null> {
  currentStep = name;
  currentNote = note;
  process.stdout.write(`  ${name.padEnd(26)} `);
  try {
    const result = await fn();
    console.log('ok');
    return result;
  } catch (err) {
    console.log(`failed — ${err instanceof Error ? err.message.slice(0, 90) : err}`);
    return null;
  } finally {
    currentStep = 'unattributed';
    currentNote = '';
  }
}

/* --------------------------------- the run --------------------------------- */

const dayAfter = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec => (v ?? {}) as AnyRec;
const arr = (v: unknown): AnyRec[] => (Array.isArray(v) ? (v as AnyRec[]) : []);

async function main() {
  token(); // fail fast, before creating a directory or a network connection
  const searchOnly = process.argv.includes('--search');

  console.log('\nRecording real Duffel responses to fixtures/live/\n');
  const restore = installRecordingFetch();

  try {
    // ---- Q0: does our own search request survive contact with the real API? --
    // The one place the *adapter* is what is under test. Everything below is a
    // raw probe, because the adapter cannot reach the credit questions.
    await step('adapter search', 'provider.search() — our outbound body, real response', async () => {
      const provider = new DuffelProvider(configFromEnv());
      const result = await provider.search({
        constraints: {
          originAirport: 'JFK',
          destinationAirport: 'LAX',
          earliestDeparture: new Date(`${dayAfter(30)}T00:00:00Z`),
          latestArrival: new Date(`${dayAfter(30)}T23:59:59Z`),
        },
        passengers: [{ givenName: 'Test', familyName: 'Traveler' }],
      });
      console.log(`\n    → ${result.offers.length} offers normalized without error`);
      process.stdout.write('  '.padEnd(30));
      return result;
    });

    // ---- the raw offer request, so we can read ids the normalizer drops ------
    const offerReq = await step(
      'raw offer request',
      'POST /air/offer_requests — the unnormalized truth, incl. passenger ids',
      () =>
        raw('POST', '/air/offer_requests?return_offers=true', {
          data: {
            slices: [{ origin: 'JFK', destination: 'LAX', departure_date: dayAfter(30) }],
            passengers: [{ type: 'adult', given_name: 'Test', family_name: 'Traveler' }],
          },
        }),
    );

    const offers = arr(rec(rec(offerReq).data).offers);
    const firstOffer = offers[0];
    const passengerIds = arr(rec(firstOffer).passengers).map((p) => String(p.id));

    if (!firstOffer) {
      console.log('\n  No offers returned — cannot probe orders. Captures so far are still written.');
      return;
    }

    // ---- Q1: what does a single re-fetched offer carry about credits? -------
    await step('get offer', 'GET /air/offers/:id — Q1, the credit fields on one offer', () =>
      raw('GET', `/air/offers/${firstOffer.id}?return_available_services=false`),
    );

    if (searchOnly) {
      console.log('\n  --search given; stopping before anything is ordered.');
      return;
    }

    const passenger = (id: string) => ({
      id,
      given_name: 'Test',
      family_name: 'Traveler',
      born_on: '1990-01-01',
      email: 'test.traveler@example.com',
      phone_number: '+14155550100',
      gender: 'm',
      title: 'mr',
    });
    const people = passengerIds.map(passenger);

    // ---- hold, then pay it off ---------------------------------------------
    const holdable = offers.find(
      (o) => rec(o.payment_requirements).requires_instant_payment === false,
    );
    if (holdable) {
      const held = await step('hold order', 'POST /air/orders type=hold', () =>
        raw('POST', '/air/orders', {
          data: {
            type: 'hold',
            selected_offers: [holdable.id],
            passengers: arr(holdable.passengers).map((p) => passenger(String(p.id))),
          },
        }),
      );
      const heldId = rec(rec(held).data).id;
      if (heldId) {
        await step('get held order', 'GET /air/orders/:id — price before paying', () =>
          raw('GET', `/air/orders/${heldId}`),
        );
        await step('pay held order', 'POST /air/payments', () =>
          raw('POST', '/air/payments', {
            data: {
              order_id: heldId,
              payment: {
                type: 'balance',
                amount: rec(rec(held).data).total_amount,
                currency: rec(rec(held).data).total_currency,
              },
            },
          }),
        );
      }
    } else {
      console.log('  hold order                 skipped — no holdable offer in this search');
    }

    // ---- instant order, no credit: the control ------------------------------
    const instant = await step('instant order', 'POST /air/orders type=instant, no credit', () =>
      raw('POST', '/air/orders', {
        data: {
          type: 'instant',
          selected_offers: [firstOffer.id],
          passengers: people,
          payments: [
            {
              type: 'balance',
              amount: firstOffer.total_amount,
              currency: firstOffer.total_currency,
            },
          ],
        },
      }),
    );

    const orderId = rec(rec(instant).data).id;
    if (orderId) {
      await step('cancel order', 'POST /air/order_cancellations', () =>
        raw('POST', '/air/order_cancellations', { data: { order_id: orderId } }),
      );
    }

    // ---- Q1/Q2/Q3: the credit path, which is the point of the whole script --
    const credit = await step(
      'create credit',
      'POST /air/airline_credits — a credit to redeem',
      () =>
        raw('POST', '/air/airline_credits', {
          data: {
            given_name: 'Test',
            family_name: 'Traveler',
            airline_iata_code: 'AA',
            credit_amount: '150.00',
            credit_currency: 'USD',
            credit_name: 'Harness test credit',
            issued_on: dayAfter(-30),
            type: 'eticket',
          },
        }),
    );

    const creditId = rec(rec(credit).data).id;
    if (!creditId) {
      console.log(
        '\n  No credit created, so Q1–Q3 stay open. The response body above is the reason;\n' +
          '  the create-credit payload shape is itself one of the things we are learning.',
      );
      return;
    }

    // Q1: search again, this time naming the credit. Whichever field comes back
    // populated on the offers is the answer.
    const credited = await step(
      'offer request w/ credit',
      'Q1 — offer request naming a credit id; which field comes back?',
      () =>
        raw('POST', '/air/offer_requests?return_offers=true', {
          data: {
            slices: [{ origin: 'JFK', destination: 'LAX', departure_date: dayAfter(30) }],
            passengers: [{ type: 'adult', given_name: 'Test', family_name: 'Traveler' }],
            airline_credit_ids: [creditId],
          },
        }),
    );

    const creditedOffer = arr(rec(rec(credited).data).offers)[0];
    if (!creditedOffer) return;

    await step('get credited offer', 'Q1 — the same question on GET /air/offers/:id', () =>
      raw('GET', `/air/offers/${creditedOffer.id}`),
    );

    // Q2: send it the way `client.ts` does today. A 422 here is the finding.
    await step(
      'order: our shape',
      'Q2 — top-level `airline_credits: [{id}]`, exactly what client.ts:440 sends',
      () =>
        raw('POST', '/air/orders', {
          data: {
            type: 'instant',
            selected_offers: [creditedOffer.id],
            passengers: arr(creditedOffer.passengers).map((p) => passenger(String(p.id))),
            airline_credits: [{ id: creditId }],
            payments: [
              {
                type: 'balance',
                amount: creditedOffer.total_amount,
                currency: creditedOffer.total_currency,
              },
            ],
          },
        }),
    );

    // Q2/Q3: send it the way the docs describe. Whichever of these two succeeds
    // is the shape `client.ts` should be sending, and its response answers Q3.
    await step(
      'order: documented shape',
      'Q2/Q3 — credit as a `payments` entry; response should say what it charged',
      () =>
        raw('POST', '/air/orders', {
          data: {
            type: 'instant',
            selected_offers: [creditedOffer.id],
            passengers: arr(creditedOffer.passengers).map((p) => passenger(String(p.id))),
            payments: [
              { type: 'airline_credit', airline_credit_id: creditId },
              {
                type: 'balance',
                amount: creditedOffer.total_amount,
                currency: creditedOffer.total_currency,
              },
            ],
          },
        }),
    );

    await step('get credit', 'Q1 — GET /air/airline_credits/:id, where the values live', () =>
      raw('GET', `/air/airline_credits/${creditId}`),
    );
  } finally {
    restore();
    await writeCaptures();
  }
}

async function writeCaptures() {
  if (captures.length === 0) {
    console.log('\nNothing captured.\n');
    return;
  }
  await mkdir(OUT_DIR, { recursive: true });

  const index: AnyRec[] = [];
  for (const [i, c] of captures.entries()) {
    const slug = `${String(i + 1).padStart(3, '0')}-${c.request.method}-${c.request.url
      .replace(API, '')
      .replace(/^\//, '')
      .replace(/[/?=&]/g, '-')
      .slice(0, 60)}`;
    await writeFile(path.join(OUT_DIR, `${slug}.json`), `${JSON.stringify(c, null, 2)}\n`);
    index.push({ file: `${slug}.json`, step: c.step, note: c.note, status: c.response.status });
  }
  await writeFile(
    path.join(OUT_DIR, 'index.json'),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), captures: index }, null, 2)}\n`,
  );

  console.log(`\n${captures.length} captures written to fixtures/live/\n`);
  for (const c of index) {
    console.log(`  ${String(c.status).padEnd(4)} ${String(c.step).padEnd(26)} ${c.file}`);
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
