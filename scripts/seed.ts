/**
 * Seed data — clearly seed data, and it lives only here.
 *
 * SCOPE.md non-negotiable #2: we never put invented data behind a real integration.
 * These are two realistic shows with a staffed team, so every later step has
 * something to develop against without any API keys. Nothing here implies a live
 * flight status or a real fare.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { RecordedFlightProvider } from '../src/lib/integrations/flights/recorded/provider';
import { runAgent, submitTravelRequest, type AgentDeps } from '../src/lib/travel/agent';
import { applyTemplate, setTaskStatus } from '../src/lib/readiness/store';
import { sweepDeadlineAlerts } from '../src/lib/deadlines/store';
import { instantToZoned } from '../src/lib/datetime/zoned';
import {
  addAttendee,
  addRsvp,
  addShift,
  addSideEvent,
  assignToShift,
  respondToInvitation,
} from '../src/lib/team/store';
import { addLodging, assignRoom } from '../src/lib/lodging/store';

const day = 24 * 60 * 60 * 1000;
const now = new Date();
const at = (offsetDays: number, hour = 9) => {
  const d = new Date(now.getTime() + offsetDays * day);
  d.setHours(hour, 0, 0, 0);
  return d;
};

async function main() {
  const db = getDb();

  console.log('· clearing existing data');
  // Order matters only where cascades don't cover it; orgs cascade to everything.
  await db.delete(s.organizations);

  console.log('· organization & cost centers');
  const [org] = await db
    .insert(s.organizations)
    .values({ name: 'Northwind Robotics' })
    .returning();

  const costCenters = await db
    .insert(s.costCenters)
    .values([
      { orgId: org.id, code: 'MKT-100', name: 'Field Marketing' },
      { orgId: org.id, code: 'SE-200', name: 'Sales Engineering' },
      { orgId: org.id, code: 'EXEC-001', name: 'Executive' },
    ])
    .returning();
  const [mkt, se, exec] = costCenters;

  console.log('· travel policy layers');
  // The org row is the base: its nulls are real answers. The override rows below
  // speak only to the rules they change and inherit the rest — see the note on
  // `travelPolicies` in src/db/schema.ts for why that asymmetry matters.
  await db.insert(s.travelPolicies).values([
    {
      orgId: org.id,
      scope: 'org',
      version: 1,
      label: 'Northwind standard travel policy',
      maxAirfareDomesticCents: 65_000,
      maxAirfareInternationalCents: 180_000,
      autoApproveUnderCents: 50_000,
      denyOverCents: 120_000,
      maxCabinDomestic: 'economy',
      maxCabinInternational: 'premium_economy',
      premiumCabinAllowedOverHours: 6,
      minAdvanceBookingDays: 14,
      maxStops: 1,
      minConnectionMinutes: 60,
      arrivalBufferHoursBeforeMoveIn: 4,
      nonRefundableAllowedUnderCents: 50_000,
      maxAcceptableRefundPenaltyCents: 15_000,
      preferredAirlines: ['DL', 'AA'],
      blockedAirlines: [],
      maxHotelNightlyRateCents: 30_000,
      perShowTravelBudgetCents: 1_200_000,
      requireCreditFirst: true,
    },
    {
      orgId: org.id,
      scope: 'cost_center',
      scopeRef: exec.id,
      version: 1,
      label: 'Executive — long-haul allowance',
      maxAirfareDomesticCents: 95_000,
      maxAirfareInternationalCents: 450_000,
      autoApproveUnderCents: 120_000,
      denyOverCents: 500_000,
      maxCabinInternational: 'business',
    },
    {
      orgId: org.id,
      scope: 'cost_center',
      scopeRef: se.id,
      version: 1,
      label: 'Sales Engineering — nonstop only, tighter cap',
      maxAirfareDomesticCents: 55_000,
      maxStops: 1,
    },
  ]);

  console.log('· users');
  const people = await db
    .insert(s.users)
    .values([
      {
        orgId: org.id,
        email: 'shelley@northwindrobotics.test',
        fullName: 'Shelley Shivers',
        title: 'Director, Field Marketing',
        role: 'admin',
        costCenterId: mkt.id,
        seatPreference: 'aisle',
        phone: '+14155550101',
        bornOn: '1981-04-17',
        gender: 'f',
        honorific: 'ms',
      },
      {
        orgId: org.id,
        email: 'marcus@northwindrobotics.test',
        fullName: 'Marcus Oyelaran',
        title: 'Travel & Events Manager',
        role: 'travel_manager',
        costCenterId: mkt.id,
        seatPreference: 'aisle',
        phone: '+14155550102',
        bornOn: '1988-11-02',
        gender: 'm',
        honorific: 'mr',
      },
      {
        orgId: org.id,
        email: 'priya@northwindrobotics.test',
        fullName: 'Priya Raghunathan',
        title: 'Senior Sales Engineer',
        role: 'member',
        costCenterId: se.id,
        knownTravelerNumber: 'KTN9924183',
        seatPreference: 'window',
        phone: '+14155550103',
        bornOn: '1990-06-25',
        gender: 'f',
        honorific: 'ms',
      },
      {
        orgId: org.id,
        email: 'tomas@northwindrobotics.test',
        fullName: 'Tomás Iglesias',
        title: 'Sales Engineer',
        role: 'member',
        costCenterId: se.id,
        seatPreference: 'aisle',
        phone: '+14155550104',
        bornOn: '1986-01-09',
        gender: 'm',
        honorific: 'mr',
      },
      {
        orgId: org.id,
        email: 'reese@northwindrobotics.test',
        fullName: 'Reese Vanterpool',
        title: 'Product Marketing Manager',
        role: 'member',
        costCenterId: mkt.id,
        // Deliberately incomplete: no date of birth, no phone. Half of any real
        // org's directory looks like this, and a live purchase for Reese must
        // fail with a message naming the missing fields rather than inventing
        // them. See `src/lib/travel/passengers.ts`.
      },
      {
        orgId: org.id,
        email: 'ingrid@northwindrobotics.test',
        fullName: 'Ingrid Solberg',
        title: 'VP Revenue',
        role: 'member',
        costCenterId: exec.id,
        seatPreference: 'aisle',
        phone: '+14155550106',
        bornOn: '1975-09-30',
        gender: 'f',
        honorific: 'ms',
      },
    ])
    .returning();
  const [shelley, marcus, priya, tomas, reese, ingrid] = people;

  const actorFor = (u: (typeof people)[number]): Actor => ({
    userId: u.id,
    orgId: u.orgId,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    costCenterId: u.costCenterId,
  });

  console.log('· shows');
  const [automate, medtech, packexpo, sensors, roboticsSummit] = await db
    .insert(s.shows)
    .values([
      {
        orgId: org.id,
        name: 'Automate 2026',
        status: 'planning',
        website: 'https://www.automateshow.com/',
        venueName: 'Huntington Place',
        venueAddress: '1 Washington Blvd, Detroit, MI 48226',
        city: 'Detroit',
        region: 'MI',
        country: 'US',
        airportCode: 'DTW',
        timezone: 'America/Detroit',
        startsOn: at(52, 9),
        endsOn: at(55, 16),
        moveInAt: at(50, 8),
        moveOutAt: at(55, 17),
        boothNumber: '4218',
        boothSize: '20x20',
        budgetCents: 14_500_000,
        goals: '120 qualified leads, 18 demo meetings, 2 analyst briefings.',
      },
      {
        orgId: org.id,
        name: 'MedTech Summit 2026',
        status: 'committed',
        venueName: 'Minneapolis Convention Center',
        venueAddress: '1301 2nd Ave S, Minneapolis, MN 55403',
        city: 'Minneapolis',
        region: 'MN',
        country: 'US',
        airportCode: 'MSP',
        timezone: 'America/Chicago',
        startsOn: at(118, 9),
        endsOn: at(120, 15),
        moveInAt: at(117, 10),
        moveOutAt: at(120, 18),
        boothNumber: '911',
        boothSize: '10x20',
        budgetCents: 6_200_000,
        goals: 'Regulated-market positioning; 40 qualified leads.',
      },
      {
        // A prospect: intake's reason for existing. Nobody has decided yet, and
        // the decision row carries the argument for considering it at all.
        orgId: org.id,
        name: 'PACK EXPO International 2027',
        status: 'prospect',
        website: 'https://www.packexpointernational.com/',
        venueName: 'McCormick Place',
        city: 'Chicago',
        region: 'IL',
        country: 'US',
        airportCode: 'ORD',
        timezone: 'America/Chicago',
        startsOn: at(310, 9),
        endsOn: at(313, 16),
        boothSize: '10x20',
        budgetCents: 7_800_000,
        goals: 'Adjacent-market test: packaging automation buyers.',
      },
      {
        // Overlaps Automate by two days, deliberately: cross-show double-booking
        // (§5, "Team & shifts") cannot be demonstrated on a calendar where no two
        // shows are ever in the same week, and the interesting half of the model
        // is the person who is at both and is *fine*, because their travel
        // windows do not touch. See src/lib/team/conflicts.ts.
        orgId: org.id,
        name: 'Sensors Converge 2026',
        status: 'committed',
        venueName: 'Santa Clara Convention Center',
        city: 'Santa Clara',
        region: 'CA',
        country: 'US',
        airportCode: 'SJC',
        timezone: 'America/Los_Angeles',
        startsOn: at(53, 9),
        endsOn: at(56, 16),
        moveInAt: at(52, 8),
        moveOutAt: at(56, 18),
        boothNumber: '1142',
        boothSize: '10x10',
        budgetCents: 2_900_000,
        goals: 'Component-buyer reach; 35 qualified leads.',
      },
      {
        // Declined, and still here. The value of the intake record is entirely in
        // the ones we said no to — a deleted row cannot argue with next year.
        orgId: org.id,
        name: 'Robotics Summit & Expo 2026',
        status: 'cancelled',
        venueName: 'Boston Convention & Exhibition Center',
        city: 'Boston',
        region: 'MA',
        country: 'US',
        airportCode: 'BOS',
        timezone: 'America/New_York',
        startsOn: at(84, 9),
        endsOn: at(85, 16),
        boothSize: '10x10',
        budgetCents: 3_400_000,
        goals: 'Considered for developer-audience reach.',
      },
    ])
    .returning();

  console.log('· intake decisions');
  // shows.status is the projection; these rows are the record. SCOPE.md §5.
  await db.insert(s.showDecisions).values([
    {
      showId: automate.id,
      decision: 'proposed',
      rationale:
        'Our largest source of qualified automotive and logistics leads two years running.',
      decidedById: shelley.id,
      decidedAt: at(-210),
    },
    {
      showId: automate.id,
      decision: 'committed',
      rationale:
        'Committed the 20x20 island. 2024 sourced $2.1M pipeline against $138k all-in; the island pays for itself at half that.',
      decidedById: shelley.id,
      decidedAt: at(-200),
    },
    {
      showId: medtech.id,
      decision: 'proposed',
      rationale:
        'Regulated-market positioning; sales asked for a credible medical-device presence.',
      decidedById: ingrid.id,
      decidedAt: at(-60),
    },
    {
      showId: medtech.id,
      decision: 'committed',
      rationale:
        'Committed a 10x20 inline. Smaller bet than Automate, and the first year is a read on whether the audience converts.',
      decidedById: shelley.id,
      decidedAt: at(-52),
    },
    {
      showId: packexpo.id,
      decision: 'proposed',
      rationale:
        'Packaging automation is adjacent to our arm business and three inbound deals last quarter came from that segment. Worth a 10x20 test.',
      decidedById: ingrid.id,
      decidedAt: at(-14),
    },
    {
      showId: roboticsSummit.id,
      decision: 'proposed',
      rationale:
        'Developer-audience reach; engineering wanted a recruiting and community presence.',
      decidedById: reese.id,
      decidedAt: at(-95),
    },
    {
      showId: roboticsSummit.id,
      decision: 'declined',
      rationale:
        'Declined: booth space rose 40% year over year and 2025 sourced $190k pipeline against $61k all-in — the worst ratio on the calendar. Revisit if we ship the developer SDK.',
      decidedById: shelley.id,
      decidedAt: at(-88),
    },
  ]);

  console.log('· service manual deadlines');
  // The advance order deadline is the expensive one: 25-40% surcharge after it.
  await db.insert(s.showDeadlines).values([
    {
      showId: automate.id,
      kind: 'advance_order',
      title: 'Advance order deadline — all show services',
      dueAt: at(26, 17),
      penaltyEstimateCents: 312_500,
      penaltyNote: '~30% surcharge on a $10,400 services order if missed.',
      ownerId: marcus.id,
      confirmedAt: now,
    },
    {
      showId: automate.id,
      kind: 'electrical',
      title: 'Electrical order — 20A dedicated circuit',
      dueAt: at(24, 17),
      penaltyEstimateCents: 47_000,
      penaltyNote: 'Floor rate is ~50% higher than advance rate.',
      ownerId: marcus.id,
      confirmedAt: now,
    },
    {
      showId: automate.id,
      kind: 'warehouse_cutoff',
      title: 'Advance warehouse receiving cutoff',
      dueAt: at(38, 16),
      penaltyEstimateCents: 90_000,
      penaltyNote: 'Direct-to-show shipping plus off-target drayage if missed.',
      ownerId: shelley.id,
      confirmedAt: now,
    },
    {
      showId: automate.id,
      kind: 'staff_registration',
      title: 'Booth staff badge registration',
      dueAt: at(31, 17),
      ownerId: reese.id,
      confirmedAt: now,
    },
    {
      showId: automate.id,
      kind: 'furniture_carpet',
      title: 'Carpet & furniture order',
      dueAt: at(26, 17),
      penaltyEstimateCents: 46_000,
      ownerId: marcus.id,
      confirmedAt: now,
    },
    {
      showId: medtech.id,
      kind: 'advance_order',
      title: 'Advance order deadline — all show services',
      dueAt: at(92, 17),
      penaltyEstimateCents: 148_000,
      ownerId: marcus.id,
      confirmedAt: now,
    },
    {
      showId: medtech.id,
      kind: 'room_block',
      title: 'Hotel room block cutoff',
      dueAt: at(76, 17),
      penaltyNote: 'Rooms release to public inventory; rack rate applies.',
      ownerId: marcus.id,
      confirmedAt: now,
    },
    // Three rows the alert engine has something different to say about, because
    // a register where every row is confirmed, owned and ahead of us exercises
    // exactly one of its four cases. SCOPE.md §5a, `src/lib/deadlines/alerts.ts`.
    {
      showId: automate.id,
      kind: 'av_rigging',
      title: 'Rigging & hanging sign order',
      dueAt: at(21, 17),
      penaltyEstimateCents: 120_000,
      penaltyNote: 'Date carried over from last year’s manual — not yet checked.',
      ownerId: marcus.id,
      // Unconfirmed on purpose: this is what a cloned or remembered date looks
      // like, and the engine chases it as a date rather than quoting its penalty.
      confirmedAt: null,
    },
    {
      showId: automate.id,
      kind: 'labor',
      title: 'Install & dismantle labor order',
      dueAt: at(19, 17),
      penaltyEstimateCents: 65_000,
      // Unowned on purpose: the row an owner-addressed engine would mail nobody.
      ownerId: null,
      confirmedAt: now,
    },
    {
      showId: automate.id,
      kind: 'sponsorship_artwork',
      title: 'Sponsorship artwork upload',
      dueAt: at(-3, 17),
      penaltyEstimateCents: 90_000,
      penaltyNote: 'Logo drops off the printed program; the sponsorship is bought either way.',
      ownerId: reese.id,
      confirmedAt: now,
    },
  ]);

  console.log('· readiness tasks');
  const task = (
    showId: string,
    title: string,
    category: (typeof s.taskCategoryEnum.enumValues)[number],
    status: (typeof s.taskStatusEnum.enumValues)[number],
    assigneeId: string,
    dueDays: number,
    weight = 1,
    sortOrder = 0,
    // Required by `lib/readiness/edit.ts` for blocked and skipped, and required
    // here for the same reason: a blocked task with no obstacle named is one
    // nobody can pick up, and a skip with no reason is a way to make the score
    // go up by declaring the work unnecessary.
    statusNote: string | null = null,
  ) => ({
    showId,
    title,
    category,
    status,
    assigneeId,
    dueOn: at(dueDays, 17),
    weight,
    sortOrder,
    statusNote,
    completedAt: status === 'complete' ? at(-2, 12) : null,
    completedById: status === 'complete' ? assigneeId : null,
  });

  await db.insert(s.showTasks).values([
    task(automate.id, 'Sign booth space contract', 'legal', 'complete', shelley.id, -40, 3, 0),
    task(automate.id, 'Confirm booth design & graphics', 'booth', 'complete', reese.id, -14, 3, 1),
    task(automate.id, 'Order show services (electrical, carpet, AV)', 'booth', 'in_progress', marcus.id, 26, 3, 2),
    task(automate.id, 'Book staff travel', 'travel', 'in_progress', marcus.id, 30, 3, 3),
    task(automate.id, 'Reserve hotel room block', 'lodging', 'complete', marcus.id, -8, 2, 4),
    task(automate.id, 'Ship booth crate to advance warehouse', 'shipping', 'not_started', shelley.id, 38, 3, 5),
    task(automate.id, 'Print new datasheets & case studies', 'collateral', 'in_progress', reese.id, 20, 2, 6),
    task(automate.id, 'Order branded swag', 'collateral', 'not_started', reese.id, 25, 1, 7),
    task(automate.id, 'Register booth staff badges', 'staffing', 'not_started', reese.id, 31, 2, 8),
    task(automate.id, 'Build booth shift schedule', 'staffing', 'not_started', marcus.id, 35, 2, 9),
    task(
      automate.id,
      'Schedule analyst briefings',
      'marketing',
      'blocked',
      ingrid.id,
      30,
      2,
      10,
      'Waiting on the Q2 analyst calendar from the AR agency — chased twice, no dates yet.',
    ),
    task(automate.id, 'Pre-show email campaign to target accounts', 'marketing', 'not_started', reese.id, 21, 2, 11),
    task(automate.id, 'Book customer dinner venue', 'marketing', 'in_progress', ingrid.id, 28, 1, 12),
    task(automate.id, 'Confirm lead capture app & licenses', 'follow_up', 'not_started', reese.id, 30, 3, 13),
    task(automate.id, 'Set post-show follow-up SLA with sales', 'follow_up', 'not_started', ingrid.id, 40, 2, 14),
    task(automate.id, 'Reconcile show budget', 'budget', 'not_started', shelley.id, 60, 1, 15),
    task(
      automate.id,
      'Order branded lanyards for the whole show',
      'collateral',
      'skipped',
      reese.id,
      25,
      1,
      16,
      'Show organizer is providing sponsor lanyards this year; ours would not be worn.',
    ),
  ]);

  /**
   * MedTech's checklist is seeded by *running the template applier*, not by
   * typing tasks — the same rule the travel requests follow. A hand-written list
   * that looked template-shaped would let the planner's dating, its idempotency,
   * and its "already late" flag all be wrong without the seed ever noticing, and
   * the seed is where those would be noticed first. The statuses that follow go
   * through `setTaskStatus`, so the seed exercises the real gate too.
   */
  console.log('· medtech checklist (real template applier)');
  const shelleyActor: Actor = {
    userId: shelley.id,
    orgId: shelley.orgId,
    email: shelley.email,
    fullName: shelley.fullName,
    role: shelley.role,
    costCenterId: shelley.costCenterId,
  };
  await applyTemplate(shelleyActor, medtech.id, 'standard-exhibitor', now, db);

  const medtechTasks = await db
    .select()
    .from(s.showTasks)
    .where(eq(s.showTasks.showId, medtech.id));
  const byKey = (key: string) =>
    medtechTasks.find((t) => t.templateKey === `standard-exhibitor:${key}`)!;

  await setTaskStatus(shelleyActor, byKey('contract').id, 'complete', null, now, db);
  await setTaskStatus(shelleyActor, byKey('budget-approved').id, 'complete', null, now, db);
  await setTaskStatus(shelleyActor, byKey('goals').id, 'in_progress', null, now, db);
  await setTaskStatus(
    shelleyActor,
    byKey('booth-design').id,
    'blocked',
    'New brand guidelines land in April; designing against the old ones would be thrown away.',
    now,
    db,
  );
  // A template deliberately assigns nobody, so most of these stay unassigned —
  // which is the honest state of a show whose checklist was seeded last week and
  // is what the screen should show. Only the ones somebody has actually picked up
  // get an owner.
  for (const [key, owner] of [
    ['contract', shelley],
    ['budget-approved', shelley],
    ['goals', ingrid],
    ['booth-design', reese],
    ['room-block', marcus],
    ['travel-requests', marcus],
  ] as const) {
    await db
      .update(s.showTasks)
      .set({ assigneeId: owner.id })
      .where(eq(s.showTasks.id, byKey(key).id));
  }

  // Everything below runs through `src/lib/team` and `src/lib/lodging` rather
  // than inserting rows, for the rule step 9 set and steps 10 and 11 kept: seed
  // data that skips the pipeline is evidence for a screen that the pipeline
  // would never have produced. Here it buys three specific things — every
  // roster row arrives `invited` because only the person themselves confirms
  // (`respondedAt`), the room block cutoff gets its derived deadline from the
  // real sync rather than from a hand-typed register row, and the coverage
  // model is exercised against a roster it did not help build.
  const localOn = (d: Date, tz: string) => instantToZoned(d, tz).slice(0, 10);
  const localAt = (d: Date, tz: string) => instantToZoned(d, tz).slice(11, 16);
  const admin = actorFor(shelley);
  const DTW = automate.timezone;
  const SJC = sensors.timezone;

  console.log('\u00b7 attendees (invited by the lead, answered by the person)');
  const invite = async (
    show: typeof automate,
    user: (typeof people)[number],
    role: string,
    window?: { from: Date; to: Date },
  ) => {
    const tz = show.timezone;
    const { id } = await addAttendee(admin, show.id, {
      userId: user.id,
      role,
      status: 'invited',
      ...(window
        ? {
            arrivesOn: localOn(window.from, tz),
            arrivesAt: localAt(window.from, tz),
            departsOn: localOn(window.to, tz),
            departsAt: localAt(window.to, tz),
          }
        : {}),
    });
    return id;
  };

  /** The person answers for themselves — which is what makes `confirmed` a fact. */
  const accept = async (
    attendeeId: string,
    user: (typeof people)[number],
    show: typeof automate,
    window: { from: Date; to: Date },
  ) => {
    const tz = show.timezone;
    await respondToInvitation(actorFor(user), attendeeId, 'confirmed', {
      arrivesOn: localOn(window.from, tz),
      arrivesAt: localAt(window.from, tz),
      departsOn: localOn(window.to, tz),
      departsAt: localAt(window.to, tz),
    });
  };

  const automateWindows = {
    shelley: { from: at(50, 11), to: at(55, 19) },
    priya: { from: at(51, 14), to: at(55, 18) },
    tomas: { from: at(51, 16), to: at(53, 8) },
    reese: { from: at(52, 13), to: at(55, 20) },
  };

  const aShelley = await invite(automate, shelley, 'Show lead');
  await accept(aShelley, shelley, automate, automateWindows.shelley);
  const aPriya = await invite(automate, priya, 'Technical demos');
  await accept(aPriya, priya, automate, automateWindows.priya);
  const aTomas = await invite(automate, tomas, 'Technical demos');
  await accept(aTomas, tomas, automate, automateWindows.tomas);
  // Reese lands at 1pm on the first show day — after the morning shift they are
  // rostered on starts. A roster count calls that shift full; `coverage.ts` does
  // not, and the difference is the whole argument of step 12.
  const aReese = await invite(automate, reese, 'Booth staff');
  await accept(aReese, reese, automate, automateWindows.reese);
  // Ingrid never answers. She stays `invited` — pencilled in, and counted by
  // nothing, which is why she is also on a shift below.
  await invite(automate, ingrid, 'Executive', { from: at(52, 8), to: at(53, 19) });

  const mShelley = await invite(medtech, shelley, 'Show lead');
  await accept(mShelley, shelley, medtech, { from: at(117, 12), to: at(120, 18) });
  await invite(medtech, priya, 'Technical demos');

  // Sensors Converge overlaps Automate. Tomas leaves Detroit before it starts,
  // so he is not double-booked and must not be flagged. Priya has no travel
  // window here at all, so the model can only compare show dates and says so.
  const sTomas = await invite(sensors, tomas, 'Technical demos');
  await accept(sTomas, tomas, sensors, { from: at(53, 15), to: at(56, 18) });
  const sPriya = await invite(sensors, priya, 'Technical demos');
  await respondToInvitation(actorFor(priya), sPriya, 'confirmed', {});

  console.log('\u00b7 booth shifts and coverage');
  const shiftAt = async (show: typeof automate, from: Date, to: Date, targetStaff: number) => {
    const tz = show.timezone;
    const { id } = await addShift(admin, show.id, {
      startsOn: localOn(from, tz),
      startsAt: localAt(from, tz),
      endsOn: localOn(to, tz),
      endsAt: localAt(to, tz),
      targetStaff,
    });
    return id;
  };

  const shifts = [
    await shiftAt(automate, at(52, 9), at(52, 13), 3),
    await shiftAt(automate, at(52, 13), at(52, 17), 3),
    await shiftAt(automate, at(53, 9), at(53, 13), 2),
    await shiftAt(automate, at(53, 13), at(53, 17), 2),
  ];

  for (const [shiftId, userId] of [
    // Three assigned against a target of three — and one of them (Ingrid) never
    // accepted the invitation, so the shift reads as full and is not.
    [shifts[0], priya.id],
    [shifts[0], reese.id],
    [shifts[0], ingrid.id],
    [shifts[1], tomas.id],
    [shifts[1], shelley.id],
    [shifts[2], priya.id],
    // Tomas flies to Santa Clara on the morning of day 53; this assignment is a
    // hole the roster hides.
    [shifts[2], tomas.id],
    [shifts[3], reese.id],
    [shifts[3], shelley.id],
  ] as const) {
    await assignToShift(admin, shiftId, userId);
  }

  console.log('\u00b7 lodging (its room block cutoff derives a deadline)');
  const { id: hotelId } = await addLodging(admin, automate.id, {
    hotelName: 'Detroit Foundation Hotel',
    address: '250 W Larned St, Detroit, MI 48226',
    phone: '+1-313-800-5500',
    confirmationCode: 'NWR-4471902',
    checkInOn: localOn(at(50, 15), DTW),
    checkInAt: localAt(at(50, 15), DTW),
    checkOutOn: localOn(at(55, 11), DTW),
    checkOutAt: localAt(at(55, 11), DTW),
    nightlyRate: '289.00',
    roomBlockCutoffOn: localOn(at(22, 17), DTW),
    roomBlockCutoffAt: localAt(at(22, 17), DTW),
    costCenterId: mkt.id,
  });
  for (const u of [shelley, priya, tomas, reese]) {
    await assignRoom(admin, hotelId, u.id);
  }

  const { id: sensorsHotelId } = await addLodging(admin, sensors.id, {
    hotelName: 'Hyatt Regency Santa Clara',
    address: '5101 Great America Pkwy, Santa Clara, CA 95054',
    confirmationCode: 'NWR-5518844',
    checkInOn: localOn(at(53, 15), SJC),
    checkInAt: localAt(at(53, 15), SJC),
    checkOutOn: localOn(at(56, 11), SJC),
    checkOutAt: localAt(at(56, 11), SJC),
    nightlyRate: '312.00',
    // Already past. The derived deadline lands in the engine's past tense —
    // "missed", to the show runners, not "at risk" to nobody.
    roomBlockCutoffOn: localOn(at(-4, 17), SJC),
    roomBlockCutoffAt: localAt(at(-4, 17), SJC),
    costCenterId: se.id,
  });
  await assignRoom(admin, sensorsHotelId, tomas.id);

  console.log('\u00b7 side events and guest lists');
  const { id: dinnerId } = await addSideEvent(admin, automate.id, {
    name: 'Customer & prospect dinner',
    kind: 'dinner',
    location: 'Prime + Proper, Detroit',
    startsOn: localOn(at(52, 19), DTW),
    startsAt: localAt(at(52, 19), DTW),
    endsOn: localOn(at(52, 22), DTW),
    endsAt: localAt(at(52, 22), DTW),
    capacity: 18,
    budget: '4500.00',
    hostId: ingrid.id,
    costCenterId: exec.id,
  });
  for (const rsvp of [
    { userId: ingrid.id, status: 'accepted' },
    { userId: shelley.id, status: 'accepted' },
    { guestName: 'Alicia Ferrer', guestCompany: 'Grantham Automotive', status: 'accepted' },
    { guestName: 'Ken Ogawa', guestCompany: 'Lakeside Packaging', status: 'invited' },
  ] as const) {
    await addRsvp(admin, dinnerId, rsvp);
  }

  // A demo that overlaps the afternoon booth shift Tomas is on: the everyday
  // double-booking, made by two people who were each looking at one screen.
  const { id: demoId } = await addSideEvent(admin, automate.id, {
    name: 'Partner integration demo',
    kind: 'demo',
    location: 'Huntington Place, room 251',
    startsOn: localOn(at(52, 15), DTW),
    startsAt: localAt(at(52, 15), DTW),
    endsOn: localOn(at(52, 16), DTW),
    endsAt: localAt(at(52, 16), DTW),
    hostId: priya.id,
    costCenterId: se.id,
  });
  await addRsvp(admin, demoId, { userId: tomas.id, status: 'accepted' });

  console.log('· assets & collateral');
  const assetRows = await db
    .insert(s.assets)
    .values([
      { orgId: org.id, name: '20x20 island booth', kind: 'booth', assetTag: 'NWR-BOOTH-01', condition: 'good', storageLocation: 'Warehouse A, Bay 3', purchaseValueCents: 8_400_000, weightLb: '1240.00', dimensions: "20' x 20' x 12'" },
      { orgId: org.id, name: '10x20 inline booth', kind: 'booth', assetTag: 'NWR-BOOTH-02', condition: 'good', storageLocation: 'Warehouse A, Bay 4', purchaseValueCents: 3_100_000, weightLb: '620.00' },
      { orgId: org.id, name: 'Demo robot arm (RX-7)', kind: 'display', assetTag: 'NWR-DEMO-11', condition: 'good', storageLocation: 'Lab 2', purchaseValueCents: 4_200_000, weightLb: '180.00' },
      { orgId: org.id, name: '85" touchscreen + stand', kind: 'av_equipment', assetTag: 'NWR-AV-04', condition: 'needs_repair', storageLocation: 'Warehouse A, Bay 1', purchaseValueCents: 620_000, weightLb: '210.00' },
    ])
    .returning();
  await db.insert(s.assetReservations).values([
    { assetId: assetRows[0].id, showId: automate.id, reservedFrom: at(40), reservedTo: at(60) },
    { assetId: assetRows[2].id, showId: automate.id, reservedFrom: at(40), reservedTo: at(60) },
    { assetId: assetRows[1].id, showId: medtech.id, reservedFrom: at(108), reservedTo: at(125) },
  ]);
  await db.insert(s.collateralItems).values([
    { orgId: org.id, name: 'Platform overview datasheet', sku: 'DS-PLAT-01', quantityOnHand: 640, lowStockThreshold: 250, unitCostCents: 85 },
    { orgId: org.id, name: 'Case study booklet', sku: 'CS-BOOK-02', quantityOnHand: 180, lowStockThreshold: 200, unitCostCents: 310 },
    { orgId: org.id, name: 'Branded water bottle', sku: 'SWAG-BTL-01', quantityOnHand: 95, lowStockThreshold: 150, unitCostCents: 640 },
  ]);

  console.log('· flights (manually entered — nothing here came from a provider)');
  // My Itinerary needs something to show, and a manually recorded flight is a real
  // product state: `bookingProvider` is null, so nothing downstream can mistake
  // these for anything the agent bought. Times are airport-local; see
  // src/lib/datetime/zoned.ts.
  await db.insert(s.flights).values([
    {
      showId: automate.id,
      userId: priya.id,
      airlineCode: 'DL',
      airlineName: 'Delta Air Lines',
      flightNumber: '2218',
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      scheduledDeparture: at(51, 7),
      scheduledArrival: at(51, 15),
      seat: '14A',
      cabin: 'economy',
      priceCents: 48_600,
      costCenterId: se.id,
      bookingReference: 'JHQ4M2',
    },
    {
      showId: automate.id,
      userId: priya.id,
      airlineCode: 'DL',
      airlineName: 'Delta Air Lines',
      flightNumber: '1141',
      originAirport: 'DTW',
      destinationAirport: 'SFO',
      scheduledDeparture: at(55, 18),
      scheduledArrival: at(55, 21),
      seat: '22A',
      cabin: 'economy',
      priceCents: 48_600,
      costCenterId: se.id,
      bookingReference: 'JHQ4M2',
    },
    {
      showId: automate.id,
      userId: shelley.id,
      airlineCode: 'AA',
      airlineName: 'American Airlines',
      flightNumber: '318',
      originAirport: 'SFO',
      destinationAirport: 'DTW',
      scheduledDeparture: at(50, 6),
      scheduledArrival: at(50, 14),
      seat: '8C',
      cabin: 'economy',
      priceCents: 52_100,
      costCenterId: mkt.id,
      bookingReference: 'RB80KP',
    },
  ]);

  console.log('· expenses');
  await db.insert(s.expenses).values([
    { showId: automate.id, category: 'Booth space', description: '20x20 island, Automate 2026', amountCents: 5_600_000, paid: true, costCenterId: mkt.id, incurredOn: at(-40) },
    { showId: automate.id, category: 'Booth services', description: 'Electrical, carpet, rigging (estimate)', amountCents: 1_040_000, paid: false, costCenterId: mkt.id },
    { showId: automate.id, category: 'Collateral', description: 'Datasheet + case study reprint', amountCents: 184_000, paid: false, costCenterId: mkt.id },
    { showId: medtech.id, category: 'Booth space', description: '10x20 inline, MedTech Summit', amountCents: 2_300_000, paid: true, costCenterId: mkt.id, incurredOn: at(-6) },
  ]);

  console.log('· ticket credits (SCOPE.md §5b)');
  // All four sit with Tomas, deliberately. One road-warrior engineer holding a
  // pile of forfeited credits is the §5b story in one person, and it keeps every
  // other scenario's traveler with an empty pool — credit-first escalates a
  // request that would otherwise auto-book, so a credit on the demo traveler
  // would quietly change what the other scenarios are demonstrating.
  //
  // Each credit is a different answer to "why was this not spent?", which is the
  // question §5b exists to answer.
  const creditRows = await db
    .insert(s.ticketCredits)
    .values([
      {
        // Redeemable here: the id matches the airline credit on the holdable
        // fixture offer, so the agent can actually put it against a purchase.
        orgId: org.id,
        userId: tomas.id,
        providerCreditId: 'acr_00009htYpSCXrwaB9DnCr1',
        airlineCode: 'AA',
        recordLocator: 'QK7ZP2',
        ticketNumber: '0012345678901',
        originalValueCents: 18_400,
        remainingValueCents: 18_400,
        currency: 'USD',
        issuedOn: at(-120),
        expiresOn: at(240),
        status: 'available',
        costCenterId: mkt.id,
        notes: 'MedTech Summit trip cancelled when the booth slipped a quarter.',
      },
      {
        // Redeemable elsewhere: real money, no provider id. The agent must
        // surface it and refuse to pretend it applied.
        orgId: org.id,
        userId: tomas.id,
        airlineCode: 'DL',
        recordLocator: 'HV93QQ',
        originalValueCents: 61_200,
        remainingValueCents: 61_200,
        currency: 'USD',
        issuedOn: at(-200),
        expiresOn: at(21),
        status: 'available',
        costCenterId: mkt.id,
        notes: 'Booked directly with Delta before this system existed.',
      },
      {
        // Part-spent, and close enough to expiry to trip an alert bucket. The
        // old code only looked at `available` and would have missed this one
        // entirely — a partly-used credit is still money.
        orgId: org.id,
        userId: tomas.id,
        airlineCode: 'UA',
        recordLocator: 'RR41MB',
        originalValueCents: 44_000,
        remainingValueCents: 12_750,
        currency: 'USD',
        issuedOn: at(-300),
        expiresOn: at(11),
        status: 'partially_used',
        costCenterId: mkt.id,
      },
      {
        // Already dead. The sweep writes it off so the forfeited total — the
        // number that justifies this whole feature — has something real in it.
        orgId: org.id,
        userId: tomas.id,
        airlineCode: 'AS',
        originalValueCents: 27_300,
        remainingValueCents: 27_300,
        currency: 'USD',
        issuedOn: at(-420),
        expiresOn: at(-3),
        status: 'available',
        transferable: true,
        costCenterId: se.id,
        notes: 'Nobody was watching the clock. Exactly the loss §5b is about.',
      },
    ])
    .returning();

  // The balance is a projection of the ledger, so every seeded credit needs the
  // entries that produced it. Seeding a balance with no entries would leave the
  // reconciler right to call the whole pool corrupt.
  await db.insert(s.ticketCreditEntries).values(
    creditRows.flatMap((c) => {
      const issued = {
        creditId: c.id,
        orgId: org.id,
        kind: 'issued' as const,
        deltaCents: c.originalValueCents,
        balanceAfterCents: c.originalValueCents,
        currency: c.currency,
        costCenterId: c.costCenterId,
        actorKind: 'agent',
        reason: `Issued by ${c.airlineCode} for a cancelled non-refundable ticket`,
        occurredAt: c.issuedOn,
      };
      if (c.remainingValueCents === c.originalValueCents) return [issued];
      return [
        issued,
        {
          ...issued,
          kind: 'applied' as const,
          deltaCents: c.remainingValueCents - c.originalValueCents,
          balanceAfterCents: c.remainingValueCents,
          reason: 'Applied to an earlier trip booked outside this system',
          occurredAt: at(-60),
        },
      ];
    }),
  );

  /**
   * Travel requests — produced by running the *real* agent, not written by hand.
   *
   * The screens step 9 added need requests in several states to be worth
   * looking at, and there was an obvious shortcut: insert `travel_requests`,
   * `offer_snapshots`, and `policy_evaluations` rows directly with plausible
   * numbers in them. That shortcut is the thing SCOPE.md's second non-negotiable
   * forbids. An offer snapshot is a *record of what a provider returned*; typing
   * one by hand fabricates a fare that no airline ever quoted and then files it
   * as evidence, in the one table the whole audit story rests on.
   *
   * So the seed submits real requests and runs the real agent against the
   * `recorded` provider — captured payloads replayed through the production
   * normalizer, stamped `provider: recorded` and `live: false`, and structurally
   * unable to spend money. Every snapshot, verdict, and timeline row below is
   * genuinely produced by the pipeline that will produce them in anger.
   *
   * The clocks are deliberate. The escalated request is run two hours in the
   * past so that its offer is already dead by the time anyone opens the
   * approvals queue — which is the case §6b is about, and the case a queue
   * seeded with fresh offers would never show anyone.
   */
  console.log('· travel requests (real agent runs against the recorded provider)');

  const agentDeps = (nowAt: Date): AgentDeps => ({
    db,
    provider: new RecordedFlightProvider({ now: () => nowAt }),
    now: () => nowAt,
    // Never true in the seed. Nothing here may reach a payment path.
    live: false,
  });

  // 1. Within policy, and therefore never seen by a human: the agent searched,
  //    judged, and booked it. Present so the list is not made entirely of
  //    exceptions — most requests should look like this one.
  {
    const d = agentDeps(now);
    const request = await submitTravelRequest(
      {
        travelerId: priya.id,
        showId: automate.id,
        originAirport: 'SFO',
        destinationAirport: 'DTW',
        earliestDeparture: at(24, 7),
        latestArrival: at(25, 18),
        returnEarliestDeparture: at(29, 16),
        returnLatestArrival: at(30, 23),
        idempotencyKey: 'seed:priya:automate:out',
        notes: 'Booth demo lead — needs to be on site for move-in.',
      },
      actorFor(priya),
      d,
    );
    await runAgent(request.id, d, actorFor(priya));
  }

  // 2. Over the auto-approve band, escalated, and *left waiting* — with its
  //    offer already expired. This is the row the approvals queue exists for:
  //    the price on screen is a ceiling, not a fare, and approving re-searches.
  {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const d = agentDeps(twoHoursAgo);
    const request = await submitTravelRequest(
      {
        travelerId: ingrid.id,
        originAirport: 'SFO',
        destinationAirport: 'LHR',
        earliestDeparture: at(45, 8),
        latestArrival: at(47, 20),
        idempotencyKey: 'seed:ingrid:lhr',
        notes: 'Partner summit in London — long-haul, expected to need sign-off.',
      },
      actorFor(marcus),
      d,
    );
    await runAgent(request.id, d, actorFor(marcus));
  }

  // 3. Nothing matched. Not an error state and not a dead end — the screen says
  //    which constraint to relax, and searching again from here is one click.
  {
    const d = agentDeps(now);
    const request = await submitTravelRequest(
      {
        travelerId: tomas.id,
        showId: packexpo.id,
        originAirport: 'MSP',
        destinationAirport: 'ORD',
        earliestDeparture: at(200, 6),
        latestArrival: at(200, 11),
        idempotencyKey: 'seed:tomas:packexpo',
        notes: 'Short hop — no recorded payload covers this route, so it finds nothing.',
      },
      actorFor(marcus),
      d,
    );
    await runAgent(request.id, d, actorFor(marcus));
  }

  console.log('· show outcomes (prior-year comparison basis)');
  await db.insert(s.showOutcomes).values({
    showId: medtech.id,
    impressions: 4200,
    boothWalkbys: 1350,
    pipelineSourcedCents: 41_000_000,
    pipelineInfluencedCents: 96_000_000,
    revenueForecastCents: 12_000_000,
    attributionWindowDays: 180,
  });

  // The alerts come out of the engine, not out of a list of rows typed here —
  // the same rule step 9 set for travel requests and step 10 for the checklist.
  // Hand-written alert rows would be evidence of notifications nobody was owed.
  console.log('· deadline alerts (real sweep over the register)');
  const swept = await sweepDeadlineAlerts(org.id, now, db);

  const counts = {
    users: people.length,
    deadlineAlerts: swept.written,
    shows: 5,
    costCenters: costCenters.length,
    policyLayers: 3,
    assets: assetRows.length,
    shifts: shifts.length,
    ticketCredits: creditRows.length,
    travelRequests: 3,
  };
  console.log('\n✓ seed complete', counts);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n✗ seed failed');
    console.error(err);
    process.exit(1);
  });
