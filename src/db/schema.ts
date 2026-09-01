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

/**
 * How much it costs to walk past this account. Three levels rather than two,
 * because "would be nice" and "the reason we bought the booth" are different
 * sentences to put in front of somebody at hour six of day two.
 */
export const targetPriorityEnum = pgEnum('target_priority', [
  'must_meet',
  'target',
  'watch',
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

/**
 * Which way a leg flies relative to the show.
 *
 * Only a leg *to* the show can miss move-in, and without this the tracker raises
 * a critical alert every time somebody's Friday flight home slips — a feed that
 * cries wolf on the way back is one nobody reads on the way there. Set for real
 * when a flight is materialized from a booking (slice 0 is out, the rest are
 * back); `unknown` is honest for a hand-entered row, and the store infers a
 * direction for those and says on screen that it inferred one.
 */
export const flightLegDirectionEnum = pgEnum('flight_leg_direction', [
  'to_show',
  'from_show',
  'unknown',
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
  /**
   * The carrier put it on a dock. **Not the same as received** — see
   * `shipments.received_at`, and `src/lib/shipping/status.ts` for why the
   * distinction is the most expensive one in this table.
   */
  'delivered',
  'exception',
  'returned',
  'cancelled',
  /**
   * The provider has a record and cannot currently say. Step 13's rule, applied
   * to a second tracker: not knowing is not the same as fine, and it is what a
   * row nobody has refreshed silently claims to be.
   */
  'unknown',
]);

/**
 * Where an outbound crate is consigned, which decides what "on time" means.
 *
 * These are not shipping addresses under different names; they are two
 * different *rules*. An advance warehouse has a **cutoff**: it accepts freight
 * for weeks and stops on a published date, and arriving early is the whole
 * point. Show-site receiving has a **window**: the dock opens when move-in
 * opens, and a crate that turns up two days early is refused, stored at the
 * carrier's rate, or sent back — which is a failure a deadline model cannot
 * express, because it is on the wrong side of the date. §5g.
 */
export const shipmentConsignmentEnum = pgEnum('shipment_consignment', [
  'advance_warehouse',
  'show_site',
  /** A return leg: the crate is coming back to us, not going to a floor. */
  'office',
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

/**
 * What has become of a deadline.
 *
 * `not_applicable` is the dangerous one, and it is here for the same reason
 * `skipped` is a task status: it removes a dollar figure from the show's exposure
 * without anybody doing the work. So it carries a written reason and the same
 * authority as deleting the row. See `src/lib/deadlines/edit.ts`.
 */
export const deadlineStatusEnum = pgEnum('deadline_status', [
  'open',
  'complete',
  'not_applicable',
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

export const collateralEntryKindEnum = pgEnum('collateral_entry_kind', [
  'received',
  'issued',
  'returned',
  'written_off',
  /** A physical count that disagreed with the ledger. Always needs a reason. */
  'counted',
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

export const assistantRoleEnum = pgEnum('assistant_role', [
  'user',
  'assistant',
  /** A tool ran. The row holds what was asked for and what came back. */
  'tool',
]);

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
    /**
     * Set when the person themselves answered, as opposed to being pencilled in
     * by whoever built the roster. Coverage counts a *confirmed* attendee; this
     * is how we tell a real yes from an optimistic one. See lib/team/coverage.ts.
     */
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    /**
     * Room block cutoff dates are a classic missed deadline — which is exactly
     * what `show_deadlines` and its engine are for. Rather than growing a second
     * clock beside the first, a lodging row with a cutoff *owns* a deadline row
     * (`show_deadlines.lodging_id`), and this column stays the single place the
     * date is edited. See lib/lodging/store.ts.
     */
    roomBlockCutoff: timestamp('room_block_cutoff', { withTimezone: true }),
    notes: text('notes'),
    /** Non-negotiable: every financial row carries a cost center at creation. */
    costCenterId: uuid('cost_center_id')
      .notNull()
      .references(() => costCenters.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    /**
     * Nullable as of step 13, and the nullability is the point.
     *
     * A travel request may have no show (`travel_requests.show_id` has always
     * been nullable), so a ticket bought through the agent for a non-show trip
     * had nowhere to land here — which meant either dropping the flight or
     * inventing a show for it. It is still a flight the traveler is on and the
     * board still tracks it; what it does not have is a move-in time to miss,
     * which is exactly the verdict the policy engine's `arrival_buffer` rule
     * already returns when `moveInAt` is absent. The tracker inherits that
     * answer rather than inventing a second one. SCOPE.md 5f.
     */
    showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Carrier IATA code + number, e.g. "AA" + "1423".
    airlineCode: text('airline_code').notNull(),
    airlineName: text('airline_name'),
    flightNumber: text('flight_number').notNull(),

    originAirport: text('origin_airport').notNull(),
    destinationAirport: text('destination_airport').notNull(),
    legDirection: flightLegDirectionEnum('leg_direction').notNull().default('unknown'),

    /**
     * The airports' IANA zones, when the provider told us.
     *
     * Instants are unambiguous and unreadable: nobody boards at
     * `2026-03-30T14:05:00Z`. Every screen before step 13 got away with the
     * show's zone because everything it rendered happened at the show. A
     * departure does not — it happens at the origin airport, which is where the
     * traveler is standing — and Duffel has been sending `airport.time_zone`
     * all along, which `normalize.ts` read for the conversion and then dropped.
     * Null means we genuinely do not know, and the board says which zone it fell
     * back to rather than mislabelling one.
     */
    originTimeZone: text('origin_time_zone'),
    destinationTimeZone: text('destination_time_zone'),

    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
    scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }).notNull(),
    estimatedDeparture: timestamp('estimated_departure', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }),

    /**
     * What the *carrier* now calls the schedule, when that disagrees with ours.
     *
     * "Scheduled times are immutable" is a ground rule and it stays one: the
     * scheduled columns hold the plan the ticket was bought against, which is
     * what the policy verdict was computed from and what an audit has to be able
     * to read back. But airlines re-time flights weeks ahead, and that is a new
     * plan rather than a delay — writing it into `estimated_*` would report a
     * three-hour delay on a flight that is running exactly on time, and writing
     * it into `scheduled_*` would erase the itinerary somebody approved. So it
     * goes here, beside both, and raises its own alert. SCOPE.md 5f.
     */
    providerScheduledDeparture: timestamp('provider_scheduled_departure', { withTimezone: true }),
    providerScheduledArrival: timestamp('provider_scheduled_arrival', { withTimezone: true }),
    scheduleChangedAt: timestamp('schedule_changed_at', { withTimezone: true }),

    status: flightStatusEnum('status').notNull().default('scheduled'),
    delayMinutes: integer('delay_minutes').notNull().default(0),
    departureTerminal: text('departure_terminal'),
    departureGate: text('departure_gate'),
    arrivalTerminal: text('arrival_terminal'),
    arrivalGate: text('arrival_gate'),
    /** `diverted` is in the status enum; where to was not recorded anywhere. */
    divertedToAirport: text('diverted_to_airport'),

    // Booking linkage — set when purchased through the app.
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    /**
     * The booking this segment was materialized from, and its index within the
     * itinerary. Before step 13 nothing wrote a flight row at all — the agent
     * bought tickets and recorded an *order*, so the tracking layer could not
     * see a single thing the product's own booking spine had purchased. These
     * two columns are what makes materialization idempotent: re-running it after
     * a retry updates the same rows instead of filing the itinerary twice.
     */
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    segmentIndex: integer('segment_index'),
    bookingProvider: text('booking_provider'),
    bookingReference: text('booking_reference'),
    ticketNumber: text('ticket_number'),
    priceCents: integer('price_cents'),
    currency: text('currency').notNull().default('USD'),
    seat: text('seat'),
    cabin: text('cabin'),

    /** Which status provider last spoke, so a stale row says who went quiet. */
    statusProvider: text('status_provider'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flights_show_idx').on(t.showId),
    index('flights_user_idx').on(t.userId),
    index('flights_departure_idx').on(t.scheduledDeparture),
    uniqueIndex('flights_booking_segment_idx').on(t.bookingId, t.segmentIndex),
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
    consignment: shipmentConsignmentEnum('consignment').notNull().default('advance_warehouse'),
    carrier: carrierEnum('carrier').notNull(),
    trackingNumber: text('tracking_number'),
    status: shipmentStatusEnum('status').notNull().default('draft'),

    /**
     * Who chases this crate.
     *
     * Nullable, and that is the interesting case rather than the tidy one. §5a
     * learned it on deadlines: an alert addressed to an owner, on a row with no
     * owner, reaches nobody — silently, and on precisely the row most likely to
     * be missed. Unownedness escalates to the show's runners and is named as the
     * thing to fix first. §5g.
     */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),

    fromAddress: jsonb('from_address').$type<Address>(),
    toAddress: jsonb('to_address').$type<Address>(),

    // Show floors have hard receiving windows; missing them costs drayage fees.
    mustArriveBy: timestamp('must_arrive_by', { withTimezone: true }),
    /**
     * The other edge of the window, and the one a deadline model cannot hold.
     *
     * Show-site receiving does not open until move-in does. A crate that arrives
     * before this is not early, it is refused — held by the carrier at its own
     * rate, or returned. Null for an advance warehouse, which accepts freight
     * for weeks and only has a far edge. `src/lib/shipping/status.ts`.
     */
    receivingOpensAt: timestamp('receiving_opens_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    estimatedDelivery: timestamp('estimated_delivery', { withTimezone: true }),
    /**
     * What the carrier promised when the label was made, kept beside what it
     * says now.
     *
     * The flights rule ("scheduled times are immutable") reaching shipping. A
     * single `estimated_delivery` column overwritten on every poll cannot answer
     * the only question worth asking — *has the carrier moved its own promise?*
     * — because the promise is gone. Without it every late crate looks like it
     * was always going to be late, and nobody can tell a slipping shipment from
     * one that was booked too tight in the first place.
     */
    promisedDelivery: timestamp('promised_delivery', { withTimezone: true }),
    estimateChangedAt: timestamp('estimate_changed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /**
     * When a person said the crate is actually *here*.
     *
     * `delivered_at` is the carrier's claim that it reached a dock. Between that
     * dock and the booth sits drayage — a separate contractor, on its own
     * schedule, that this app cannot see. The single most expensive thing this
     * table could do is let "delivered" render as done while the crate sits in a
     * marshalling yard and the booth stands empty. Only a person sets this, the
     * way only the subject sets `show_attendees.responded_at`.
     */
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedById: uuid('received_by_id').references(() => users.id, { onDelete: 'set null' }),

    pieces: integer('pieces').notNull().default(1),
    weightLb: numeric('weight_lb', { precision: 8, scale: 2 }),
    declaredValueCents: integer('declared_value_cents'),
    costCents: integer('cost_cents'),
    labelUrl: text('label_url'),
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),

    /** Which tracking provider produced the readings on this row. */
    trackingProvider: text('tracking_provider'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipments_show_idx').on(t.showId),
    index('shipments_tracking_idx').on(t.carrier, t.trackingNumber),
  ],
);

/**
 * The carrier's scan history — append-only, and the thing `shipments.status` is
 * a projection of.
 *
 * The same shape as `ticket_credit_entries` under a credit balance: the events
 * are the facts and the status column is a rollup of them, so "where has this
 * crate actually been" stays answerable after somebody corrects the status by
 * hand.
 *
 * `fingerprint` is why re-polling does not double the timeline. A tracker
 * returns its *whole* history on every call, not the delta, so an append with no
 * identity turns a nightly sweep into a timeline that grows by its own length
 * every night. Carriers do not issue stable event ids, so the fingerprint is
 * derived from the scan itself — `normalize.ts` builds it — and the unique index
 * is what makes the claim true rather than intended.
 */
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
    /** Which provider reported this scan. `manual` when a person typed it. */
    source: text('source').notNull().default('manual'),
    /** Stable identity for one scan, so re-polling appends nothing. */
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shipment_events_shipment_idx').on(t.shipmentId, t.occurredAt),
    uniqueIndex('shipment_events_fingerprint_idx').on(t.shipmentId, t.fingerprint),
  ],
);

/* --------------------------------- alerts ---------------------------------- */

/**
 * Every notification this product owes somebody, and the durable record that it
 * was owed. Five engines write here; step 17 built the screen that reads it.
 *
 * Two things a row can be, and the difference is load-bearing:
 *
 * - A **condition** — "this crate has not scanned in five days" — is a claim
 *   that is true right now and can stop being true without anybody touching the
 *   alert. Conditions are planned by a nightly sweep over the *whole*
 *   population, so a key the sweep no longer plans is a condition that has
 *   ended, and the sweep resolves it. That precondition is the whole basis of
 *   `resolved_at`: an engine that planned over a subset would resolve half the
 *   board every night by simply not having looked.
 * - A **notice** — "your flight is ticketed" — happened once, at an instant, and
 *   is never untrue afterwards. Nothing resolves it; it is read and dismissed.
 *
 * `dedupe_key` was the entire dedupe story until now, and it hid a bug that only
 * a feed makes reachable: with `onConflictDoNothing`, a condition that ends and
 * later recurs under the same key silently reuses the row somebody already
 * acknowledged — so the second occurrence is muted by a dismissal of the first.
 * The writer upserts instead: `last_seen_at` and `occurrences` move every night
 * a condition still holds, and a row that had been *resolved* comes back
 * un-acknowledged, because a recurrence is news.
 */

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
    /**
     * Which engine wrote it: `deadline`, `flight`, `shipping`, `asset`,
     * `credit`, `booking`. Not parsed out of the dedupe key — a feed that has to
     * regex a key to decide where a row links is a feed that breaks the next
     * time a key gains a segment.
     */
    source: text('source').notNull().default('unknown'),
    /** `condition` (can end, and the sweep says when) or `notice` (happened once). */
    kind: text('kind').notNull().default('condition'),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    // Stable key so a repeating condition updates one alert instead of piling up.
    dedupeKey: text('dedupe_key').notNull(),
    /** First reported. Deliberately never moved: "since when" is the question. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last time a sweep still found this true. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** How many sweeps have said it. One alert said nine nights running is a story. */
    occurrences: integer('occurrences').notNull().default(1),
    /**
     * When the condition stopped holding. Set by the sweep, never by a person —
     * acknowledging is not fixing, and conflating the two would let a feed be
     * cleared by dismissal while every crate stayed exactly where it was.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('alerts_dedupe_idx').on(t.orgId, t.dedupeKey),
    index('alerts_user_idx').on(t.userId, t.acknowledgedAt),
    index('alerts_feed_idx').on(t.orgId, t.userId, t.resolvedAt),
    index('alerts_source_idx').on(t.orgId, t.source),
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
    status: deadlineStatusEnum('status').notNull().default('open'),
    /** Required for `not_applicable`; that is a change to the plan, not a status. */
    statusNote: text('status_note'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    sourceUrl: text('source_url'),
    // Set when extracted from a manual PDF; a human must confirm before it alerts.
    extractedFromDocument: boolean('extracted_from_document').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedById: uuid('confirmed_by_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Set when this row is *derived* from a lodging record's room block cutoff
     * rather than typed into the register. The date then belongs to the lodging
     * row and cannot be edited here — two editable copies of one date is how the
     * date gets missed. Everything else (owner, penalty, completion) is ordinary.
     */
    lodgingId: uuid('lodging_id').references(() => lodgings.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('show_deadlines_show_due_idx').on(t.showId, t.dueAt),
    // One deadline per room block, ever. The upsert in lib/lodging/store.ts
    // leans on this rather than on remembering to look first.
    uniqueIndex('show_deadlines_lodging_unique').on(t.lodgingId),
  ],
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    /** A dinner budget is money somebody gets charged for; §4's rule applies. */
    costCenterId: uuid('cost_center_id')
      .notNull()
      .references(() => costCenters.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
  (t) => [
    index('side_event_rsvps_event_idx').on(t.sideEventId),
    // Postgres treats NULLs as distinct, so this constrains internal invitees
    // without collapsing every external guest into one row.
    uniqueIndex('side_event_rsvps_user_unique').on(t.sideEventId, t.userId),
  ],
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
    /**
     * The *current* condition, and therefore a fact about the past that a
     * future reservation has to be judged against. §5h: a booth that came back
     * `needs_repair` is still reservable, and the reservation still renders as
     * a filled slot — which is why `custody.ts` treats condition as a gate on
     * serviceability rather than as a label on a row.
     */
    condition: assetConditionEnum('condition').notNull().default('good'),
    storageLocation: text('storage_location'),
    purchaseValueCents: integer('purchase_value_cents'),
    /** §4's rule, which assets had been violating: capital is somebody's budget. */
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    weightLb: numeric('weight_lb', { precision: 8, scale: 2 }),
    dimensions: text('dimensions'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assets_org_idx').on(t.orgId),
    // An asset tag is a barcode somebody sticks on a crate; two assets carrying
    // the same one makes the whole chain of custody ambiguous at the one moment
    // it is being read off a scanner.
    uniqueIndex('assets_tag_unique').on(t.orgId, t.assetTag),
  ],
);

/**
 * A log, not a flag. Capital assets get lost between shows; chain of custody is
 * who took it, when it came back, and in what condition.
 *
 * `condition_on_checkout` is the half that was missing. "In what condition" is
 * only an answerable question as a *delta*, and `assets.condition` is mutable —
 * by the time anybody asks whether Automate damaged the touchscreen, the column
 * says `needs_repair` and cannot say when it started. So the reservation
 * records both ends and the log reads on its own.
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
    /**
     * The window the asset is *unavailable*, which is not the show's window and
     * is longer than it at both ends: freight leaves days before move-in and
     * comes back weeks after move-out. §5h — comparing show dates under-reports
     * an asset clash exactly as comparing them over-reported a person's.
     */
    reservedFrom: timestamp('reserved_from', { withTimezone: true }).notNull(),
    reservedTo: timestamp('reserved_to', { withTimezone: true }).notNull(),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutById: uuid('checked_out_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    conditionOnCheckout: assetConditionEnum('condition_on_checkout'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedById: uuid('returned_by_id').references(() => users.id, { onDelete: 'set null' }),
    conditionOnReturn: assetConditionEnum('condition_on_return'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_reservations_asset_idx').on(t.assetId, t.reservedFrom),
    index('asset_reservations_show_idx').on(t.showId),
    // One reservation of one asset for one show. A second is a duplicate, and a
    // duplicate reads on screen as the asset being needed twice.
    uniqueIndex('asset_reservations_unique').on(t.assetId, t.showId),
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
    /**
     * A projection of the append-only entries in `collateral_entries`, exactly
     * as `ticket_credits.remaining_value_cents` is a projection of its ledger.
     * Only `recordMovement()` moves it, by appending a signed delta — so "how
     * many datasheets did Automate actually consume" stays answerable, which is
     * a §8 cost question and not an inventory nicety.
     */
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    /**
     * Judged against *available* stock, never against on-hand. Stock promised
     * to a show next week is not stock. §5h.
     */
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    unitCostCents: integer('unit_cost_cents'),
    /** §4's rule again: print and swag are somebody's line item. */
    costCenterId: uuid('cost_center_id').references(() => costCenters.id, {
      onDelete: 'set null',
    }),
    storageLocation: text('storage_location'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collateral_items_org_idx').on(t.orgId),
    uniqueIndex('collateral_items_sku_unique').on(t.orgId, t.sku),
  ],
);

/**
 * Every way a quantity can move, signed, append-only — the credit ledger's shape
 * applied to things instead of money.
 *
 * An *allocation* is deliberately not one of these. Promising 400 datasheets to
 * a show is a claim on stock, not a movement of it; the movement happens when
 * somebody picks them off the shelf and puts them in the crate. Conflating the
 * two is how a warehouse shows empty for a month before anybody packs anything.
 */
export const collateralEntries = pgTable(
  'collateral_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => collateralItems.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: collateralEntryKindEnum('kind').notNull(),
    /** Signed: `received` and `returned` positive, `issued` and `written_off` negative. */
    delta: integer('delta').notNull(),
    /** The quantity this entry produced, so the trail reads without re-summing it. */
    quantityAfter: integer('quantity_after').notNull(),
    allocationId: uuid('allocation_id').references(() => collateralAllocations.id, {
      onDelete: 'set null',
    }),
    showId: uuid('show_id').references(() => shows.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Always required: a quantity that moved without a stated reason is not auditable. */
    reason: text('reason').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collateral_entries_item_idx').on(t.itemId, t.occurredAt),
    // Rail: one issue and one return per allocation, ever. A retried "pack the
    // crate" must not empty the shelf twice.
    uniqueIndex('collateral_entries_allocation_idx').on(t.allocationId, t.kind),
  ],
);

/**
 * A claim on stock, with three states and no boolean between them: planned
 * (promised, still on the shelf), issued (in the crate, off the shelf), and
 * reconciled (counted back).
 *
 * `quantity_returned` is nullable and that nullability is load-bearing.
 * **Nobody counted** and **counted, none came back** are different facts: the
 * first is an open allocation, the second is 280 datasheets legitimately given
 * away. Reading null as zero writes off stock that is sitting in a crate in
 * Warehouse A. Same shape as an unknown travel window in §5e.
 */
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
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedById: uuid('issued_by_id').references(() => users.id, { onDelete: 'set null' }),
    quantityReturned: integer('quantity_returned'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedById: uuid('returned_by_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collateral_allocations_show_idx').on(t.showId),
    uniqueIndex('collateral_allocations_unique').on(t.collateralItemId, t.showId),
  ],
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

/**
 * A person we met at a booth — and the only table in this product holding
 * personal data about somebody who is not our user. §9.8 makes that regulated
 * data from the first row, which shows up in four columns here rather than in a
 * policy document.
 *
 * `consent_basis` has no default and that is the design. A badge-scanner export
 * has no consent column, so an import that defaulted the basis would be
 * manufacturing a lawful basis out of the absence of one — the §5a fabricated
 * bill, in a jurisdiction that fines for it. Unknown is a real, recorded answer,
 * and `leads/consent.ts` decides what may be done with a row that carries it.
 *
 * `redacted_at` exists because erasure must not erase the *count*. Deleting the
 * row would silently move every ROI figure that show ever produced, which is the
 * §8c failure with a compliance obligation on top; nulling the PII and keeping
 * the shell satisfies the erasure request and keeps "we captured 84 leads" true.
 */
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
    /** `consent` | `legitimate_interest` | `unknown`. Never defaulted. */
    consentBasis: text('consent_basis'),
    /** What the person was actually told. A basis with no notice behind it is a claim. */
    consentNotice: text('consent_notice'),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    /** `manual` | `csv` | `api`. Which door it came through. */
    source: text('source').notNull().default('manual'),
    /** The batch, when it came from one. Append-only; see `leadImports`. */
    importId: uuid('import_id'),
    /**
     * The scanner's own id for this scan. Unique per show, which is what makes
     * the intake endpoint idempotent: a scanner on convention-center wifi
     * retries, and a retry that creates a second lead inflates the one number
     * §8c says is already the weakest link in the ROI story.
     */
    externalRef: text('external_ref'),
    /** Set when this row is a duplicate of another lead on the same show. */
    duplicateOfId: uuid('duplicate_of_id'),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactedById: uuid('redacted_by_id').references(() => users.id, { onDelete: 'set null' }),
    redactionReason: text('redaction_reason'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_show_idx').on(t.showId),
    index('leads_crm_idx').on(t.crmExternalId),
    index('leads_capturer_idx').on(t.showId, t.capturedById),
    index('leads_retention_idx').on(t.deleteAfter, t.redactedAt),
    uniqueIndex('leads_external_ref_idx').on(t.showId, t.externalRef),
  ],
);

/**
 * One import, recorded whole — including what it refused.
 *
 * A CSV import that reports "84 leads imported" and silently dropped nine
 * malformed rows produces a lead count that is wrong in the direction nobody
 * checks. Every row read lands in exactly one of accepted / rejected /
 * duplicate, the three add up to `rowsRead`, and the arithmetic is on the
 * screen. The column mapping is kept because "why is every company blank" is
 * only answerable against the mapping the import actually used.
 */
export const leadImports = pgTable(
  'lead_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    importedById: uuid('imported_by_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('csv'),
    filename: text('filename'),
    mapping: jsonb('mapping').$type<Record<string, string | null>>(),
    rowsRead: integer('rows_read').notNull().default(0),
    accepted: integer('accepted').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    /** Every rejection, with its row number and the reason. Never summarized away. */
    problems: jsonb('problems').$type<{ row: number; reason: string }[]>(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lead_imports_show_idx').on(t.showId, t.createdAt)],
);

/**
 * A credential for the REST intake endpoint — the first principal in this app
 * that is not a person.
 *
 * Only the hash is stored, so a leaked database does not leak working keys and
 * the plaintext is displayed exactly once. `showId` is nullable but strongly
 * preferred: a badge scanner rented for one show has no business writing to
 * another, and the narrowest credential that does the job is the one to issue.
 * Revocation is a timestamp rather than a delete, because "which key wrote these
 * forty leads" has to stay answerable after the key is gone.
 */
export const intakeKeys = pgTable(
  'intake_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null means every show in the org — allowed, discouraged, and said so on screen. */
    showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** The public half, shown so a person can tell two keys apart. */
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedById: uuid('revoked_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('intake_keys_hash_idx').on(t.tokenHash),
    index('intake_keys_org_idx').on(t.orgId, t.revokedAt),
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
    /**
     * When it actually happened. Null on a scheduled meeting and null on one
     * that nobody showed up to, which are different things — `noShowAt` is what
     * tells them apart, because a booked meeting that never occurred must not
     * sit in the count of meetings held.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    noShowAt: timestamp('no_show_at', { withTimezone: true }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The device's own id for this record, when it was written offline.
     *
     * `leads.external_ref` earns its unique index because a badge scanner
     * retries a request it never saw the answer to. A phone in a hall with no
     * signal is the same machine with a longer gap: the outbox re-sends on
     * reconnect, and without a rail the second send is a second meeting. The
     * ref is minted on the device at the moment the person types, so it
     * survives the app being closed, the battery dying, and the sync being
     * attempted from a different network an hour later.
     */
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meetings_show_idx').on(t.showId),
    uniqueIndex('meetings_external_ref_idx').on(t.showId, t.externalRef),
  ],
);

/**
 * The accounts this show exists to meet.
 *
 * SCOPE.md §10 step 20 asks for "target-company alerts", and the reason they
 * belong to the day-of PWA rather than to a planning screen is a matter of
 * timing: the alert is worth something for the ninety seconds somebody is
 * standing in front of the person, and nothing at all afterwards. A nightly
 * engine cannot deliver it. It has to fire on the device, from cached rows,
 * while the name is still being typed — which is why `dayof/targets.ts` is pure
 * and shipped to the client, and why this table is small enough to cache whole.
 *
 * **Whether a target was met is derived, never stored.** There is no `met_at`
 * column, and adding one would be the mistake the credit ledger and the ROI
 * attribution both refused: a target is met because a lead exists on this show
 * whose company matches, so the answer changes when the lead does. A stored
 * flag would be set by whoever remembered to press the button, would survive an
 * erasure that removed the only evidence, and would let "we met 6 of 9 targets"
 * disagree with the lead list it is supposedly counting.
 *
 * `aliases` exists because a company is a string typed at a booth. "Lakeside
 * Manufacturing", "Lakeside Mfg" and "Lakeside" are one account, and
 * `matchTarget` deliberately will not guess that — it matches the name and the
 * aliases exactly, after normalising legal suffixes, and nothing else. A fuzzy
 * match here does not produce a wrong row; it produces somebody at a booth
 * telling a stranger they are an important account.
 */
export const showTargets = pgTable(
  'show_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    showId: uuid('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    companyName: text('company_name').notNull(),
    /** Other spellings of the same account. Matched exactly, like the name. */
    aliases: jsonb('aliases').$type<string[]>(),
    /** `must_meet` | `target` | `watch`. What it costs to walk past them. */
    priority: targetPriorityEnum('priority').notNull().default('target'),
    /** Why this account is on the list — the sentence a booth staffer reads. */
    reason: text('reason'),
    /**
     * Who owns the relationship. Nullable, and the nullability is load-bearing
     * in the same way `show_deadlines.owner_id`'s is: an unowned must-meet is
     * the one most likely to be walked past, and an alert addressed to its owner
     * would reach nobody. It escalates instead.
     */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('show_targets_show_idx').on(t.showId),
    uniqueIndex('show_targets_company_idx').on(t.showId, t.companyName),
  ],
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
    /**
     * `sourced` (the default, §11.7) or `influenced`. Recorded per show rather
     * than as a global setting because a figure has to be able to say which
     * model produced it — the two differ by a factor of two or three on the same
     * pipeline, and an unlabelled number that changed models between readings is
     * the §8a fabricated bill with a percentage sign on it.
     */
    attributionModel: text('attribution_model').notNull().default('sourced'),
    /**
     * Where these figures came from: `manual` for a number somebody typed, or a
     * provider name for a synced one.
     *
     * They are deliberately **not merged** with the derived figures the ROI
     * rollup computes from `crm_opportunities`. Two editable copies of one
     * number is how the number gets wrong (§5e's room-block cutoff, one domain
     * over), so a typed pipeline figure that disagrees with a synced one is
     * *named as a disagreement* rather than silently resolved in either
     * direction.
     */
    source: text('source').notNull().default('manual'),
    /**
     * True when these figures came from a replay rather than from a CRM.
     *
     * The other three `recorded` providers replay a *shape* — a journey, a
     * delay, a tool plan — and asserting it about this workspace is harmless. A
     * replayed opportunity has no shape separable from its claim: "$340,000
     * sourced by MedTech" is a sentence about this company's pipeline, and it
     * would land beside a real cost under the app's own byline. So a replayed
     * figure is marked here, all the way to the screen, and the ROI rollup
     * withholds every ratio derived from it.
     */
    replayed: boolean('replayed').notNull().default(false),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  },
);

/* --------------------------------- the CRM --------------------------------- */

/**
 * The link between a lead we captured and the record the customer's CRM already
 * holds — and the first row in this product that records *how* we know two
 * strangers are the same person.
 *
 * `leads.crm_external_id` has existed since step 1 and is not enough. It says
 * which record, and says nothing about how the match was made, when, or whether
 * a person agreed with it. That matters because the two match methods are not
 * equally trustworthy and because one of them is not always allowed: matching on
 * an id the CRM itself gave us costs nothing, and matching on an email means
 * sending a stranger's email address to a third-party system, which
 * `marketabilityOf` gates. A lead captured with no lawful basis is therefore
 * **unmatchable** rather than merely unmatched, and this table is where that
 * distinction becomes a fact somebody can read rather than a rule in a file.
 *
 * `attribution_written_at` is the §8b write half: one field back onto the CRM
 * record saying which show it came from, so the CRM can answer the question too.
 * It is a timestamp rather than a boolean because "we told Salesforce in March"
 * and "we told Salesforce this morning" are different answers to a support
 * question, and because a re-write after a stage change has to be detectable.
 */
export const crmLinks = pgTable(
  'crm_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** `contact` | `lead` — Salesforce keeps them apart and we have to say which. */
    objectType: text('object_type').notNull().default('contact'),
    externalId: text('external_id').notNull(),
    /** `external_id` | `email` | `manual`. See the header: they differ in cost. */
    matchMethod: text('match_method').notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
    attributionWrittenAt: timestamp('attribution_written_at', { withTimezone: true }),
    attributionValue: text('attribution_value'),
    /**
     * True when the link came from a replay rather than from a CRM. Carried on
     * the row rather than inferred from an env var at read time, because the
     * environment changes and this row is evidence about the moment it was
     * written.
     */
    replayed: boolean('replayed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One lead links to one CRM record. A second link would let one conversation
    // be attributed twice, which is the failure §8b's whole model exists to avoid.
    uniqueIndex('crm_links_lead_idx').on(t.leadId),
    index('crm_links_external_idx').on(t.orgId, t.externalId),
  ],
);

/**
 * An opportunity the CRM owns, cached here so a dashboard can be drawn without
 * a round trip to Salesforce for every row.
 *
 * Everything in this table is the CRM's fact, copied. **Nothing here is an
 * attribution**: which show sourced this opportunity is derived at read time in
 * `roi/attribution.ts` from capture dates and the configured window, never
 * stored. That is the credit ledger's rule (`remaining_value_cents` is a
 * projection, never assigned) applied to pipeline, and it has a specific payoff:
 * changing the attribution window from 180 days to 365 re-derives every figure
 * instead of requiring a migration and leaving the old answers lying around
 * looking authoritative.
 *
 * `stage_kind` is normalized because stage *names* are per-org free text —
 * "Closed Won", "6 - Closed/Won", "Won (Renewal)" — and a dashboard that has to
 * know a customer's stage vocabulary is a dashboard that is wrong at the second
 * customer.
 */
export const crmOpportunities = pgTable(
  'crm_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    /** The customer's own stage label, kept verbatim so a person recognises it. */
    stage: text('stage').notNull(),
    /** `open` | `won` | `lost`. What the dashboard is allowed to reason about. */
    stageKind: text('stage_kind').notNull(),
    amountCents: integer('amount_cents'),
    currency: text('currency').notNull().default('USD'),
    /** The CRM's contact/lead id, which is what joins this to `crm_links`. */
    contactExternalId: text('contact_external_id'),
    /** When the opportunity was created in the CRM. First touch is measured off this. */
    crmCreatedAt: timestamp('crm_created_at', { withTimezone: true }),
    closeDate: timestamp('close_date', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    ownerName: text('owner_name'),
    replayed: boolean('replayed').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crm_opps_external_idx').on(t.orgId, t.provider, t.externalId),
    index('crm_opps_contact_idx').on(t.orgId, t.contactExternalId),
  ],
);

/**
 * One sync, recorded whole — including what it could not do.
 *
 * `lead_imports`' shape, reached from a fifth direction, and for the identical
 * reason: a sync that reports "matched 41 leads" and silently skipped nine is a
 * pipeline figure that is wrong in the direction nobody checks. Every lead
 * considered lands in exactly one of matched / unmatched / withheld, the three
 * add up to `leadsConsidered`, and the arithmetic is on the screen.
 *
 * **`withheld` is the column this product needed and a generic sync would not
 * have.** It is leads we deliberately did not send — no lawful basis recorded,
 * or already erased — and it is kept apart from `unmatched` because they are
 * opposite findings: unmatched is the CRM's answer, and withheld is ours.
 * Collapsing them would make step 18's refusal look like a data-quality problem
 * with the vendor.
 */
export const crmSyncRuns = pgTable(
  'crm_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    replayed: boolean('replayed').notNull().default(false),
    startedById: uuid('started_by_id').references(() => users.id, { onDelete: 'set null' }),
    leadsConsidered: integer('leads_considered').notNull().default(0),
    matched: integer('matched').notNull().default(0),
    unmatched: integer('unmatched').notNull().default(0),
    withheld: integer('withheld').notNull().default(0),
    opportunitiesRead: integer('opportunities_read').notNull().default(0),
    attributionsWritten: integer('attributions_written').notNull().default(0),
    /** Every refusal and every failure, with the lead it belongs to and the reason. */
    problems: jsonb('problems').$type<{ leadId: string | null; reason: string }[]>(),
    /** Set when the run itself failed. A half-run that reported success is how a board goes quiet. */
    failedReason: text('failed_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('crm_sync_runs_org_idx').on(t.orgId, t.startedAt)],
);

/* ------------------------------ the assistant ------------------------------ */

/**
 * One conversation with the assistant. SCOPE.md §10 step 15.
 *
 * Scoped to a **user**, not to an org, and read by nobody else — not by an
 * admin, not by a travel manager. That is stricter than every other table here
 * and it is not a privacy flourish. Every tool result inside a transcript was
 * retrieved as the person who was talking: `travelerScope` had already narrowed
 * it, `access.ts` had already gated it. A second reader would be reading rows
 * that were fetched under somebody else's scope, which is exactly the lateral
 * path the whole access posture exists to close. So the transcript belongs to
 * the person in it.
 */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /**
     * Which model answered, recorded per conversation because it changes what
     * the transcript is. A `scripted` run chose its tools by keyword match and
     * wrote no prose of its own; a screen replaying one must say so, the way
     * every other replayed provider in this app does.
     */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assistant_conversations_user_idx').on(t.userId, t.updatedAt)],
);

/**
 * The transcript, append-only.
 *
 * A `tool` row is the load-bearing one. The assistant's prose is a paraphrase
 * and the app must never treat it as a source: the numbers a person is entitled
 * to rely on are the ones in `resultJson`, which came out of a store function
 * this turn. The screen renders those beside the prose for that reason, so a
 * figure the model got wrong is contradicted on the same screen rather than
 * standing alone.
 */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: assistantRoleEnum('role').notNull(),
    /** Prose, for `user` and `assistant` rows. Empty on a `tool` row. */
    text: text('text').notNull().default(''),

    /* --- tool rows only --- */
    toolName: text('tool_name'),
    /** What the model asked for, after Zod validation — never the raw input. */
    toolInputJson: jsonb('tool_input_json').$type<Record<string, unknown>>(),
    /** What the store returned, as the asking actor. The authoritative half. */
    toolResultJson: jsonb('tool_result_json').$type<unknown>(),
    /** A refused or failed tool call is kept: it is why an answer is thin. */
    toolError: text('tool_error'),

    /**
     * Set on an `assistant` row that produced a draft, and the whole point of
     * the step: a link to a `travel_requests` or `lodgings` row a human still
     * has to commit. Nothing here ever confirms its own parse.
     */
    draftTravelRequestId: uuid('draft_travel_request_id').references(() => travelRequests.id, {
      onDelete: 'set null',
    }),
    draftLodgingId: uuid('draft_lodging_id').references(() => lodgings.id, {
      onDelete: 'set null',
    }),

    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('assistant_messages_seq_unique').on(t.conversationId, t.seq)],
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
  intakeKeys: many(intakeKeys),
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
  booking: one(bookings, { fields: [flights.bookingId], references: [bookings.id] }),
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
  costCenter: one(costCenters, { fields: [assets.costCenterId], references: [costCenters.id] }),
  reservations: many(assetReservations),
}));

export const assetReservationsRelations = relations(assetReservations, ({ one }) => ({
  asset: one(assets, { fields: [assetReservations.assetId], references: [assets.id] }),
  show: one(shows, { fields: [assetReservations.showId], references: [shows.id] }),
  returnedBy: one(users, {
    fields: [assetReservations.returnedById],
    references: [users.id],
    relationName: 'reservationReturnedBy',
  }),
  checkedOutBy: one(users, {
    fields: [assetReservations.checkedOutById],
    references: [users.id],
    relationName: 'reservationCheckedOutBy',
  }),
}));

export const collateralItemsRelations = relations(collateralItems, ({ one, many }) => ({
  org: one(organizations, {
    fields: [collateralItems.orgId],
    references: [organizations.id],
  }),
  costCenter: one(costCenters, {
    fields: [collateralItems.costCenterId],
    references: [costCenters.id],
  }),
  allocations: many(collateralAllocations),
  entries: many(collateralEntries),
}));

export const collateralEntriesRelations = relations(collateralEntries, ({ one }) => ({
  item: one(collateralItems, {
    fields: [collateralEntries.itemId],
    references: [collateralItems.id],
  }),
  allocation: one(collateralAllocations, {
    fields: [collateralEntries.allocationId],
    references: [collateralAllocations.id],
  }),
  show: one(shows, { fields: [collateralEntries.showId], references: [shows.id] }),
  actor: one(users, { fields: [collateralEntries.actorId], references: [users.id] }),
}));

export const collateralAllocationsRelations = relations(
  collateralAllocations,
  ({ one, many }) => ({
    entries: many(collateralEntries),
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
  import: one(leadImports, { fields: [leads.importId], references: [leadImports.id] }),
  meetings: many(meetings),
}));

export const meetingsRelations = relations(meetings, ({ one }) => ({
  show: one(shows, { fields: [meetings.showId], references: [shows.id] }),
  owner: one(users, { fields: [meetings.ownerId], references: [users.id] }),
  lead: one(leads, { fields: [meetings.leadId], references: [leads.id] }),
}));

export const leadImportsRelations = relations(leadImports, ({ one, many }) => ({
  org: one(organizations, { fields: [leadImports.orgId], references: [organizations.id] }),
  show: one(shows, { fields: [leadImports.showId], references: [shows.id] }),
  importedBy: one(users, { fields: [leadImports.importedById], references: [users.id] }),
  leads: many(leads),
}));

export const crmLinksRelations = relations(crmLinks, ({ one }) => ({
  org: one(organizations, { fields: [crmLinks.orgId], references: [organizations.id] }),
  lead: one(leads, { fields: [crmLinks.leadId], references: [leads.id] }),
}));

export const crmOpportunitiesRelations = relations(crmOpportunities, ({ one }) => ({
  org: one(organizations, { fields: [crmOpportunities.orgId], references: [organizations.id] }),
}));

export const crmSyncRunsRelations = relations(crmSyncRuns, ({ one }) => ({
  org: one(organizations, { fields: [crmSyncRuns.orgId], references: [organizations.id] }),
  startedBy: one(users, { fields: [crmSyncRuns.startedById], references: [users.id] }),
}));

export const intakeKeysRelations = relations(intakeKeys, ({ one }) => ({
  org: one(organizations, { fields: [intakeKeys.orgId], references: [organizations.id] }),
  show: one(shows, { fields: [intakeKeys.showId], references: [shows.id] }),
  createdBy: one(users, { fields: [intakeKeys.createdById], references: [users.id] }),
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
