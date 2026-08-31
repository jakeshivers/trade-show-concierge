import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  date,
  uuid,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/* ---------------------------------- enums --------------------------------- */

export const showStatusEnum = pgEnum('show_status', [
  'prospect',
  'committed',
  'planning',
  'ready',
  'live',
  'complete',
  'cancelled',
]);

/**
 * The intake transitions worth recording. `proposed` is the entry point, and
 * `cloned` is a proposal too — it just arrives pre-filled from a prior year.
 */
export const showDecisionEnum = pgEnum('show_decision', [
  'proposed',
  'cloned',
  'committed',
  'declined',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'not_started',
  'in_progress',
  'blocked',
  'complete',
  'skipped',
]);

export const taskCategoryEnum = pgEnum('task_category', [
  'booth',
  'collateral',
  'staffing',
  'travel',
  'lodging',
  'shipping',
  'marketing',
  'legal',
  'budget',
  'follow_up',
]);

export const attendeeStatusEnum = pgEnum('attendee_status', [
  'invited',
  'confirmed',
  'declined',
  'waitlist',
]);

export const flightStatusEnum = pgEnum('flight_status', [
  'scheduled',
  'active',
  'landed',
  'delayed',
  'diverted',
  'cancelled',
  'unknown',
]);

export const shipmentDirectionEnum = pgEnum('shipment_direction', [
  'outbound', // office -> show
  'return', // show -> office
]);

export const shipmentStatusEnum = pgEnum('shipment_status', [
  'draft',
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned',
  'cancelled',
]);

export const carrierEnum = pgEnum('carrier', ['ups', 'usps', 'fedex', 'dhl', 'other']);

/** Mirrors the state machine in SCOPE.md §6b. */
export const travelRequestStatusEnum = pgEnum('travel_request_status', [
  'draft',
  'submitted',
  'searching',
  'offers_found',
  'pending_approval',
  'approved',
  'rejected',
  'held',
  'booking',
  'ticketed',
  'no_options',
  'expired',
  'failed',
  'cancelled',
]);

export const policyDecisionEnum = pgEnum('policy_decision', [
  'auto_approve',
  'needs_approval',
  'deny',
]);

export const approvalOutcomeEnum = pgEnum('approval_outcome', [
  'approved',
  'rejected',
  'break_glass',
]);

export const userRoleEnum = pgEnum('user_role', ['member', 'travel_manager', 'admin']);

/** Where a rule set came from. Resolved most-specific-first. SCOPE.md §7. */
export const policyScopeEnum = pgEnum('policy_scope', ['org', 'cost_center', 'show', 'role']);

export const deadlineKindEnum = pgEnum('deadline_kind', [
  'advance_order',      // the big one: 25-40% surcharge after this date
  'electrical',
  'furniture_carpet',
  'av_rigging',
  'labor',
  'warehouse_cutoff',
  'direct_to_show',
  'booth_registration',
  'staff_registration',
  'room_block',
  'sponsorship_artwork',
  'other',
]);

export const assetKindEnum = pgEnum('asset_kind', [
  'booth',
  'display',
  'furniture',
  'av_equipment',
  'crate',
  'other',
]);

export const assetConditionEnum = pgEnum('asset_condition', [
  'good',
  'damaged',
  'needs_repair',
  'retired',
]);

export const creditStatusEnum = pgEnum('credit_status', [
  'available',
  'partially_used',
  'used',
  'expired',
  'refunded',
]);

/**
 * Every way a credit's balance can move. Signed deltas, never a set-to value —
 * a ledger you can only overwrite cannot answer "why is this $412 and not $600",
 * and a credit's balance is money. See `src/lib/travel/credits.ts`.
 */
export const creditEntryKindEnum = pgEnum('credit_entry_kind', [
  /** The credit came into existence, usually from a cancelled non-refundable ticket. */
  'issued',
  /** Drawn down against a purchase. */
  'applied',
  /** An application undone — the booking it paid for was cancelled or never happened. */
  'released',
  /** The carrier's clock ran out. The remaining value is gone and we say so. */
  'expired',
  /** The carrier gave the money back as money rather than as credit. */
  'refunded',
  /** A human correcting the ledger against a carrier statement, with a reason. */
  'adjusted',
]);

export const sideEventKindEnum = pgEnum('side_event_kind', [
  'dinner',
  'demo',
  'seminar',
  'reception',
  'meeting',
  'other',
]);

export const rsvpStatusEnum = pgEnum('rsvp_status', ['invited', 'accepted', 'declined', 'tentative']);

/* ------------------------------- tenancy/users ----------------------------- */

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkOrgId: text('clerk_org_id').unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Finance dimension carried by every row that represents money. Set at creation and
 * never inferred later — see SCOPE.md non-negotiable #6.
 */
export const costCenters = pgTable(
  'cost_centers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('cost_centers_org_code_idx').on(t.orgId, t.code)],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clerkUserId: text('clerk_user_id').unique(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    role: userRoleEnum('role').notNull().default('member'),
    // Default cost center for this user's travel; overridable per request.
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    title: text('title'),
    phone: text('phone'),
    avatarUrl: text('avatar_url'),
    // Known traveler / loyalty details reused when booking.
    knownTravelerNumber: text('known_traveler_number'),
    seatPreference: text('seat_preference'),
    /**
     * Passenger identity, required by the airline to issue a ticket — not by us.
     * Nullable because most of the app never needs it, and because a missing
     * date of birth must fail a live purchase loudly rather than be invented.
     * See `src/lib/travel/passengers.ts`.
     */
    bornOn: date('born_on'),
    gender: text('gender'),
    /** Mr / Ms / Mrs / Miss / Dr — the airline's `title`, not the job title above. */
    honorific: text('honorific'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('users_org_idx').on(t.orgId),
    uniqueIndex('users_org_email_idx').on(t.orgId, t.email),
  ],
);

/* ------------------------------ login methods ------------------------------ */

/**
 * How an org's permitted sign-in strategies are expressed.
 *
 * `unrestricted` is the default and means exactly that — any strategy Clerk has
 * enabled for the instance is acceptable. `allowlist` names the permitted ones;
 * anything else is a violation. There is deliberately no "denylist" mode: a
 * security control that fails open when a new strategy appears is not a control.
 */
export const loginPolicyModeEnum = pgEnum('login_policy_mode', ['unrestricted', 'allowlist']);

/**
 * Per-org control over permitted authentication strategies — "everyone signs in
 * with Okta, no passwords." SCOPE.md §3 calls this an enterprise security-review
 * blocker rather than a feature request.
 *
 * Versioned and append-only, like `travel_policies` and for the same reason: six
 * months later an auditor asks when the org went SSO-only and who decided it. A
 * row updated in place cannot answer that.
 *
 * The *primary* enforcement of this policy lives in Clerk, at sign-in. This table
 * is the org's recorded intent and the input to our second gate — see
 * `src/lib/auth/login-methods.ts` for what that gate can and cannot verify.
 */
export const orgLoginPolicies = pgTable(
  'org_login_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    mode: loginPolicyModeEnum('mode').notNull().default('unrestricted'),
    /** Our own strategy vocabulary; see LOGIN_STRATEGIES in lib/auth/login-methods.ts. */
    allowedStrategies: jsonb('allowed_strategies').$type<string[]>().notNull().default([]),
    /** Required in both directions — restricting and relaxing are both decisions. */
    reason: text('reason').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a newer version replaces this one; null means live. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('org_login_policies_version_idx').on(t.orgId, t.version),
    index('org_login_policies_live_idx').on(t.orgId, t.supersededAt),
  ],
);

/* ---------------------------------- shows ---------------------------------- */

export const shows = pgTable(
  'shows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: showStatusEnum('status').notNull().default('planning'),
    website: text('website'),

    venueName: text('venue_name'),
    venueAddress: text('venue_address'),
    city: text('city'),
    region: text('region'),
    country: text('country'),
    // Nearest commercial airport — drives flight search defaults.
    airportCode: text('airport_code'),
    timezone: text('timezone').notNull().default('UTC'),

    startsOn: timestamp('starts_on', { withTimezone: true }).notNull(),
    endsOn: timestamp('ends_on', { withTimezone: true }).notNull(),
    // Move-in / move-out bracket the show and gate shipping deadlines.
    moveInAt: timestamp('move_in_at', { withTimezone: true }),
    moveOutAt: timestamp('move_out_at', { withTimezone: true }),

    boothNumber: text('booth_number'),
    boothSize: text('booth_size'),
    budgetCents: integer('budget_cents'),
    goals: text('goals'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shows_org_starts_idx').on(t.orgId, t.startsOn)],
);

/**
 * Show intake decisions — append-only.
 *
 * SCOPE.md §5: "should we do this show?" is the question the ROI loop exists to
 * answer, and the answer is worth as much when it was *no*. A status column alone
 * forgets: it can say a show is `cancelled` but not that we declined it in March
 * because the booth cost doubled and last year's pipeline was thin. So each
 * transition is a row, with the deciding actor and a written rationale, and the
 * `shows.status` column is the projection of the latest one.
 *
 * A declined prospect is therefore a permanent record rather than a deleted row.
 */
export const showDecisions = pgTable(
  'show_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    decision: showDecisionEnum('decision').notNull(),
    /** Never null: a decision with no stated reason is the thing this table is against. */
    rationale: text('rationale').notNull(),
    decidedById: uuid('decided_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set when the show was created by cloning another. */
    clonedFromId: uuid('cloned_from_id').references(() => shows.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('show_decisions_show_idx').on(t.showId, t.decidedAt)],
);

/* -------------------------------- readiness -------------------------------- */

export const showTasks = pgTable(
  'show_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    category: taskCategoryEnum('category').notNull().default('booth'),
    status: taskStatusEnum('status').notNull().default('not_started'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    dueOn: timestamp('due_on', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    // Higher weight tasks move the readiness score more.
    weight: integer('weight').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    /**
     * Why this task is blocked or skipped. Required in both directions by
     * `lib/readiness/edit.ts` — a skip silently leaves the denominator, so a skip
     * with no stated reason is a way to raise the readiness score by deleting the
     * work. Same posture as `show_decisions.rationale`.
     */
    statusNote: text('status_note'),
    /**
     * The built-in template item this task came from, if any. Applying a template
     * twice must merge rather than produce twenty-five duplicates, and the unique
     * index below is what makes that a database fact rather than a query the
     * caller has to remember. NULL for hand-written tasks, and Postgres treats
     * NULLs as distinct, so any number of those coexist.
     */
    templateKey: text('template_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('show_tasks_show_idx').on(t.showId, t.sortOrder),
    uniqueIndex('show_tasks_template_unique').on(t.showId, t.templateKey),
  ],
);

/* -------------------------------- attendees -------------------------------- */

export const showAttendees = pgTable(
  'show_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('Booth staff'),
    status: attendeeStatusEnum('status').notNull().default('invited'),
    arrivesOn: timestamp('arrives_on', { withTimezone: true }),
    departsOn: timestamp('departs_on', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => [uniqueIndex('show_attendees_unique').on(t.showId, t.userId)],
);

/* --------------------------------- lodging --------------------------------- */

export const lodgings = pgTable(
  'lodgings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    hotelName: text('hotel_name').notNull(),
    address: text('address'),
    phone: text('phone'),
    confirmationCode: text('confirmation_code'),
    checkIn: timestamp('check_in', { withTimezone: true }),
    checkOut: timestamp('check_out', { withTimezone: true }),
    nightlyRateCents: integer('nightly_rate_cents'),
    // Room block cutoff dates are a classic missed deadline.
    roomBlockCutoff: timestamp('room_block_cutoff', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => [index('lodgings_show_idx').on(t.showId)],
);

export const lodgingGuests = pgTable(
  'lodging_guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lodgingId: uuid('lodging_id')
      .notNull()
      .references(() => lodgings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('lodging_guests_unique').on(t.lodgingId, t.userId)],
);

/* --------------------------------- flights --------------------------------- */

export const flights = pgTable(
  'flights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Carrier IATA code + number, e.g. "AA" + "1423".
    airlineCode: text('airline_code').notNull(),
    airlineName: text('airline_name'),
    flightNumber: text('flight_number').notNull(),

    originAirport: text('origin_airport').notNull(),
    destinationAirport: text('destination_airport').notNull(),

    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
    scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }).notNull(),
    estimatedDeparture: timestamp('estimated_departure', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }),

    status: flightStatusEnum('status').notNull().default('scheduled'),
    delayMinutes: integer('delay_minutes').notNull().default(0),
    departureTerminal: text('departure_terminal'),
    departureGate: text('departure_gate'),
    arrivalTerminal: text('arrival_terminal'),
    arrivalGate: text('arrival_gate'),

    // Booking linkage — set when purchased through the app.
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    bookingProvider: text('booking_provider'),
    bookingReference: text('booking_reference'),
    ticketNumber: text('ticket_number'),
    priceCents: integer('price_cents'),
    currency: text('currency').notNull().default('USD'),
    seat: text('seat'),
    cabin: text('cabin'),

    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flights_show_idx').on(t.showId),
    index('flights_user_idx').on(t.userId),
    index('flights_departure_idx').on(t.scheduledDeparture),
  ],
);

/* -------------------------------- shipments -------------------------------- */

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    direction: shipmentDirectionEnum('direction').notNull().default('outbound'),
    carrier: carrierEnum('carrier').notNull(),
    trackingNumber: text('tracking_number'),
    status: shipmentStatusEnum('status').notNull().default('draft'),

    fromAddress: jsonb('from_address').$type<Address>(),
    toAddress: jsonb('to_address').$type<Address>(),

    // Show floors have hard receiving windows; missing them costs drayage fees.
    mustArriveBy: timestamp('must_arrive_by', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    estimatedDelivery: timestamp('estimated_delivery', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    pieces: integer('pieces').notNull().default(1),
    weightLb: numeric('weight_lb', { precision: 8, scale: 2 }),
    declaredValueCents: integer('declared_value_cents'),
    costCents: integer('cost_cents'),
    labelUrl: text('label_url'),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),

    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipments_show_idx').on(t.showId),
    index('shipments_tracking_idx').on(t.carrier, t.trackingNumber),
  ],
);

export const shipmentEvents = pgTable(
  'shipment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    message: text('message').notNull(),
    location: text('location'),
  },
  (t) => [index('shipment_events_shipment_idx').on(t.shipmentId, t.occurredAt)],
);

/* --------------------------------- alerts ---------------------------------- */

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }),
    /** Whose alert this is. Null means the whole org sees it. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    // Stable key so a repeating condition updates one alert instead of piling up.
    dedupeKey: text('dedupe_key').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alerts_dedupe_idx').on(t.orgId, t.dedupeKey),
    index('alerts_user_idx').on(t.userId, t.acknowledgedAt),
  ],
);

/* -------------------------------- expenses --------------------------------- */

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    paid: boolean('paid').notNull().default(false),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    incurredOn: timestamp('incurred_on', { withTimezone: true }),
  },
  (t) => [index('expenses_show_idx').on(t.showId)],
);



/* ------------------------------ travel requests ---------------------------- */

/**
 * A traveler's constraints — the booking agent's input.
 *
 * Written after seeing real Duffel payloads (build step 3), not guessed at.
 * Constraints are stored structurally rather than as free text: an LLM parses
 * "I need to be in Vegas by Tuesday noon" into these columns and the user
 * confirms them, but from here down everything is deterministic. SCOPE.md §6a.
 */
/**
 * Travel policy rule sets, versioned and layered.
 *
 * The policy engine (`src/lib/policy`) is pure and knows nothing about this table;
 * these rows are its *input*. A row is one layer — an org baseline, or a narrower
 * override for a cost center, show, or role — and `resolveTravelPolicy()` merges
 * them most-specific-first into the single rule set that actually runs.
 *
 * **Null means inherit, on an override layer only.** The org layer is the base and
 * its nulls are real values ("no hotel cap set"); an override that leaves a column
 * null simply does not speak to that rule. The consequence is deliberate: an
 * override can tighten or loosen a limit but cannot *remove* one, because removing
 * a spend limit by omission is exactly the accident this table must not permit.
 *
 * Versions are immutable. Editing a policy writes a new version and stamps
 * `supersededAt` on the old one, so a `policy_evaluations` row from six months ago
 * can still be read against the rules that were live when it ran.
 */
export const travelPolicies = pgTable(
  'travel_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    scope: policyScopeEnum('scope').notNull().default('org'),
    /** The cost center / show id, or the role name, this layer applies to. */
    scopeRef: text('scope_ref'),
    version: integer('version').notNull().default(1),
    label: text('label'),

    maxAirfareDomesticCents: integer('max_airfare_domestic_cents'),
    maxAirfareInternationalCents: integer('max_airfare_international_cents'),
    autoApproveUnderCents: integer('auto_approve_under_cents'),
    denyOverCents: integer('deny_over_cents'),

    maxCabinDomestic: text('max_cabin_domestic'),
    maxCabinInternational: text('max_cabin_international'),
    premiumCabinAllowedOverHours: integer('premium_cabin_allowed_over_hours'),

    minAdvanceBookingDays: integer('min_advance_booking_days'),
    maxStops: integer('max_stops'),
    minConnectionMinutes: integer('min_connection_minutes'),
    arrivalBufferHoursBeforeMoveIn: integer('arrival_buffer_hours_before_move_in'),

    nonRefundableAllowedUnderCents: integer('non_refundable_allowed_under_cents'),
    maxAcceptableRefundPenaltyCents: integer('max_acceptable_refund_penalty_cents'),
    preferredAirlines: jsonb('preferred_airlines').$type<string[]>(),
    blockedAirlines: jsonb('blocked_airlines').$type<string[]>(),

    maxHotelNightlyRateCents: integer('max_hotel_nightly_rate_cents'),
    perShowTravelBudgetCents: integer('per_show_travel_budget_cents'),
    requireCreditFirst: boolean('require_credit_first'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a newer version replaces this one; null means live. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('travel_policies_layer_version_idx').on(t.orgId, t.scope, t.scopeRef, t.version),
    index('travel_policies_live_idx').on(t.orgId, t.supersededAt),
  ],
);

export const travelRequests = pgTable(
  'travel_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    showId: uuid('show_id').references(() => shows.id, { onDelete: 'set null' }),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    travelerId: uuid('traveler_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),

    status: travelRequestStatusEnum('status').notNull().default('draft'),

    originAirport: text('origin_airport').notNull(),
    destinationAirport: text('destination_airport').notNull(),
    earliestDeparture: timestamp('earliest_departure', { withTimezone: true }).notNull(),
    latestArrival: timestamp('latest_arrival', { withTimezone: true }).notNull(),
    returnEarliestDeparture: timestamp('return_earliest_departure', { withTimezone: true }),
    returnLatestArrival: timestamp('return_latest_arrival', { withTimezone: true }),
    cabinPreference: text('cabin_preference'),

    /** What the user actually typed, kept beside the parsed result. */
    rawRequestText: text('raw_request_text'),
    /** Parsed constraints are not acted on until the human confirms them. */
    constraintsConfirmedAt: timestamp('constraints_confirmed_at', { withTimezone: true }),

    /**
     * One ticket per request, ever. Retries, double-clicks, and crashed workers
     * must not produce two tickets. SCOPE.md §6c.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('travel_requests_idempotency_idx').on(t.orgId, t.idempotencyKey),
    index('travel_requests_status_idx').on(t.orgId, t.status),
    index('travel_requests_traveler_idx').on(t.travelerId),
  ],
);

/**
 * What the agent saw, recorded immutably.
 *
 * Airline offers expire in roughly 30 minutes and then vanish from the provider
 * entirely. Without this snapshot, "why did it pick the $780 flight?" is
 * permanently unanswerable — so we store the chosen offer AND the rejected ones.
 *
 * `rawPayload` keeps the provider response verbatim: the normalized columns are
 * our interpretation, and an audit may need to see the source.
 */
export const offerSnapshots = pgTable(
  'offer_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    travelRequestId: uuid('travel_request_id')
      .notNull()
      .references(() => travelRequests.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerOfferId: text('provider_offer_id').notNull(),
    /**
     * Which search produced this row. Part of the identity of a snapshot, not a
     * decoration: a request that gets re-searched after its offer expired has
     * two legitimate captures of the same itinerary, and the audit needs both.
     */
    providerSearchId: text('provider_search_id').notNull(),

    totalCents: integer('total_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    /** Duffel sends decimal strings; kept verbatim alongside our parsed cents. */
    totalAmountRaw: text('total_amount_raw').notNull(),

    ownerAirlineCode: text('owner_airline_code'),
    outboundDeparture: timestamp('outbound_departure', { withTimezone: true }).notNull(),
    outboundArrival: timestamp('outbound_arrival', { withTimezone: true }).notNull(),
    maxStops: integer('max_stops').notNull().default(0),
    highestCabin: text('highest_cabin').notNull(),

    refundable: boolean('refundable').notNull().default(false),
    refundPenaltyCents: integer('refund_penalty_cents'),
    changeable: boolean('changeable').notNull().default(false),
    changePenaltyCents: integer('change_penalty_cents'),

    /** Drives whether an approval can be backed by a hold. SCOPE.md §6b. */
    requiresInstantPayment: boolean('requires_instant_payment').notNull().default(true),
    paymentRequiredBy: timestamp('payment_required_by', { withTimezone: true }),
    priceGuaranteeExpiresAt: timestamp('price_guarantee_expires_at', { withTimezone: true }),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }).notNull(),

    availableCreditIds: jsonb('available_credit_ids').$type<string[]>(),
    corporateFareCodes: jsonb('corporate_fare_codes').$type<string[]>(),

    /** True for the offer the agent chose; false for the alternatives it saw. */
    selected: boolean('selected').notNull().default(false),
    rank: integer('rank'),
    score: integer('score'),

    rawPayload: jsonb('raw_payload').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('offer_snapshots_request_idx').on(t.travelRequestId, t.rank),
    // Discovered building step 4: keying on (request, offer) alone made the
    // re-search-on-approval path impossible, because a provider may return the
    // same offer id twice and a snapshot is a point-in-time capture, not a
    // singleton. One row per offer *per search* is the rule that was meant.
    uniqueIndex('offer_snapshots_provider_offer_idx').on(
      t.travelRequestId,
      t.providerSearchId,
      t.providerOfferId,
    ),
  ],
);

/**
 * The policy verdict, stored per evaluated offer.
 *
 * `resolvedPolicy` is the merged rule set that actually ran, not a pointer to
 * today's org defaults — an audit six months later must reconstruct exactly why
 * a purchase was permitted. `results` holds every rule's structured outcome,
 * including the ones that passed and the ones that did not apply.
 */
export const policyEvaluations = pgTable(
  'policy_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    travelRequestId: uuid('travel_request_id')
      .notNull()
      .references(() => travelRequests.id, { onDelete: 'cascade' }),
    offerSnapshotId: uuid('offer_snapshot_id')
      .notNull()
      .references(() => offerSnapshots.id, { onDelete: 'cascade' }),

    decision: policyDecisionEnum('decision').notNull(),
    policyId: text('policy_id').notNull(),
    policyVersion: integer('policy_version').notNull(),
    /** The merged, most-specific-first rule set as applied. */
    resolvedPolicy: jsonb('resolved_policy').notNull(),
    /** Every rule: pass, fail, or not_applicable, with its margin. */
    results: jsonb('results').notNull(),
    blockerRuleIds: jsonb('blocker_rule_ids').$type<string[]>(),

    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('policy_evaluations_request_idx').on(t.travelRequestId),
    uniqueIndex('policy_evaluations_offer_idx').on(t.offerSnapshotId),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    travelRequestId: uuid('travel_request_id')
      .notNull()
      .references(() => travelRequests.id, { onDelete: 'cascade' }),
    policyEvaluationId: uuid('policy_evaluation_id').references(() => policyEvaluations.id, {
      onDelete: 'set null',
    }),
    approverId: uuid('approver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    outcome: approvalOutcomeEnum('outcome').notNull(),
    reason: text('reason'),

    /**
     * Set when no eligible approver existed and the requester self-approved.
     * Requires a written justification and is surfaced as an exception rather
     * than a normal approval. SCOPE.md §3.
     */
    breakGlassJustification: text('break_glass_justification'),

    /**
     * An offer that expired while awaiting approval must be re-searched and
     * re-evaluated; the approved *price* may no longer exist. SCOPE.md §6b.
     */
    reSearchedOnApproval: boolean('re_searched_on_approval').notNull().default(false),
    priceAtApprovalCents: integer('price_at_approval_cents'),

    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('approvals_request_idx').on(t.travelRequestId)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    travelRequestId: uuid('travel_request_id')
      .notNull()
      .references(() => travelRequests.id, { onDelete: 'cascade' })
      // One booking per request, enforced by the database and not just by code.
      .unique(),
    offerSnapshotId: uuid('offer_snapshot_id').references(() => offerSnapshots.id, {
      onDelete: 'set null',
    }),

    provider: text('provider').notNull(),
    providerOrderId: text('provider_order_id').notNull(),
    bookingReference: text('booking_reference'),
    ticketNumbers: jsonb('ticket_numbers').$type<string[]>(),

    /** A hold reserves space without payment while an approver decides. */
    isHold: boolean('is_hold').notNull().default(false),
    payBy: timestamp('pay_by', { withTimezone: true }),
    priceGuaranteedUntil: timestamp('price_guaranteed_until', { withTimezone: true }),

    chargedCents: integer('charged_cents'),
    creditAppliedCents: integer('credit_applied_cents'),
    currency: text('currency').notNull().default('USD'),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),

    /** False for dry runs, which exercise the whole pipeline without spending. */
    live: boolean('live').notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('bookings_provider_order_idx').on(t.provider, t.providerOrderId),
    index('bookings_request_idx').on(t.travelRequestId),
  ],
);

/** Every agent decision, appended and never updated. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    travelRequestId: uuid('travel_request_id')
      .notNull()
      .references(() => travelRequests.id, { onDelete: 'cascade' }),
    /**
     * Position in this request's history, 1-based.
     *
     * `occurredAt` alone cannot order the trail: several steps of one run share
     * a timestamp — deliberately, since the clock is injected so the pipeline is
     * reproducible — and an audit log you cannot put in order is not an audit
     * log. The sequence is the ordering; the timestamp is the fact.
     */
    sequence: integer('sequence').notNull(),
    step: text('step').notNull(),
    fromStatus: travelRequestStatusEnum('from_status'),
    toStatus: travelRequestStatusEnum('to_status'),
    /** Who or what acted: a user id, or 'agent'. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull().default('agent'),
    /** Both identities when an admin was impersonating. SCOPE.md §3. */
    impersonatedById: uuid('impersonated_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    summary: text('summary').notNull(),
    detail: jsonb('detail'),
    /** Provider request id, for correlating with the vendor's own logs. */
    providerRequestId: text('provider_request_id'),
    durationMs: integer('duration_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_runs_request_idx').on(t.travelRequestId, t.sequence),
    uniqueIndex('agent_runs_sequence_idx').on(t.travelRequestId, t.sequence),
  ],
);

/* ------------------------------- kill switch ------------------------------- */

/**
 * The kill switch. SCOPE.md §6c rail 5.
 *
 * Append-only, and deliberately so: the current state is the newest row, and the
 * history of who halted purchasing, when, and why is the same table. A mutable
 * boolean column would answer "is it on" and nothing else, and the question that
 * actually gets asked after an incident is "who turned it back on."
 *
 * An org with no rows is not halted. That means the switch is safe to introduce
 * to an existing database without a backfill, and a missing row can never read
 * as "halted" and silently stop an org from travelling.
 */
export const bookingControls = pgTable(
  'booking_controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** True from this row onward, until a later row says otherwise. */
    purchasingHalted: boolean('purchasing_halted').notNull(),
    /** Required in both directions — halting and resuming are both decisions. */
    reason: text('reason').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('booking_controls_org_idx').on(t.orgId, t.createdAt)],
);

/* -------------------------- service manual deadlines ----------------------- */

/**
 * Exhibitor service manual deadlines. The advance order deadline typically lands
 * 21-30 days before show open; missing it surcharges every service order 25-40%.
 * `penaltyEstimateCents` is what makes this a decision rather than a nag.
 * See SCOPE.md §5a.
 */
export const showDeadlines = pgTable(
  'show_deadlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    kind: deadlineKindEnum('kind').notNull().default('other'),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    penaltyEstimateCents: integer('penalty_estimate_cents'),
    penaltyNote: text('penalty_note'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sourceUrl: text('source_url'),
    // Set when extracted from a manual PDF; a human must confirm before it alerts.
    extractedFromDocument: boolean('extracted_from_document').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('show_deadlines_show_due_idx').on(t.showId, t.dueAt)],
);

/* ------------------------------- booth shifts ------------------------------ */

export const boothShifts = pgTable(
  'booth_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    // Coverage target: how many staff this slot needs.
    targetStaff: integer('target_staff').notNull().default(2),
    notes: text('notes'),
  },
  (t) => [index('booth_shifts_show_idx').on(t.showId, t.startsAt)],
);

export const shiftAssignments = pgTable(
  'shift_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => boothShifts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('shift_assignments_unique').on(t.shiftId, t.userId)],
);

/**
 * Who was *actually* at the booth. Deliberately separate from shiftAssignments:
 * rostered is not present, and the gap between them is the staffing insight.
 */
export const shiftPresence = pgTable(
  'shift_presence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => boothShifts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }).notNull(),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  },
  (t) => [index('shift_presence_shift_idx').on(t.shiftId)],
);

/* -------------------------------- side events ------------------------------ */

export const sideEvents = pgTable(
  'side_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    kind: sideEventKindEnum('kind').notNull().default('dinner'),
    name: text('name').notNull(),
    location: text('location'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    capacity: integer('capacity'),
    budgetCents: integer('budget_cents'),
    hostId: uuid('host_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
  },
  (t) => [index('side_events_show_idx').on(t.showId, t.startsAt)],
);

export const sideEventRsvps = pgTable(
  'side_event_rsvps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sideEventId: uuid('side_event_id')
      .notNull()
      .references(() => sideEvents.id, { onDelete: 'cascade' }),
    // Either an internal user or an external guest, not both.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestName: text('guest_name'),
    guestEmail: text('guest_email'),
    guestCompany: text('guest_company'),
    status: rsvpStatusEnum('status').notNull().default('invited'),
  },
  (t) => [index('side_event_rsvps_event_idx').on(t.sideEventId)],
);

/* ---------------------------- assets & collateral -------------------------- */

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: assetKindEnum('kind').notNull().default('display'),
    assetTag: text('asset_tag'),
    condition: assetConditionEnum('condition').notNull().default('good'),
    storageLocation: text('storage_location'),
    purchaseValueCents: integer('purchase_value_cents'),
    weightLb: numeric('weight_lb', { precision: 8, scale: 2 }),
    dimensions: text('dimensions'),
    notes: text('notes'),
  },
  (t) => [index('assets_org_idx').on(t.orgId)],
);

/**
 * A log, not a flag. Capital assets get lost between shows; chain of custody is
 * who took it, when it came back, and in what condition.
 */
export const assetReservations = pgTable(
  'asset_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    reservedFrom: timestamp('reserved_from', { withTimezone: true }).notNull(),
    reservedTo: timestamp('reserved_to', { withTimezone: true }).notNull(),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutById: uuid('checked_out_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    conditionOnReturn: assetConditionEnum('condition_on_return'),
    notes: text('notes'),
  },
  (t) => [
    index('asset_reservations_asset_idx').on(t.assetId, t.reservedFrom),
    index('asset_reservations_show_idx').on(t.showId),
  ],
);

export const collateralItems = pgTable(
  'collateral_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    unitCostCents: integer('unit_cost_cents'),
    storageLocation: text('storage_location'),
  },
  (t) => [index('collateral_items_org_idx').on(t.orgId)],
);

export const collateralAllocations = pgTable(
  'collateral_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collateralItemId: uuid('collateral_item_id')
      .notNull()
      .references(() => collateralItems.id, { onDelete: 'cascade' }),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    quantityAllocated: integer('quantity_allocated').notNull(),
    quantityReturned: integer('quantity_returned'),
  },
  (t) => [index('collateral_allocations_show_idx').on(t.showId)],
);

/* ----------------------------- ticket credits ------------------------------ */

/**
 * Unused airline credits. 5-11% of corporate air spend is forfeited to expiry each
 * year; we hold these only because we booked the ticket. Expiry is per-carrier
 * (roughly 6-24 months), so it is stored per row rather than computed from a
 * constant. See SCOPE.md §5b.
 */
export const ticketCredits = pgTable(
  'ticket_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // Credits are usually locked to the original traveler.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originFlightId: uuid('origin_flight_id').references(() => flights.id, {
      onDelete: 'set null',
    }),
    /**
     * The provider's own id for this credit, where it has one.
     *
     * Duffel surfaces credits it can apply itself as `available_airline_credit_ids`
     * on an offer. Those are the *same money* as a row here that we issued from a
     * cancellation, and counting both would double-spend a credit that only exists
     * once. This column is the join between the two views of it; a credit we know
     * about but the provider does not is simply null here, and is reported to a
     * human rather than applied automatically.
     */
    providerCreditId: text('provider_credit_id'),
    /** The booking whose cancellation produced this credit, when we made it. */
    originBookingId: uuid('origin_booking_id').references(() => bookings.id, {
      onDelete: 'set null',
    }),

    airlineCode: text('airline_code').notNull(),
    recordLocator: text('record_locator'),
    ticketNumber: text('ticket_number'),
    originalValueCents: integer('original_value_cents').notNull(),
    /**
     * A cached projection of the entries in `ticket_credit_entries`, never the
     * source of truth. `reconcile()` recomputes it; a disagreement between this
     * and the entries is a bug worth failing loudly on, not papering over.
     */
    remainingValueCents: integer('remaining_value_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    issuedOn: timestamp('issued_on', { withTimezone: true }).notNull(),
    expiresOn: timestamp('expires_on', { withTimezone: true }).notNull(),
    status: creditStatusEnum('status').notNull().default('available'),
    transferable: boolean('transferable').notNull().default(false),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
  },
  (t) => [
    index('ticket_credits_org_expiry_idx').on(t.orgId, t.expiresOn),
    index('ticket_credits_user_idx').on(t.userId, t.status),
    // One row per provider-side credit. Ingesting the same airline credit twice
    // would present the org with money it does not have.
    uniqueIndex('ticket_credits_provider_idx').on(t.orgId, t.providerCreditId),
  ],
);

/**
 * The credit ledger proper: append-only, signed, and the only thing allowed to
 * change a credit's balance.
 *
 * Every financial row carries a cost center at creation (non-negotiable #7) —
 * a credit applied to a booking is a real cost-centre-level saving, and if the
 * centre is not on the row at the moment it is written it never will be.
 */
export const ticketCreditEntries = pgTable(
  'ticket_credit_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creditId: uuid('credit_id')
      .notNull()
      .references(() => ticketCredits.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    kind: creditEntryKindEnum('kind').notNull(),
    /** Signed, in cents: `issued` is positive, `applied` and `expired` negative. */
    deltaCents: integer('delta_cents').notNull(),
    /** The balance this entry produced, so the trail reads without re-summing it. */
    balanceAfterCents: integer('balance_after_cents').notNull(),
    currency: text('currency').notNull().default('USD'),

    /** What the movement was for. A booking for `applied`, its origin for `issued`. */
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    travelRequestId: uuid('travel_request_id').references(() => travelRequests.id, {
      onDelete: 'set null',
    }),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),

    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'agent' for the booking agent, 'user' for a person, 'sweep' for the expiry job. */
    actorKind: text('actor_kind').notNull().default('agent'),
    /** Always required: a balance that moved without a stated reason is not auditable. */
    reason: text('reason').notNull(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_entries_credit_idx').on(t.creditId, t.occurredAt),
    index('credit_entries_booking_idx').on(t.bookingId),
    // Rail 2 for credits: one application of one credit to one booking, ever.
    // A retried purchase must not burn the credit down twice.
    uniqueIndex('credit_entries_application_idx').on(t.creditId, t.bookingId, t.kind),
  ],
);

/* ------------------------------ leads & meetings --------------------------- */

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    capturedById: uuid('captured_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    company: text('company'),
    title: text('title'),
    interests: jsonb('interests').$type<string[]>(),
    notes: text('notes'),
    score: integer('score'),
    // The CRM owns pipeline truth; we own the attribution link.
    crmExternalId: text('crm_external_id'),
    // Lead PII is regulated data: consent is recorded at capture, not assumed.
    consentCapturedAt: timestamp('consent_captured_at', { withTimezone: true }),
    consentBasis: text('consent_basis'),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_show_idx').on(t.showId),
    index('leads_crm_idx').on(t.crmExternalId),
  ],
);

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    company: text('company'),
    isExistingCustomer: boolean('is_existing_customer').notNull().default(false),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    notes: text('notes'),
  },
  (t) => [index('meetings_show_idx').on(t.showId)],
);

/**
 * Engagement and pipeline numbers per show. Impressions and forecast revenue sit
 * alongside actuals; realized revenue lags 6-12 months, so `asOf` is mandatory —
 * every ROI figure must be able to state the date it was true.
 */
export const showOutcomes = pgTable(
  'show_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' })
      .unique(),
    impressions: integer('impressions'),
    boothWalkbys: integer('booth_walkbys'),
    pipelineSourcedCents: integer('pipeline_sourced_cents'),
    pipelineInfluencedCents: integer('pipeline_influenced_cents'),
    revenueForecastCents: integer('revenue_forecast_cents'),
    revenueClosedWonCents: integer('revenue_closed_won_cents'),
    attributionWindowDays: integer('attribution_window_days').notNull().default(180),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  },
);

/* --------------------------------- shared ---------------------------------- */

export type Address = {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
};

/* -------------------------------- relations -------------------------------- */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  shows: many(shows),
  costCenters: many(costCenters),
  loginPolicies: many(orgLoginPolicies),
  assets: many(assets),
  collateralItems: many(collateralItems),
  ticketCredits: many(ticketCredits),
}));

export const costCentersRelations = relations(costCenters, ({ one, many }) => ({
  org: one(organizations, { fields: [costCenters.orgId], references: [organizations.id] }),
  users: many(users),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  org: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
  costCenter: one(costCenters, {
    fields: [users.costCenterId],
    references: [costCenters.id],
  }),
  attendances: many(showAttendees),
  flights: many(flights),
  shiftAssignments: many(shiftAssignments),
  ticketCredits: many(ticketCredits),
}));

export const orgLoginPoliciesRelations = relations(orgLoginPolicies, ({ one }) => ({
  org: one(organizations, { fields: [orgLoginPolicies.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [orgLoginPolicies.actorId], references: [users.id] }),
}));

export const showsRelations = relations(shows, ({ one, many }) => ({
  org: one(organizations, { fields: [shows.orgId], references: [organizations.id] }),
  tasks: many(showTasks),
  attendees: many(showAttendees),
  lodgings: many(lodgings),
  flights: many(flights),
  shipments: many(shipments),
  expenses: many(expenses),
  deadlines: many(showDeadlines),
  shifts: many(boothShifts),
  sideEvents: many(sideEvents),
  assetReservations: many(assetReservations),
  collateralAllocations: many(collateralAllocations),
  leads: many(leads),
  meetings: many(meetings),
  outcome: one(showOutcomes),
}));

export const showTasksRelations = relations(showTasks, ({ one }) => ({
  show: one(shows, { fields: [showTasks.showId], references: [shows.id] }),
  assignee: one(users, { fields: [showTasks.assigneeId], references: [users.id] }),
}));

export const showAttendeesRelations = relations(showAttendees, ({ one }) => ({
  show: one(shows, { fields: [showAttendees.showId], references: [shows.id] }),
  user: one(users, { fields: [showAttendees.userId], references: [users.id] }),
}));

export const lodgingsRelations = relations(lodgings, ({ one, many }) => ({
  show: one(shows, { fields: [lodgings.showId], references: [shows.id] }),
  guests: many(lodgingGuests),
}));

export const lodgingGuestsRelations = relations(lodgingGuests, ({ one }) => ({
  lodging: one(lodgings, { fields: [lodgingGuests.lodgingId], references: [lodgings.id] }),
  user: one(users, { fields: [lodgingGuests.userId], references: [users.id] }),
}));

export const flightsRelations = relations(flights, ({ one }) => ({
  show: one(shows, { fields: [flights.showId], references: [shows.id] }),
  user: one(users, { fields: [flights.userId], references: [users.id] }),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  show: one(shows, { fields: [shipments.showId], references: [shows.id] }),
  events: many(shipmentEvents),
}));

export const shipmentEventsRelations = relations(shipmentEvents, ({ one }) => ({
  shipment: one(shipments, { fields: [shipmentEvents.shipmentId], references: [shipments.id] }),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  show: one(shows, { fields: [expenses.showId], references: [shows.id] }),
}));

export const showDeadlinesRelations = relations(showDeadlines, ({ one }) => ({
  show: one(shows, { fields: [showDeadlines.showId], references: [shows.id] }),
  owner: one(users, { fields: [showDeadlines.ownerId], references: [users.id] }),
}));

export const boothShiftsRelations = relations(boothShifts, ({ one, many }) => ({
  show: one(shows, { fields: [boothShifts.showId], references: [shows.id] }),
  assignments: many(shiftAssignments),
  presence: many(shiftPresence),
}));

export const shiftAssignmentsRelations = relations(shiftAssignments, ({ one }) => ({
  shift: one(boothShifts, {
    fields: [shiftAssignments.shiftId],
    references: [boothShifts.id],
  }),
  user: one(users, { fields: [shiftAssignments.userId], references: [users.id] }),
}));

export const shiftPresenceRelations = relations(shiftPresence, ({ one }) => ({
  shift: one(boothShifts, {
    fields: [shiftPresence.shiftId],
    references: [boothShifts.id],
  }),
  user: one(users, { fields: [shiftPresence.userId], references: [users.id] }),
}));

export const sideEventsRelations = relations(sideEvents, ({ one, many }) => ({
  show: one(shows, { fields: [sideEvents.showId], references: [shows.id] }),
  host: one(users, { fields: [sideEvents.hostId], references: [users.id] }),
  rsvps: many(sideEventRsvps),
}));

export const sideEventRsvpsRelations = relations(sideEventRsvps, ({ one }) => ({
  sideEvent: one(sideEvents, {
    fields: [sideEventRsvps.sideEventId],
    references: [sideEvents.id],
  }),
  user: one(users, { fields: [sideEventRsvps.userId], references: [users.id] }),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  org: one(organizations, { fields: [assets.orgId], references: [organizations.id] }),
  reservations: many(assetReservations),
}));

export const assetReservationsRelations = relations(assetReservations, ({ one }) => ({
  asset: one(assets, { fields: [assetReservations.assetId], references: [assets.id] }),
  show: one(shows, { fields: [assetReservations.showId], references: [shows.id] }),
  checkedOutBy: one(users, {
    fields: [assetReservations.checkedOutById],
    references: [users.id],
  }),
}));

export const collateralItemsRelations = relations(collateralItems, ({ one, many }) => ({
  org: one(organizations, {
    fields: [collateralItems.orgId],
    references: [organizations.id],
  }),
  allocations: many(collateralAllocations),
}));

export const collateralAllocationsRelations = relations(
  collateralAllocations,
  ({ one }) => ({
    item: one(collateralItems, {
      fields: [collateralAllocations.collateralItemId],
      references: [collateralItems.id],
    }),
    show: one(shows, { fields: [collateralAllocations.showId], references: [shows.id] }),
  }),
);

export const ticketCreditsRelations = relations(ticketCredits, ({ one, many }) => ({
  org: one(organizations, {
    fields: [ticketCredits.orgId],
    references: [organizations.id],
  }),
  user: one(users, { fields: [ticketCredits.userId], references: [users.id] }),
  originFlight: one(flights, {
    fields: [ticketCredits.originFlightId],
    references: [flights.id],
  }),
  entries: many(ticketCreditEntries),
}));

export const ticketCreditEntriesRelations = relations(ticketCreditEntries, ({ one }) => ({
  credit: one(ticketCredits, {
    fields: [ticketCreditEntries.creditId],
    references: [ticketCredits.id],
  }),
  booking: one(bookings, {
    fields: [ticketCreditEntries.bookingId],
    references: [bookings.id],
  }),
  costCenter: one(costCenters, {
    fields: [ticketCreditEntries.costCenterId],
    references: [costCenters.id],
  }),
  actor: one(users, { fields: [ticketCreditEntries.actorId], references: [users.id] }),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  show: one(shows, { fields: [leads.showId], references: [shows.id] }),
  capturedBy: one(users, { fields: [leads.capturedById], references: [users.id] }),
  meetings: many(meetings),
}));

export const meetingsRelations = relations(meetings, ({ one }) => ({
  show: one(shows, { fields: [meetings.showId], references: [shows.id] }),
  owner: one(users, { fields: [meetings.ownerId], references: [users.id] }),
  lead: one(leads, { fields: [meetings.leadId], references: [leads.id] }),
}));

export const showOutcomesRelations = relations(showOutcomes, ({ one }) => ({
  show: one(shows, { fields: [showOutcomes.showId], references: [shows.id] }),
}));

export const travelPoliciesRelations = relations(travelPolicies, ({ one }) => ({
  org: one(organizations, { fields: [travelPolicies.orgId], references: [organizations.id] }),
}));

export const travelRequestsRelations = relations(travelRequests, ({ one, many }) => ({
  org: one(organizations, {
    fields: [travelRequests.orgId],
    references: [organizations.id],
  }),
  show: one(shows, { fields: [travelRequests.showId], references: [shows.id] }),
  requester: one(users, { fields: [travelRequests.requesterId], references: [users.id] }),
  traveler: one(users, { fields: [travelRequests.travelerId], references: [users.id] }),
  costCenter: one(costCenters, {
    fields: [travelRequests.costCenterId],
    references: [costCenters.id],
  }),
  offers: many(offerSnapshots),
  evaluations: many(policyEvaluations),
  approvals: many(approvals),
  booking: one(bookings),
  runs: many(agentRuns),
}));

export const offerSnapshotsRelations = relations(offerSnapshots, ({ one }) => ({
  request: one(travelRequests, {
    fields: [offerSnapshots.travelRequestId],
    references: [travelRequests.id],
  }),
  evaluation: one(policyEvaluations),
}));

export const policyEvaluationsRelations = relations(policyEvaluations, ({ one }) => ({
  request: one(travelRequests, {
    fields: [policyEvaluations.travelRequestId],
    references: [travelRequests.id],
  }),
  offer: one(offerSnapshots, {
    fields: [policyEvaluations.offerSnapshotId],
    references: [offerSnapshots.id],
  }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  request: one(travelRequests, {
    fields: [approvals.travelRequestId],
    references: [travelRequests.id],
  }),
  evaluation: one(policyEvaluations, {
    fields: [approvals.policyEvaluationId],
    references: [policyEvaluations.id],
  }),
  approver: one(users, { fields: [approvals.approverId], references: [users.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  request: one(travelRequests, {
    fields: [bookings.travelRequestId],
    references: [travelRequests.id],
  }),
  offer: one(offerSnapshots, {
    fields: [bookings.offerSnapshotId],
    references: [offerSnapshots.id],
  }),
  costCenter: one(costCenters, {
    fields: [bookings.costCenterId],
    references: [costCenters.id],
  }),
}));

export const bookingControlsRelations = relations(bookingControls, ({ one }) => ({
  org: one(organizations, {
    fields: [bookingControls.orgId],
    references: [organizations.id],
  }),
  actor: one(users, { fields: [bookingControls.actorId], references: [users.id] }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  request: one(travelRequests, {
    fields: [agentRuns.travelRequestId],
    references: [travelRequests.id],
  }),
  actor: one(users, { fields: [agentRuns.actorId], references: [users.id] }),
}));
