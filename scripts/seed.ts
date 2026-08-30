/**
 * Seed data — clearly seed data, and it lives only here.
 *
 * SCOPE.md non-negotiable #2: we never put invented data behind a real integration.
 * These are two realistic shows with a staffed team, so every later step has
 * something to develop against without any API keys. Nothing here implies a live
 * flight status or a real fare.
 */
import { getDb } from '../src/db';
import * as s from '../src/db/schema';

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
        email: 'dana@northwindrobotics.test',
        fullName: 'Dana Whitfield',
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
  const [dana, marcus, priya, tomas, reese, ingrid] = people;

  console.log('· shows');
  const [automate, medtech] = await db
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
    ])
    .returning();

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
      ownerId: dana.id,
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
  ) => ({
    showId,
    title,
    category,
    status,
    assigneeId,
    dueOn: at(dueDays, 17),
    weight,
    sortOrder,
    completedAt: status === 'complete' ? at(-2, 12) : null,
  });

  await db.insert(s.showTasks).values([
    task(automate.id, 'Sign booth space contract', 'legal', 'complete', dana.id, -40, 3, 0),
    task(automate.id, 'Confirm booth design & graphics', 'booth', 'complete', reese.id, -14, 3, 1),
    task(automate.id, 'Order show services (electrical, carpet, AV)', 'booth', 'in_progress', marcus.id, 26, 3, 2),
    task(automate.id, 'Book staff travel', 'travel', 'in_progress', marcus.id, 30, 3, 3),
    task(automate.id, 'Reserve hotel room block', 'lodging', 'complete', marcus.id, -8, 2, 4),
    task(automate.id, 'Ship booth crate to advance warehouse', 'shipping', 'not_started', dana.id, 38, 3, 5),
    task(automate.id, 'Print new datasheets & case studies', 'collateral', 'in_progress', reese.id, 20, 2, 6),
    task(automate.id, 'Order branded swag', 'collateral', 'not_started', reese.id, 25, 1, 7),
    task(automate.id, 'Register booth staff badges', 'staffing', 'not_started', reese.id, 31, 2, 8),
    task(automate.id, 'Build booth shift schedule', 'staffing', 'not_started', marcus.id, 35, 2, 9),
    task(automate.id, 'Schedule analyst briefings', 'marketing', 'blocked', ingrid.id, 30, 2, 10),
    task(automate.id, 'Pre-show email campaign to target accounts', 'marketing', 'not_started', reese.id, 21, 2, 11),
    task(automate.id, 'Book customer dinner venue', 'marketing', 'in_progress', ingrid.id, 28, 1, 12),
    task(automate.id, 'Confirm lead capture app & licenses', 'follow_up', 'not_started', reese.id, 30, 3, 13),
    task(automate.id, 'Set post-show follow-up SLA with sales', 'follow_up', 'not_started', ingrid.id, 40, 2, 14),
    task(automate.id, 'Reconcile show budget', 'budget', 'not_started', dana.id, 60, 1, 15),
    task(medtech.id, 'Sign booth space contract', 'legal', 'complete', dana.id, -6, 3, 0),
    task(medtech.id, 'Confirm booth design & graphics', 'booth', 'not_started', reese.id, 80, 3, 1),
    task(medtech.id, 'Reserve hotel room block', 'lodging', 'not_started', marcus.id, 76, 2, 2),
    task(medtech.id, 'Order show services', 'booth', 'not_started', marcus.id, 92, 3, 3),
    task(medtech.id, 'Book staff travel', 'travel', 'not_started', marcus.id, 95, 3, 4),
  ]);

  console.log('· attendees');
  await db.insert(s.showAttendees).values([
    { showId: automate.id, userId: dana.id, role: 'Show lead', status: 'confirmed', arrivesOn: at(50, 11), departsOn: at(55, 19) },
    { showId: automate.id, userId: priya.id, role: 'Technical demos', status: 'confirmed', arrivesOn: at(51, 14), departsOn: at(55, 18) },
    { showId: automate.id, userId: tomas.id, role: 'Technical demos', status: 'confirmed', arrivesOn: at(51, 16), departsOn: at(55, 18) },
    { showId: automate.id, userId: reese.id, role: 'Booth staff', status: 'confirmed', arrivesOn: at(50, 13), departsOn: at(55, 20) },
    { showId: automate.id, userId: ingrid.id, role: 'Executive', status: 'invited', arrivesOn: at(52, 8), departsOn: at(53, 19) },
    { showId: medtech.id, userId: dana.id, role: 'Show lead', status: 'confirmed' },
    { showId: medtech.id, userId: priya.id, role: 'Technical demos', status: 'invited' },
  ]);

  console.log('· booth shifts');
  const shifts = await db
    .insert(s.boothShifts)
    .values([
      { showId: automate.id, startsAt: at(52, 9), endsAt: at(52, 13), targetStaff: 3 },
      { showId: automate.id, startsAt: at(52, 13), endsAt: at(52, 17), targetStaff: 3 },
      { showId: automate.id, startsAt: at(53, 9), endsAt: at(53, 13), targetStaff: 2 },
      { showId: automate.id, startsAt: at(53, 13), endsAt: at(53, 17), targetStaff: 2 },
    ])
    .returning();
  await db.insert(s.shiftAssignments).values([
    { shiftId: shifts[0].id, userId: priya.id },
    { shiftId: shifts[0].id, userId: reese.id },
    { shiftId: shifts[0].id, userId: ingrid.id },
    { shiftId: shifts[1].id, userId: tomas.id },
    { shiftId: shifts[1].id, userId: dana.id },
    { shiftId: shifts[2].id, userId: priya.id },
    { shiftId: shifts[2].id, userId: tomas.id },
    { shiftId: shifts[3].id, userId: reese.id },
    { shiftId: shifts[3].id, userId: dana.id },
  ]);

  console.log('· lodging');
  const [hotel] = await db
    .insert(s.lodgings)
    .values({
      showId: automate.id,
      hotelName: 'Detroit Foundation Hotel',
      address: '250 W Larned St, Detroit, MI 48226',
      phone: '+1-313-800-5500',
      confirmationCode: 'NWR-4471902',
      checkIn: at(50, 15),
      checkOut: at(55, 11),
      nightlyRateCents: 28_900,
      roomBlockCutoff: at(22, 17),
    })
    .returning();
  await db.insert(s.lodgingGuests).values([
    { lodgingId: hotel.id, userId: dana.id },
    { lodgingId: hotel.id, userId: priya.id },
    { lodgingId: hotel.id, userId: tomas.id },
    { lodgingId: hotel.id, userId: reese.id },
  ]);

  console.log('· side events');
  const [dinner] = await db
    .insert(s.sideEvents)
    .values({
      showId: automate.id,
      kind: 'dinner',
      name: 'Customer & prospect dinner',
      location: 'Prime + Proper, Detroit',
      startsAt: at(52, 19),
      endsAt: at(52, 22),
      capacity: 18,
      budgetCents: 450_000,
      hostId: ingrid.id,
    })
    .returning();
  await db.insert(s.sideEventRsvps).values([
    { sideEventId: dinner.id, userId: ingrid.id, status: 'accepted' },
    { sideEventId: dinner.id, userId: dana.id, status: 'accepted' },
    { sideEventId: dinner.id, guestName: 'Alicia Ferrer', guestCompany: 'Grantham Automotive', status: 'accepted' },
    { sideEventId: dinner.id, guestName: 'Ken Ogawa', guestCompany: 'Lakeside Packaging', status: 'invited' },
  ]);

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

  console.log('· expenses');
  await db.insert(s.expenses).values([
    { showId: automate.id, category: 'Booth space', description: '20x20 island, Automate 2026', amountCents: 5_600_000, paid: true, costCenterId: mkt.id, incurredOn: at(-40) },
    { showId: automate.id, category: 'Booth services', description: 'Electrical, carpet, rigging (estimate)', amountCents: 1_040_000, paid: false, costCenterId: mkt.id },
    { showId: automate.id, category: 'Collateral', description: 'Datasheet + case study reprint', amountCents: 184_000, paid: false, costCenterId: mkt.id },
    { showId: medtech.id, category: 'Booth space', description: '10x20 inline, MedTech Summit', amountCents: 2_300_000, paid: true, costCenterId: mkt.id, incurredOn: at(-6) },
  ]);

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

  const counts = {
    users: people.length,
    shows: 2,
    costCenters: costCenters.length,
    policyLayers: 3,
    assets: assetRows.length,
    shifts: shifts.length,
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
