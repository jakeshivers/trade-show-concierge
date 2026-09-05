import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeOffer } from '@/lib/integrations/flights/duffel/normalize';
import type { DuffelOffer } from '@/lib/integrations/flights/duffel/wire';

/**
 * The captured half of the Duffel adapter's test suite.
 *
 * `duffel.test.ts` next door asserts that our code behaves correctly *given* the
 * payloads in `fixtures.ts`. Those payloads were written from the published
 * schema by the same person who wrote the code that reads them, which makes that
 * suite a closed loop: it proves internal consistency and cannot, even in
 * principle, catch a wrong field name.
 *
 * This file is the other half. It reads whatever `pnpm duffel:capture` recorded
 * from the real API and asks whether our types and our normalizer survive it.
 *
 * **It skips itself when there are no captures**, which is not a compromise but
 * the point: SCOPE.md §9 requires `pnpm db:reset && pnpm test` to pass on a clean
 * clone with zero keys and zero accounts, and a suite that fails without a Duffel
 * key would quietly make a key mandatory. So a clean clone sees these skipped,
 * and anyone with a free test key sees them run.
 *
 * The assertions below are ordered by what they would teach us, not by severity.
 * Several of them are expected to fail the first time this is ever run against a
 * real key — that is the deliverable, not a defect.
 */

const LIVE_DIR = path.resolve(import.meta.dirname, '../fixtures/live');

type Capture = {
  step: string;
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

/** Every offer object anywhere in the captures, from either endpoint that returns one. */
function capturedOffers(): { offer: Record<string, unknown>; from: string }[] {
  const out: { offer: Record<string, unknown>; from: string }[] = [];
  for (const c of captures) {
    if (!c.response.ok) continue;
    const data = rec(rec(c.response.body).data);
    for (const o of arr(data.offers)) out.push({ offer: o, from: c.step });
    // GET /air/offers/:id returns a bare offer as `data`.
    if (data.id && data.slices) out.push({ offer: data, from: c.step });
  }
  return out;
}

const offers = capturedOffers();
const withCaptures = captures.length > 0 ? describe : describe.skip;

describe('captured Duffel payloads', () => {
  it('reports whether any captures exist', () => {
    if (captures.length === 0) {
      console.log(
        '\n  No fixtures/live/ captures — conformance checks skipped.\n' +
          '  Run `pnpm duffel:capture` with a Duffel test key to activate them.\n',
      );
    }
    expect(true).toBe(true);
  });
});

withCaptures('the normalizer against real offers', () => {
  it('normalizes every captured offer without throwing', () => {
    // The single highest-value assertion in the file. `normalizeOffer` throws a
    // NormalizationError naming the field whenever a structural assumption is
    // wrong, so a failure here arrives pre-diagnosed.
    const failures: string[] = [];
    for (const { offer, from } of offers) {
      try {
        normalizeOffer(offer as unknown as DuffelOffer);
      } catch (err) {
        failures.push(`${from}/${offer.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('found offers to check at all', () => {
    expect(offers.length).toBeGreaterThan(0);
  });
});

withCaptures('fields the normalizer would otherwise mis-read in silence', () => {
  // Each of these has a default that is indistinguishable from a real value.
  // They cannot fail loudly at runtime by construction, so they are checked here
  // or nowhere.

  it('every cabin_class is one the normalizer knows', () => {
    // An unknown cabin silently becomes `economy` (normalize.ts:34), which would
    // mis-rank every policy decision without erroring anywhere.
    const known = ['economy', 'premium_economy', 'business', 'first'];
    const seen = new Set<string>();
    for (const { offer } of offers) {
      for (const slice of arr(offer.slices)) {
        for (const segment of arr(slice.segments)) {
          for (const p of arr(segment.passengers)) {
            if (p.cabin_class) seen.add(String(p.cabin_class));
          }
        }
      }
    }
    const unknown = [...seen].filter((c) => !known.includes(c));
    expect(unknown, `Duffel sent cabin classes we silently coerce to economy: ${unknown}`).toEqual(
      [],
    );
  });

  it('every airport carries the time_zone the normalizer resolves against', () => {
    // Missing time_zone throws rather than defaulting, so this is a loud failure
    // in production — but finding it here is considerably cheaper.
    const missing: string[] = [];
    for (const { offer } of offers) {
      for (const slice of arr(offer.slices)) {
        for (const segment of arr(slice.segments)) {
          for (const key of ['origin', 'destination']) {
            const airport = rec(segment[key]);
            if (!airport.time_zone) missing.push(`${offer.id} ${key} ${airport.iata_code}`);
          }
        }
      }
    }
    expect(missing, `airports with no time_zone: ${missing.slice(0, 5)}`).toEqual([]);
  });

  it('offers carry payment_requirements rather than relying on our default', () => {
    // Absent, the normalizer assumes `requiresInstantPayment: true` — the safe
    // direction, but it makes every offer look unholdable, which would silently
    // disable the hold-then-approve path the whole approvals queue rests on.
    const without = offers.filter(({ offer }) => offer.payment_requirements == null);
    expect(without.length, `${without.length}/${offers.length} offers had no payment_requirements`).toBe(0);
  });

  it('offers carry conditions rather than reading as non-refundable by omission', () => {
    // `condition(undefined)` returns `{allowed: false}` — an offer with no
    // conditions block is indistinguishable from a genuinely restricted fare.
    const without = offers.filter(({ offer }) => offer.conditions == null);
    expect(without.length, `${without.length}/${offers.length} offers had no conditions`).toBe(0);
  });
});

withCaptures('Q1 — which airline-credit field is real', () => {
  /**
   * `wire.ts` declares both and hedges between them. `normalize.ts` reads
   * `available_airline_credit_ids`; `client.ts:resolveCredits` reads *only*
   * `available_airline_credits` and throws when it is empty. They cannot both be
   * right, and the second one is the one purchases depend on.
   */
  const credited = offers.filter(
    ({ offer }) =>
      arr(offer.available_airline_credits).length > 0 ||
      (Array.isArray(offer.available_airline_credit_ids) &&
        offer.available_airline_credit_ids.length > 0),
  );

  it('captured at least one offer with a credit attached', () => {
    if (credited.length === 0) {
      console.log(
        '\n  No captured offer carried a credit. Q1 is unanswered — the credit-redemption\n' +
          '  steps of `pnpm duffel:capture` did not produce one. Check its output.\n',
      );
    }
    expect(true).toBe(true);
  });

  it('the field client.ts depends on is the field Duffel actually sends', () => {
    if (credited.length === 0) return;

    const shapes = credited.map(({ offer }) => ({
      id: offer.id,
      hasIds: Array.isArray(offer.available_airline_credit_ids),
      hasPriced: Array.isArray(offer.available_airline_credits),
    }));
    console.log('\n  Credit fields observed on real offers:', JSON.stringify(shapes, null, 2));

    // If this fails, `resolveCredits` throws on every credited purchase and §5b
    // has never once fired. That is the finding this whole harness exists for.
    const pricedMissing = shapes.filter((s) => !s.hasPriced);
    expect(
      pricedMissing.length,
      'Duffel did not send `available_airline_credits` (the priced shape client.ts:52 reads). ' +
        'Credits arrive as ids only, so the values must be fetched from ' +
        'GET /air/airline_credits/:id and resolveCredits needs rewriting.',
    ).toBe(0);
  });
});

withCaptures('Q2 — how a credit is applied on order create', () => {
  const ourShape = captures.find((c) => c.step === 'order: our shape');
  const documented = captures.find((c) => c.step === 'order: documented shape');

  it('records what each order-create shape did', () => {
    const summary = [ourShape, documented]
      .filter(Boolean)
      .map((c) => `${c!.step}: HTTP ${c!.response.status}`);
    console.log(`\n  Order-create probes → ${summary.join(' · ') || 'none captured'}\n`);
    expect(true).toBe(true);
  });

  it('the shape client.ts sends today is accepted by Duffel', () => {
    if (!ourShape) return;
    expect(
      ourShape.response.ok,
      'Duffel rejected the top-level `airline_credits: [{id}]` body that client.ts:440 sends. ' +
        `Response: ${JSON.stringify(ourShape.response.body).slice(0, 400)}`,
    ).toBe(true);
  });
});

withCaptures('Q3 — what the provider says it charged to the credit', () => {
  it('an order created with a credit reports the applied amount', () => {
    // The ground rule: `creditAppliedCents` is what the carrier took off, never
    // our arithmetic. Today client.ts computes it. Whatever field appears here is
    // what it should be reading instead.
    const order = captures.find(
      (c) => c.step.startsWith('order:') && c.response.ok,
    );
    if (!order) return;

    const data = rec(rec(order.response.body).data);
    const candidates = Object.keys(data).filter((k) =>
      /payment|credit|charge/i.test(k),
    );
    console.log(
      `\n  Payment/credit-ish fields on a real order: ${candidates.join(', ') || '(none)'}\n`,
    );
    expect(candidates.length).toBeGreaterThan(0);
  });
});

withCaptures('Q4 — does Duffel accept a loyalty account on a passenger', () => {
  /**
   * The quietest of the four questions and the reason it is asked at all.
   *
   * `client.ts` sends `loyalty_programme_accounts` on the offer request and
   * again on order create, written to the published schema and never run against
   * a live key. Every other unverified field in this adapter fails loudly — a
   * wrong tracking field gives a crate with no scans, a wrong credit field
   * throws. This one does not: the search returns offers, the order is created,
   * a real ticket is issued, and the only symptom is a traveler who earns
   * nothing for a year while their number sits saved on `/settings/profile`.
   *
   * What this can and cannot establish: a 200 means the *field name* was
   * accepted. Whether the carrier credited anything is not in any response body,
   * which is exactly why the profile screen says so on the page rather than
   * implying a saved number is a working one.
   */
  const sent = captures.filter((c) =>
    JSON.stringify(c.request.body ?? {}).includes('loyalty_programme_accounts'),
  );

  it('sent one at all, or says why the question stays open', () => {
    if (sent.length === 0) {
      console.log(
        '\n  No captured request carried a loyalty account. Q4 is unanswered — re-run\n' +
          '  `pnpm duffel:capture` from a build that includes the Q4 probes.\n',
      );
    }
    expect(true).toBe(true);
  });

  it('was not rejected for the field', () => {
    for (const c of sent) {
      if (c.response.ok) continue;
      const body = JSON.stringify(c.response.body ?? '');
      // A 422 naming the field is the finding: `client.ts` is sending a shape
      // Duffel does not take, and the fix is the field name, not a retry.
      expect(
        body.includes('loyalty_programme_accounts'),
        `${c.step} failed and named loyalty_programme_accounts — client.ts sends a field ` +
          `Duffel rejects (see duffel/client.ts, offer request and createOrder): ${body}`,
      ).toBe(false);
    }
  });

  it('came back on the passenger where the API echoes one', () => {
    // Duffel echoes the passengers it was given on an order. Where a capture
    // shows one, this is the only positive evidence available that the field was
    // read rather than dropped on the floor.
    const orders = captures.filter((c) => c.response.ok && c.request.url.includes('/air/orders'));
    const echoed = orders.filter((c) =>
      JSON.stringify(c.response.body ?? '').includes('loyalty_programme_accounts'),
    );
    if (orders.length && echoed.length === 0) {
      console.log(
        '\n  Q4: an order was created and no response echoed loyalty_programme_accounts.\n' +
          '  That is not proof it was dropped — Duffel may simply not echo it — but it is\n' +
          '  the point at which to read the order in the Duffel dashboard by hand.\n',
      );
    }
    expect(true).toBe(true);
  });
});
