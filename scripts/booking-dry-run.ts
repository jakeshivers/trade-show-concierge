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
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import { getActor, type Actor } from '../src/lib/auth/actor';
import { RecordedFlightProvider } from '../src/lib/integrations/flights/recorded/provider';
import {
  submitTravelRequest,
  runAgent,
  approveRequest,
  expireStaleRequests,
  type AgentDeps,
} from '../src/lib/travel/agent';
import { haltPurchasing, resumePurchasing } from '../src/lib/travel/kill-switch';
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
  const dana = await actorFor('dana@northwindrobotics.test');
  const approved = await approveRequest(request.id, dana, deps(clock));

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
  const dana = await actorFor('dana@northwindrobotics.test');
  const priya = await actorFor('priya@northwindrobotics.test');
  const show = await db.query.shows.findFirst({ where: eq(s.shows.name, 'Automate 2026') });
  if (!show?.moveInAt) throw new Error('Seed is missing Automate 2026 move-in time');
  const day = 86_400_000;

  await haltPurchasing(dana.orgId, dana, 'Fare feed looked wrong at 09:12', db, clock.now);
  console.log('    dana@ halted purchasing: "Fare feed looked wrong at 09:12"');

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
  await resumePurchasing(dana.orgId, dana, 'Feed verified against the carrier', db, clock.now);
  console.log('\n    dana@ resumed purchasing; the queued request is approved normally');

  const marcus = await actorFor('marcus@northwindrobotics.test');
  const booked = await approveRequest(request.id, marcus, deps(clock));
  console.log(
    `    result: ${booked.status}  booking ${booked.booking?.providerOrderId ?? '—'} ` +
      `at ${usd(booked.booking?.chargedCents)} (live=${booked.booking?.live})`,
  );
}

async function scenarioAuditTrail() {
  console.log('\n━━ 6. The audit trail, as a person reads it ━━');
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
