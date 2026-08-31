@AGENTS.md

# Trade Show Concierge

Enterprise trade show management: shows, readiness, people, travel, lodging, booth
shipments, and ROI — with a **policy-governed agent that purchases flights** within
admin-defined spend and schedule constraints.

## Read these first

- **`SCOPE.md`** — the contract. North star, roles, domain model, the booking agent,
  travel policy, ROI, non-negotiables, build order (§10), and open decisions (§11).
- **`RESEARCH.md`** — competitive analysis. Explains *why* the service-manual deadline
  engine and ticket-credit recovery are the differentiators.
- **`git log`** — each step commit documents what was learned building it.

## Working agreement — do this at the end of every step

The context window gets cleared between sessions. Nothing survives except what is on
disk, so **finishing a step means writing it down, not just making it work.** Before
saying a step is done, all four:

1. **Commit** the working tree, with a message explaining *what was learned*, not just
   what changed — corrections to earlier assumptions especially. `git log` is the
   project's reasoning record.
2. **Tick the box** in `SCOPE.md` §10 and amend the step text if what shipped differed
   from what was planned.
3. **Update "Where we are"** below — the current step, and anything deliberately
   deferred or left broken.
4. **Fold new findings into `SCOPE.md`.** If a step disproved an assumption, the
   assumption gets corrected in the doc, not just in the commit message.

A fresh session reading `CLAUDE.md` + `SCOPE.md` + `git log` should be able to pick up
the next step with no further explanation. If it couldn't, the step isn't finished.

## Where we are

Phase A (**the vertical slice through the booking spine**) is done; Phase B is under way.

**Done:** steps 1–9 — local Postgres + schema + `getActor()` seam; the policy engine;
the Duffel adapter with the booking schema corrected against real payload shapes; the
request state machine with dry-run booking end to end; live purchasing behind the flag
with a kill switch and a readable audit trail; the ticket credit ledger; Clerk wired
to the seam with per-org login-method control and a first app shell; the planning
core — show list, show detail tabs, My Itinerary, cloning, and intake; and the travel
request UI with the approvals queue. 307 tests, no keys required.

`pnpm booking:dry-run` walks the whole booking loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the
reasons worth relaxing, the request expiry sweep, the kill switch, credit-first
escalation, the credit expiry sweep, and the audit trail as a person reads it. Read
that output before reading the code; it is the fastest way to understand the spine.
`pnpm booking:audit <id | idempotency-key>` prints the same trail for any one request,
and `pnpm credits` prints the credit ledger.

**What step 9 added, and where:** the first screens over the booking spine.
`src/lib/travel/review.ts` is the design core and is pure — `offerStanding` answers *what
does approving this actually do right now* in four cases (live / held-and-guaranteed /
held-but-not / expired), `STATUS` says what each machine status means to a person waiting
on one, and `availableActions` returns what an actor may do **with a reason attached to
every refusal**. `provider.ts` selects the flight provider from the environment and is the
first code to do so — every previous caller constructed one by hand. `queue.ts` is the
org-scoped, `travelerScope`-narrowed read layer, same posture as `shows/store.ts`.
Screens: `/travel`, `/travel/new`, `/travel/[id]` (which is `pnpm booking:audit` as a page,
reusing `getAuditTrail` rather than assembling a second, thinner version), and
`/travel/approvals`. The nav gained Travel and Approvals; the show detail Travel tab now
links through instead of naming step 9.

**The three corrections step 9 turned up:**

1. **An approval screen that shows a fare beside an Approve button lies about half the
   time.** §6b settled that an approval authorizes an *amount*, not an offer, and
   `approveRequest` implements that faithfully — but the approver only ever sees the
   screen, and a bare number reads as a price. The standing of the offer is now on the
   queue row itself, and the predicate that decides it moved out of `agent.ts` into
   `review.ts` so the screen and the engine cannot disagree about what is being
   authorized. `SCOPE.md` §6b.
2. **Cancel does not tell the airline, and only a button made that visible.**
   `FlightProvider.cancel()` is implemented and called by nothing; `cancelRequest` closes
   our row and returns credits. Harmless while cancelling was script-only, reachable by a
   person now — so on a ticketed request the button reads "Close this record" and says the
   carrier still has to be called. Wiring it properly is the void/refund work in §6d.
   `SCOPE.md` §6d.
3. **The config layer is where "no fake data behind a real integration" is easiest to
   break.** A script named `booking:dry-run` may name `RecordedFlightProvider` in its own
   source; a web request has nobody to name it, so the choice moves into configuration —
   and a default that quietly served replayed offers to a screen would be indistinguishable
   there from real availability. `selectProvider` has **no fallback**: Duffel with a key,
   `recorded` only when explicitly asked for, and otherwise an error naming the variable.
   Screens that replay say so in a banner. Same reasoning drove the seed: it produces its
   travel requests by running the *real* agent against the `recorded` provider rather than
   inserting offer snapshots by hand, which would file fares no airline ever quoted as
   evidence in the table the whole audit story rests on.

**What step 8 added, and where:** `src/lib/shows/` is the planning core, split the same
way the booking spine is — pure decisions apart from the rows. `clone.ts` is a pure
planner (source + options → a plan of what to write, plus plain-language lists of what it
carried and what it deliberately did not); `intake.ts` is pure validation and the
decidable-status guard; `visibility.ts` holds the one visibility rule the screens share;
`store.ts` is the only file that touches the database, and it org-scopes at the source
rather than loading-then-checking. `show_decisions` in the schema is append-only, with a
written rationale required in both directions. The datetime primitives gained
`instantToZoned`, `shiftDaysPreservingLocalTime`, and `calendarDaysBetween`, which is what
the clone shifts dates with. Screens: `/shows`, `/shows/new`, `/shows/[id]` with five tab
routes, `/shows/[id]/clone`, `/itinerary`, plus `src/app/(app)/_components/ui.tsx` — a
deliberately plain shared vocabulary, not a design system invented before ten screens
exist to test it against. The seed grew a prospect, a *declined* show with its reasoning,
intake history for the two originals, and three manually-entered flights so My Itinerary
has something real in it.

**The two corrections step 8 turned up:**

1. **"See own shows" scopes travel, not the calendar.** §3's table draws its line around
   travel; reading it as "a Member only sees shows they're staffed on" hides next
   quarter's calendar from the engineer who will staff it, which is less useful and no
   safer. The calendar and every planning fact on a show are org-wide; flights, lodging
   assignments, and travel requests narrow to the actor unless they can approve. The
   narrowing is in the query, so a Member's page never contains a colleague's fare.
   `SCOPE.md` §3.
2. **A clone that copies too much manufactures facts.** Copied rows look like this year's
   facts. So: dates shift on the local calendar rather than by elapsed milliseconds (a
   5:00pm deadline moved 364 days by arithmetic lands at 4:00pm across a DST boundary);
   confirmations are never carried, so every cloned deadline arrives unconfirmed and
   every attendee re-invited; and the "shipping plan" the scope asked us to clone turns
   out to be shipments with tracking numbers, which a copy would fabricate — what clones
   is the asset reservations and the deadlines that gate them. The header of
   `src/lib/shows/clone.ts` is the long version; `SCOPE.md` §5c has the rest, and the
   clone screen lists what it will not carry on the page.

**What step 7 added, and where:** `src/lib/auth/mode.ts` — `authMode()`, dependency-free
so `proxy.ts` can read it without pulling PGlite's WASM into the proxy bundle;
`src/lib/auth/clerk.ts` — session → provisioned user; `src/lib/auth/login-methods.ts` —
the login-method gate, pure and testable like the policy engine; `org_login_policies`
(versioned, append-only, a written reason required in both directions) with
`src/lib/auth/login-policy-store.ts` over it; `src/proxy.ts` (Next 16's rename of
Middleware), Clerk's context in Clerk mode and a pass-through otherwise. Its correction,
still standing: a login-method restriction is enforced at sign-in and we are not present
at sign-in, so our gate checks the credentials an account **holds**, not the one it used.
It fails closed. `SCOPE.md` §3, and `/settings/security` says it on screen.

**Next:** step 10 — readiness: checklist CRUD, templates, scoring, and the portfolio
rollup (`SCOPE.md` §10, Phase B). It is the first step that makes a show detail tab
writable.

**Deliberately not built, and visible as such:** the free-text request box §6a describes
(an LLM parsing "Vegas by Tuesday noon, back Thursday night" into constraints) is not
built — but its *seam* is, and is exercised: `raw_request_text` and
`constraints_confirmed_at` are in the schema, the agent refuses to search an unconfirmed
parse, and `availableActions` already surfaces the confirmation step. What is missing is
only the parser. Every step-8 tab is still read-only apart from
intake and cloning. Checklist editing is step 10, the deadline engine step 11, team and
lodging step 12, shipment tracking step 14 — and each tab says so where the interaction
would be, rather than showing a dead button. The nav still grows one entry per screen
that exists. `lib/readiness.ts` is now used for real (the list and the readiness tab);
the off-plan dev console it was written for was abandoned at step 3 and never built.

**Outstanding:** the Duffel adapter — search, hold, *and now purchase* — is verified
against fixtures and mocked HTTP written to the published v2 schema, not a live
response. Nothing has ever been bought. A free test key from duffel.com would confirm
it end to end; the normalizer and purchase tests should pass unchanged against recorded
real responses. Purchasing with that key would produce `live_mode: false` orders, which
the pipeline correctly records as not-spend.

The credit path is the least-verified part of that: `available_airline_credits` (the
credit *values* on an offer) and `airline_credits` on the order payload are written to
what the v2 schema implies, and a live response is what would confirm the field names.
The adapter is built so a wrong guess fails loudly rather than quietly — it refuses to
purchase when an offer names a credit without its value, so the worst case is an
escalation to a human, not a fare paid over an unused credit.

Clerk is in the same position as of step 7: the seam, the linking, and the login-method
gate are tested against a mocked `@clerk/nextjs/server`, and no real Clerk session has
ever reached this app. A free dev instance would confirm the three things worth
confirming — that `auth()` under `proxy.ts` resolves in Next 16, that
`externalAccounts[].provider` and `enterpriseAccounts[].provider` carry the slugs
`normalizeProvider()` expects, and that an impersonation session surfaces `actor.sub`
where `clerk.ts` reads it.

## Ground rules that are easy to violate

- **No fake data behind a real integration.** Missing key → an error naming the env var,
  never an invented fare or delay. Seed data lives only in `scripts/seed.ts`.
- **Clerk says who you are; the database says what you may do.** Role, org, and cost
  center are read from the `users` row, never from Clerk metadata — and a verified
  session that matches no row gets no access and no row created for it.
- **The dev seam closes when Clerk opens.** Both Clerk keys present means
  `DEV_ACTOR_EMAIL` is never consulted again, including when a Clerk lookup fails. A
  fallback that only triggers when the front door jams is a back door.
- **Login-method control checks credentials held, not the method used.** Clerk's session
  does not record the strategy. Under an allowlist the gate fails closed. `SCOPE.md` §3.
- **Nothing under `src/app/(app)/` may be prerendered.** Every page there is resolved per
  actor; the layout's `dynamic = 'force-dynamic'` is what stops a build from shipping one
  person's session to everyone as static HTML.
- **An LLM never decides to spend money.** It parses requests into constraints and
  narrates verdicts. The policy engine is deterministic, pure, and the only thing that
  authorizes. `SCOPE.md` §6a.
- **Dry run is the default and the `recorded` provider cannot buy.** Live purchasing
  needs `FLIGHT_BOOKING_LIVE=true`, a configured real provider, *and*
  `FLIGHT_BOOKING_MAX_CENTS` — the adapter refuses to buy without a ceiling it cannot
  raise. Dry-run bookings are stamped `live: false` with a `dryrun:`-prefixed order id
  so they can never be mistaken for real ones in a query or a report.
- **`booking.live` comes from the provider, never from our intent.** A test key issues
  real-looking orders with `live_mode: false`; those are not spend, and recording them
  as spend would corrupt the true-cost rollup.
- **A traveler's identity is never defaulted.** No date of birth means no ticket and an
  error naming the missing fields — a plausible placeholder would be accepted by the
  carrier and produce a real ticket that does not match the traveler's ID.
- **An approval authorizes an amount, not an offer.** Offers expire in ~30 minutes;
  approval queues do not. Re-price on approval and re-run policy. `SCOPE.md` §6b — and
  the screen must say which of the two the number on it is, via `offerStanding` in
  `src/lib/travel/review.ts`. The agent imports the same predicate; never write a second
  liveness check for the UI.
- **The provider is never chosen by falling back.** `selectProvider` uses Duffel with a
  key, `recorded` only when `FLIGHT_PROVIDER=recorded` says so explicitly, and otherwise
  throws naming the variable. A screen quietly serving replayed offers is indistinguishable
  there from real availability. Screens that replay say so on the page.
- **Seed data is produced by the pipeline, not typed.** `scripts/seed.ts` gets its travel
  requests by running the real agent against the `recorded` provider. Hand-written
  `offer_snapshots` rows would file fares no airline ever quoted as evidence.
- **Cancelling does not tell the airline.** `FlightProvider.cancel()` is implemented and
  called by nothing; `cancelRequest` closes our row and returns credits. The UI says so on
  a ticketed request rather than implying the ticket is gone. `SCOPE.md` §6d.
- **Runs with zero API keys and zero cloud accounts.** `pnpm db:reset && pnpm test`
  must work on a clean clone. Hosting is deferred; do not wire a cloud provider.
- **Every financial row carries a cost center at creation.** Never backfilled.
- **A credit's balance is derived, never assigned.** `ticket_credits.remaining_value_cents`
  is a projection of the append-only entries in `ticket_credit_entries`; only
  `recordEntry()` moves it, by appending a signed delta. Expiry writes the loss off as
  an entry, so "what did we forfeit last year" stays answerable.
- **Credit applied comes from the provider, never from our ledger's intent.**
  `PurchaseResult.creditAppliedCents` is what the carrier actually took off. A ledger
  that drifts from the airline's is worth nothing.
- **A dry run never burns a credit.** The ticket it would have paid for does not exist,
  and the next real booking would find the money gone.
- **A clone never carries a confirmation, and never carries a shipment.** Cloned
  deadlines arrive unconfirmed, cloned attendees re-invited, and shipments, flights,
  lodging, expenses, and the booth number do not come at all. Dates shift on the local
  calendar, not by elapsed milliseconds. `SCOPE.md` §5c.
- **A declined show is kept.** Intake decisions are append-only rows with a written
  reason; `shows.status` is the projection. The declines are the half that argues with
  next year's calendar.
- **Scheduled times are immutable.** Live/estimated times go in separate columns.
- **Money is integer cents.** Providers send decimal strings — parse with
  `src/lib/money/decimal.ts`, never `parseFloat`.
- **Flight times are local airport time.** Resolve with `src/lib/datetime/zoned.ts`
  against the airport's IANA zone, never `new Date()`.

## Commands

```bash
pnpm db:reset     # rm .pglite, push schema, seed — safe any time
pnpm db:seed      # reseed only
pnpm booking:dry-run  # the whole booking loop, headless, no keys, no purchases
pnpm booking:audit <id | idempotency-key>   # the audit trail for one request
pnpm credits          # credit exposure and every live credit
pnpm credits <id>     # one credit's ledger, entry by entry
pnpm credits --sweep  # write off what expired, warn about what will
pnpm dev          # the app: shows, itinerary, security; no Clerk keys needed
pnpm test         # vitest; no keys, no network, no browser
pnpm typecheck
pnpm lint
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user whenever Clerk is not
configured. Seeded roles: `dana@` admin, `marcus@` travel_manager, `priya@` member.
Set both Clerk keys (see `.env.example`) and the seam switches to real sessions.

## Layout

```
src/db/schema.ts              ~35 tables, the domain model
src/app/(app)/               the app shell and its screens; never prerendered
src/app/(app)/travel/        the request list, the form, the audit trail as a page,
                              and the approvals queue
src/lib/shows/                the planning core — pure clone planner, pure intake,
                              the visibility rule, and the org-scoped store
src/proxy.ts                  Next 16's Middleware: Clerk's context, or a pass-through
src/lib/auth/                 the seam — getActor(), the Clerk adapter, login-method
                              control (pure gate + versioned policy store)
src/lib/policy/               the decision layer — pure, deterministic, 47 tests
src/lib/integrations/flights/ provider interface + Duffel adapter + `recorded` replay
src/lib/travel/               the spine — state machine, policy store, booking agent,
                              kill switch, passenger identity, credit ledger, audit
                              trail, notifications; plus step 9's read/present layer:
                              review.ts (pure — what approving does, who may act),
                              provider.ts (env → provider, no fallback), queue.ts
src/lib/money/ src/lib/datetime/  correctness primitives; see ground rules
scripts/seed.ts               the only place seed data lives
```
