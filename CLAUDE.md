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

**Done:** steps 1–11 — local Postgres + schema + `getActor()` seam; the policy engine;
the Duffel adapter with the booking schema corrected against real payload shapes; the
request state machine with dry-run booking end to end; live purchasing behind the flag
with a kill switch and a readable audit trail; the ticket credit ledger; Clerk wired
to the seam with per-org login-method control and a first app shell; the planning
core — show list, show detail tabs, My Itinerary, cloning, and intake; the travel
request UI with the approvals queue; readiness — a writable checklist, templates,
scoring that refuses to call an unplanned show ready, and a portfolio ranked on pace;
and the service manual deadline engine — a writable register and escalating alerts that
know the difference between money at risk and money already spent. 387 tests, no keys
required.

`pnpm booking:dry-run` walks the whole booking loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the
reasons worth relaxing, the request expiry sweep, the kill switch, credit-first
escalation, the credit expiry sweep, and the audit trail as a person reads it. Read
that output before reading the code; it is the fastest way to understand the spine.
`pnpm booking:audit <id | idempotency-key>` prints the same trail for any one request,
`pnpm credits` prints the credit ledger, and `pnpm deadlines` prints the deadline register
with the alerts the engine would send tonight, in the words it would send them.

**What step 11 added, and where:** `src/lib/deadlines/` — the service manual deadline
engine, split the way the spine and the planning core are. `alerts.ts` is pure and holds
the entire argument: the T-30 / T-14 / T-3 / day-of thresholds, the 45-day confirmation
chase, who each alert is addressed to, which *tense* it is written in, the dedupe key that
voids itself when a date moves, and `summarizeExposure` — the one exposure model, shared
by the register screen, the portfolio and the CLI. `edit.ts` is pure validation: a deadline
carries a local *time of day*, penalties parse through `money/decimal.ts`, and
`not_applicable` needs a written reason. `access.ts` is the report / confirm /
change-the-plan split. `store.ts` is the only file touching rows, org-scoped at the source,
and carries `sweepDeadlineAlerts`. `show_deadlines` gained `status`, `status_note`,
`completed_by_id`, `confirmed_by_id` and `updated_at`. The register on
`/shows/[id]/readiness` is writable — add, edit, own, confirm, complete, waive — and each
row shows what the engine will say about it next and to whom. `pnpm deadlines` /
`pnpm deadlines --sweep` is the engine without a screen. The seed grew an unconfirmed, an
unowned and a missed deadline so all four alert cases are live, and produces its alert rows
by **running the real sweep**.

**The four corrections step 11 turned up:**

1. **"A human confirms a deadline before it alerts" means silence on the rows most likely
   to be wrong.** Every cloned deadline is a prediction by construction (§5c), and those
   are exactly the dates that pass unnoticed. But quoting "$3,125 at risk on Feb 3" for a
   date nobody checked is a fabricated bill, and one of those teaches a team to close the
   next alert unread. So an unconfirmed deadline is chased as a **date** — earlier, at 45
   days, and without its penalty figure — and confirmation gates the claim about *money*,
   not the reminder. Typing a deadline never confirms it, and moving a confirmed date
   withdraws the confirmation, or an edit launders a guess into a quoted figure.
   `SCOPE.md` §5a.
2. **Past the date, "at risk" is false and the audience is wrong.** The surcharge is not at
   risk, it is incurred, and there is nothing to hurry about — and the owner who needed the
   reminder is not the show lead who needs the cost. A missed deadline gets one past-tense
   alert to whoever runs the show, and does not repeat nightly. The portfolio counts those
   cents as *incurred*, not "exposed". `SCOPE.md` §5a and §5d.
3. **An unowned deadline is the likeliest to be missed and, addressed to its owner, reaches
   nobody.** `owner_id` is nullable and real registers are full of nulls, so an
   owner-addressed engine sends zero alerts on precisely those rows, silently. Unownedness
   escalates instead of muting: the alert goes to the show runners and names the missing
   owner as the thing to fix first.
4. **An alert is a claim about a date, so the dedupe key carries the date.** The credit
   ledger can key expiry warnings on the bucket alone because a credit's expiry never
   moves. A deadline's does — that is half of what editing the register is for — and a
   bucket-only key would leave "3 days left" standing for a date that no longer exists
   while suppressing the one the new date deserves.

**What step 10 added, and where:** `src/lib/readiness/` — the first *writable* show
detail tab, and the module that replaced the nine-line placeholder `lib/readiness.ts`.
Split the way the spine and the planning core are, pure decisions apart from the rows:
`score.ts` returns a **breakdown, not a number**, and `null` — *unplanned* — for a show
with no checklist; `templates.ts` holds the built-in library (25-task standard, 8-task
tabletop) and a pure apply planner that is idempotent and dates every task on the show's
local calendar; `edit.ts` is pure validation plus the written-reason rule for blocked and
skipped; `access.ts` is the one permission split worth arguing about (below); `portfolio.ts`
is the pace model and the ranking; `store.ts` is the only file that touches the database,
org-scoping at the source like `shows/store.ts`. `show_tasks` gained `status_note`,
`template_key` (unique per show), `completed_by_id`, `updated_at`. Screens: the readiness
tab at `/shows/[id]/readiness` is writable — status control per task, add/edit/delete for
whoever runs the show, template apply — and `/readiness` is the portfolio rollup, in the
nav. The seed builds MedTech's checklist by **running `applyTemplate` and `setTaskStatus`
for real**, not by typing rows.

**The four corrections step 10 turned up:**

1. **`readinessScore([]) === 100` said an unplanned show was a finished one.** Harmless on
   one page; on a portfolio ranked by score it means the show nobody has touched sorts
   above every show somebody is working on — the one that most needs attention is the one
   the screen most reassures you about. The score is `number | null` now, `null` renders
   as "No checklist", and never as 0% (reads as behind) or 100% (reads as done).
   `SCOPE.md` §5d.
2. **A single percentage hides the shape of what is left.** Blocked and not-started both
   earn zero and are different problems; overdue does not move the number at all, because
   the score has no clock. Scoring returns counts by status, overdue against an explicit
   `asOf`, and the share of remaining *weight* sitting in blocked tasks — and both screens
   lead with what is wrong rather than with the headline. `SCOPE.md` §5d.
3. **Skipping is a change to the plan wearing the costume of a status.** A skipped task
   leaves the denominator, so "skip it" is the fastest way to raise a readiness score
   without doing anything. It needs a written reason and the same authority as deleting the
   task — while *reporting progress* needs none, because a checklist only a manager can
   tick is maintained by asking around, which is the spreadsheet we are replacing.
   `src/lib/readiness/access.ts`, `SCOPE.md` §3 and §5d.
4. **A portfolio ranked by readiness buries the emergency.** 40% ready eight months out is
   on schedule; 70% ready in nine days is not. Readiness only means anything against the
   clock, so `portfolio.ts` ranks on the gap to a pace model — linear over the 120 days
   before open — and the page says on it that the curve is a heuristic rather than letting
   a number imply precision it does not have. `SCOPE.md` §5d.

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

**Next:** step 12 — team & lodging (`SCOPE.md` §10 Phase B): attendees, booth shifts and
the conflicts between them, hotels, room blocks, and side events. The show detail Team and
Logistics tabs are still read-only and say so where the controls would be.

**Deliberately not built, and visible as such:** the free-text request box §6a describes
(an LLM parsing "Vegas by Tuesday noon, back Thursday night" into constraints) is not
built — but its *seam* is, and is exercised: `raw_request_text` and
`constraints_confirmed_at` are in the schema, the agent refuses to search an unconfirmed
parse, and `availableActions` already surfaces the confirmation step. What is missing is
only the parser. The readiness tab and its deadline register are both writable as of steps
10 and 11; team and lodging (step 12) and shipment tracking (step 14) are still read-only,
each saying so where the interaction would be rather than showing a dead button.
**Deadline alerts land in the `alerts` table and nowhere else** — there is no feed screen
(step 16) and no transport (step 20), so `pnpm deadlines` is how a person reads them
today. The row is the durable record that the notification was owed; a transport added
later cannot erase it. **Extraction from the manual PDF is not built** — §5a's post-v1 LLM
step — but the columns it writes (`extracted_from_document`, `confirmed_at`) and the rule
it must obey (nothing extracted is quoted in dollars until a human confirms it) are both
live and enforced by the engine today. **Checklist templates are code, not rows**: the library in
`src/lib/readiness/templates.ts` is versioned in git and an org-editable template builder
is deliberately deferred until the standard list has been used and argued with, which the
templates card says on the page. The nav still grows one entry per screen
that exists.

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
- **An empty checklist is unplanned, not ready.** `scoreChecklist` returns `null`, never
  100 and never 0, and every caller has to say what it renders for that. A show nobody
  has planned must not outrank a show somebody is working on. `SCOPE.md` §5d.
- **Skipping a task is an edit, not a status.** It leaves the readiness denominator, so it
  needs a written reason and the authority to change the plan — while moving your own task
  between not-started, in-progress, blocked and complete needs nothing.
  `src/lib/readiness/access.ts`.
- **Applying a template twice adds nothing, and the unique index is what says so.** The
  plan makes it visible; `(show_id, template_key)` makes it true. A template never re-dates
  or edits a task somebody has already started, and it creates already-late tasks rather
  than hiding them.
- **A deadline nobody confirmed is chased as a date, never quoted as an amount.** The
  penalty figure behind a guessed date is a fabricated bill, and one of those teaches a
  team to close the next alert unread. Typing a deadline does not confirm it, and moving a
  confirmed date withdraws the confirmation. `src/lib/deadlines/alerts.ts`, `SCOPE.md` §5a.
- **Past its date, a penalty is incurred, not at risk.** The tense is the product: "at
  risk" says hurry, and there is nothing left to hurry about. A missed deadline alerts
  once, in the past tense, to whoever runs the show rather than to the owner who needed the
  reminder — and the portfolio counts those cents as incurred.
- **An unowned deadline escalates; it never goes quiet.** `owner_id` is nullable, so an
  owner-addressed alert on an unowned row reaches nobody, silently — which is exactly the
  row most likely to be missed. It goes to the show runners and names the missing owner.
- **A deadline alert is keyed to the deadline *and its date*.** Move the date and every
  alert already sent about it is void. A bucket-only key (which is right for a credit,
  whose expiry never moves) would leave "3 days left" standing for a date that no longer
  exists. `src/lib/deadlines/alerts.ts`.
- **A deadline carries a time of day, read in the show's zone.** A task can be due "the
  4th" and land at 5pm local; a warehouse that closes at 4:00pm cannot, and the hour is a
  drayage penalty.
- **Marking a deadline "does not apply" is an edit, not a status.** It takes money out of
  the show's exposure, so it needs a written reason and the authority to change the plan —
  the same rule `skipped` needed, reached from an unrelated direction.
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
pnpm deadlines        # the deadline register, its exposure, and tonight's alerts
pnpm deadlines --sweep # write those alerts; run twice, nothing is written the second time
pnpm dev          # the app: shows, itinerary, security; no Clerk keys needed
pnpm test         # vitest; no keys, no network, no browser
pnpm typecheck
pnpm lint
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user whenever Clerk is not
configured. Seeded roles: `shelley@` admin, `marcus@` travel_manager, `priya@` member.
Set both Clerk keys (see `.env.example`) and the seam switches to real sessions.

## Layout

```
src/db/schema.ts              ~35 tables, the domain model
src/app/(app)/               the app shell and its screens; never prerendered
src/app/(app)/travel/        the request list, the form, the audit trail as a page,
                              and the approvals queue
src/app/(app)/readiness/     the portfolio rollup, ranked on pace rather than on score
src/lib/shows/                the planning core — pure clone planner, pure intake,
                              the visibility rule, and the org-scoped store
src/lib/readiness/            scoring (a breakdown, and `null` for unplanned), the
                              built-in templates + idempotent apply planner, the edit
                              rules, who may edit vs. report, the pace model, the store
src/lib/deadlines/            the §5a engine — alerts.ts (pure: thresholds, audience,
                              tense, dedupe-by-date, the one exposure model), edit.ts
                              (local time of day, the written reason), access.ts, store.ts
                              (org-scoped rows + the sweep)
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
