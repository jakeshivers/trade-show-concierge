/**
 * Seed data — clearly seed data, and it lives only here.
 *
 * SCOPE.md non-negotiable #2: we never put invented data behind a real integration.
 * These are two realistic shows with a staffed team, so every later step has
 * something to develop against without any API keys. Nothing here implies a live
 * flight status or a real fare.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';
import type { Actor } from '../src/lib/auth/actor';
import { RecordedFlightProvider } from '../src/lib/integrations/flights/recorded/provider';
import { runAgent, submitTravelRequest, type AgentDeps } from '../src/lib/travel/agent';
import { applyTemplate, setTaskStatus } from '../src/lib/readiness/store';
import { setDeadlineStatus, sweepDeadlineAlerts } from '../src/lib/deadlines/store';
import { acknowledgeAlert } from '../src/lib/alerts/store';
import { connectMyChannel, deliverPending } from '../src/lib/notify/store';
import { runNightly } from '../src/lib/schedule/nightly';
import { ConsoleTransport } from '../src/lib/integrations/notify/console/provider';
import { syncFlightStatuses } from '../src/lib/flights/store';
import { RecordedStatusProvider } from '../src/lib/integrations/flightstatus/recorded/provider';
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
import { addShipment, syncShipmentTracking } from '../src/lib/shipping/store';
import {
  saveRateCard,
  setRateCardConfirmed,
  setShipmentHandling,
} from '../src/lib/drayage/store';
import { RecordedTrackingProvider } from '../src/lib/integrations/shipping/recorded/provider';
import { ask } from '../src/lib/assistant/store';
import {
  allocateCollateral,
  checkInAsset,
  checkOutAsset,
  createAsset,
  createCollateralItem,
  issueAllocation,
  recordMovement,
  reserveAsset,
  sweepAssetAlerts,
} from '../src/lib/assets/store';
import { ScriptedAssistantModel } from '../src/lib/integrations/llm/scripted/provider';
import {
  captureLead,
  commitImport,
  createIntakeKey,
  intakeLead,
  recordMeeting,
  resolveIntakeKey,
  sweepLeadAlerts,
} from '../src/lib/leads/store';
import { inferMapping, parseCsv, planImport } from '../src/lib/leads/parse';
import { addTarget } from '../src/lib/dayof/store';
import { sweepRoiAlerts, syncCrm } from '../src/lib/roi/store';
import { RecordedCrmProvider } from '../src/lib/integrations/crm/recorded/provider';

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
  /**
   * One statement, and it has to be `TRUNCATE … CASCADE` rather than a delete.
   *
   * This used to be `db.delete(s.organizations)` under a comment claiming "orgs
   * cascade to everything". Every one of the ~50 tables really is reachable from
   * `organizations`, so the *intent* was right and the mechanism was not: three
   * foreign keys are `onDelete: 'restrict'` on purpose — `lodgings` and
   * `side_events` protect their cost center (§4's rule: a financial row's cost
   * center must not vanish underneath it) and `approvals` protects its approver.
   * `RESTRICT` is checked **immediately, per row**, while the order Postgres
   * processes sibling cascade constraints in is unspecified. So a delete that
   * reached `cost_centers` before it reached `shows` was refused by a lodging
   * that was itself about to be deleted a moment later — a real failure, on
   * correct data, from an ordering nothing declares.
   *
   * `TRUNCATE … CASCADE` truncates every table that transitively references this
   * one instead of firing per-row referential actions, so it is order-free and,
   * more importantly, **cannot rot**: the next `restrict` FK somebody adds for a
   * good reason does not silently break the seed the way these three did.
   *
   * Why it survived twenty steps: `pnpm db:reset` deletes the whole `.pglite`
   * directory first, so in the only path anybody runs this statement was a no-op
   * against an empty database. `pnpm db:seed` on its own — the documented way to
   * reseed without losing the schema — was broken the whole time, and the
   * command that hid it is the one the docs recommend.
   */
  await db.execute(sql`TRUNCATE TABLE ${s.organizations} CASCADE`);

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
  const [automate, medtech, packexpo, sensors, dmwest, automate2025, roboticsSummit, medtech2025] =
    await db
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
        // A show that is happening *now* — move-in was this morning.
        //
        // The seed had no such show, and that turned out to be load-bearing
        // rather than cosmetic: every other show is fifty days out, so no crate
        // on this calendar has plausibly shipped, and a shipping feature seeded
        // against it would have had an empty event timeline on every row. The
        // recorded provider is right to return no scans for freight that has not
        // left; what was missing was somewhere for freight to be.
        orgId: org.id,
        name: 'Design & Manufacturing West 2026',
        status: 'live',
        venueName: 'Anaheim Convention Center',
        city: 'Anaheim',
        region: 'CA',
        country: 'US',
        airportCode: 'SNA',
        timezone: 'America/Los_Angeles',
        startsOn: at(1, 9),
        endsOn: at(3, 16),
        moveInAt: at(0, 8),
        moveOutAt: at(3, 18),
        boothNumber: '2209',
        boothSize: '10x20',
        budgetCents: 4_100_000,
        goals: 'West-coast manufacturing buyers; 50 qualified leads.',
      },
      {
        // Last year's Detroit show, already over. It exists because step 14's
        // sharpest alert has no row behind it: freight went out to a show that
        // has moved out, and nothing is recorded coming back. That cannot be
        // demonstrated on a calendar where every show is still in the future,
        // and it is the failure that surfaces a quarter late — which is to say,
        // exactly now, on this row.
        orgId: org.id,
        name: 'Automate 2025',
        status: 'complete',
        venueName: 'Huntington Place',
        city: 'Detroit',
        region: 'MI',
        country: 'US',
        airportCode: 'DTW',
        timezone: 'America/Detroit',
        startsOn: at(-48, 9),
        endsOn: at(-45, 16),
        moveInAt: at(-50, 8),
        moveOutAt: at(-45, 17),
        boothNumber: '4102',
        boothSize: '20x20',
        budgetCents: 13_900_000,
        goals: 'Prior year. Kept as the clone source and the comparison basis.',
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
      {
        // Fourteen months ago, and it exists for the same kind of reason step 14
        // grew the calendar a live show: the seed had nowhere for the feature to
        // happen.
        //
        // §8e says a show's ROI is not final for 6-12 months, and step 19
        // enforces that rather than printing it — a show inside the maturity
        // horizon reports its figures and withholds its verdict. Every show on
        // the calendar before this one was in the future or closed six weeks
        // ago, so *every* verdict was correctly withheld and the ROI dashboard
        // could not be shown working at all. That is not a seeding
        // inconvenience; it is the finding. A product whose third north-star job
        // takes a year to answer needs at least one show old enough to have
        // answered it, or nobody can tell the refusals from a bug.
        //
        // It is also the only show here with a *complete* cost: every §8a line
        // carries a figure and nothing structural is absent, which is what makes
        // it the one show whose pipeline multiple is quotable. Every other show
        // on this calendar is a floor, and a floor withholds the multiple.
        orgId: org.id,
        name: 'MedTech Summit 2025',
        status: 'complete',
        venueName: 'Minneapolis Convention Center',
        city: 'Minneapolis',
        region: 'MN',
        country: 'US',
        airportCode: 'MSP',
        timezone: 'America/Chicago',
        startsOn: at(-402, 9),
        endsOn: at(-400, 15),
        moveInAt: at(-403, 10),
        moveOutAt: at(-400, 18),
        boothNumber: '844',
        boothSize: '10x20',
        budgetCents: 5_900_000,
        goals: 'Prior year. The only show on this calendar old enough to have an ROI.',
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
  const MSP = medtech.timezone;
  const SNA = dmwest.timezone;

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
  // Marcus is the *secondhand* case: he told Shelley in a corridor that he is
  // coming, and Shelley recorded it. The row reads `confirmed` and
  // `responded_at` is null, because only the subject's own answer stamps it —
  // so coverage does not count him and says why. Recorded through the admin
  // actor deliberately: this is what the "Record Marcus's answer" control on
  // the team tab writes, and seeding it by hand would file an answer the
  // pipeline never produced.
  const aMarcus = await invite(automate, marcus, 'Booth staff', {
    from: at(51, 9),
    to: at(55, 17),
  });
  await respondToInvitation(admin, aMarcus, 'confirmed', {
    arrivesOn: localOn(at(51, 9), DTW),
    arrivesAt: localAt(at(51, 9), DTW),
    departsOn: localOn(at(55, 17), DTW),
    departsAt: localAt(at(55, 17), DTW),
  });

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
    // Three against a target of three, and the third is Marcus — `confirmed`,
    // but by Shelley rather than by Marcus. A roster count calls this shift
    // full; coverage calls it overstated and names him.
    [shifts[1], marcus.id],
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

  console.log('· assets & collateral (through the real stores — nothing typed)');
  // Everything below runs through `src/lib/assets/store.ts`, the rule step 9 set
  // for travel requests and step 12 for the roster. Two properties come out of
  // that rather than being arranged: the ledger under `quantity_on_hand` is
  // written by the same `recordMovement` a form calls, and the condition on
  // `85" touchscreen` is the *return* condition from a real check-in rather than
  // a column somebody typed `needs_repair` into.
  const asset = async (draft: Parameters<typeof createAsset>[1]) => createAsset(admin, draft);

  const islandBooth = await asset({
    name: '20x20 island booth',
    kind: 'booth',
    assetTag: 'NWR-BOOTH-01',
    condition: 'good',
    storageLocation: 'Warehouse A, Bay 3',
    purchaseValue: '84000',
    costCenterId: mkt.id,
    weightLb: '1240.00',
    dimensions: "20' x 20' x 12'",
  });
  const inlineBooth = await asset({
    name: '10x20 inline booth',
    kind: 'booth',
    assetTag: 'NWR-BOOTH-02',
    condition: 'good',
    storageLocation: 'Warehouse A, Bay 4',
    purchaseValue: '31000',
    costCenterId: mkt.id,
    weightLb: '620.00',
  });
  const demoArm = await asset({
    name: 'Demo robot arm (RX-7)',
    kind: 'display',
    assetTag: 'NWR-DEMO-11',
    condition: 'good',
    storageLocation: 'Lab 2',
    purchaseValue: '42000',
    costCenterId: se.id,
    weightLb: '180.00',
  });
  const touchscreen = await asset({
    name: '85" touchscreen + stand',
    kind: 'av_equipment',
    assetTag: 'NWR-AV-04',
    condition: 'good',
    storageLocation: 'Warehouse A, Bay 1',
    purchaseValue: '6200',
    costCenterId: se.id,
    weightLb: '210.00',
  });
  const truss = await asset({
    name: 'Rigging & lighting truss',
    kind: 'other',
    assetTag: 'NWR-TRUSS-02',
    condition: 'good',
    storageLocation: 'Warehouse A, Bay 6',
    purchaseValue: '18000',
    costCenterId: mkt.id,
    weightLb: '480.00',
  });

  const reserve = async (
    show: typeof automate,
    assetId: string,
    fromDay: number,
    toDay: number,
  ) => {
    const tz = show.timezone ?? 'UTC';
    return reserveAsset(admin, show.id, {
      assetId,
      reservedFromDate: localOn(at(fromDay, 8), tz),
      reservedFromTime: '08:00',
      reservedToDate: localOn(at(toDay, 17), tz),
      reservedToTime: '17:00',
    });
  };

  // 1. The one the schema comment has been about since step 1. The island booth
  //    went to Detroit last spring, was signed out, and nothing was ever checked
  //    back in — $84,000 of capital that no screen in the product could see was
  //    gone, and that is reserved again for Automate in seven weeks.
  const lostBooth = await reserve(automate2025, islandBooth.id, -53, -42);
  await checkOutAsset(actorFor(marcus), lostBooth.id, at(-53, 7));
  await reserve(automate, islandBooth.id, 30, 62);

  // 2. A certain clash. Automate and Sensors Converge overlap — the pair step 12
  //    added so the *people* conflict case would be live — and one robot arm
  //    cannot be in Detroit and San Jose in the same fortnight.
  await reserve(automate, demoArm.id, 30, 60);
  await reserve(sensors, demoArm.id, 34, 62);

  // 3. A possible one. The truss comes home from Anaheim on the 6th and is due
  //    out again on the 8th: 48 hours to cross the country, be opened, be looked
  //    at and be re-crated. Fine if both shows share a floor; not otherwise.
  const trussWest = await reserve(dmwest, truss.id, -18, 6);
  await reserve(sensors, truss.id, 8, 60);
  void trussWest;

  // 4. A future claim invalidated by a past fact. The touchscreen goes to
  //    Automate in seven weeks, and it comes back from Detroit with a cracked
  //    panel — recorded by a real check-in, so `condition_on_checkout` and
  //    `condition_on_return` disagree and the delta is a fact rather than a guess.
  const screenLastYear = await reserve(automate2025, touchscreen.id, -53, -44);
  await checkOutAsset(actorFor(reese), screenLastYear.id, at(-53, 7));
  await checkInAsset(
    actorFor(reese),
    screenLastYear.id,
    {
      conditionOnReturn: 'needs_repair',
      conditionOnCheckout: 'good',
      note: 'Panel cracked in the top-left corner — happened somewhere between the booth and the crate; nobody saw it.',
    },
    at(-41, 15),
  );
  await reserve(automate, touchscreen.id, 30, 62);

  // 5. Reserved for a show that came and went, and never signed out. Either the
  //    inline booth stayed in the warehouse while Detroit ran, or somebody took
  //    it and did not say. The row looks identical either way.
  await reserve(automate2025, inlineBooth.id, -53, -44);
  // 6. And the one where assets meet freight. MedTech's booth crate has to be at
  //    the advance warehouse on the 104th day; the reservation opens on the
  //    110th. For six days the booth is on a truck and the register says it is
  //    on a shelf — which is exactly the window another show could claim it in.
  await reserve(medtech, inlineBooth.id, 110, 128);

  const item = async (draft: Parameters<typeof createCollateralItem>[1], received: number) => {
    const row = await createCollateralItem(admin, draft);
    await recordMovement(
      admin,
      row.id,
      { kind: 'received', quantity: String(received), reason: 'Opening stock count' },
      { now: at(-70) },
    );
    return row;
  };

  const datasheet = await item(
    {
      name: 'Platform overview datasheet',
      sku: 'DS-PLAT-01',
      lowStockThreshold: '250',
      unitCost: '0.85',
      costCenterId: mkt.id,
      storageLocation: 'Warehouse A, Rack 1',
    },
    900,
  );
  const booklet = await item(
    {
      name: 'Case study booklet',
      sku: 'CS-BOOK-02',
      lowStockThreshold: '200',
      unitCost: '3.10',
      costCenterId: mkt.id,
      storageLocation: 'Warehouse A, Rack 1',
    },
    180,
  );
  const bottle = await item(
    {
      name: 'Branded water bottle',
      sku: 'SWAG-BTL-01',
      lowStockThreshold: '150',
      unitCost: '6.40',
      costCenterId: mkt.id,
      storageLocation: 'Warehouse A, Rack 4',
    },
    95,
  );

  // The correction, live: 650 datasheets on the shelf reads fine on every screen
  // in every product of this kind, and 250 of them are actually free.
  await allocateCollateral(admin, automate.id, { itemId: datasheet.id, quantity: '400' });
  const westDatasheets = await allocateCollateral(admin, dmwest.id, {
    itemId: datasheet.id,
    quantity: '250',
  });
  await issueAllocation(actorFor(reese), westDatasheets.id, at(-6, 9));

  // Promised more than we hold. Nothing about `quantity_on_hand` says so.
  await allocateCollateral(admin, automate.id, { itemId: booklet.id, quantity: '220' });

  // Went to Detroit last spring in a crate and nobody has counted it back. Not
  // the same as "none came back", which for swag would be the ordinary result.
  const detroitBottles = await allocateCollateral(admin, automate2025.id, {
    itemId: bottle.id,
    quantity: '60',
  });
  await issueAllocation(actorFor(marcus), detroitBottles.id, at(-53, 9));

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
      originTimeZone: 'America/Los_Angeles',
      destinationTimeZone: 'America/Detroit',
      legDirection: 'to_show',
      scheduledDeparture: at(49, 7),
      scheduledArrival: at(49, 15),
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
      originTimeZone: 'America/Detroit',
      destinationTimeZone: 'America/Los_Angeles',
      legDirection: 'from_show',
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
      originTimeZone: 'America/Los_Angeles',
      destinationTimeZone: 'America/Detroit',
      legDirection: 'to_show',
      // A red-eye landing six hours before move-in: legal under the 4h buffer,
      // with two hours to spare. That two hours is what makes this the flight
      // worth putting on the board — a delay of any size eats it.
      scheduledDeparture: at(49, 20),
      scheduledArrival: at(50, 2),
      seat: '8C',
      cabin: 'economy',
      priceCents: 52_100,
      costCenterId: mkt.id,
      bookingReference: 'RB80KP',
    },
  ]);

  console.log('\u00b7 shipments (built through the real store, tracked by the real sweep)');
  // The four cases §5g argues about, one crate each — and the fifth case, which
  // has no crate at all.
  //
  // Consignment is the load-bearing field: the same delivery date means opposite
  // things at an advance warehouse (which holds freight for weeks and closes on
  // a published date) and at show-site receiving (whose dock does not open until
  // move-in). Both are here so the screen has to show the difference.
  await addShipment(
    admin,
    automate.id,
    {
      description: 'Booth crate 1 of 2 — 20x20 island',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'fedex',
      // The advance warehouse closes a fortnight before move-in. Defaulting this
      // to move-in would be wrong by two weeks in the expensive direction and
      // would look right on every screen — `edit.ts` refuses to guess it.
      mustArriveOn: localOn(at(36, 16), DTW),
      mustArriveAt: localAt(at(36, 16), DTW),
      trackingNumber: '772091144821',
      ownerId: marcus.id,
      pieces: '2',
      weightLb: '1240.00',
      declaredValue: '84000.00',
      cost: '2180.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // The carrier will call this on time. Show-site receiving will not: the dock
  // opens with move-in, and this is expected before it. Every status column in
  // every payload says success.
  await addShipment(
    admin,
    automate.id,
    {
      description: 'Literature & giveaways',
      direction: 'outbound',
      consignment: 'show_site',
      carrier: 'ups',
      receivingOpensOn: localOn(at(50, 8), DTW),
      receivingOpensAt: localAt(at(50, 8), DTW),
      mustArriveOn: localOn(at(50, 18), DTW),
      mustArriveAt: localAt(at(50, 18), DTW),
      trackingNumber: '1Z8W4A710390442117',
      ownerId: priya.id,
      pieces: '6',
      weightLb: '310.00',
      cost: '640.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // Deliberately unowned, and deliberately the one that goes quiet. An alert
  // addressed to an owner would reach nobody here, which is why unownedness
  // escalates rather than mutes. §5a's third correction, from a fourth direction.
  await addShipment(
    admin,
    sensors.id,
    {
      description: 'Booth crate — 10x10 inline',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'ups',
      mustArriveOn: localOn(at(40, 16), SJC),
      mustArriveAt: localAt(at(40, 16), SJC),
      trackingNumber: '1Z8W4A710390998812',
      pieces: '1',
      weightLb: '620.00',
      cost: '1420.00',
      costCenterId: se.id,
    },
    now,
    db,
  );

  // Months out and behaving. The quiet row is not filler: an engine that has
  // nothing to say about most of the board is the property being demonstrated.
  await addShipment(
    admin,
    medtech.id,
    {
      description: 'Booth crate — 10x20 inline',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'fedex',
      mustArriveOn: localOn(at(104, 16), MSP),
      mustArriveAt: localAt(at(104, 16), MSP),
      trackingNumber: '772091277315',
      ownerId: marcus.id,
      pieces: '3',
      weightLb: '740.00',
      cost: '1960.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // The show that is on right now, which is where freight can actually be in
  // motion. Both crates below have real scan histories because their transit
  // windows are in the past — the recorded provider projects a shape onto the
  // window and hands back only the scans that have already happened.
  //
  // This one is the distinction the carrier's own data cannot express: it was
  // delivered, on time, to the dock — and nobody has said it reached the booth.
  // Every status column on this row reads success while the booth may be empty.
  await addShipment(
    admin,
    dmwest.id,
    {
      description: 'Booth crate — 10x20 inline',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'fedex',
      mustArriveOn: localOn(at(-12, 16), SNA),
      mustArriveAt: localAt(at(-12, 16), SNA),
      trackingNumber: '772044819903',
      ownerId: marcus.id,
      pieces: '3',
      weightLb: '640.00',
      cost: '1180.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // And this one missed the dock outright: consigned to show-site receiving,
  // which opened and closed with move-in this morning.
  await addShipment(
    admin,
    dmwest.id,
    {
      description: 'Demo unit & spares',
      direction: 'outbound',
      consignment: 'show_site',
      carrier: 'ups',
      receivingOpensOn: localOn(at(0, 8), SNA),
      receivingOpensAt: localAt(at(0, 8), SNA),
      mustArriveOn: localOn(at(0, 18), SNA),
      mustArriveAt: localAt(at(0, 18), SNA),
      trackingNumber: '1Z8W4A710391556604',
      ownerId: priya.id,
      pieces: '2',
      weightLb: '190.00',
      cost: '520.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // The case with no status field behind it. This crate is inside its deadline
  // on the carrier's own account — it is still promising delivery a day early —
  // and there has not been a scan since Saturday. Nothing in the payload says
  // anything is wrong, which is exactly why the silence has to be what raises it.
  await addShipment(
    admin,
    dmwest.id,
    {
      description: 'Carpet, furniture & AV rigging',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'ups',
      mustArriveOn: localOn(at(2, 16), SNA),
      mustArriveAt: localAt(at(2, 16), SNA),
      trackingNumber: '1Z8W4A710391772039',
      ownerId: marcus.id,
      pieces: '4',
      weightLb: '880.00',
      cost: '1340.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

  // Last year's show. Freight went out; nothing is recorded coming back. This
  // crate is here so the *absence* of its return leg is a row the engine can
  // find — the one alert in the product with no shipment behind it.
  await addShipment(
    admin,
    automate2025.id,
    {
      description: 'Booth crate 1 of 2 — 20x20 island',
      direction: 'outbound',
      consignment: 'advance_warehouse',
      carrier: 'fedex',
      mustArriveOn: localOn(at(-64, 16), DTW),
      mustArriveAt: localAt(at(-64, 16), DTW),
      trackingNumber: '772088410277',
      ownerId: marcus.id,
      pieces: '2',
      weightLb: '1240.00',
      cost: '2090.00',
      costCenterId: mkt.id,
    },
    now,
    db,
  );

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

  // Flight status comes out of the real sweep against the `recorded` provider,
  // for the same reason the travel requests come out of the real agent: a row
  // reading `delayed` that nobody's status provider ever produced is a delay no
  // carrier ever reported, filed as evidence in the table the board rests on.
  // The recorded provider picks a scenario per flight number, deterministically,
  // so the seeded board covers a clean leg, a re-timing and a disruption.
  console.log('· flight status (real sweep against the recorded provider)');
  // Which recorded payload each leg replays is pinned, so the board tells one
  // story instead of whatever the hash spelled: the tight red-eye loses its
  // buffer, the roomy morning flight is fine, and the flight *home* is late and
  // deliberately silent — the case that proves the engine is not just reporting
  // delays. Everything else on the board, including the leg the agent bought,
  // draws from the provider's own cycle.
  const flightSync = await syncFlightStatuses(
    org.id,
    new RecordedStatusProvider({
      AA318: 'delayed_into_buffer',
      DL2218: 'on_time',
      DL1141: 'minor_delay',
    }),
    now,
    db,
  );

  // Scans and shipment alerts come out of the real sweep against the `recorded`
  // provider, for the reason the travel requests come out of the real agent: a
  // hand-written `shipment_events` row is a carrier scan no carrier ever made,
  // filed as evidence in the timeline the whole feature rests on. Which recorded
  // payload each crate replays is pinned so the board tells one story — the
  // advance-warehouse crate slips past its cutoff, the show-site crate is
  // "on time" and will be refused at a shut dock, and the unowned one goes quiet.
  console.log('· shipment tracking (real sweep against the recorded provider)');
  const shipmentSync = await syncShipmentTracking(
    org.id,
    new RecordedTrackingProvider({
      // Automate is fifty days out: these two have labels and have not moved,
      // which is what the board should say about them.
      '772091144821': 'on_time',
      '1Z8W4A710390442117': 'on_time',
      // Fifty days out and not yet handed to anybody, so this pin never fires:
      // the provider returns a pre-transit tracker with no scans, which is the
      // truthful answer for freight that has not left.
      '1Z8W4A710390998812': 'on_time',
      '772091277315': 'on_time',
      // The live show, where freight is actually somewhere.
      '772044819903': 'delivered',
      '1Z8W4A710391556604': 'late',
      '1Z8W4A710391772039': 'stalled',
    }),
    now,
    db,
  );

  // The assistant's transcripts come out of the real loop, against the real
  // tools, as the real actor — the same rule as everything above, and here it
  // buys something specific. A hand-written transcript is prose about a
  // workspace, and prose about a workspace is the one kind of seed row that is
  // *indistinguishable from the product being wrong*: it would sit on screen
  // under the app's byline making claims no query produced. So these two run
  // through `ask()` with the scripted model, which plans tool calls and asserts
  // nothing, and every figure in them came out of a store this run.
  //
  // Two conversations rather than one, and they are the demonstration: Priya is
  // a member and Shelley an admin, they ask the *same* question, and the tool
  // results differ. Nothing about the prompt differs. That difference is the
  // access model, and it is in the queries.
  // After the shipments, deliberately: `freightCoverage` reads the freight rows
  // to decide whether a reservation window covers the trip, and a sweep that ran
  // before them would return `unverified` on every row and quietly prove nothing.
  // Drayage. After the shipments, necessarily: the estimate is a function of the
  // crates, and a card written before them would price nothing.
  //
  // Three states, because the argument is about which figures may be printed:
  // Automate has a **confirmed** card, so its estimate is a figure; the live show
  // has one nobody has checked against this year's manual, so its estimate is
  // introduced as coming from an unchecked card; and Sensors Converge has real
  // freight and **no card at all**, which is the case that must never render as
  // $0 — the largest cost on the show, reported as free.
  console.log('· drayage rate cards (through the real store, and one show left without one)');
  await saveRateCard(
    admin,
    automate.id,
    {
      contractor: 'Freeman',
      advanceCwt: '142.00',
      showSiteCwt: '175.00',
      minimumLb: '200',
      // Read off the manual rather than assumed. Getting this wrong is a 100%
      // error in whichever direction the assumption ran.
      basis: 'round_trip',
      specialHandlingPct: '30',
      overtimePct: '25',
      sourceNote: 'Exhibitor services manual, section 7 — material handling rates',
    },
    now,
    db,
  );
  await setRateCardConfirmed(admin, automate.id, true, now, db);

  await saveRateCard(
    admin,
    dmwest.id,
    {
      contractor: 'GES',
      advanceCwt: '128.50',
      showSiteCwt: '161.00',
      minimumLb: '200',
      basis: 'round_trip',
      // The card is silent on special handling, which is not the same as saying
      // there is no surcharge — so an uncrated crate here is a named gap rather
      // than a crate billed at par.
      specialHandlingPct: null,
      overtimePct: '25',
    },
    now,
    db,
  );

  // How a crate is packed is a fact only somebody standing next to it holds, so
  // it is recorded by the people who packed them rather than by whoever set the
  // rates — and most crates stay `unknown`, which is the honest standing of a
  // workspace where nobody has been asked yet.
  const automateFreight = await db
    .select({ id: s.shipments.id, description: s.shipments.description })
    .from(s.shipments)
    .where(eq(s.shipments.showId, automate.id));
  for (const crate of automateFreight) {
    if (crate.description.includes('Booth crate')) {
      await setShipmentHandling(actorFor(marcus), crate.id, 'crated', now, db);
    }
    // Six cartons of literature on a skid is exactly the freight a contractor
    // surcharges, and exactly the freight everybody forgets to declare.
    if (crate.description.includes('Literature')) {
      await setShipmentHandling(actorFor(priya), crate.id, 'uncrated', now, db);
    }
  }

  console.log('· asset alerts (produced by running the real sweep)');
  const assetSweep = await sweepAssetAlerts(org.id, now);
  console.log(`  ${assetSweep.planned.length} planned · ${assetSweep.alertsWritten} written`);

  console.log('· assistant conversations (real loop, scripted model, real tools)');
  const scriptedModel = new ScriptedAssistantModel();
  await ask({
    actor: actorFor(priya),
    model: scriptedModel,
    question: 'Am I flying anywhere? What is my itinerary?',
    now,
    db,
  });
  await ask({
    actor: admin,
    model: scriptedModel,
    question: 'Which crates are we worried about?',
    now,
    db,
  });

  // The feed's two states that only a *second* run can produce, produced by
  // running things a second time rather than by writing rows that look like it.
  //
  console.log('\u00b7 leads & meetings (real capture, a real CSV through the real parser)');
  // The live show is where capture is *happening*, so it is where §8c's failure
  // lives: some of the booth captures, some does not, and the count is honest
  // about which. dmwest needs a roster for that to be measurable at all —
  // coverage counts people rostered on booth shifts, and 0 of 0 would read as
  // perfect rather than as unknown.
  const dmShifts = [
    await shiftAt(dmwest, at(1, 9), at(1, 13), 3),
    await shiftAt(dmwest, at(1, 13), at(1, 17), 3),
  ];
  const dmRoster = [priya, tomas, reese, ingrid] as const;
  for (const person of dmRoster) {
    const invited = await invite(dmwest, person, 'Booth staff', { from: at(0, 12), to: at(3, 19) });
    await accept(invited, person, dmwest, { from: at(0, 12), to: at(3, 19) });
  }
  for (const [shiftId, userId] of [
    [dmShifts[0], priya.id],
    [dmShifts[0], tomas.id],
    [dmShifts[0], reese.id],
    [dmShifts[1], priya.id],
    [dmShifts[1], ingrid.id],
  ] as const) {
    await assignToShift(admin, shiftId, userId);
  }

  // Priya captures at the booth, with the notice she actually reads out. Tomás
  // captures one and stops. Reese and Ingrid record nothing at all — which is
  // the ordinary case §8c describes, and the reason the count says "at least".
  const boothNotice = 'Told at the booth: we will follow up about the products discussed.';
  const captured = [
    { by: priya, name: 'Dana Whitfield', email: 'dana.whitfield@lakeside-mfg.test', company: 'Lakeside Manufacturing', title: 'VP Operations', basis: 'consent', interests: ['Palletizing', 'Vision'] },
    { by: priya, name: 'Hector Balint', email: 'h.balint@corvid-packaging.test', company: 'Corvid Packaging', title: 'Automation Engineer', basis: 'consent', interests: ['Cobots'] },
    { by: priya, name: 'Su-Min Ha', email: 'sumin.ha@fairweather.test', company: 'Fairweather Foods', title: 'Plant Manager', basis: 'legitimate_interest', interests: ['Palletizing'] },
    { by: tomas, name: 'Ollie Vance', email: 'ovance@brightpath-labs.test', company: 'Brightpath Labs', title: 'Director, Engineering', basis: 'legitimate_interest', interests: ['Vision'] },
    // The `possible` case, and the only one a person has to settle: same name,
    // same company, captured by two people an hour apart, with no email on the
    // second to make it certain. The machine admits it deliberately — two people
    // really can share a name — and the tab asks somebody who was there.
    { by: tomas, name: 'Dana Whitfield', email: null, company: 'Lakeside Manufacturing', title: 'VP Ops', basis: 'legitimate_interest', interests: ['Cobots'] },
  ] as const;
  // Staggered through this morning rather than all at `now`. Two captures
  // sharing a timestamp make "first, and again" a claim the data cannot support,
  // and the possible-duplicate pair below is exactly where that shows.
  for (const [i, c] of captured.entries()) {
    const capturedAt = new Date(now.getTime() - (captured.length - i) * 3_600_000);
    await captureLead(
      actorFor(c.by),
      dmwest.id,
      {
        fullName: c.name,
        email: c.email ?? null,
        phone: null,
        company: c.company,
        title: c.title,
        notes: null,
        interests: [...c.interests],
        externalRef: null,
        basis: c.basis,
        consentNotice: c.basis === 'consent' ? boothNotice : null,
      },
      capturedAt,
      db,
    );
  }

  // Who this show is for — the list the day-of screen warns against, built
  // through the real store so the must-meet reason rule is actually enforced
  // rather than typed around.
  //
  // The shape is the finding rather than the rows. Lakeside Manufacturing is
  // *met*, and it is met because Priya captured Dana Whitfield an hour ago —
  // there is no `met_at` column and nothing ticked a box, so erasing that lead
  // would take the claim with it. Corvid Packaging is met under a different
  // spelling ("Corvid Packaging Inc." on the badge), which is the only thing
  // `normalizeCompany` is for. Vance Group is a must-meet nobody has spoken to
  // and nobody owns, which is the escalation case. And Brightpath is a target
  // whose lead exists but was captured by somebody else, so the alert on the
  // floor is "already spoken to" rather than "go and find them".
  for (const t of [
    {
      companyName: 'Lakeside Manufacturing',
      aliases: ['Lakeside Mfg'],
      priority: 'must_meet' as const,
      reason: 'Renewal is up in Q1 and their VP Ops is on the floor Tuesday only.',
      ownerId: marcus.id,
    },
    {
      companyName: 'Corvid Packaging Inc.',
      aliases: [],
      priority: 'target' as const,
      reason: 'Evaluating cobots against two competitors.',
      ownerId: priya.id,
    },
    {
      companyName: 'Vance Group',
      aliases: ['Vance Group Holdings'],
      priority: 'must_meet' as const,
      reason: 'Largest unclosed opportunity in the region. Nobody has met them in person.',
      // Deliberately unowned: an alert addressed to an owner who does not exist
      // reaches nobody, and this is the row most likely to be walked past.
      ownerId: null,
    },
    {
      companyName: 'Brightpath Labs',
      aliases: [],
      priority: 'watch' as const,
      reason: null,
      ownerId: null,
    },
  ]) {
    await addTarget(admin, dmwest.id, t, now, db);
  }

  // A badge scanner, through the REST endpoint's own code path — key issued,
  // resolved, and used. Seeding these as plain inserts would file leads the
  // intake path never accepted, which is the same objection as hand-writing an
  // offer snapshot.
  const scannerKey = await createIntakeKey(
    admin,
    { label: 'Anaheim booth scanner', showId: dmwest.id },
    now,
    db,
  );
  const resolved = await resolveIntakeKey(scannerKey.token, db);
  if (!('principal' in resolved)) throw new Error('seeded intake key did not resolve');
  const scans = [
    { ref: 'DMW-88214', name: 'Marguerite Adeyemi', email: 'm.adeyemi@northstar-tool.test', company: 'Northstar Tool' },
    { ref: 'DMW-88301', name: 'Ivan Pokorny', email: 'ipokorny@delta-fab.test', company: 'Delta Fabrication' },
    // Sent twice, the way a scanner on convention-centre wifi does. The second
    // is answered as a duplicate rather than as an error, and writes nothing.
    { ref: 'DMW-88301', name: 'Ivan Pokorny', email: 'ipokorny@delta-fab.test', company: 'Delta Fabrication' },
  ];
  let scanned = 0;
  let retried = 0;
  for (const scan of scans) {
    const outcome = await intakeLead(
      resolved.principal,
      {
        showId: dmwest.id,
        input: {
          fullName: scan.name,
          email: scan.email,
          phone: null,
          company: scan.company,
          title: null,
          notes: null,
          interests: null,
          externalRef: scan.ref,
          // The scanner vendor collected consent at their kiosk, or did not, and
          // says nothing about it. `unknown` is what honesty looks like here.
          basis: null,
          consentNotice: null,
        },
      },
      now,
      db,
    );
    if (outcome.kind === 'created') scanned += 1;
    if (outcome.kind === 'duplicate') retried += 1;
  }

  // Last year's show had a roster, and that is what makes its lead story
  // legible: with nobody rostered, coverage can only say "unknown", which is
  // true and says nothing. With three people on the booth and every lead
  // arriving later in a vendor's CSV, the count reads "at least 5 leads, from 0
  // of 3 people on the booth" — which is §8c's finding stated as a number.
  const a25Shifts = [
    await shiftAt(automate2025, at(-47, 9), at(-47, 13), 3),
    await shiftAt(automate2025, at(-47, 13), at(-47, 17), 3),
  ];
  for (const person of [shelley, priya, tomas] as const) {
    const invited = await invite(automate2025, person, 'Booth staff', {
      from: at(-50, 12),
      to: at(-45, 19),
    });
    await accept(invited, person, automate2025, { from: at(-50, 12), to: at(-45, 19) });
  }
  for (const [shiftId, userId] of [
    [a25Shifts[0], shelley.id],
    [a25Shifts[0], priya.id],
    [a25Shifts[0], tomas.id],
    [a25Shifts[1], priya.id],
    [a25Shifts[1], tomas.id],
  ] as const) {
    await assignToShift(admin, shiftId, userId);
  }

  // Sweep *before* the import, so the sharpest alert in this feature is a row
  // somebody actually raised rather than a sentence in a comment: a show that
  // ran, was staffed, and recorded nothing at all. It is then resolved by the
  // import below — the same way a crate arriving resolves a stall, and the only
  // demonstration in the seed of step 17's resolution on the sixth engine.
  const preImportSweep = await sweepLeadAlerts(org.id, now, db);

  // Imported from the scanner vendor's CSV after the fact —
  // through the real parser and the real planner, so the rejected rows and the
  // duplicate are the ones `planImport` actually found rather than numbers typed
  // into the batch record.
  const csv = [
    'Attendee Name,Email,Company,Job Title,Badge ID,Notes',
    'Perry Nakashima,pnakashima@ridgeline-auto.test,Ridgeline Automotive,Manufacturing Engineer,A25-1188,Wants the palletizer datasheet',
    '"Okonkwo, Ada",ada.okonkwo@sable-industries.test,Sable Industries,Head of Ops,A25-1201,"Asked about lead times, twice"',
    'Bettina Krause,bkrause@havenworks.test,Havenworks,Controls Lead,A25-1244,',
    ',orphan@nowhere.test,Unknown,,A25-1250,Badge scanned with no name attached',
    'Perry Nakashima,pnakashima@ridgeline-auto.test,Ridgeline Automotive,Manufacturing Engineer,A25-1188,Second scan on day two',
    'Yusuf Demir,ydemir@kestrel-controls.test,Kestrel Controls,Buyer,A25-1290,',
    'Marguerite Adeyemi,m.adeyemi@northstar-tool.test,Northstar Tool,Procurement,A25-1301,Met at the demo bar',
  ].join('\n');
  const csvRows = parseCsv(csv);
  const csvMapping = inferMapping(csvRows[0]);
  const csvPlan = planImport(csvRows, csvMapping);
  const imported = await commitImport(
    admin,
    {
      showId: automate2025.id,
      plan: csvPlan,
      mapping: csvMapping,
      filename: 'automate-2025-scans.csv',
      now: at(-44, 10),
    },
    db,
  );

  // Somebody set a 90-day retention on last year's scans and nothing has ever
  // enforced it. That is the whole reason `retention_overdue` is `critical` from
  // the first night: a documented commitment being documented-ly broken, and it
  // becomes visible only because something finally reads the column.
  const stale = await db
    .select({ id: s.leads.id })
    .from(s.leads)
    .where(eq(s.leads.showId, automate2025.id))
    .limit(2);
  for (const row of stale) {
    await db
      .update(s.leads)
      .set({ deleteAfter: at(-4, 12) })
      .where(eq(s.leads.id, row.id));
  }

  // Meetings: one held, one still booked, and one nobody turned up to — the
  // third is the state a simpler model loses, and it must not sit in the count
  // of meetings held.
  await recordMeeting(
    actorFor(priya),
    dmwest.id,
    {
      subject: 'Lakeside Manufacturing — palletizer line walkthrough',
      company: 'Lakeside Manufacturing',
      isExistingCustomer: false,
      scheduledAt: at(1, 11),
      occurredAt: at(1, 11),
      noShowAt: null,
      leadId: null,
      ownerId: priya.id,
      notes: 'Wants a quote against a 14-week install window.',
    },
    now,
    db,
  );
  await recordMeeting(
    actorFor(shelley),
    dmwest.id,
    {
      subject: 'Corvid Packaging — commercial follow-up',
      company: 'Corvid Packaging',
      isExistingCustomer: true,
      scheduledAt: at(2, 15),
      occurredAt: null,
      noShowAt: null,
      leadId: null,
      ownerId: shelley.id,
      notes: null,
    },
    now,
    db,
  );
  await recordMeeting(
    actorFor(tomas),
    dmwest.id,
    {
      subject: 'Brightpath Labs — vision demo',
      company: 'Brightpath Labs',
      isExistingCustomer: false,
      scheduledAt: at(1, 14),
      occurredAt: null,
      noShowAt: at(1, 15),
      leadId: null,
      ownerId: tomas.id,
      notes: 'Nobody came. Rebooked for the follow-up call.',
    },
    now,
    db,
  );

  // ---------------------------------------------------------------------------
  // MedTech Summit 2025 — the only show on this calendar with an ROI.
  //
  // Everything below exists to make one row of `/roi` mean something: a
  // *complete* cost (every §8a line carries a figure, so the multiple is
  // quotable rather than withheld), leads captured with a real lawful basis (so
  // they can lawfully be matched to a CRM), and one buyer we also met again at
  // Automate 2025 — which is what makes cross-show first touch a fact in this
  // workspace rather than an assertion in a test.
  // ---------------------------------------------------------------------------
  console.log('\u00b7 MedTech Summit 2025 (the only show old enough to have an ROI)');
  const m25Window = { from: at(-403, 12), to: at(-400, 19) };
  for (const person of [shelley, priya, tomas] as const) {
    const invited = await invite(medtech2025, person, 'Booth staff', m25Window);
    await accept(invited, person, medtech2025, m25Window);
  }
  const m25Shifts = [
    await shiftAt(medtech2025, at(-402, 9), at(-402, 13), 3),
    await shiftAt(medtech2025, at(-402, 13), at(-402, 17), 3),
  ];
  for (const [shiftId, userId] of [
    [m25Shifts[0], shelley.id],
    [m25Shifts[0], priya.id],
    [m25Shifts[0], tomas.id],
    [m25Shifts[1], shelley.id],
    [m25Shifts[1], priya.id],
    [m25Shifts[1], tomas.id],
  ] as const) {
    await assignToShift(admin, shiftId, userId);
  }

  // A complete cost, line by line. `space`, `services` and `collateral` are
  // expenses; `travel` comes from recorded flights and `lodging` from the hotel
  // rows below. There are no shipments, which is why shipping is silent without
  // being *missing* — `assessCoverage` only expects a line a show has rows for.
  await db.insert(s.expenses).values([
    { showId: medtech2025.id, category: 'Booth space', description: '10x20 inline, MedTech Summit 2025', amountCents: 2_180_000, paid: true, costCenterId: mkt.id, incurredOn: at(-470) },
    { showId: medtech2025.id, category: 'Booth services', description: 'Electrical, carpet, AV', amountCents: 612_000, paid: true, costCenterId: mkt.id, incurredOn: at(-404) },
    { showId: medtech2025.id, category: 'Collateral', description: 'Regulated-market brochure run', amountCents: 96_000, paid: true, costCenterId: mkt.id, incurredOn: at(-420) },
  ]);
  // One reservation per person, so no room-block assumption is made on our
  // behalf — a lodging row is one reservation (§8a refusal 4) and a block
  // recorded once with three guests would be an undercount the rollup has to
  // name rather than fix.
  for (const [person, code] of [
    [shelley, 'NWR-2211004'],
    [priya, 'NWR-2211005'],
    [tomas, 'NWR-2211006'],
  ] as const) {
    const { id } = await addLodging(admin, medtech2025.id, {
      hotelName: 'Hilton Minneapolis',
      address: '1001 Marquette Ave S, Minneapolis, MN 55403',
      confirmationCode: code,
      checkInOn: localOn(at(-403, 15), MSP),
      checkInAt: localAt(at(-403, 15), MSP),
      checkOutOn: localOn(at(-400, 11), MSP),
      checkOutAt: localAt(at(-400, 11), MSP),
      nightlyRate: '241.00',
      costCenterId: mkt.id,
    });
    await assignRoom(admin, id, person.id);
  }
  await db.insert(s.flights).values(
    [shelley, priya, tomas].flatMap((person) => [
      {
        showId: medtech2025.id,
        userId: person.id,
        airlineCode: 'DL',
        airlineName: 'Delta Air Lines',
        flightNumber: '1602',
        originAirport: 'SFO',
        destinationAirport: 'MSP',
        originTimeZone: 'America/Los_Angeles',
        destinationTimeZone: 'America/Chicago',
        legDirection: 'to_show' as const,
        scheduledDeparture: at(-403, 8),
        scheduledArrival: at(-403, 14),
        cabin: 'economy',
        priceCents: 41_200,
        costCenterId: mkt.id,
      },
      {
        showId: medtech2025.id,
        userId: person.id,
        airlineCode: 'DL',
        airlineName: 'Delta Air Lines',
        flightNumber: '1877',
        originAirport: 'MSP',
        destinationAirport: 'SFO',
        originTimeZone: 'America/Chicago',
        destinationTimeZone: 'America/Los_Angeles',
        legDirection: 'from_show' as const,
        scheduledDeparture: at(-400, 19),
        scheduledArrival: at(-400, 21),
        cabin: 'economy',
        priceCents: 41_200,
        costCenterId: mkt.id,
      },
    ]),
  );

  // Captured with a recorded basis and a written notice, which is what makes
  // them lawfully matchable at all. Contrast the badge-scanner rows on the live
  // show, every one of which carries `unknown` and is therefore withheld from
  // the CRM forever — that contrast is the entire §5j-meets-§8b argument, and it
  // is visible on the ROI screen as a number rather than as a policy.
  const m25Notice = 'Told at the booth: we will follow up about the products discussed.';
  const m25Leads = [
    { by: priya, name: 'Renata Oyelaran', email: 'r.oyelaran@meridian-medical.test', company: 'Meridian Medical', title: 'Director, Quality' },
    { by: priya, name: 'Callum Fitzhugh', email: 'cfitzhugh@atlas-biotech.test', company: 'Atlas Biotech', title: 'VP Manufacturing' },
    { by: shelley, name: 'Ingeborg Alvarsson', email: 'i.alvarsson@nordwall-devices.test', company: 'Nordwall Devices', title: 'Head of Ops' },
    { by: tomas, name: 'Ruben Castellanos', email: 'rcastellanos@caldera-labs.test', company: 'Caldera Labs', title: 'Automation Lead' },
    // Met here first, and met *again* at Automate 2025 fourteen months later
    // (below). The whole reason this person is in the seed: an opportunity that
    // opened off this conversation belongs to this show, and a model that
    // credited the most recent show would hand it to Automate every year,
    // silently and flatteringly. `roi/attribution.ts` refusal 1, as a row rather
    // than as a test.
    { by: tomas, name: 'Wilhelmina Boateng', email: 'w.boateng@stellar-surgical.test', company: 'Stellar Surgical', title: 'Procurement' },
    { by: shelley, name: 'Perry Nakashima', email: 'pnakashima@ridgeline-auto.test', company: 'Ridgeline Automotive', title: 'Manufacturing Engineer' },
  ] as const;
  for (const [i, c] of m25Leads.entries()) {
    await captureLead(
      actorFor(c.by),
      medtech2025.id,
      {
        fullName: c.name,
        email: c.email,
        phone: null,
        company: c.company,
        title: c.title,
        notes: null,
        interests: null,
        externalRef: null,
        basis: 'consent',
        consentNotice: m25Notice,
      },
      new Date(at(-402, 10).getTime() + i * 45 * 60_000),
      db,
    );
  }
  // The second meeting with the same buyer, fourteen months later, at a
  // different show — captured at the booth with a real basis, so it links to the
  // same CRM contact. Automate 2025 therefore reads `influenced` on that
  // opportunity and MedTech 2025 keeps the `sourced` credit, because the deal
  // already existed by the time Automate met them. Two refusals demonstrated by
  // one row.
  await captureLead(
    actorFor(priya),
    automate2025.id,
    {
      fullName: 'Wilhelmina Boateng',
      email: 'w.boateng@stellar-surgical.test',
      phone: null,
      company: 'Stellar Surgical',
      title: 'Director, Procurement',
      notes: 'Second conversation — was at MedTech last year.',
      interests: null,
      externalRef: null,
      basis: 'consent',
      consentNotice: m25Notice,
    },
    at(-46, 11),
    db,
  );

  for (const [subject, company] of [
    ['Meridian Medical — validation walkthrough', 'Meridian Medical'],
    ['Atlas Biotech — line integration scoping', 'Atlas Biotech'],
  ] as const) {
    await recordMeeting(
      actorFor(priya),
      medtech2025.id,
      {
        subject,
        company,
        isExistingCustomer: false,
        scheduledAt: at(-402, 11),
        occurredAt: at(-402, 11),
        noShowAt: null,
        leadId: null,
        ownerId: priya.id,
        notes: null,
      },
      now,
      db,
    );
  }

  console.log('· lead alerts (produced by running the real sweep, twice)');
  const leadSweep = await sweepLeadAlerts(org.id, now, db);
  console.log(
    `  before the import: ${preImportSweep.planned.length} condition(s), ${preImportSweep.raised} raised`,
  );
  console.log(
    `  after it: ${leadSweep.planned.length} condition(s), ${leadSweep.raised} raised, ` +
      `${leadSweep.resolved} resolved \u00b7 csv: ${csvPlan.accepted.length} accepted, ` +
      `${csvPlan.rejected.length} rejected, ${csvPlan.duplicates.length} duplicate`,
  );

  // Resolution is the half of step 17 that nothing else in the seed demonstrates:
  // an alert ends because a sweep stops planning it, not because anybody clears
  // it. So somebody orders the carpet, the register no longer has anything to
  // say about that deadline, and the row it left behind is closed by the next
  // sweep — which is exactly what a crate arriving or a delay recovering does.
  // The CRM half comes out of the real sync against the `recorded` provider, for
  // the reason step 9 set for travel requests and step 13 for flight status:
  // hand-written `crm_opportunities` rows would be pipeline no CRM ever
  // reported, filed as evidence in the table the whole ROI story rests on.
  //
  // Two things this run demonstrates that no test can. Seven of eighteen leads
  // are **withheld** — every badge-scanner row carries `unknown` consent, so
  // nothing about those people is sent anywhere, ever. And the replay writes no
  // attribution back, because there is no CRM on the other end of it to write to.
  console.log('\u00b7 crm sync (real sync, recorded provider, no key)');
  const capturedFirstAt = new Map<string, Date>();
  for (const row of await db
    .select({ email: s.leads.email, capturedAt: s.leads.capturedAt })
    .from(s.leads)) {
    if (!row.email) continue;
    const seen = capturedFirstAt.get(row.email);
    if (!seen || row.capturedAt < seen) capturedFirstAt.set(row.email, row.capturedAt);
  }
  const crmSync = await syncCrm(
    admin,
    new RecordedCrmProvider(
      (email) => capturedFirstAt.get(email) ?? null,
      () => now,
    ),
    { replayed: true, writeAttribution: true, now },
    db,
  );
  const roiSweep = await sweepRoiAlerts(org.id, now, db);
  console.log(
    `  ${crmSync.matched} matched, ${crmSync.unmatched} unmatched, ${crmSync.withheld} withheld ` +
      `(no lawful basis) \u00b7 ${crmSync.opportunitiesRead} opportunit(ies) read \u00b7 ` +
      `${roiSweep.raised} ROI alert(s)`,
  );

  console.log('· one deadline gets done, and the alert it raised resolves itself');
  const carpet = await db.query.showDeadlines.findFirst({
    where: and(eq(s.showDeadlines.showId, automate.id), eq(s.showDeadlines.kind, 'furniture_carpet')),
  });
  if (carpet) {
    await setDeadlineStatus(
      actorFor(marcus),
      carpet.id,
      'complete',
      'Ordered through the advance rate portal.',
      now,
      db,
    );
  }
  const resweep = await sweepDeadlineAlerts(org.id, now, db);

  // And one alert somebody has read. Acknowledging is a person saying "I have
  // seen this" about their own row, so it is done as that person, through the
  // same call the screen makes — a row with `acknowledged_at` typed into it
  // would be hearsay in the one column that records that somebody looked.
  const mine = await db
    .select()
    .from(s.alerts)
    .where(and(eq(s.alerts.userId, marcus.id), isNull(s.alerts.resolvedAt)))
    .limit(1);
  if (mine[0]) await acknowledgeAlert(actorFor(marcus), mine[0].id, now, db);

  /* ------------------------------ notifications ----------------------------- */

  // Step 21. Two people connect a destination **through the real store**, and
  // the delivery pass runs for real — so the log holds rows a screen can be read
  // against rather than rows typed here.
  //
  // The transport is `console`, which composes every message from the real
  // alerts and delivers it to nobody. That is the honest state of this
  // workspace and the seed does not dress it up: every row it writes says
  // `rendered`, never `sent`, and `/settings/notifications` leads with the
  // sentence "nothing has ever left this workspace". A seeded `sent` would be
  // the one lie the whole feature exists to make impossible.
  //
  // Shelley is deliberately left unconnected, so the run reports somebody with
  // alerts worth carrying and nowhere to carry them — which is the state most
  // people in a real workspace are in on the first day, and the only one of the
  // log's five outcomes that is fixable by anybody.
  console.log('\n· notifications (real destinations, real delivery pass, nothing delivered)');
  const rendering = new ConsoleTransport();
  for (const person of [marcus, priya]) {
    await connectMyChannel(actorFor(person), { transport: rendering, now }, db);
  }
  const carried = await deliverPending(org.id, { transport: rendering, now }, db);
  console.log(
    `  ${carried.messages} message(s) composed for ${carried.people} people · ` +
      `${carried.rendered} rendered to nobody · ${carried.suppressed} suppressed · ` +
      `${carried.undeliverable} with nowhere to go`,
  );

  // Run it a second time, the way the seed runs the lead sweep twice. Nothing is
  // carried: a condition that held a moment ago and holds now is one alert row
  // whose `created_at` never moved, and the delivery rail is keyed on that.
  const again = await deliverPending(
    org.id,
    { transport: rendering, now: new Date(now.getTime() + 60_000) },
    db,
  );
  console.log(`  a second pass a minute later carried ${again.messages} — the rail holds`);

  // And one recorded run of the job itself, so `/alerts` has something true to
  // say about what runs the engines. `trigger: 'manual'` is the accurate answer
  // and the interesting one: the page then says "run by a person, not on a
  // schedule", which is precisely this workspace's situation until somebody
  // points a scheduler at `/api/cron/nightly`.
  //
  // Retention is skipped, and this is the second caller allowed to do that: the
  // sweep really erases, and a seed that destroyed the overdue leads it had just
  // created would leave `pnpm db:reset` with a worse demo than the one it built.
  // `pnpm leads --retention` is where that is exercised, on purpose.
  const nightly = await runNightly(
    org.id,
    { trigger: 'manual', now, transport: rendering, skipRetention: true },
    db,
  );
  console.log(`  one recorded run: ${nightly.ok ? 'finished' : nightly.error}`);

  const counts = {
    users: people.length,
    alertsResolved: resweep.resolved,
    deadlineAlerts: swept.written,
    flightsChecked: flightSync.checked,
    flightAlerts: flightSync.alertsWritten,
    shipmentScans: shipmentSync.scansAdded,
    shipmentAlerts: shipmentSync.alertsWritten,
    shows: 8,
    costCenters: costCenters.length,
    policyLayers: 3,
    assets: 5,
    shifts: shifts.length + dmShifts.length + a25Shifts.length,
    ticketCredits: creditRows.length,
    travelRequests: 3,
    assistantConversations: 2,
    leadsCaptured: captured.length,
    leadsScanned: scanned,
    leadScanRetries: retried,
    leadsImported: imported.written,
    leadAlerts: leadSweep.raised,
    crmMatched: crmSync.matched,
    crmWithheld: crmSync.withheld,
    crmOpportunities: crmSync.opportunitiesRead,
    roiAlerts: roiSweep.raised,
    leadAlertsResolved: leadSweep.resolved,
    notificationsComposed: carried.messages,
    notificationsDelivered: carried.sent,
    notificationsNowhereToGo: carried.undeliverable,
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
