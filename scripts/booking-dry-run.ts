/**
 * The booking spine, end to end, headless.
 *
 * Runs the whole loop from SCOPE.md §6 against the seeded org with no API keys
 * and no network: submit → search → snapshot → evaluate → decide → book or
 * escalate → approve → dry-run purchase. Offers come from the `recorded`
 * provider, which replays recorded wire payloads through the production
 * normalizer and cannot spend money under any configuration.
 *
 *   pnpm booking:dry-run
 *
 * This script is the step-4 deliverable: proof that the spine works before a
 * single screen exists to look at it.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import { getActor, type Actor } from '../src/lib/auth/actor';
import { RecordedFlightProvider } from '../src/lib/integrations/flights/recorded/provider';
import { nonstopOffer, unitedNearTieOffer } from '../src/lib/integrations/flights/duffel/fixtures';
import {
  submitTravelRequest,
  runAgent,
  approveRequest,
  expireStaleRequests,
  type AgentDeps,
} from '../src/lib/travel/agent';
import { haltPurchasing, resumePurchasing } from '../src/lib/travel/kill-switch';
import {
  creditExposure,
  creditPool,
  runCreditMaintenance,
} from '../src/lib/travel/credits';
import { getAuditTrail, renderAuditTrail } from '../src/lib/travel/audit';

const db = getDb();
const usd = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);

/** One clock for the agent and the provider, so "two hours later" is a real test. */
class Clock {
  constructor(private t: Date) {}
  now = () => new Date(this.t);
  advanceMinutes(n: number) {
    this.t = new Date(this.t.getTime() + n * 60_000);
    return this;
  }
}

async function actorFor(email: string): Promise<Actor> {
  process.env.DEV_ACTOR_EMAIL = email;
  return getActor();
}

function deps(clock: Clock): AgentDeps {
  return {
    db,
    provider: new RecordedFlightProvider({ now: clock.now }),
    now: clock.now,
    // Never true here. This script exists to prove the pipeline, not to buy.
    live: false,
  };
}

async function trace(requestId: string) {
  const runs = await db
    .select()
    .from(s.agentRuns)
    .where(eq(s.agentRuns.travelRequestId, requestId))
    .orderBy(s.agentRuns.sequence);
  for (const run of runs) {
    const arrow = run.fromStatus ? `${run.fromStatus} → ${run.toStatus}` : (run.toStatus ?? '·');
    console.log(`    ${run.step.padEnd(20)} ${arrow.padEnd(30)} ${run.summary}`);
  }
}

async function offerTable(requestId: string) {
  const rows = await db
    .select({
      offer: s.offerSnapshots.providerOfferId,
      cents: s.offerSnapshots.totalCents,
      stops: s.offerSnapshots.maxStops,
      cabin: s.offerSnapshots.highestCabin,
      selected: s.offerSnapshots.selected,
      decision: s.policyEvaluations.decision,
      blockers: s.policyEvaluations.blockerRuleIds,
    })
    .from(s.offerSnapshots)
    .leftJoin(s.policyEvaluations, eq(s.policyEvaluations.offerSnapshotId, s.offerSnapshots.id))
    .where(eq(s.offerSnapshots.travelRequestId, requestId))
    .orderBy(s.offerSnapshots.rank);

  for (const r of rows) {
    console.log(
      `    ${r.selected ? '▸' : ' '} ${r.offer.padEnd(28)} ${usd(r.cents).padStart(9)}  ` +
        `${r.stops} stop  ${(r.cabin ?? '').padEnd(16)} ${(r.decision ?? '').padEnd(15)} ` +
        `${(r.blockers ?? []).join(', ')}`,
    );
  }
}

async function scenarioAutoBook() {
  console.log('\n━━ 1. Within policy → booked without asking anyone ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const priya = await actorFor('priya@northwindrobotics.test');
  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  if (!show?.moveInAt) throw new Error('Seed is missing Automate 2026 move-in time');

  const day = 86_400_000;
  const request = await submitTravelRequest(
    {
      showId: show.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(show.moveInAt.getTime() - day),
      latestArrival: show.moveInAt,
      idempotencyKey: 'demo-auto-book',
    },
    priya,
    d,
  );

  const outcome = await runAgent(request.id, d, priya);
  await offerTable(request.id);
  console.log();
  await trace(request.id);
  console.log(
    `\n    result: ${outcome.status}  ` +
      `booking ${outcome.booking?.providerOrderId ?? '—'} at ${usd(outcome.booking?.chargedCents)} ` +
      `(live=${outcome.booking?.live})`,
  );

  // Rail 2: submitting the same key again must not open a second request.
  const again = await submitTravelRequest(
    {
      showId: show.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(show.moveInAt.getTime() - day),
      latestArrival: show.moveInAt,
      idempotencyKey: 'demo-auto-book',
    },
    priya,
    d,
  );
  console.log(`    idempotency: resubmitting returned ${again.id === request.id ? 'the same request ✓' : 'A SECOND REQUEST ✗'}`);
}

async function scenarioApprovalAfterExpiry() {
  console.log('\n━━ 2. Over the auto-approve band → escalated, offer dies, re-priced on approval ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const marcus = await actorFor('marcus@northwindrobotics.test');
  const ingrid = await db.query.users.findFirst({
    where: eq(s.users.email, 'ingrid@northwindrobotics.test'),
  });
  if (!ingrid) throw new Error('Seed is missing Ingrid Solberg');

  const day = 86_400_000;
  const depart = new Date(clock.now().getTime() + 45 * day);
  const request = await submitTravelRequest(
    {
      travelerId: ingrid.id,
      originAirport: 'SFO',
      destinationAirport: 'LHR',
      earliestDeparture: depart,
      latestArrival: new Date(depart.getTime() + 2 * day),
      idempotencyKey: 'demo-approval',
    },
    marcus,
    d,
  );

  const escalated = await runAgent(request.id, d, marcus);
  await offerTable(request.id);
  console.log(`\n    status: ${escalated.status} — ${escalated.selected?.verdict.reasons.join('; ')}`);

  // The offer had a 30-minute life and the approver went to lunch.
  clock.advanceMinutes(120);
  const shelley = await actorFor('shelley@northwindrobotics.test');
  const approved = await approveRequest(request.id, shelley, deps(clock));

  console.log();
  await trace(request.id);
  console.log(
    `\n    result: ${approved.status}  ` +
      `booking ${approved.booking?.providerOrderId ?? '—'} at ${usd(approved.booking?.chargedCents)} ` +
      `(live=${approved.booking?.live})`,
  );

  const approvals = await db
    .select()
    .from(s.approvals)
    .where(eq(s.approvals.travelRequestId, request.id));
  for (const a of approvals) {
    console.log(
      `    approval: ${a.outcome} by ${a.approverId.slice(0, 8)} at ${usd(a.priceAtApprovalCents)} ` +
        `re-searched=${a.reSearchedOnApproval}`,
    );
  }
}

async function scenarioNoOptions() {
  console.log('\n━━ 3. Every offer refused → no_options, with the relaxations worth suggesting ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const priya = await actorFor('priya@northwindrobotics.test');

  const day = 86_400_000;
  // A window narrow enough that nothing on the route can land inside it. The
  // point is the *reasons*: "no options" is only useful if it tells the user
  // which constraint to loosen.
  const depart = new Date(clock.now().getTime() + 40 * day);
  const request = await submitTravelRequest(
    {
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: depart,
      latestArrival: new Date(depart.getTime() + 4 * 3_600_000),
      idempotencyKey: 'demo-no-options',
    },
    priya,
    d,
  );
  const outcome = await runAgent(request.id, d, priya);

  await offerTable(request.id);
  console.log(`\n    status: ${outcome.status}`);
  for (const reason of outcome.noOptionsReasons ?? []) console.log(`    · ${reason}`);
  if ((outcome.noOptionsReasons ?? []).length === 0) {
    console.log('    · the provider returned nothing at all for that route');
  }
}

async function scenarioExpirySweep() {
  console.log('\n━━ 4. Expiry sweep — a request nobody approved in time ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const marcus = await actorFor('marcus@northwindrobotics.test');
  const ingrid = await db.query.users.findFirst({
    where: eq(s.users.email, 'ingrid@northwindrobotics.test'),
  });

  const day = 86_400_000;
  const depart = new Date(clock.now().getTime() + 60 * day);
  const request = await submitTravelRequest(
    {
      travelerId: ingrid!.id,
      originAirport: 'SFO',
      destinationAirport: 'LHR',
      earliestDeparture: depart,
      latestArrival: new Date(depart.getTime() + 2 * day),
      idempotencyKey: 'demo-expiry',
    },
    marcus,
    d,
  );
  await runAgent(request.id, d, marcus);

  clock.advanceMinutes(90);
  const expired = await expireStaleRequests(marcus.orgId, deps(clock));
  console.log(`    swept ${expired.length} request(s) whose offer died while awaiting approval`);
  await trace(request.id);
}

async function scenarioKillSwitch() {
  console.log('\n━━ 5. Kill switch — an admin halts purchasing, and nothing is bought or lost ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const shelley = await actorFor('shelley@northwindrobotics.test');
  const priya = await actorFor('priya@northwindrobotics.test');
  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  if (!show?.moveInAt) throw new Error('Seed is missing Automate 2026 move-in time');
  const day = 86_400_000;

  await haltPurchasing(shelley.orgId, shelley, 'Fare feed looked wrong at 09:12', db, clock.now);
  console.log('    shelley@ halted purchasing: "Fare feed looked wrong at 09:12"');

  const request = await submitTravelRequest(
    {
      showId: show.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(show.moveInAt.getTime() - day),
      latestArrival: show.moveInAt,
      idempotencyKey: 'demo-kill-switch',
    },
    priya,
    d,
  );

  // The same request that auto-booked in scenario 1.
  const halted = await runAgent(request.id, d, priya);
  console.log(
    `    verdict ${halted.selected?.verdict.decision} but status ${halted.status} — ` +
      'judged, queued, not bought',
  );
  await trace(request.id);

  clock.advanceMinutes(30);
  await resumePurchasing(shelley.orgId, shelley, 'Feed verified against the carrier', db, clock.now);
  console.log('\n    shelley@ resumed purchasing; the queued request is approved normally');

  const marcus = await actorFor('marcus@northwindrobotics.test');
  const booked = await approveRequest(request.id, marcus, deps(clock));
  console.log(
    `    result: ${booked.status}  booking ${booked.booking?.providerOrderId ?? '—'} ` +
      `at ${usd(booked.booking?.chargedCents)} (live=${booked.booking?.live})`,
  );
}

/**
 * §5b, the part that makes the ledger worth building: the agent looks at the
 * credit pool before it spends, and refuses to pay cash over money we already
 * hold. Tomás is the one carrying credits in the seed.
 */
async function scenarioCreditFirst() {
  console.log('\n━━ 6. Unused credit in the pool → the agent will not pay cash over it ━━\n');
  const clock = new Clock(new Date());
  const d = deps(clock);
  const marcus = await actorFor('marcus@northwindrobotics.test');
  const shelley = await actorFor('shelley@northwindrobotics.test');
  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  const tomas = await db.query.users.findFirst({
    where: eq(s.users.email, 'tomas@northwindrobotics.test'),
  });
  if (!show?.moveInAt || !tomas) throw new Error('Seed is missing Automate 2026 or Tomás');

  const day = 86_400_000;
  const request = await submitTravelRequest(
    {
      showId: show.id,
      travelerId: tomas.id,
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      earliestDeparture: new Date(show.moveInAt.getTime() - day),
      latestArrival: show.moveInAt,
      idempotencyKey: 'demo-credit',
    },
    marcus,
    d,
  );

  const pool = await creditPool(db, { orgId: tomas.orgId, travelerId: tomas.id, now: clock.now() });
  console.log(`    ${tomas.fullName} holds:`);
  for (const c of pool) {
    console.log(
      `      ${usd(c.remainingValueCents).padStart(9)}  ${c.airlineCode}  expires ${c.expiresOn.toISOString().slice(0, 10)}  ` +
        `${c.providerCreditId ? 'the agent can redeem this' : 'only the airline can redeem this'}`,
    );
  }
  console.log();

  await runAgent(request.id, d, marcus);
  // The same request the auto-book scenario waved through, escalated purely
  // because the traveler is holding money the org would otherwise re-spend.
  const approved = await approveRequest(request.id, shelley, d);
  await trace(request.id);

  const alerts = await db
    .select()
    .from(s.alerts)
    .where(eq(s.alerts.userId, tomas.id));
  const unreachable = alerts.filter((a) => a.dedupeKey.includes(':unreachable:'));
  console.log(
    `\n    result: ${approved.status}  credit applied ${usd(approved.booking?.creditAppliedCents ?? 0)} — ` +
      'the American credit does not match a Delta itinerary, and the Delta credit\n' +
      '            is ours but not the provider\'s to spend.',
  );
  for (const a of unreachable) console.log(`    alert:  ${a.title}`);
  console.log(
    '\n    Nothing was drawn down: a dry run must not burn a credit, because the ticket it\n' +
      '    would have paid for does not exist. See `pnpm credits`.',
  );
}

/** The ledger's own maintenance: write off what died, warn about what will. */
async function scenarioCreditExpiry() {
  console.log('\n━━ 7. The credit ledger: forfeiture is a number, not a status ━━\n');
  const org = await db.query.organizations.findFirst();
  if (!org) throw new Error('No organization in the seed');

  const now = new Date();
  const before = await creditExposure(db, org.id, now);
  const swept = await runCreditMaintenance(db, org.id, now);
  const after = await creditExposure(db, org.id, now);

  // The spendable total does not move: an expired credit was already unspendable.
  // What the sweep changes is the *forfeited* total — the number that says how
  // much the org lost, which a status flip alone could never produce.
  console.log(`    still spendable    ${usd(after.liveCents)}  (unchanged — expired money was never spendable)`);
  console.log(`    forfeited before   ${usd(before.forfeitedCents)}`);
  console.log(`    forfeited after    ${usd(after.forfeitedCents)}  — ${swept.sweptCount} credit(s) written off`);
  console.log(`    needs a phone call ${usd(after.redeemableElsewhereCents)} — real money, not reachable from here`);
  console.log(`    warned             ${swept.warned} credit(s), ${swept.alertsSent} alert(s) written`);

  const again = await runCreditMaintenance(db, org.id, now);
  console.log(
    `\n    run again: ${usd(again.forfeitedCents)} written off, ${again.alertsSent} new alert(s) — ` +
      'each threshold speaks once.',
  );
  console.log('\n    (the whole ledger: pnpm credits · one credit: pnpm credits <id>)');
}

/**
 * The traveler's own carrier preference, and what it is and is not allowed to do.
 *
 * Priya prefers UA; the org prefers DL and AA and has priced a personal carrier
 * preference at $60. So the UA fare wins by $22 — and the same run, read with
 * the allowance removed, picks the cheaper Delta. Both halves are printed,
 * because the interesting claim is not that a preference works, it is that it is
 * **bounded**: the second half is what somebody signing off on the feature needs
 * to see.
 */
async function scenarioCarrierPreference() {
  console.log('\n━━ 8. A traveler’s own carrier preference — bounded, and it never rules ━━\n');
  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  if (!show?.moveInAt) throw new Error('Seed is missing Automate 2026 move-in time');
  const day = 86_400_000;

  const run = async (key: string, allowanceCents: number | null) => {
    // The allowance is an org policy value, so this moves the *policy* rather
    // than the person — which is the honest way round: a traveler cannot change
    // what their preference is worth.
    await db
      .update(s.travelPolicies)
      .set({ personalCarrierAllowanceCents: allowanceCents })
      .where(and(eq(s.travelPolicies.scope, 'org'), isNull(s.travelPolicies.supersededAt)));

    const clock = new Clock(new Date());
    const d: AgentDeps = {
      db,
      provider: new RecordedFlightProvider({
        now: clock.now,
        payloads: [nonstopOffer, unitedNearTieOffer],
      }),
      now: clock.now,
      live: false,
    };
    const priya = await actorFor('priya@northwindrobotics.test');
    const request = await submitTravelRequest(
      {
        showId: show.id,
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        earliestDeparture: new Date(show.moveInAt!.getTime() - day),
        latestArrival: show.moveInAt!,
        idempotencyKey: key,
      },
      priya,
      d,
    );
    await runAgent(request.id, d, priya);
    return request.id;
  };

  console.log('    Priya prefers UA. The org prefers DL/AA and pays up to $60 for a preference.\n');
  const withAllowance = await run('demo-carrier-preference', 6_000);
  await offerTable(withAllowance);
  console.log();
  await trace(withAllowance);

  console.log('\n    The same two fares with the allowance withdrawn — nobody has priced it:\n');
  const withoutAllowance = await run('demo-carrier-preference-unpriced', null);
  await offerTable(withoutAllowance);
  console.log();
  await trace(withoutAllowance);

  // Leave the seeded policy as the seed wrote it.
  await db
    .update(s.travelPolicies)
    .set({ personalCarrierAllowanceCents: 6_000 })
    .where(and(eq(s.travelPolicies.scope, 'org'), isNull(s.travelPolicies.supersededAt)));

  console.log(
    '\n    It never denies, never escalates, and cannot cross a decision tier — `rank.ts`\n' +
      '    clamps the discounted score to the tier floor rather than trusting the number.',
  );
}

async function scenarioAuditTrail() {
  console.log('\n━━ 9. The audit trail, as a person reads it ━━');
  const request = await db.query.travelRequests.findFirst({
    where: eq(s.travelRequests.idempotencyKey, 'demo-approval'),
  });
  if (!request) throw new Error('Scenario 2 did not leave a request behind');
  console.log('');
  console.log(
    renderAuditTrail(await getAuditTrail(request.id, db))
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
  console.log('\n    (the same for any request: pnpm booking:audit <id | idempotency-key>)');
}

async function main() {
  console.log('Trade Show Concierge — booking spine, dry run');
  console.log('provider: recorded (replayed payloads) · live purchasing: OFF');

  // Start from a clean spine so the run is reproducible; the seeded planning
  // data is left alone.
  await db.delete(s.travelRequests);
  await db.delete(s.bookingControls);

  await scenarioAutoBook();
  await scenarioApprovalAfterExpiry();
  await scenarioNoOptions();
  await scenarioExpirySweep();
  await scenarioKillSwitch();
  await scenarioCreditFirst();
  await scenarioCreditExpiry();
  await scenarioCarrierPreference();
  await scenarioAuditTrail();

  const bookings = await db.select().from(s.bookings);
  console.log(
    `\n━━ ${bookings.length} booking row(s) written, ${bookings.filter((b) => b.live).length} of them live. ` +
      'No money moved. ━━\n',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n✗ dry run failed');
    console.error(err);
    process.exit(1);
  });
