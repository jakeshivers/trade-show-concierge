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
- **`UI-REWORK.md`** — **approved, not started, gates nothing.** The app layer's
  consolidation *and* a visual redesign ("modern, bright colors, easy to navigate"), in
  eight tranches. §6 is the foundation survey — Tailwind v4 CSS-first with no config file,
  `lucide-react`/`clsx`/`tailwind-merge` already installed and unused, and the
  `@theme inline` trap that breaks runtime dark mode. **Read §6 before writing any CSS**,
  and read the whole thing before adding a sixth `forms.tsx`.
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

**Done:** steps 1–12 — local Postgres + schema + `getActor()` seam; the policy engine;
the Duffel adapter with the booking schema corrected against real payload shapes; the
request state machine with dry-run booking end to end; live purchasing behind the flag
with a kill switch and a readable audit trail; the ticket credit ledger; Clerk wired
to the seam with per-org login-method control and a first app shell; the planning
core — show list, show detail tabs, My Itinerary, cloning, and intake; the travel
request UI with the approvals queue; readiness — a writable checklist, templates,
scoring that refuses to call an unplanned show ready, and a portfolio ranked on pace;
the service manual deadline engine — a writable register and escalating alerts that
know the difference between money at risk and money already spent; and team & lodging — a
writable roster whose booth coverage refuses to count anybody who has not confirmed or is
not in town, cross-show double-booking compared on travel windows, side events with guest
lists, and hotels whose room block cutoff *is* a deadline register row rather than a second
clock. 431 tests, no keys required.

`pnpm booking:dry-run` walks the whole booking loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the
reasons worth relaxing, the request expiry sweep, the kill switch, credit-first
escalation, the credit expiry sweep, and the audit trail as a person reads it. Read
that output before reading the code; it is the fastest way to understand the spine.
`pnpm booking:audit <id | idempotency-key>` prints the same trail for any one request,
`pnpm credits` prints the credit ledger, and `pnpm deadlines` prints the deadline register
with the alerts the engine would send tonight, in the words it would send them.
`pnpm roster` prints booth coverage across every show — every shift's target beside what it
can *actually* field, the people it cannot count and why, and the shifts a naive roster
count would have called full.

**What step 12 added, and where:** `src/lib/team/` and `src/lib/lodging/`, split the way
everything since step 8 has been. `team/coverage.ts` is pure and holds the whole argument:
`standingFor` says whether one assigned person can actually work one slot (on the roster,
confirmed, in town), `coverageFor` reports `assignedCount` beside `effectiveCount` and
flags a shift **overstated** when a roster count would have called it full, and
`planPersonalClashes` catches the booth shift that runs into the dinner. `team/conflicts.ts`
is cross-show double-booking, compared on `arrives_on → departs_on` and marked `possible`
rather than `certain` where it had to fall back to show dates. `team/edit.ts` is pure
validation plus `describeDetachment` — the sentence naming what un-staffing somebody does
*not* cancel. `team/access.ts` is the staff-vs-answer split. `lodging/edit.ts` refuses a
cutoff that falls inside the stay; `lodging/store.ts` is where a cutoff derives its register
row. Schema: `show_attendees.responded_at` + `updated_at`, `booth_shifts.updated_at`,
`lodgings.cost_center_id` + `updated_at`, `side_events.cost_center_id` + `updated_at`,
`show_deadlines.lodging_id` (unique), and a unique index on `(side_event_id, user_id)`.
Screens: `/shows/[id]/team` is writable — invite, answer, re-window, shifts, assignment,
check-in, side events, guest lists — and `/shows/[id]/lodging` is a new sixth tab.
`pnpm roster` is the coverage model without a screen. The seed builds all of it **through
the real stores**, and grew a fifth show (Sensors Converge, overlapping Automate) so both
conflict cases are live.

**The four corrections step 12 turned up:**

1. **A roster count lies about the future the way a presence count reports the past.** §4
   already keeps `booth_shift` and `shift_presence` apart because rostered ≠ present. There
   is a third state in front of both: *assigned* is not *able to be there*. "3 of 3
   assigned" counts rows in `shift_assignments`, and any of those three can be somebody who
   never accepted, somebody who declined the show, somebody not on the roster at all, or
   somebody whose flight lands after the shift starts — each a hole that renders as a
   filled slot, and a filled slot is the one thing nobody looks at again. Coverage counts
   who can actually stand there, and `overstated` names the shifts the naive count would
   have reassured you about. An *unknown* travel window is not absence: plenty of people
   drive, and flagging every unrecorded window flags the whole roster, which is the same as
   flagging nobody. `SCOPE.md` §5e.
2. **Because coverage counts confirmations, the confirmation has to come from the person.**
   A `confirmed` typed by whoever built the roster is hearsay inside a staffing number. So
   staffing only ever *invites*, `responded_at` records that the subject answered for
   themselves, and answering an invitation plus setting your own travel window is the one
   control a Member gets on the tab. Step 10's split — reporting is not a privilege,
   changing the plan is — arriving from a third direction. `SCOPE.md` §3.
3. **A double-booking is between travel windows, not between show dates.** Comparing show
   dates flags the person who works one show Monday–Tuesday and the next Thursday–Friday —
   the ordinary busy quarter — and a warning that fires on the normal case is one nobody
   reads. But a *missing* window is not a clear either, and most rosters are half-empty of
   arrival dates. So the comparison is the window, falling back to show dates where one is
   absent, and that finding is `possible`, not `certain`, and says which side it guessed.
   `SCOPE.md` §5e.
4. **The room block cutoff must not get a second clock.** §4 makes it first-class because
   missing it is among the most expensive routine mistakes — which is a description of the
   engine step 11 built. A warning banner on the lodging screen would have been a weaker
   copy on a different schedule, and the two would disagree, with the screen you were not
   looking at holding the version you needed. So a cutoff **owns** a register row; the date
   is edited on the hotel record and refused in the register. Two properties fell out of
   the composition rather than being designed: moving the cutoff withdraws the deadline's
   confirmation, and a derived row arrives unowned, which the engine escalates rather than
   addressing to nobody. `SCOPE.md` §5e.

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

**Open alongside the build order (approved, not started):** `UI-REWORK.md` — the app layer has grown by
copy-paste since step 8 (correctly; `ui.tsx` said to wait for ten screens, and there are
now 16). Step 12 produced the fourth and fifth copies and duplicated one zone-formatting
helper twice within itself, which is the signal. It gates nothing and can be done before or
after step 13, but it gets more expensive every step and it carries one real defect — the
roster offers an admin a first-person "I'm going" form on every colleague's row. Needs a
scope call; see `SCOPE.md` §11.11. **Resolved 2026-08-31: option B — consolidation plus a
full visual pass.** The foundation survey in its §6 is the part that would be expensive to
re-derive.

**Next:** step 13 — flight tracking (`SCOPE.md` §10 Phase C): a status provider behind the
usual interface, a flight board, and delay alerts read against the show's move-in time. The
show detail Logistics tab is the last read-only one, and says so where the controls would
be.

**Deliberately not built, and visible as such:** the free-text request box §6a describes
(an LLM parsing "Vegas by Tuesday noon, back Thursday night" into constraints) is not
built — but its *seam* is, and is exercised: `raw_request_text` and
`constraints_confirmed_at` are in the schema, the agent refuses to search an unconfirmed
parse, and `availableActions` already surfaces the confirmation step. What is missing is
only the parser. The readiness tab, its deadline register, the team tab and lodging are all
writable as of steps 10–12; Logistics — shipment tracking (step 14) and chain of custody
(step 15) — is the last read-only tab, and says so where the interaction would be rather
than showing a dead button. **Booth presence has no seed rows**: every seeded show is in the
future and `shift_presence` is a record of what happened, so the check-in control appears on
a shift once it has run rather than inviting somebody to pre-record their own attendance.
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

**Outstanding — and step 12.5 built the tools to close it.** The Duffel adapter is still
verified only against fixtures and mocked HTTP written to the published v2 schema.
Nothing has ever been bought. What is new is that the loop can now be opened:
`pnpm duffel:capture` records real responses into `fixtures/live/` and
`tests/duffel-conformance.test.ts` checks our wire types and the unmodified normalizer
against them, skipping cleanly when there are no captures so a clean clone still needs
zero keys.

**Why that matters more than it sounds:** `duffel/fixtures.ts` is the single source for
the unit tests, the `recorded` provider, *and* the seed's travel requests. So `pnpm test`,
`pnpm booking:dry-run` and every seeded booking all validate against payloads we invented.
That is a closed loop — it proves internal consistency and structurally cannot catch a
wrong field name.

**The credit path is where that bites, and doc research says it is probably already
broken.** `wire.ts` declares two credit fields and hedges between them:
`available_airline_credit_ids` (string ids — real, three independent doc reads agree, and
`normalize.ts` reads it) and `available_airline_credits` (objects carrying values — absent
from the published Offer schema). `client.ts:resolveCredits` reads **only** the second and
throws when it is empty, so if it is fictional then **every credit-first purchase has
always escalated to a human and §5b has never once fired.** It fails loudly, which is
exactly why nothing caught it. The docs describe credit values living on the credit
resource (`GET /air/airline_credits/:id`) and credits applying through the order's
`payments` array as `{type: "airline_credit", airline_credit_id, …}` rather than the
top-level `airline_credits: [{id}]` we send at `client.ts:440`. A third suspect: the
adapter *computes* `creditAppliedCents` instead of reading back what the carrier applied,
which the ground rule below forbids.

None of that is confirmed. Doc sources contradicted each other once during research, so
**the live key is the arbiter** — capture first, change code second. The three questions
are labelled Q1/Q2/Q3 in `scripts/duffel-capture.ts` and asserted in the conformance
suite, each failure naming the file, the line, and the fix.

Clerk is in the same position, and `pnpm clerk:verify` is its equivalent: it reads the
Backend API and prints what really comes back next to what the code assumes. Four claims,
none yet confirmed — that `externalAccounts[].provider` and `enterpriseAccounts[].provider`
carry slugs `normalizeProvider()`'s `oauth_|saml_|oidc_|custom_` strip recognises (if not,
the strip silently no-ops and an org permitting Okta refuses the person using Okta); that
those identity arrays are always arrays and never `undefined` (`credentialsHeld` iterates
them directly, so `undefined` is a 500 rather than the promised fail-closed refusal); that
an impersonation session surfaces `actor.sub` where `clerk.ts` reads it — **a path with
zero test coverage today, since every test passes `actor: null`**; and that `auth()`
resolves under `proxy.ts` in Next 16, whose Clerk branch is also untested. Enterprise SSO
may need a paid plan; if it is unreachable that half stays unverified and this file will
say so rather than implying otherwise.

One Clerk bug *was* confirmed and fixed without any key: `authMode()` returned `'dev'`
when exactly one of the two keys was set, so a deployment with the publishable key
injected and the secret key forgotten served `DEV_ACTOR_EMAIL`'s seeded user to everyone,
silently. One key is now `AuthConfigError`.

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
- **Assigned is not staffed, and staffed is not present.** Booth coverage counts people who
  are on the roster, have confirmed, and are in town for the whole slot; a shift that is
  fully assigned and still short is flagged **overstated**, because that is the one figure
  nobody would have gone looking for. An unknown travel window is unknown, not absent.
  `src/lib/team/coverage.ts`.
- **Only the person confirms their own attendance.** Staffing a show invites;
  `show_attendees.responded_at` records that the subject answered. Coverage counts
  confirmations, so one typed on somebody's behalf is hearsay inside a staffing number.
- **A double-booking is between travel windows, not between show dates** — and where a
  window is missing the finding is `possible`, never `certain`, and says which side it had
  to guess. `src/lib/team/conflicts.ts`.
- **Un-staffing somebody cancels nothing outside this app.** The ticket is with the airline
  and the room is with the hotel. The store names what is attached and refuses once; the
  second press carries the acknowledgement. Same rule as cancelling a ticketed request.
- **A room block cutoff owns a deadline register row; it never gets a second clock.**
  `show_deadlines.lodging_id` is the link, the date is editable only on the lodging record,
  and moving it withdraws the deadline's confirmation. Two editable copies of one date is
  how the date gets missed. `src/lib/lodging/store.ts`, `SCOPE.md` §5e.
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
pnpm roster           # booth coverage everywhere: target, assigned, who can actually work it
pnpm roster <show id> # one show, shift by shift
pnpm duffel:capture   # record what the real Duffel API says into fixtures/live/ (needs a test key)
pnpm duffel:capture --search   # stop after search; create no orders
pnpm clerk:verify     # what a real Clerk instance returns, vs. what our code assumes
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
src/app/(app)/shows/[id]/team/     the writable roster, booth coverage, side events
src/app/(app)/shows/[id]/lodging/  hotels, room blocks, and the derived deadline
src/lib/shows/                the planning core — pure clone planner, pure intake,
                              the visibility rule, and the org-scoped store
src/lib/readiness/            scoring (a breakdown, and `null` for unplanned), the
                              built-in templates + idempotent apply planner, the edit
                              rules, who may edit vs. report, the pace model, the store
src/lib/deadlines/            the §5a engine — alerts.ts (pure: thresholds, audience,
                              tense, dedupe-by-date, the one exposure model), edit.ts
                              (local time of day, the written reason), access.ts, store.ts
                              (org-scoped rows + the sweep)
src/lib/team/                 the roster — coverage.ts (pure: assigned vs. able to be
                              there, `overstated`, personal clashes), conflicts.ts
                              (cross-show, on travel windows, certain vs. possible),
                              edit.ts, access.ts, store.ts
src/lib/lodging/              hotels, room assignments, and the cutoff that derives a
                              deadline register row rather than a second clock
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
