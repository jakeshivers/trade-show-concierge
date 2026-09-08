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
- **`UI-REWORK.md`** — **done, all eight tranches**, plus findings §9–§12 added afterwards.
  §6 is the foundation survey — Tailwind v4 CSS-first with no config file, and the
  `@theme inline` trap that breaks runtime dark mode. **Read §6 before writing any CSS.**
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

Phase A (**the vertical slice through the booking spine**) is done; Phase B is done; Phase D
has started. **Steps 1–20, 22, 23 and 24 are done.** Step 21 is **half done and marked `[~]`
in §10**: the transport and the scheduler shipped, hosting and the SSO rollout did not and
cannot here — both need a cloud account or a real IdP, and §9's ground rule forbids wiring
one unasked. 1,118 tests, no keys required.

Read `git log` for the long version of any step: each commit documents what was learned
building it, and this file keeps only what a fresh session needs before touching code. The
**Ground rules** section below is the enforcement layer — every rule a step discovered is
restated there, so that section is the one to read in full.

### The practice, and it has now paid off six times

Steps 17, 19, 22, 23 and 24 each found a real defect by **reading the CLI's output** —
`onConflictDoNothing` muting recurrences, `SOURCE_LABEL` mislabelling a whole engine, a
deduplicated reading counted as unread, a crate count that made freight invisible, and two in
one sitting on presence. None was caught by a test, because in every case the test had been
written to the same wrong rule. **Run the CLI and read what it says** before believing a green
suite.

**A stale `next dev` will lie to you about everything below.** `pnpm db:reset` deletes
`.pglite` out from under a running server, which then serves the pre-reset database from a
deleted inode — new columns and enum values do not exist in it, and a section gated on a query
can render as absent with no error anywhere; once the inode is really gone the server throws
`ErrnoError { errno: 44 }` and every request hangs for minutes. Restart `pnpm dev` after
`db:reset` before believing a screen. `db:reset` prints that sentence when it finishes, because
knowing the rule did not stop it happening twice.

**And a stale service worker will lie harder, across the whole app.** `public/sw.js` served
`/_next/static/` cache-first on a comment asserting those names are content-hashed — true of
`next build`, false of `next dev`, where Turbopack reuses chunk names as files change. That
pins one build's bytes into the *browser* permanently: an hour-old chunk against a current
render, `is not a function`, hydration failure, surviving a dev restart because nothing on the
server can reach the stale copy. The worker's scope is `/`, so the blast radius was the whole
app rather than `/day-of`. It is **told** which mode it is in (`/sw.js?mode=dev`, from
`_register.tsx`) rather than sniffing a hostname; production unchanged, dev network-first with
a cache fallback. `CACHE` is `day-of-v2` so a poisoned browser heals on next load. If one is
stuck: DevTools → Application → Service Workers → Unregister, or Clear site data.

**Do not run `prettier` on this repo.** There is no config, so its defaults rewrite every
quote and re-wrap every blurb — 132 lines of churn in one file to add six.

### The spine and the seam (steps 1–7)

Local Postgres + schema + the `getActor()` seam; the pure policy engine (47 tests); the Duffel
adapter with the booking schema corrected against real payload shapes; the request state
machine with dry-run booking end to end; live purchasing behind a flag with a kill switch and a
readable audit trail; the ticket credit ledger; and Clerk wired to the seam with per-org
login-method control and a first app shell.

`pnpm booking:dry-run` walks the whole booking loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the reasons
worth relaxing, the request expiry sweep, the kill switch, credit-first escalation, the credit
expiry sweep, carrier preference run three times against three fares (the org's, the traveler's,
and neither priced), and the audit trail as a person reads it. **Read that output before reading the
code**; it is the fastest way to understand the spine.

Step 7's correction, still standing: a login-method restriction is enforced at sign-in and we
are not present at sign-in, so our gate checks the credentials an account **holds**, not the
one it used. It fails closed. `SCOPE.md` §3, and `/settings/security` says it on screen.
`src/lib/auth/mode.ts` is dependency-free so `proxy.ts` can read it without pulling PGlite's
WASM into the proxy bundle. One Clerk bug was confirmed and fixed with no key: `authMode()`
returned `'dev'` when exactly one of the two keys was set, so a deployment with the publishable
key injected and the secret forgotten served `DEV_ACTOR_EMAIL`'s seeded user to everyone,
silently. One key is now `AuthConfigError`.

### The planning core (step 8)

`src/lib/shows/` — pure decisions apart from the rows, the split every step since has followed.
`clone.ts` is a pure planner (source + options → a plan of what to write, plus plain-language
lists of what it carried and what it deliberately did not); `intake.ts` is pure validation and
the decidable-status guard; `visibility.ts` holds the one visibility rule the screens share;
`store.ts` is the only file touching the database and org-scopes at the source rather than
loading-then-checking. `show_decisions` is append-only with a written rationale required in
both directions. The datetime primitives gained `instantToZoned`,
`shiftDaysPreservingLocalTime` and `calendarDaysBetween`. Screens: `/shows`, `/shows/new`,
`/shows/[id]` with tab routes, `/shows/[id]/clone`, `/itinerary`.

Its corrections are all restated as ground rules below.

### The travel UI (step 9)

`src/lib/travel/review.ts` is the design core and is pure: `offerStanding` answers *what does
approving this actually do right now* in four cases (live / held-and-guaranteed / held-but-not /
expired), `STATUS` says what each machine status means to a person waiting on one, and
`availableActions` returns what an actor may do **with a reason attached to every refusal**.
`provider.ts` selects the flight provider from the environment and is the first code to do so.
`queue.ts` is the org-scoped, `travelerScope`-narrowed read layer. Screens: `/travel`,
`/travel/new`, `/travel/[id]` (which is `pnpm booking:audit` as a page, reusing
`getAuditTrail`) and `/travel/approvals`.

Its corrections are all restated as ground rules below.

### Readiness (step 10)

`src/lib/readiness/` — the first *writable* show tab. `score.ts` returns a **breakdown, not a
number**, and `null` — *unplanned* — for a show with no checklist; `templates.ts` holds the
built-in library (25-task standard, 8-task tabletop) and a pure apply planner that is idempotent
and dates tasks on the show's local calendar; `edit.ts` is pure validation plus the
written-reason rule; `access.ts` is the permission split; `portfolio.ts` is the pace model and
the ranking. Screens: `/shows/[id]/readiness` writable, `/readiness` as the portfolio rollup.
The seed builds MedTech's checklist by **running `applyTemplate` and `setTaskStatus` for real**.

Its corrections are all restated as ground rules below.

### The deadline engine (step 11)

`src/lib/deadlines/` — the service-manual engine, and this product's #1 feature. `alerts.ts` is
pure and holds the whole argument: the T-30 / T-14 / T-3 / day-of thresholds, the 45-day
confirmation chase, who each alert is addressed to, which *tense* it is written in, the dedupe
key that voids itself when a date moves, and `summarizeExposure` — the one exposure model,
shared by the register screen, the portfolio and the CLI. `edit.ts` is pure validation (a local
time of day, penalties through `money/decimal.ts`, a written reason for `not_applicable`).
`store.ts` carries `sweepDeadlineAlerts`. The register on `/shows/[id]/readiness` is writable
and each row shows what the engine will say about it next and to whom. The seed grew an
unconfirmed, an unowned and a missed deadline so all four alert cases are live, and produces
its alert rows by **running the real sweep**.

Its four corrections — a date is chased, never an amount; past the date a penalty is *incurred*
and the audience changes; an unowned deadline escalates; the dedupe key carries the date — are
all restated as ground rules below.

### Team & lodging (step 12)

`src/lib/team/coverage.ts` is pure and holds the whole argument: `standingFor` says whether one
assigned person can actually work one slot (on the roster, confirmed, in town), `coverageFor`
reports `assignedCount` beside `effectiveCount` and flags a shift **overstated** when a roster
count would have called it full, and `planPersonalClashes` catches the booth shift that runs
into the dinner. `team/conflicts.ts` is cross-show double-booking compared on
`arrives_on → departs_on`, marked `possible` rather than `certain` where it fell back to show
dates. `team/edit.ts` carries `describeDetachment` — the sentence naming what un-staffing
somebody does *not* cancel. `lodging/edit.ts` refuses a cutoff inside the stay;
`lodging/store.ts` is where a cutoff derives its register row. Schema:
`show_attendees.responded_at`, `booth_shifts.updated_at`, `lodgings`/`side_events` cost centers,
`show_deadlines.lodging_id` (unique), unique `(side_event_id, user_id)`. Screens:
`/shows/[id]/team` writable and `/shows/[id]/lodging` as a sixth tab. The seed builds all of it
through the real stores and grew a fifth show (Sensors Converge, overlapping Automate) so both
conflict cases are live.

Its corrections are all restated as ground rules below.

### Flight tracking (step 13)

`src/lib/integrations/flightstatus/` — the second integration behind an interface. `types.ts`
reports what a carrier says about one leg at one moment, and `NoRecord` is deliberately not
`phase: 'unknown'`. `aeroapi/` is FlightAware AeroAPI v4 (wire / normalize / client), written
to the published schema and **never run against a live key**. `recorded/` replays AeroAPI-shaped
payloads through the *real* normalizer; what it records is a **shape** projected onto whichever
leg it is asked about, so a canned block time never reports a transcontinental delay on a
shuttle. `src/lib/flights/status.ts` is pure: `freshnessOf` / `effectiveStatus`,
`bufferVerdict` (§7's arrival buffer re-run against live times, reading the required hours out
of the *resolved travel policy*) and `reconcile`, which keeps a carrier's re-timing apart from
a delay. `board.ts` orders by what is wrong rather than by what leaves next. `store.ts`
org-scopes through the *traveler* rather than through the nullable show, and carries
`materializeFlights`. Schema: `flights.show_id` nullable, `leg_direction`, both airport zones,
`provider_scheduled_*`, `schedule_changed_at`, `diverted_to_airport`, `status_provider`,
`booking_id` + `segment_index` (unique). The seed produces flight status by **running the real
sweep**, pinning which payload each leg replays: a red-eye that loses its buffer, a roomy
morning flight that is fine, and a flight *home* that is late and deliberately silent.

Its corrections are all restated as ground rules below.

### Shipping (step 14)

`src/lib/integrations/shipping/` — EasyPost Tracker v2 (wire / normalize / client, **never run
against a live key**), plus a `recorded` provider that replays EasyPost-shaped payloads through
the real normalizer, projecting a recorded **shape** onto the crate's actual transit window and
handing back only scans that have already happened — so a replay can never show a crate
delivered on the day its label was printed, and `stalled`, whose whole content is the *absence*
of recent scans, stays distinguishable from `on_time`. Its scan locations are roles ("Origin
hub"), not cities. `src/lib/shipping/status.ts` is pure: the two-edged `windowVerdict` with
`too_early` as a real standing, `stallOf`, `freshnessOf` / `effectiveStatus`, and `reconcile`,
which captures the carrier's promise *once* so `brokenSincePromise` can ever be true.
`alerts.ts` carries `planReturnGapAlert` — the one planner in the product that fires on an
absence. `board.ts` orders by what is wrong. `access.ts`: confirming a crate reached the booth
is available to **anybody**. Schema: `shipments.consignment`, `receiving_opens_at`, `owner_id`,
`received_at` / `received_by_id`, `promised_delivery`, `estimate_changed_at`,
`tracking_provider`, an `unknown` status; `shipment_events.source` + `fingerprint` unique on
`(shipment_id, fingerprint)`. Screens: `/shipping`, and the show's Logistics tab became
writable — it was the last read-only one. `_present.tsx` is the shipment vocabulary both
screens render through, because the moment two screens draw a crate they can disagree about
what `too_early` looks like.

**The seed grew two shows, and that was a finding rather than a convenience.** Every seeded
show was fifty or more days out, so no crate had plausibly shipped and a shipping feature
seeded against that calendar would have had an empty timeline on every row. There is now a
**live** show (a crate delivered to a dock nobody has confirmed at the booth, one that missed
show-site receiving, one that has gone quiet) and a **prior-year** show that moved out seven
weeks ago with outbound freight and nothing recorded coming back.

Five corrections, all ground rules below: a crate has a window, not a deadline, and early is a
failure too; delivered is not received, and only a person can close that gap; silence is the
failure mode and nothing in the payload reports it, which is why the sweep plans against every
shipment rather than the ones that changed; §5f's rule about the leg home inverts, so the sharpest
alert here has no shipment row behind it; and a poll returns the whole timeline, not a delta, which
is what the fingerprint is for. One small bug proved the general rule: `expectedArrival` trusted
`estimated_delivery` on a shipment with **no tracking number**, so a crate nobody had handed to a
carrier was reported as *"will miss the receiving deadline"* — a confident claim about a truck,
sourced from nothing, hiding the actual problem.

### The conversational assistant (step 15)

`src/lib/integrations/llm/` — the fourth integration, and the first where a vendor SDK exists.
`types.ts` performs **one exchange and runs no loop**, because running a tool means choosing an
actor to run it as and that choice must not live in an adapter. `anthropic/client.ts` is the
Messages API through `@anthropic-ai/sdk`, so unlike the others there is **no `wire.ts` and no
fixture file of payloads we invented** — the vendor ships the types. `scripted/` is the zero-key
model and it replays **tool plans, never prose**.

`src/lib/assistant/tools.ts` is the whole step: fifteen tools, every one an existing org-scoped
store function called as the asking actor through the same `access.ts` gate a screen goes
through — no query, no join, no org id from the model. `access.ts` is subtractive, so a withheld
tool is never described. `prompt.ts` carries **tense and nothing load-bearing**. `loop.ts` is a
manual loop with three bounds of ours (`MAX_TURNS`, `MAX_TOOL_CALLS`, and a `max_tokens` stop
that is never presented as an answer). `draft.ts` refuses to file without the person's own
words, refuses to guess a time zone, and carries a `FlightProvider` whose every method rejects.
`serialize.ts` sends instants rather than formatted local strings. `store.ts` scopes a
conversation to a **user**. Schema: `assistant_conversations` (provider recorded per
conversation) and `assistant_messages` (append-only; a `tool` row keeps the validated input and
the store's actual result, because the prose is the paraphrase). Screens: `/assistant` and
`/assistant/[id]`, with each tool step rendered *beside* the answer and openable. The seed
produces two transcripts by **running the real loop against the real tools** — a member and an
admin asking questions whose *results* differ while nothing about the prompt does.

Its corrections are all restated as ground rules below.

### Assets & collateral (step 16)

`src/lib/assets/custody.ts` is pure and holds three arguments: the seven-state custody chain,
`availabilityFor` (three refusals, each with its reason — **reserved is not available and
available is not serviceable**), and `freightCoverage`, where assets meet step 14's shipping
rows. `conflicts.ts` compares **reservation windows rather than show dates** and adds
`turnaround` as a `possible` finding. `inventory.ts` is the collateral half — on hand minus
committed, low stock judged on what is *free*, an allocation's three states, and the projection
over the ledger. `alerts.ts` carries both dedupe-key shapes at once (§5a's date for a
reservation, §5b's bucket for a quantity). `edit.ts` requires a condition on return and a
written note when it comes back worse. `access.ts` puts sign-out, check-in and counting a shelf
in **anybody's** hands. `store.ts` scopes through the **asset's own org** — a third posture
beside shipping's show and flights' traveler, falling out of the domain: a booth belongs to the
company between shows, which is most of its life and all of the time it goes missing.

Schema: `assets.cost_center_id` + a unique asset tag; `asset_reservations.condition_on_checkout`,
`returned_by_id`, unique `(asset, show)`; `collateral_items.cost_center_id` + unique SKU; a new
append-only **`collateral_entries`** with signed deltas and a `(allocation, kind)` rail;
`collateral_allocations.issued_at` / `issued_by_id` / `returned_at` / `returned_by_id`. Screens:
`/assets`, and the **Logistics tab now renders three models on one page** — the crate, what is
inside it, and the collateral — which is why step 16 came after step 14. The seed builds it
through the real stores, including a booth signed out to last spring's Detroit show and never
checked in, which is the sentence the schema comment has carried since step 1.

Its corrections are all restated as ground rules below.

### The alerts feed and the true-cost rollup (step 17)

`alerts/feed.ts` is pure and is the whole argument: an alert row records that a notification was
**owed at an instant**, and a feed shows it later, so `standingOf` reports which of five things
it has become — `new`, `repeating`, `unchecked`, `acknowledged`, `resolved`. `linkFor` reads
`source` rather than regexing a dedupe key. `groupFeed` collapses one sentence said by many
rows. `alerts/access.ts` refuses an org-wide read at all. `alerts/store.ts` is the **only** file
that writes the table: `syncConditionAlerts` takes an engine's complete current plan, upserts
it, and **closes every key the engine no longer plans**. `alerts/sweep.ts` runs every engine and
names the ones that could not run. `cost/rollup.ts` is pure and holds the six refusals;
`cost/store.ts` loads every show's inputs in a fixed number of queries so the portfolio and a
show's tab cannot disagree; `cost/access.ts` is Travel Manager and Admin. Schema: `alerts`
gained `source`, `kind` (`condition` vs `notice`), `last_seen_at`, `occurrences`, `resolved_at`,
`acknowledged_by_id`. Screens: `/alerts`, `/cost`, a **Cost** tab not rendered at all for a
Member, and one line on the overview above everything else. The seed completes one deadline and
re-runs the sweep so a genuinely **resolved** row exists, and acknowledges one alert *as the
person it was addressed to*.

Its corrections are all restated as ground rules below.

### Leads & meetings (step 18)

`src/lib/leads/` — the first table here holding personal data about somebody who is not our
user. `coverage.ts` is pure and is the argument §8c was missing: a count is introduced with
**"at least"** whenever anybody rostered on a booth shift recorded nothing, the silent people
are *named*, "on the booth" is a shift assignment rather than attendance, an unrostered show is
`unknown` and never 0 of 0 — and `mayQuotePerLead` **withholds** cost per lead over a thin
denominator instead of publishing it with an asterisk. `consent.ts` is the GDPR half: `unknown`
is a recorded answer rather than a default, consent with no timestamp or no recorded notice is a
claim about consent, and **erasure is redaction**. `parse.ts` is a CSV reader (quotes, embedded
newlines, CRLF, Excel's BOM) plus an import planner in which accepted + rejected + duplicate
always equals the row count. `dedupe.ts` is identity *within a show* — the scanner's reference,
then the email, and name-plus-company as a suspicion that is never auto-merged — and
`findPossiblePairs` is what makes that refusal honest rather than a nicer word for discarded.
`alerts.ts` mostly says nothing. `intake.ts` is the REST credential, and an `IntakePrincipal` is
deliberately not an `Actor`. `access.ts` splits the count from the person behind it, and capture
from erasure.

Schema: `leads` gained `source`, `import_id`, `external_ref` (unique per `(show, ref)`),
`duplicate_of_id`, `consent_notice`, `redacted_at` / `redacted_by_id` / `redaction_reason`;
`meetings` gained `no_show_at` and `created_by_id`; new append-only **`lead_imports`** (which
keeps every rejection with its row number) and **`intake_keys`** (hash only, show-scoped,
revoked rather than deleted). Screens: `/leads`, a **Leads** tab shown to everybody, and
`/settings/intake`. `POST /api/intake/leads` is the first route here that authenticates without
`getActor()`, and `src/proxy.ts` marks `/api/intake` public in Clerk mode because it carries its
own credential. The assistant gained `lead_capture` — counts and coverage, no personal data. The
seed captures at the booth as four different people, posts through the **real** intake path
including the retry a scanner makes on bad wifi, imports a CSV through the **real** parser (one
row with no name, one duplicate — both rejected by the planner rather than by hand), and runs
the sweep **before and after** the import so a genuinely resolved lead alert exists.

Its corrections are all restated as ground rules below.

### ROI (step 19)

`src/lib/integrations/crm/` — the fifth integration, and the first where §11.6's "one well
rather than both adequately" resolved to *one at a time* rather than to one. `types.ts` carries
**exactly one write method**, because §8b's "never own the pipeline" only survives a second
customer if the interface is structurally unable to widen; it also splits `matchByExternalId`
from `matchByEmail`, because one sends nothing about a person and the other sends a stranger's
address to a third party. `salesforce/` is REST v60 + SOQL, written to the published reference
and **never run against a live org**. `hubspot/client.ts` is **declared and throws on every
method**. `recorded/` replays a conversion *shape*, not a pipeline. `roi/provider.ts` selects
with **no fallback** and answers `hubspot` with what finishing it takes.

`src/lib/roi/attribution.ts` is pure and is the honest hard part: five refusals, of which the
first — first touch is decided across the **whole calendar** — is the one a naive implementation
gets wrong forever and silently. `rollup.ts` is pure and holds §5k: the two-floors rule, the
replayed-pipeline withholding, matching coverage as a third floor, §8e's maturity horizon as an
enforcement rather than a footnote, and `Quotable` — a figure or the sentence saying why there is
not one. `alerts.ts` is the **seventh engine**, reports an unanswered question rather than a
broken thing, and deliberately never alerts on a low multiple. `store.ts` gates email matching
on `marketabilityOf` and keeps `withheld` apart from `unmatched` in every count. `access.ts`
inherits the cost gate, and the assistant gained `show_roi` — the **second tool ever withheld
from a Member**.

Schema: `crm_links` (how a match was made, and whether the attribution went back),
`crm_opportunities` (the CRM's facts, cached — and **no attribution stored**, because it is
derived at read time so changing the window re-derives rather than migrates) and `crm_sync_runs`
(append-only, keeps every refusal); `show_outcomes` gained `attribution_model`, `source`,
`replayed`. Screens: `/roi`, a **ROI** tab not rendered for a Member, `/settings/crm`. **The
seed grew an eighth show and that was the finding**: every show was either in the future or six
weeks closed, so every ROI verdict was correctly withheld and the dashboard could not be shown
working at all. MedTech Summit 2025 is fourteen months back with a *complete* cost — the only
show whose multiple is quotable — and one buyer on it was met again at Automate 2025, so
cross-show first touch is a row rather than an assertion in a test.

Six corrections: **two floors in a quotient do not cancel; they widen**; **a replayed
opportunity is a different object from a replayed crate, and a banner is not enough**; **first
touch is a fact about our own data, and the naive test favours the newest show forever** (two
more fell out — influenced pipeline deliberately does not sum, and when first touch lands
outside the window the runner-up does not inherit); **our own consent posture is a hole in the
pipeline figure, on purpose, and it must not look like the vendor's fault** — withheld is us
refusing, unmatched is the CRM answering; **an unbuilt adapter must not be able to produce a
finding**, because "we captured 41 leads and the CRM knows none of them" is a real and alarming
answer this product exists to surface; and **three defects in the Salesforce client a
docs-written fixture could never have caught** — `query()` did not follow `nextRecordsUrl`
(Salesforce pages at 2,000 records, so a large customer got a quietly short pipeline figure
reported with the confidence of a correct one), `opportunitiesFor` interpolated *every* matched
contact id into one SOQL string riding in a GET query string, and `CurrencyIsoCode` exists
**only in a multi-currency org** so the obvious query fails outright on most orgs. All three are
covered by unit tests against a mock transport.

**The repair:** `alerts/store.ts` kept a hand-written `SOURCES` array beside the union in
`feed.ts`, and adding `'roi'` to the type compiled everywhere, wrote correct rows, and read
every one back as `unknown` — so a whole engine's output was labelled "Other" and `linkFor` sent
it to the wrong page. Nothing failed. It was caught by reading the CLI's output. The guard is
now derived from `SOURCE_LABEL`, whose `Record<AlertSource, string>` the compiler already checks
exhaustively.

### The offline day-of PWA (step 20)

`src/lib/dayof/` — the first step that changes how the *client* works. **`targets.ts` and
`outbox.ts` are pure and shipped to the browser**, because a target-company alert has to fire
while the name is being typed and a queue has to be reconciled with no server to ask.
`targets.ts` matches a company **exactly, after stripping legal suffixes, and never fuzzily** —
the failure of a loose match is somebody at a booth telling a stranger their company is one we
came for — and *met* is derived from the leads rather than stored. `outbox.ts` is the device
queue: every item accounted for, `reconcile` throws rather than dropping one, a rejected item is
**kept and marked** instead of retried forever, and our own re-send (`already`) is deliberately
a different answer from somebody else's `duplicate`. `snapshot.ts` carries one instant and
`degradeVerdicts` takes the present tense off a crate line past forty-five minutes while leaving
the recorded facts standing. `access.ts` puts the screen and the target list in **anybody's**
hands and editing the list in an approver's. `store.ts` builds the snapshot in a fixed number of
queries and drains the queue **through the real `captureLead`**, as the person who typed it.

Schema: a new **`show_targets`** — with no `met_at` column, deliberately — and
`meetings.external_ref`, unique per show. Routes: `GET /api/day-of/snapshot` is the only screen
here whose data leaves the server as data, and `POST /api/day-of/sync` answers **every** item it
is sent. Screens: `/day-of` (a picker ordered by proximity to *now*), `/day-of/[id]` — **the
only page here that is not a Server Component, whose server half deliberately fetches
nothing** — and a Target accounts card on the show's Leads tab. `public/sw.js` is hand-written
and caches only the day-of pages; `src/app/manifest.ts` starts at `/day-of`. The seed grows four
target accounts through the real store: one met, one met under a different spelling, one
must-meet that is unmet *and* unowned, and one watch.

Its corrections are all restated as ground rules below.

### Notifications and the nightly job (step 21, `[~]`)

`src/lib/integrations/notify/` — the sixth integration, and the first that carries something
**out** of the workspace rather than asking a supplier a question. That inverts the risk the
other five manage: a transport cannot report a false crate, but it can put a colleague's fare in
a room that was never entitled to it, and unlike a wrong reading that cannot be corrected on the
next poll. So `types.ts` takes a **resolved address and a rendered message and does nothing
else** — no database, no audience, no idea what an alert is. `slack/` is the Web API, written to
the published reference and **never run against a live workspace**; it asks for exactly three
scopes and is write-only. `console/` is deliberately **not** a `recorded` provider.
`notify/provider.ts` selects with no fallback, with one difference from the other five: unset is
a legitimate state and resolves to `console`, while a *name this app does not have* still
throws, because a typo must not quietly resolve to the transport that reaches nobody.

**`notify/plan.ts` is the whole step**: pure, and five refusals — an `info` condition stays on
the screen while a notice goes at any severity, eleven rows are one sentence (through
`groupFeed`, never a second grouping), switching a transport on does not replay history, only
somebody who was told is told it ended, and a personal alert never reaches a shared room. It
takes **no user id and does no lookup**, so the only rows it can put in a message are rows a
query already narrowed — `assistant/tools.ts`'s posture, one layer out. `store.ts` is the only
caller of a transport. `access.ts` puts a destination in the **subject's own hands and not an
admin's**. `src/lib/schedule/nightly.ts` is sweep → erase → carry, and it stops rather than
delivering last night's answers as tonight's; `principal.ts` is the second principal here that
is not an `Actor`, and the first that erases.

Schema: **`notification_channels`** (a person's destination, resolved by the transport and never
typed), **`notification_deliveries`** (append-only; the rail is
`(alert, channel, phase, alert_created_at)`, the last segment inheriting `alerts/store.ts`'s own
recurrence decision rather than inventing a second one) and **`scheduled_runs`** (append-only;
`trigger` keeps "somebody ran it" and "it runs" apart). `FeedAlert` gained `userId`. Routes:
`POST /api/cron/nightly`, and `/api/cron` is public in Clerk mode for a sharper reason than
`/api/intake` — a scheduler has no browser, so a Clerk bounce answers 302 and every hosted cron
reads that as success. Screens: `/settings/notifications`, **the only entry under Settings that
is not admin-only**, and one line on `/alerts` the feed could never say about itself. The seed
connects two people through the real store, runs the delivery pass **twice** (the second carries
nothing — the rail holds), and records one `manual` run.

Its corrections are all restated as ground rules below.

**The repair:** `pnpm alerts --sweep`, `pnpm flights` and `pnpm shipping` ran without `dotenv`
while `next dev` loads `.env.local`, so the CLI and the app disagreed about the environment:
the sweep reported the flight and freight engines as **could not run** on a workspace where they
were configured. "Could not run is not nothing to say" is a sentence the whole design leans on,
and it was being produced by the script's own env loading. All four provider-selecting CLIs load
`.env.local` now.

### LLM deadline extraction (step 22)

`src/lib/manual/` and `src/lib/integrations/extract/` — §5a's post-v1 half and the missing half
of this product's own #1 feature. The two risks flagged as decide-first were settled and
committed **before any code was written**, and both held; they are recorded at the end of
`SCOPE.md` §5a with the six corrections that turned up afterwards.

`pdf.ts` is the only file in this product that touches a PDF. It reads a document into
**numbered pages of plain text** and does nothing else, and that narrowness is the design: the
model is sent text *we* extracted and never the document, because §5a's rule is that a human
confirms every extracted deadline and **a person can only confirm against something**. Had the
PDF gone to the model, its page-and-quote citation would be model output — indistinguishable on
screen from a real one, and confirming against a hallucinated quote *launders* a guess into a
figure the engine quotes as established. `anchor.ts` is therefore the file that makes the feature
safe to confirm at all: a snippet either occurs on the page it cites or the deadline never
becomes a row, `wrong_page` is kept apart from `not_found`, and the match is on normalized
whitespace and never fuzzy. `candidates.ts` is the whole argument — six refusals, and **accepted
+ rejected + duplicate always equals what came in**. `coverage.ts` is the arbiter and is
deliberately stupid. `store.ts` writes the run before it writes any deadline.

`integrations/extract/types.ts` is the seventh integration and is a **new interface rather than
a widened `AssistantModel`**: it performs one exchange with a document and **no tools at all**,
because folding it into the assistant's interface would put a tool list within reach of a code
path whose input is a file from outside the company. `anthropic/client.ts` uses structured
output (`output_config.format`) rather than a tool, for the same reason, and has **no `wire.ts`
and no invented fixtures**. Unlike every other adapter here it **has been run against a live
key**, which is why step 22 was picked over Slack, SSO, hosting, AeroAPI and EasyPost.

Schema: new append-only **`manual_extractions`** (`lead_imports`' shape and its reason — every
rejection with its page, and `truncated`, because a half-read manual reports fewer deadlines
with the confidence of a full one), and `show_deadlines` gained `extraction_id`, `source_page`,
`source_snippet`, `due_time_assumed`. Screens: the readiness tab grew a **Read the exhibitor
service manual** card that leads with the refusals rather than the count, and every extracted
row renders its page and verbatim quote **next to the control that confirms it**.
`next.config.ts` raises the Server Action body limit to match `MAX_MANUAL_BYTES` so the refusal
comes from the store with a sentence rather than from the framework with a body-size error.
**The seed deliberately does not extract anything** — see correction 3.

Six corrections and one repair:

1. **An anchored deadline does not anchor its penalty, and the penalty is the half that becomes
   a bill.** A model can reproduce a real sentence perfectly and attach an amount that is nowhere
   in the document, and the snippet still verifies. An amount now has to appear **inside the
   verified snippet**, compared on digits, and when it does not the figure is dropped while
   `penaltyNote` survives.
2. **A time of day is never invented, and step 11's rule inverts.** That step made a local time
   mandatory because a warehouse closing at 4:00pm rounded to 5pm is a drayage penalty — a rule
   about not *rounding a printed hour*. Most manuals print no hour at all, so applied naively it
   files an assumption in the exact column it exists to protect.
3. **The seed cannot demonstrate this feature, and must not — the first step where that is
   true.** Extraction needs a key, and seeding extracted-looking rows with hand-written snippets
   would file deadlines claiming to have been read off a document nothing read, on the screen
   where somebody confirms them into quoted penalties.
4. **A deduplicated reading still counts as read, and only the probe found it.** The first
   version scored only surviving rows, so every cutoff a well-organised manual prints twice
   appeared on the unclaimed list as a possible miss. An arbiter that cries wolf is the one
   failure an arbiter cannot have. No test caught it because the tests were written to the rule.
5. **A wrong kind is corrected rather than rejected.** The taxonomy is ours, so a misfiled row is
   a labelling mistake; it lands as `other` with the model's word recorded. The opposite call is
   right for a date that will not parse.
6. **A test that asserts a seed property by reading every row stops being true the moment
   somebody uses the product.** `tests/foundation.test.ts` required every `advance_order`
   deadline to carry a dollar figure and queried the whole table; the first extracted deadline
   broke it legitimately. It is scoped to hand-entered rows now.

**The repair, and it is this file's own ground rule.** `scripts/deadlines.ts` rendered due dates
with `toISOString().slice(0, 10)` and had done since step 11 — invisible for eleven steps because
every seeded deadline carries a daytime hour, and visible within a minute of the first extracted
deadline, which is filed at 23:59 local and is therefore *tomorrow* in UTC. The register printed
every one of them **a day late**. The UI rework found four copies of this in `src/app`; this was
a fifth, in `scripts/`, where nothing was watching. The other `toISOString().slice(0, 10)` calls
under `scripts/` are on **date-only columns** and are correct; `scripts/leads.ts` is the one
arguable case left and is deliberately untouched, because fixing it means choosing *whose* zone
a lead was captured in.

### The drayage estimator (step 23)

`src/lib/drayage/` — §5n, and the first thing this product **predicts** rather than records. It
closes the largest silent line in §8a: the carrier's freight charge gets a crate to a dock, and
drayage is everything after that — off the truck, to the booth, empty stored, empty returned,
out again — billed by the general contractor off a rate card in that show's own manual, and on a
medium booth it costs more than the freight did.

`estimate.ts` is pure and is the whole step: hundredweight, the card's minimum, and **six
refusals**. `edit.ts` validates a card (rates through `money/decimal.ts`, a decimal-point slip
caught, blank ≠ zero). `access.ts` puts the rates with whoever runs the show and the **packing of
a crate in anybody's hands**. `store.ts` is org-scoped through the show and loads the portfolio
in a fixed number of queries the way `cost/store.ts` does — and for its reason, since both
compute the same figure.

Schema: new **`drayage_rate_cards`** (one row per show, upsert rather than history — a rate card
is a transcription of a document rather than a decision, so what is worth keeping is whether it
was *checked*; `confirmed_at` holds that and any edit withdraws it, exactly as re-dating a
deadline does) and **`shipments.handling`** (`crated` / `uncrated` / `unknown`). `basis` has
**no database default and no pre-selected option in the form**. Cost: `CostInputs` gained
`drayage`, `ShowCost` gained a `DrayageMemo` that sits **beside** the total, and the *shipping
line* gained a gap when there is freight and no quotable estimate — because the person who needs
to know drayage is missing is reading the shipping figure, not a memo under it. Screens: a
**Drayage** card on the Logistics tab with the arithmetic showing, a packing control on every
crate, and a fourth memo on the Cost tab and `/cost`. The seed writes a confirmed card on
Automate, an **unchecked** one on the live show, and deliberately leaves Sensors Converge with
real freight and no card at all.

The six refusals, and the second is the one that matters: **no rate card, no number** (a $0
drayage line on a show with six crates reads as *drayage was free*); **rounding is per shipment
and never in aggregate** — two 150 lb crates are two shipments, each takes the 200 lb minimum, so
400 lb is billable and summing first bills three hundredweight, **25% light**, in the direction
§5j already named as the one nobody audits, and nothing about the wrong version looks wrong; **a
crate with no weight is not a weightless crate**, which lives or dies on one line in `store.ts`
because `numeric` arrives as a string and `Number(null)` is 0; **a round-trip card is one
charge, not two**, so either guess is a 100% error and there is no default anywhere in the stack;
**uncrated is a surcharge and `unknown` is not `crated`**, which is the *honest* half of §5j
rather than a violation of it; and **an estimate is not an invoice and never joins the total** —
"estimated $2,400, billed $3,900" is a question worth asking, and the answer is usually the fifth
refusal.

Two corrections:

1. **A condition with no clock is not an alert, so this feature deliberately gets no engine.**
   The obvious eighth engine says *this show has freight and no rate card* — true, actionable,
   and still wrong. All seven existing engines fire on something that **changes with time**. "No
   rate card" is true the moment freight is recorded, stays true until somebody types one, and
   never sharpens; a permanently-true alert that never escalates is a nag, and §5a's whole
   argument is that one of those teaches a team to close the next alert unread. `/cost` already
   says it, on the line somebody is reading.
2. **A crate count derived from what was priced reports a show with six crates as having none** —
   found by reading `pnpm drayage`, not by a test. With no card the estimator prices nothing, so
   *a show with no freight* and *a show whose freight nobody can price* rendered identically.
   `considered` is on the estimate now and the accounting holds:
   `perShipment + coveredByRoundTrip + unweighed + unpriceable === considered`.

### Duty of care (step 24)

`src/lib/safety/` — §5o, and the first feature here that the seed deliberately cannot
demonstrate. `RESEARCH.md` ranks duty of care ninth and justifies it in one sentence — *"we know
where everyone is"* — and this module is what taking that seriously produces. **We do not.**
What the app holds is a badge scan at 8:04, a carrier's word about a flight, a hotel stay, and a
travel window somebody typed in June: evidence of *expected* presence at some instant in the
past, never a location. **Nothing here reads a device**, and the moment something does this
stops being a feature about who to call and becomes one about watching staff.

`presence.ts` is pure and turns that evidence into a standing with **what it rests on and how old
it is**. `rollcall.ts` is pure and holds the distinction the feature exists to protect:
**presence and safety are different questions and one must never answer the other** — the person
who badged in twelve minutes ago is who you most need to hear from about a 10am incident, so
presence decides *who to call first* and only an answer closes a name. `access.ts` is the loosest
gate in the codebase. `store.ts` builds every person's evidence in a **fixed number of queries**,
which matters here for a reason the other modules did not have: this screen is read while
something is going wrong.

Schema: **`safety_checks`** (a roll call is a row because a response is a response to a
*request*) and **`safety_responses`** (append-only; `recorded_by_id` is the interesting column
and it inverts §5e). Screens: `/safety` in the nav under Travel, and a **Safety** tab on the show
— the tenth, shown to **everybody**. The seed runs a real roll call on the live show through the
real store: Priya answers for herself, Tomás is answered **by Priya**, Ingrid has not answered,
and Reese has not answered *and* has no phone number — so her silence means nothing and the count
says so separately.

The five refusals: **unknown is not absent, and §5e inverts** (booth coverage refuses to flag an
unrecorded travel window because flagging everybody flags nobody; a roll call is the opposite —
the person nothing can locate is the entire output and sorts **first**, because the cost of the
two mistakes has swapped places); **a response is a response to a request**, or "checked in safe"
from a show last March marks somebody accounted for during this morning's evacuation; **a relayed
answer counts, and §5e inverts a second time** — "I have her on the phone, she is fine" counts and
is **labelled**; **contactable is not contacted**, and the moment that is useful is **before** an
incident, which is why it is on the screen when nothing is happening; and **nobody is marked safe
by the system** — no timeout turning silence into assent, no inference from a badge scan, and **no
bulk "mark everyone safe"**, the obvious button and the only control that could produce a
complete headcount without anybody having spoken.

Two corrections, both found by running the CLI rather than by a test:

1. **A travel window that has not started is not "nothing recorded".** Everybody at the live show
   read `unknown` and sorted to the top — a list telling somebody to go and find four colleagues
   who were at home, hours from a flight they had not taken.
2. **An interval that contains now does not age; an observation does.** Staleness was keyed by
   *kind*, so a travel window covering this moment rendered `(stale)` because it had *started*
   eighteen hours ago — which says "we have not heard in 18 hours" when the truth is "we never had
   a signal, only a plan". It is keyed by **basis** now.

**HubSpot was the written pick and was dropped on contact with reality**: the entire argument for
it was that a free developer tier makes `pnpm hubspot:capture` buildable, and with no account
available it would have become a *fourth* written-to-the-docs-and-hoped adapter replacing a seam
that honestly throws. It stays throwing; §11.6's "one well rather than both adequately" is
unchanged.

### The UI rework — done, all eight tranches

Option B: consolidation *plus* a full visual pass; brief "modern, bright colors, easy to
navigate". It gated nothing. `UI-REWORK.md` is the long version — **read its §6 before writing any
CSS.** The plumbing: **`_components/form.ts`** is one `FormState` (`{ error?, ok? }`) plus
`formErrorFrom`, `optional`, `str`, declared in five files before and drifted into three shapes,
and dependency-free on purpose because client components import the type — `refresh` is
deliberately **not** shared, since each tab's revalidation set differs in load-bearing ways.
**`_components/form-ui.tsx`** is `Input`/`Select`/`Textarea` (two named densities), `Field`,
`Message`, `Submit`, `QuietSubmit`, `ZonedDateTime`, with `useActionState` left at all 42 call
sites. `_components/cn.ts` is the `clsx` + `tailwind-merge` pair that was installed and unused.
`lib/datetime/zoned.ts` gained `zonedDateInput` / `zonedTimeInput` / `zonedDateTimeInput`, with
tests. `team/forms.tsx` split into the three cards the page renders. `pnpm smoke` fetches all
routes and checks 200 plus a phrase only present once the page resolved its data.

The visual half: **`globals.css` is the design system** — OKLCH semantic (never chromatic) tokens
in the two-stage `:root` / `.dark` + **non-inline** `@theme` pattern. **Dark mode is a `.dark`
class**, applied before first paint by an inline script in `layout.tsx`, with a three-state control
in the sidebar; absence of the stored key *is* system. `sidebar.tsx` is collapsible with a 64px
icon rail, grouped Plan / Travel / Settings. `ui.tsx` is a real vocabulary now — `Table`/`Th`/`Td`
(sticky headers; `numeric` right-aligns *and* sets tabular figures), `PageHeader`, `Stat`, `Card`,
`Badge`, `Button`, `LinkButton`. **The measurement worth keeping: `src/app` contains zero `dark:`
variants.**

**Five corrections:** **"verbatim" duplication was not verbatim, twice** — `travel/actions.ts`'s
`asFormError` renders any `Error` with a message (the booking agent throws bare `Error`s for real
explainable conditions) and its `str` trims where the other four do not, which matters because an
airport code with a trailing space is a failed search, so **read a "verbatim" copy twice before
deleting it**; **the date helper had four copies, not two**, all in `src/app` and none tested, which
is the one place nothing was watching; **the §2a defect was one control serving two acts** —
answering for yourself and recording what a colleague told you is what a boolean cannot tell apart,
so `RosterEntry.isSelf` plus a third-person control is the fix; **its second half lived in
`src/lib`** (§11.12) — `standingFor` never read `responded_at`, so an admin-typed `confirmed`
counted toward coverage, and the number ignoring a rule the write path and the badge both obeyed is
the worse half, because the number is what a lead reads and stops at; and **a media query is not a
preference** — the control needs three states, because "follow the system" is a real answer a
two-way toggle destroys on first press.

**§12, a ninth finding reported by a user: the portfolio boards had no calls to action.** Ten
screens rendered a `PageHeader` with no `action`, and the cause is structural — every board
reads across the calendar while every write belongs to one show, so there is no single `href` a
button could carry. `_components/go-to-show.tsx` is a **chooser rather than a shortcut** (a
`<details>` Server Component, no client JS, shows by proximity to now) and it **refuses to guess
the show**. Every CTA carries the gate of the form it points at; `Capture a lead` and `Open a
checklist` are ungated for §8c's reason; `/flights` and `/itinerary` get `Request travel`
instead, because nothing here types a flight in and an "Add a flight" button would be a
good-looking lie about where flights come from. **See the UX pass below for the half §12
missed** — a chooser is the wrong answer for a write whose row already knows its target.

**A tenth, same reader: the board could not take a tracking number for a small package.** The
CTA landed somebody behind a form built for a pallet, which is absurd for two boxes UPS'd to a
hotel — and those are most of the tracking numbers a show generates. So `shipment_consignment`
gained **`direct`**: no dock, therefore no window. The distinction is deliberately **the dock,
not the size of the box** — contractors bill small packages delivered to show site, so a
weight-keyed exemption would silently delete a real drayage line, and a FedEx carton addressed
to show-site receiving is still `show_site` and still drayed. `direct` means no contractor
touches it, so `drayage/store.ts` **filters those rows out before the estimator sees one**;
`EstimableShipment.consignment` stays narrow so the compiler enforces it, and adding the value
found the third caller (`cost/store.ts`) by itself. The carrier's charge still counts — a $180
overnight is freight spend and `/cost` adds it up. And `/shipping` got the write it never had,
through the same `addShipment` call rather than a leaner insert, with the dock window revealed
only for show-site receiving. `pnpm drayage` still reports Automate 2026 as **2 crates**, which
is the proof.

**Two more, and one was a schema defect the UI made visible.**
`src/lib/shipping/carrier.ts` reads the carrier off the tracking number (UPS `1Z`, USPS IMpb
92–95, FedEx Express twelve digits) with three bounds: it **fills a control, never the column**
(a wrong `shipments.carrier` answers `NoRecord`, which looks exactly like missing freight), it
**never rejects a number** (an unmatched pattern means our table is short), and it **says what
it cannot tell you** — a 22-digit barcode is a real USPS number and also what FedEx Ground
Economy issues, so USPS is who can be *asked*. The UPS check digit is verified against their
published example; FedEx's and USPS's deliberately are not, because one we got subtly wrong
accuses people of typos they did not make. Separately, **`/flights` shows what is still ahead**,
cutting at twelve hours past **scheduled** arrival (never estimated — a cancelled flight's is
nothing at all, and that is the row that must not vanish). What the horizon uncovered:
`flights.booking_id` was `ON DELETE SET NULL` while the rail is
`unique(booking_id, segment_index)`, and **Postgres treats NULLs as distinct in a unique
index** — so a deleted booking left un-reconcilable legs rendering as real ones. Fifty-two
identical DL 1422 rows. It is `cascade` now. **A nullable column in a unique index is an
idempotency rail with an off switch.**

**Every list followed, and the exercise produced a rule.** A board's order is its clock; the
question is which clock and which direction. **Prospective** lists run soonest-first
(`/flights`, `/shipping`, `/assets`, `/readiness`); **retrospective** ones run it backwards
(`/leads`, `/roi`); **`/cost` and `/safety` are neither** and order by *proximity to now in
either direction*. Severity is the tie-break, never the key — except that on `/safety` somebody
who has **said they need help** comes above everything. `shows/proximity.ts` holds
`distanceToNow` / `byMostRecentlyOpened`. Three consequences: `/shipping`'s horizon is
deliberately **not** a clock (a crate with no deadline sorts last, not first, because reading a
missing date as the earliest is `Number(null)` in a comparator, and **silence and non-arrival do
not expire**); **`/alerts` did not move**, because a feed's rows are sentences whose only clock
is `created_at` — a fact about our sweep schedule, so ordering on it puts tonight's `info` above
last week's `critical`, and it took the horizon half instead (`resolveAndForget`); and **a
comparator in a page is one two views can disagree on**, which `/safety` and `pnpm rollcall` did
until `rollCallShowOrder` moved into `rollcall.ts`. The flight board is soonest-first now where
it was worst-first for twelve steps: with landed legs gone every row is a flight somebody still
has to catch, so **a ranking that fights the clock is usually a list carrying rows that should
not be on it**.

### The UX pass (2026-09-03) — five gaps where a rule outlived the screen that feeds it

Prompted by a user reading a shipping row: *"not confirmed at the booth" — how does a user
confirm at booth?* The answer was "navigate to the show, then Logistics, then find the crate",
which is the wrong answer on a board whose purpose is to tell you which crates need somebody.
Walking every screen from there turned up a pattern with two halves.

**Half one: a board reports a condition and offers no control.** UI-REWORK §12 found that the
boards had no calls to action and answered with `go-to-show.tsx`, a chooser that refuses to
guess the show. That was right for *add freight*, which has no single target, and it quietly
became the answer for writes that do have one. **Where the row already knows its target,
sending somebody through a chooser is not caution, it is three clicks.** So `/shipping` carries
the receipt control on the row that says the crate is unconfirmed; `/safety` lists the
outstanding people with `tel:` links and the answer control beside each, because it is the
screen read while something is going wrong and recording that somebody is safe took three
navigations during an evacuation; and `/flights` and `/shipping` both carry `Re-check
everything`, since both render staleness and the only button that could clear it was on
`/alerts`. Each board action calls the same store function the show tab calls — a second
*action* is fine, a second *write path* is not.

**Half two, and it is the bigger one: four tables the app reads and only the seed writes.**
Found by asking the question systematically rather than screen by screen (the check is worth
re-running: for each `pgTable`, does anything outside `scripts/seed.ts` insert or update it).
Three were shipped as fixes and each was a rule correctly enforced on top of a table nothing
could write:

- **`users` traveler details → `/settings/profile`.** `travel/passengers.ts` refuses to build a
  passenger without a name, a **date of birth**, an email and a **phone number** — correctly,
  since a plausible placeholder buys a real ticket that fails at the gate. Nothing could write
  `phone` or `born_on`; the only `users` update in the codebase is Clerk provisioning. So the
  agent this product is built around threw `MissingTravelerDetailsError` at every real user and
  named fields they had no way to supply. §5o's duty of care had the same hole from the other
  end: it names people with no phone number and argues the moment to fix one is a quiet
  Tuesday, which was true for everybody except the person reading it. Writes **your own row
  only**, for the reason `responded_at` and notification channels already give.
- **`expenses` → the show's Cost tab.** `/cost` has read this table since step 17 and only the
  seed wrote it, so every real workspace read *"at least $X, most costs missing"* permanently,
  while the page correctly explained that booth space is the one to check first and offered no
  way to check it.
- **`cost_centers` → `/settings/cost-centers`.** §4 requires one on every financial row at
  creation and it is enforced everywhere, so **a real organization could not file money at
  all** — expenses, hotels, side events, crates, assets, print runs — with no error saying why,
  because the select was simply empty.
- **`travel_policies` → `/settings/travel-policy`.** The headline. An admin could not define
  the constraints in `SCOPE.md`'s first sentence; with no policy the agent raises `NoPolicyError`
  and refuses to search. Base layer only — overrides resolve and are listed read-only, because
  on an override a blank means "this layer says nothing" rather than "no limit".

**`show_outcomes` is the fourth and is deliberately left open.** `source` anticipates `manual`
— "a number somebody typed" — and nothing can type one. Unlike the other three that is a
**design decision rather than a mechanical gap**: §5k withholds every ratio built on a replayed
pipeline, and whether a figure a company types about *itself* earns more trust than a replayed
one is a real argument with two sides. Decide it deliberately.

**Three bugs the pass turned up, and the second is in the booking spine:**

1. **A route may not import a module out of another route's folder when the path contains a
   dynamic segment.** The first `/safety` fix did `import { AnswerFor } from
   '../shows/[id]/safety/forms'`. It type-checks, it builds, the page renders — and **every tab
   under `/shows/[id]` 404s**. No test covers routing, so `pnpm smoke` is the only thing in this
   repo that catches it, which is exactly what §20.8 kept it for.
2. **`resolvePolicy` checks that a required key is *present*, never that it is non-null, under a
   type that promises non-null.** `TravelPolicy` declares `preferredAirlines: string[]` and
   `rules.ts` asks `.length === 0` to mean "no preference", but a policy row leaving it blank
   resolves to `null` and the first read throws. Hidden for twenty-four steps because the seed
   sets `['DL', 'AA']` and because the only other reader — `validatePolicy`, carrying a comment
   since step 3 saying it is for the admin policy editor — **was called by nothing**. Building
   the editor made a blank reachable from a screen and it crashed on the first save. Fixed at
   the source: the base layer resolves lists to `[]`, an override still yields `undefined`.
   **A key-presence check under a non-nullable type is a type that lies**, and every other
   `REQUIRED_FIELD` is a scalar where the same hole is a silent wrong answer rather than a crash.
3. **`pnpm dev` and `pnpm test` against one `.pglite` leave it damaged**, after which every
   DB-touching test fails with `RuntimeError: Aborted()` naming nothing. `pnpm db:reset` fixes
   it. This file documented the reverse hazard (reset under a running server) and not this one.

**The practice that found all of it: read the screen as somebody who has to act on it.** Every
one of these is a sentence the product says confidently with no way to respond to it. The CLI
habit finds wrong *numbers*; this finds rules that outlived the screen that feeds them, and it
is a different sweep worth running per feature.

### Traveler preferences (2026-09-05) — a field the adapter already mapped and nothing filled

Prompted by a user asking whether the profile carried defaults for airline, hotel and car
rental. `/settings/profile` carried a seat preference and a Known Traveler Number; airline
preference existed only as the **org** policy's `preferred_airlines`, hotel preference had
nothing to act on it, and car rental is out of scope (`SCOPE.md` §"Explicitly out of scope").

Two things shipped. **`users.home_airport`** prefills "From" on `/travel/new` — **the
traveler's, never the requester's**, because a travel manager filing for a colleague is asking
where *they* leave from, and `travelersFor` now returns it per person so switching the dropdown
needs no round trip. It is a prefill in an editable input: typing over it is the whole override,
and `travel_requests.origin_airport` stays `notNull` and records what was actually asked, so
changing a home airport next month never moves an open request or the offers priced from it.
`assistant/draft.ts` falls back to it when the model gives no origin, and says
`originFromHomeAirport` in the result — deliberately **not** the refusal `resolveZone` makes one
line above it, because a guessed zone is an inference from nothing while a home airport is a fact
the traveler typed.

**`user_loyalty_accounts`** is one number per carrier (unique on `(user, airline)`, so nothing
downstream is ever asked to choose between two), sent at search — where a member account can
surface a fare nobody else is offered, which is a fare the policy engine should be ruling
against — and again at order create, which is where the miles actually credit.

Two were refused and the refusals are the interesting half. A **personal** airline preference is
a real design question rather than a missing field: `preferredAirlines` is an org policy input
that `rules.ts` reads as a soft preference, and a per-person one quietly becomes a constraint
under which the agent stops finding fares. **Hotel and car rental preferences have nothing to act
on them**, so the profile's "What is not here" card says so — a preference nothing reads is a
promise nothing keeps.

**The finding, and it is 24a's shape one layer in.** `SearchRequest.passengers.loyaltyAccounts`
and the Duffel mapping for it have both existed since step 5. `agent.ts` never filled the field.
So every ticket this product has ever bought was issued with no mileage credit, and no test could
have caught it — the passenger builder was correct and nothing called it with anything. 24a's
check was *does anything outside the seed write this table*; this one is **does anything fill
this field the adapter already maps**. The new test asserts it against the real agent with a
spying provider rather than against the builder, because a unit test on the builder would have
passed throughout.

The honest ceiling is written on the screen: **nothing in a search or an order response says
whether the carrier accepted a number**, so `/settings/profile` says we passed it on rather than
implying miles are accruing. That failure is silent in the way this codebase most distrusts — a
real ticket, a saved number, and a year of trips that earned nothing — so `duffel-capture.ts`
asks it as **Q4** and `duffel-conformance.test.ts` reports it. One small fix rode along:
`agent.ts` had re-implemented `splitName` inline for the search since step 5, so a traveler's
legal name could be split one way when quoting and another when buying;
`searchPassengerForUser` is now the one builder.

### The personal airline preference (2026-09-05) — rank, never rule

The half the previous section declined, decided rather than dropped. The answer came out of
`rank.ts`'s own docblock: **policy says what is allowed, ranking says what is best among the
allowed, and conflating them is how a booking agent ends up justifying an expensive choice.**

So `users.preferred_airlines` is read by **no rule**. It lives on `EvaluationContext` rather
than on `TravelPolicy` precisely so `evaluate()` cannot reach it — put it on the policy and the
first reasonable-looking change is a rule that escalates an off-preference fare, at which point
"I prefer United" is an agent that quietly stops finding flights and the person who typed the
preference is the last one able to diagnose it. `rank.ts` is its only consumer.

Four properties hold the feature safe, and they are the design:

- **An admin prices it**, in `travel_policies.personal_carrier_allowance_cents` — the ceiling on
  how much more the agent may pay to honour it. **Absolute cents, never a percentage**: 3% of a
  $6,000 international fare is $180 of somebody's convenience on the fare nobody audits.
  `policy-edit.ts` caps it at $500 *at the point of typing*, because this is the only field in
  the whole policy that authorizes spending **more** — every other number there is a ceiling, so
  a typo loosens a rule and something downstream catches it; a slipped decimal here just buys a
  dearer fare.
- **Null is a tie-break only**, and that is the app declining to spend money nobody authorized
  rather than a default we guessed. The feature is inert until somebody prices it.
- **All-or-nothing across the carriers actually flown.** A half-preferred itinerary is not half
  a preference — the traveler is on somebody else's aircraft for the other leg. Mirrors how
  `airlineRules` reads the org's list.
- **It cannot cross a decision tier**, enforced rather than assumed: `scoreOffer` clamps the
  discounted score to `DECISION_WEIGHT[decision]`, so no allowance anybody can type — including
  one with an extra zero — promotes a `needs_approval` fare past an `auto_approve` one or
  rescues a carrier the org blocks. The test asserts it against a deliberately absurd $100,000.

**Legibility is part of it.** `RankedOffer.preferenceCreditCents` is recorded per offer in the
`search` step's audit detail, and the summary names the fare that lost — *"chosen over $430.55
within the $60.00 carrier preference allowance"* — because offers vanish from the provider
within the hour and "we bought the $452 United over the $430 Delta" reads as a bug otherwise.
`/settings/profile` says which of your listed carriers the org **blocks** (they will never win,
and nothing else would ever tell you) and whether the allowance is priced at all (unpriced means
your whole list is a tie-break, which is legitimate and invisible). `pnpm booking:dry-run`
scenario 8 runs the same two fares twice, with the allowance and without, because the claim
worth demonstrating is that it is *bounded* rather than that it works.

One fixture note: `duffel/fixtures.ts` gained `unitedNearTieOffer` and it is deliberately **not**
in `allOffers`. A near-tie between two carriers is a constructed situation; adding a fifth offer
to the default set would change the offer count in every existing scenario, and a default search
that happens to produce a near-tie is a fixture arranged to flatter the feature.

**Context worth carrying: the org's `preferredAirlines` still does nothing to the outcome.** It
produces an `advisory` rule result, and `types.ts` has said since step 3 that advisory is
"recorded and ignored" — `scoreOffer` never reads it. That is documented intent rather than a
defect, but it means the org list and the personal list now do genuinely different jobs, and the
two must not be quietly merged: one is a statement an auditor reads, the other moves money.

### The org's preferred airlines now rank too (2026-09-08)

The previous section closed by flagging that the org's `preferredAirlines` did nothing to the
outcome — an `advisory` that `types.ts` called "recorded and ignored", with `scoreOffer` never
reading a rule result. An org could name its negotiated carriers and the agent still bought
whatever was cheapest. It is priced now, in `travel_policies.preferred_carrier_allowance_cents`,
and **the advisory half is untouched**: `airlineRules` still cannot deny a fare or escalate one,
and the `RuleSeverity` docblock is corrected rather than deleted — `advisory` never changes the
*verdict*, and what reads its subject is the separate ranking stage.

Three decisions worth carrying:

- **The two lists stack.** An offer on a carrier the company has an agreement with *and* the
  traveler has status on has two independent reasons behind it, both priced by an admin who
  typed two separate numbers. Taking the larger would make the smaller inert whenever the other
  is bigger — a worse surprise than the sum. What the sum costs is visibility, so it is paid
  for: `PreferenceCredit` keeps `orgCents` and `travelerCents` apart all the way into the audit,
  and the search line names which one paid, because "the company has a deal with United" and
  "Priya asked for United" are different answers with different people to argue with.
- **The caps differ on purpose** — $1,000 for the org, $500 for a person — because a negotiated
  carrier is a contract term (often paying for itself in discounts this app cannot see) and
  somebody's status is a convenience. The real worst case is the two added, which is the number
  to hold in mind before raising either; the policy screen says so under the fields.
- **`validatePolicy` warns on a list with no price**, which is the exact state this workspace
  shipped in for twenty-four steps, and on a price with no list. Warnings rather than errors
  because neither can hurt anybody and both are legitimate mid-edit — but both leave a screen
  looking configured while the agent behaves as though nothing were set.

**Two things reading the CLI output found, and neither was a test failure.** The first draft of
the dry-run scenario printed runs 1 and 3 byte-identically: with only a preferred fare and a
personal one, whichever preference is worth more wins and the trace reads exactly like a run
with no preferences at all, because the winner was the cheaper fare anyway. `offListCheapestOffer`
— Alaska, cheapest, on **neither** list — is the control that fixes it, so every outcome is now a
fare chosen *over the cheapest one*, which is the only thing an allowance can ever buy. And the
audit line read "within $60.00 for the traveler's own = $60.00": arithmetic showing its working
on a one-term expression. `describePreference` prints the sum only when there is something to
sum.

One smaller find, from a test rather than the CLI: the "listed but not priced" warning was first
written onto the `preferredAirlines` field, where it **shadowed the blocked-and-preferred error**
for any caller looking an issue up by name. Nothing in `src/` does that today; the existing test
for that error did, and caught it in a minute. It is on `preferredCarrierAllowanceCents` now,
which is also the more accurate field — the thing that is absent is the price.

### The preference breakdown on the travel request page (2026-09-08)

The org and traveler allowances were only ever in `agent_runs.detail`, which is a narrative log
rather than a schema, and the page a person actually argues with showed a fare and a rank. So
`offer_snapshots` gained `preference_org_cents` / `preference_traveler_cents`, **beside `score`**
— a score is the number that decided the purchase, and one whose largest term is invisible is a
figure nobody can argue with. They are a record of **what was applied**, never re-derived on
read: the allowances are policy values that move, and re-deriving would restate last quarter's
purchase in this quarter's numbers. `policy_evaluations` already follows that rule by recording
the resolved policy.

`travel/review.ts` gained the pure `preferencePremium`, with two refusals:

- **The comparison is against the cheapest fare the policy *allowed*, never the cheapest seen.**
  A denied offer was never an option, so measuring a premium against one invents money that was
  never available and reports the agent overspending by the width of a ticket nobody could have
  bought. `agent.ts`'s `cheapestBookable` makes the same narrowing for the audit line, and the
  two are deliberately separate implementations over different types — merging them would put a
  database shape into a pure module.
- **An allowance is a ceiling, not a spend.** A $60 preference that broke a $37.55 gap cost
  $37.55; rendering "$60.00" overstates every preference on every request, on the screen an
  approver reads. The page reports the actual difference and names the allowances beside it as
  what was *authorized*.

Both the column and the sentence appear only when a preference actually cost something — a
column that is blank a hundred times is one nobody reads on the hundred-and-first.

**Two things fell out, and both were found by looking at the rendered page rather than a test.**
`money()` drops cents by design (right for a board of fares, wrong for a difference between two
of them) and turned a $15.55 premium into *"$16 more"* — a figure that reads as rounded rather
than as a number to check. `moneyExact` is a **second function rather than a flag on the first**,
so the choice has to be made: `money` for an amount, `moneyExact` for a gap between amounts.

And `pnpm smoke` can **silently skip `/travel/[id]`** and still report "all 200" over the most
complex page in the app, with the route count going 39 → 38 as the only signal. The skip is
printed now. **A check that can skip has to say when it did** — §5f's unchecked flight, applied
to the thing that checks the screens.

**The first account of *why* it skipped was wrong in both directions, and how that happened is
the more useful half.** It claimed a clean seed leaves the approvals queue empty and that
`pnpm booking:dry-run` is what covers the page. The opposite is true: the seed puts
`seed:ingrid:lhr` in `pending_approval` deliberately — its comment has said since step 4 that it
is *"the row the approvals queue exists for"* — so a clean seed gives **39 routes** with that
page covered, and it is the **dry run** that empties the queue, deleting the seeded requests and
leaving nine of its own in terminal states because approving the escalated one and sweeping the
expiring one is exactly what those scenarios exist to show.

Two measurement mistakes produced it, both of them ones this file already warns about. A
`pkill` aborted a compound shell command before its `pnpm db:reset` ran, so the database called
"a clean seed" was a post-dry-run one. Then the re-measurement ran `booking:dry-run` from a
second process **against a `.pglite` that `next dev` was holding**, so the page was served from
the pre-dry-run copy — and both mistakes returned *confirming* answers. **When a measurement
contradicts a comment the code has carried for twenty-four steps, re-derive the state before
believing the measurement**, and kill `next dev` before anything else writes to the database.

### UX pass 3 — the first five minutes (2026-09-08)

`UI-REWORK.md` §12–§18 were all driven by a reader working *inside* a seeded workspace, on
screens that already had data. Nothing had looked at the path **before** that: the first screen
somebody lands on, what an unconfigured workspace tells them, and what the app shows while it is
thinking or when it breaks. §21 is the long version. **The empty states turned out to be fine**,
which is worth knowing before looking again — the gaps were all somewhere else.

- **The overview had been wrong since step 9.** It led with a card headed *"The booking spine
  runs headless"*, saying the travel form and approvals queue would *"land at step 9"* and
  listing three `pnpm` commands as the way to use the product — sixteen steps after they
  shipped. Deleted rather than reworded. Under it, **"What you can do here" was a hand-written
  array of seven capabilities frozen at step 8**, beside a nav grown to twenty-three entries.
  `_components/nav.ts` is now the one list both read, and **`does` is a required field**, so a
  new screen cannot join the navigation without a sentence saying what a person does there.
- **`src/lib/setup/`** is the first-run card, pure plus a store. It renders only while something
  is outstanding, names the **consequence** rather than the chore (*"the booking agent will not
  search for a fare at all"*), lists a step the reader cannot perform with **who can** beside it,
  and is **not dismissible**. It is deliberately **not an eighth engine** — the drayage rate-card
  rule, that a condition with no clock is not an alert.
- **Four boundary files that did not exist**: `(app)/loading.tsx`, `(app)/error.tsx`,
  `(app)/not-found.tsx` and root `not-found.tsx` plus `global-error.tsx`. Five call sites already
  threw `notFound()` and every one landed outside the shell.
- **An alert badge on the nav**, from `feed.summary.outstanding` — never a second SQL `count()`.
  `_request.ts` holds `currentActor` / `currentFeed` as **zero-argument** `cache()` wrappers,
  because `cache()` keys on argument identity and passing `actor` from two components is two
  misses. Rendering `/` was already doing two actor lookups before this.
- **`pnpm` was on five end-user screens.** §17's vocabulary scan greps `§`, `SCOPE.md`,
  `a floor`, `lawful basis` and `x(s)` and never looked for a **command name**. Adding
  `pnpm [a-z:-]+` to it also turned up a *seventh* "lawful basis", on `/settings/intake` — the
  one screen §14 and §15 did not walk. `layout.tsx`'s `NoDevActor` keeps its `pnpm db:reset`,
  because it renders only for somebody running this locally with no Clerk keys.

**Two things reading the rendered page found.** `1 flights booked` on the overview — §18 fixed
seven `in 1 days` and could not see this one, because a hard-coded plural noun beside an
interpolated count is not an `(s)`. And the real defect: **`missingForTicket` was a commented
*mirror* of the inline list in `passengers.ts`, and the two had already drifted.** `splitName`
maps a one-word `fullName` to a given and family name that are the same word, so
`!givenName || !familyName` was false and **the agent would have ticketed somebody whose legal
name cannot match their ID** — the exact failure that module exists to prevent — while the
profile screen correctly refused. One function now, in `passengers.ts`, asserted against
`passengerForUser` rather than against the helper.

### Next: step 25, and there is no obvious pick — read this before choosing

The backlog in `SCOPE.md` §10.25 is sponsorship campaigns, a public API + Zapier, impersonation,
multi-workspace, custom fields, external share links, a room-block optimizer, gamification and
HubSpot. Three observations that should shape the choice more than the list does:

- **Every remaining integration is blocked on an account, and that is now a pattern rather than a
  coincidence.** HubSpot needs a developer org, Slack needs a workspace, SSO needs an IdP, and all
  three need hosting first. Building any of them unverified converts an honest seam into a fourth or
  fifth adapter written to the docs and hoped — step 24 declined exactly that trade and it should
  keep being declined. **Hosting is the unlock for all of them**, and it is the one thing on the
  list that changes what else is buildable.
- **`pnpm manual:probe` against a real exhibitor manual is still the cheapest open item**, and the
  only unverified thing here that needs no account at all — just a PDF. Everything structural about
  step 22's extraction is proven and **recall is not**, by construction. That gap is a week of
  prompt work or a nasty surprise, and there is no way to know which without one real document.
- **Of the pure, no-account features left, sponsorship campaigns is the largest.** §10's backlog has
  carried it since the start and `RESEARCH.md` ranks it tenth: deliverables with their own deadlines,
  which composes the §5a engine that already exists rather than adding a ninth thing that alerts.

**The next UX step is responsive layout, and it is written down rather than done** (2026-09-08).
`sidebar.tsx` is a fixed `w-60` / `w-16` column at every width and `_components/ui.tsx` contains
no `sm:` / `md:` / `lg:` variant at all — while `manifest.ts` sets `start_url: '/day-of'`, which
is the screen used standing on a show floor, on a phone, and is therefore the one most likely to
be opened by somebody who is not at a desk. It is a whole-app pass touching every screen, so it
deserves its own commit rather than riding along with the first-five-minutes work above.

**Step 21's remaining two halves are deferred by decision, not left undone** (2026-09-01,
`SCOPE.md` §10.21 `[~]` and §11.2): there is **no real Slack workspace**, this runs on **localhost
only**, and hosting needs a cloud account that §9's ground rule forbids wiring unasked. Do not pick
any of them up speculatively.

- **Slack stays stubbed**, in the sense that matters: the adapter is written and unverified, like
  AeroAPI, EasyPost and Salesforce, and nothing constructs it without `SLACK_BOT_TOKEN`. The default
  transport is `console`, which composes the real message and delivers it to nobody. **Do not add a
  `recorded` Slack provider** — the whole argument for `console` existing is that a replayed
  *delivery* is a claim somebody's phone buzzed.
- **The SSO rollout is a TODO gated on hosting, not on itself.** A SAML IdP posts its assertion to an
  ACS URL it has to be able to reach, and an enterprise OIDC connection wants a redirect URI on a
  real domain — neither can reach `localhost:3000`. So hosting and SSO are one gate, in that order.
  When it does land, the domain-to-org mapping is a **change to a ground rule** rather than a
  feature: today a verified session matching no `users` row gets no access *and no row created for
  it*, and domain-to-org provisioning is precisely a way to create one. Decide that deliberately,
  with a live connection in front of you.
- **Hosting** is therefore the one that unblocks the other, and is where §11.10 (data residency)
  stops being deferrable and where the day-of service worker meets a real origin and a real TLS
  certificate for the first time.

§11.5 (scale) is **resolved as of 2026-09-01, and it resolved into a prohibition rather than a
number**: roughly five shows a year for the anchor customer, offered as a guideline rather than a
limit, for a product aimed at enterprise. So **nothing may be simplified on the strength of that
size** — the old offer that "under ~50 travelers some of the policy machinery can be simpler" is
withdrawn, because a simplification bought against five shows is invisible while the seed has eight
and fails at the first customer with forty. What the number buys is permission to *defer*, which is
visible, and step 21 left one concrete deferral: `POST /api/cron/nightly` is a `for` loop over every
org inside one HTTP request with `maxDuration = 300`. It degrades the wrong way — a slow org starves
the ones after it and the response still says 200 for those that ran — so read that route before
choosing a host, since a platform with a job queue makes the fix a fan-out.

### Deliberately not built, and visible as such

The free-text request box §6a describes is **built** as of step 15 — the assistant parses "Vegas by
Tuesday noon, back Thursday night" into constraints and files them — but it deliberately stops
there: the request is filed unconfirmed, and reading the parse and confirming it happens on
`/travel/[id]`, by the person whose trip it is. The assistant does not stream (a server action
returns the whole answer, which keeps every tool call inside the request as the actor `getActor()`
resolved), and it books no hotels, because §5 keeps hotel booking out of v1.

**There is no read-only tab and no dead control left.** **Booth presence has no seed rows**: every
seeded show is in the future and `shift_presence` is a record of what happened, so the check-in
control appears on a shift once it has run rather than inviting somebody to pre-record their own
attendance.

**A lead reaches a CRM only if it may, and as of step 19 that is enforced by the code path rather
than only by the screen:** every lead row carries `outbound` — `marketabilityOf`'s answer to "may
this row leave the building", with the reason and the fix — and `roi/store.ts` *reads that same
verdict* rather than re-deriving one. Every seeded scanner lead fails the check, because a badge
vendor's export carries no consent column, and those leads are consequently absent from every
pipeline figure — named on `/roi` as **withheld by us**, deliberately apart from the leads the CRM
did not know. The verdict is computed on the row rather than at the point of export, because the
moment somebody can fix it is the moment they are looking at the lead.

**`retention_overdue` is now enforced by the nightly job**, which is the promise §5j said was worse
than none while nothing kept it: stage 2 of `runNightly` really erases, and what it erased goes into
the run's summary, because an irreversible act performed by nobody has to leave a record made by
something. Two callers skip it and both have the same reason — the test suite and the seed would each
destroy the demo they exist to build. `pnpm leads --retention` is the deliberate, typed version.

**Nothing runs the nightly job on this machine**: without `CRON_SECRET` the endpoint refuses, and
until a scheduler is pointed at a real origin the only things that run it are `pnpm nightly` and a
button on `/settings/notifications` — which is why `manual_only` is a standing of its own, and why
`unchecked` is still a standing and a figure on the page. With no `SLACK_BOT_TOKEN` the transport is
`console`, which composes every message from the real alerts and delivers it **to nobody** —
recorded as `rendered`, never `sent`, so a workspace that has told nobody anything can never read as
one that has. `pnpm nightly --dry` prints the messages verbatim, which is the only way to read what
a colleague would receive before installing a Slack app.

**Nothing rebooks a cancelled flight**, and the alert says so: the agent buys against a travel
request and the ticket is already bought, so rebooking is a call to the airline — the same shape as
§6d's cancel.

**Extraction from the manual PDF is built** as of step 22, and the rule it had to obey — nothing
extracted is quoted in dollars until a human confirms it — is enforced by the step 11 engine exactly
as written, with no change to it. What is **unverified is recall against a layout nobody in this
repo has seen**, because the only corpus here is synthetic and was written by whoever wrote the
prompt. `pnpm manual:probe <file.pdf>` is what measures that, and it is the only capture script here
whose output is meant to be *read* rather than asserted on: most lines on its unclaimed list are not
deadlines, and the one that is, is a miss.

**Checklist templates are code, not rows**: the library in `src/lib/readiness/templates.ts` is
versioned in git, and an org-editable template builder is deliberately deferred until the standard
list has been used and argued with, which the templates card says on the page.

**The day-of screen queues, and nothing drains it in the background.** There is no Background Sync
registration and no push: the outbox goes up when the tab is open and the network comes back, which
is the ordinary case on a floor and is not every case. A phone put in a pocket at 4pm with three
captures on it still has three captures on it at 9pm — which is exactly why the count says "on this
device" rather than "pending". It also **only captures leads and meetings offline**: every other
write is a server action that needs a connection, because each has a store function with rules the
device does not carry. And a target-account alert is a line on the capture form, not a notification —
nothing here asks for notification permission.

### What has never met a live key

**Four adapters have never met a live key**, and each says so in its own header: AeroAPI (13),
EasyPost (14), Salesforce (19) and Slack (21). All are written to published schemas and tested
against fixtures we wrote ourselves — the closed loop step 12.5 named, which proves internal
consistency and structurally cannot catch a wrong field name. The Duffel adapter is in the same
position and nothing has ever been bought. **The Anthropic assistant adapter (15) is a different
category**: it uses the vendor's SDK, so there is no hand-written wire schema to be wrong about and
no capture script would tell us anything — what is unverified is *behavioural* (tool choice, the
tenses `prompt.ts` asks for, stopping at drafting), and none of that is load-bearing for access,
which is the point of putting the access model in `tools.ts`. The step 22 extractor **has** met a
live key.

**Only Duffel, Salesforce and Clerk have capture scripts.** Each records a real account's answers
into gitignored fixtures and checks our wire types and the *unmodified* normalizer against them,
skipping cleanly when there are no captures so a clean clone still needs zero keys. Slack's case is
the mildest of the four and worth stating so nobody over-corrects: its one docs-catchable defect —
the `{"ok": false}` envelope on an HTTP 200 — is covered by unit tests against a mock transport, and
what remains unverified is whether the three scopes are the right three and whether
`conversations.open` behaves as documented for a bot posting its first DM. A wrong answer there
fails loudly on the first send, which is the opposite of Salesforce's failure mode. **And there is
no workspace to capture against** — a standing decision as of 2026-09-01, not an oversight.

**Salesforce got its script first, out of step order, because this is the adapter where a wrong
field name would look like the truth.** A wrong field on a tracking payload gives a crate with no
scans and looks broken within a minute; a wrong field here gives a dashboard where *nothing is ever
attributed* — every show carrying a real cost and no pipeline — which is indistinguishable from the
honest finding §8c says is normal at most companies. Nobody would go looking.
`pnpm salesforce:capture` + `tests/salesforce-conformance.test.ts` label the four questions Q1–Q4
and assert them by name:

- **Q1 — the join.** An Opportunity has **no** `ContactId`; the join is `OpportunityContactRole`.
  Reading the former compiles, returns `undefined` forever, and attributes nothing. This is the one
  whose wrong answer is invisible, so it is asked first.
- **Q2 — won versus open.** Stage *names* are per-org free text ("Closed Won", "6 - Closed/Won", and
  plenty not in English), so classification reads `IsWon` / `IsClosed` and never a name. The suite
  prints the org's own stage vocabulary as the evidence.
- **Q3 — money and dates.** `Amount` arrives as a JSON *number* where every other provider here
  sends a decimal string, so it is stringified through `money/decimal.ts` rather than multiplied by
  100; `CloseDate` is a bare date anchored at midday, because `new Date()` on it lands at UTC
  midnight and therefore in the *previous* quarter in every American zone.
- **Q4 — currencies.** `CurrencyIsoCode` exists only in a multi-currency org and selecting a field
  an org lacks is a hard `INVALID_FIELD`, so the query is probed once and falls back to
  `Organization.DefaultCurrencyIsoCode` — read, never defaulted to `USD`, because a currency label
  is part of a money figure.

Captures are gitignored and the script redacts emails, names and phone numbers before writing; the
suite asserts it did. §5j is about a stranger's details not travelling somewhere they were never
collected for, and a git history is the least reversible such place.

**Duffel's credit path is where the closed loop bites, and doc research says it is probably already
broken.** `duffel/fixtures.ts` is the single source for the unit tests, the `recorded` provider
*and* the seed's travel requests, so `pnpm test`, `pnpm booking:dry-run` and every seeded booking
validate against payloads we invented. `wire.ts` declares two credit fields and hedges between
them: `available_airline_credit_ids` (string ids — real, three independent doc reads agree, and
`normalize.ts` reads it) and `available_airline_credits` (objects carrying values — absent from the
published Offer schema). `client.ts:resolveCredits` reads **only** the second and throws when it is
empty, so if it is fictional then **every credit-first purchase has always escalated to a human and
§5b has never once fired.** It fails loudly, which is exactly why nothing caught it. The docs
describe credit values living on the credit resource (`GET /air/airline_credits/:id`) and credits
applying through the order's `payments` array as
`{type: "airline_credit", airline_credit_id, …}` rather than the top-level
`airline_credits: [{id}]` we send at `client.ts:440`. A third suspect: the adapter *computes*
`creditAppliedCents` instead of reading back what the carrier applied, which the ground rules
forbid. None of it is confirmed — doc sources contradicted each other once during research, so
**the live key is the arbiter**: capture first, change code second. Q1/Q2/Q3 in
`scripts/duffel-capture.ts` are asserted in the conformance suite, each failure naming the file,
the line and the fix.

**`pnpm clerk:verify` is Clerk's equivalent**: it reads the Backend API and prints what really
comes back next to what the code assumes. Four claims, none yet confirmed — that
`externalAccounts[].provider` and `enterpriseAccounts[].provider` carry slugs
`normalizeProvider()`'s `oauth_|saml_|oidc_|custom_` strip recognises (if not, the strip silently
no-ops and an org permitting Okta refuses the person using Okta); that those identity arrays are
always arrays and never `undefined` (`credentialsHeld` iterates them directly, so `undefined` is a
500 rather than the promised fail-closed refusal); that an impersonation session surfaces
`actor.sub` where `clerk.ts` reads it — **a path with zero test coverage today, since every test
passes `actor: null`**; and that `auth()` resolves under `proxy.ts` in Next 16, whose Clerk branch
is also untested. Enterprise SSO may need a paid plan; if it is unreachable that half stays
unverified and this file will say so rather than implying otherwise.
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
- **The model is sent text we extracted, never the document.** §5a's confirmation gate is
  the only thing between a guessed date and a quoted penalty, and a person can only confirm
  against something. If the PDF went to the provider, its page-and-quote citation would be
  model output — a hallucinated quote reads exactly like a real one, and confirming against
  it *launders* the guess. So `manual/pdf.ts` reads the pages here, and every candidate's
  snippet is checked against the page it cites before anybody sees it. A snippet that is not
  there never becomes a row. `src/lib/manual/anchor.ts`.
- **An anchored deadline does not anchor its penalty.** The anchor proves the date was read
  off the page and says nothing about a figure quoted beside it — and the figure is the half
  that becomes a bill. An amount must appear **inside the verified snippet** (compared on
  digits, so "$3,125.00" and "3125.00" are one claim) or it is dropped while the manual's own
  words survive. A dollar amount nobody printed, carrying a citation, is worse than one
  without. `src/lib/manual/candidates.ts`.
- **An extracted deadline's time of day is never invented, and it blocks confirmation.**
  Step 11's rule was about not *rounding* a printed hour; most manuals print none, so a
  default files an assumption in the column that rule protects. A row with no printed time is
  end-of-day, flagged, alerts as a date, and cannot be confirmed until somebody sets the
  hour — editing is what clears the flag, because typing a time is a person deciding what the
  hour is whether or not they changed it.
- **There is no replayed extractor and no seeded extraction, for one reason.** The other five
  `recorded` providers replay a supplier's answer, and describing a shape asserts nothing. An
  extraction is nothing *but* assertions about one document, landing where somebody confirms
  them into quoted penalties. So `selectDeadlineExtractor` has no zero-key mode, and
  `scripts/seed.ts` extracts nothing — the first feature here the seed cannot demonstrate,
  and the alternative would have been hand-written snippets claiming to have been read off a
  document nothing read.
- **The coverage sweep is the arbiter and must stay stupid.** Fabrication is dead without any
  corpus, because we hold the page text. A **miss** is what is left, it is silent, and no
  synthetic corpus can catch it — the corpus and the prompt are written by the same person.
  So `coverage.ts` is a high-recall, low-precision date regex that knows nothing about the
  prompt and cannot be tuned into agreement, it reports mentions **with their line** so
  triage is a glance, and a deduplicated reading counts as *read* — an arbiter that cries
  wolf on a well-organised manual is one nobody reads.
- **Marking a deadline "does not apply" is an edit, not a status.** It takes money out of
  the show's exposure, so it needs a written reason and the authority to change the plan —
  the same rule `skipped` needed, reached from an unrelated direction.
- **Assigned is not staffed, and staffed is not present.** Booth coverage counts people who
  are on the roster, have confirmed, and are in town for the whole slot; a shift that is
  fully assigned and still short is flagged **overstated**, because that is the one figure
  nobody would have gone looking for. An unknown travel window is unknown, not absent.
  `src/lib/team/coverage.ts`.
- **Only the person confirms their own attendance, and coverage enforces it.** Staffing a
  show invites; `show_attendees.responded_at` records that the subject answered; and
  `standingFor` requires that timestamp before a `confirmed` counts — a status typed on
  somebody's behalf lands as `secondhand`, visible and uncounted. Recording the column is
  not the same as counting it, and for three steps only the write path obeyed the rule.
  `secondhand` is deliberately not `unconfirmed`: "said yes, chase them" and "has not
  answered" are different work items.
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
- **A delay is not news; a delay that costs the arrival buffer is.** §7's rule was checked
  once, against an offer, at purchase. The tracker re-checks it against live times, reads
  the required hours out of the **resolved travel policy** rather than writing "4 hours"
  down a second time, and only speaks when a flight that cleared the buffer stops clearing
  it. A flight booked inside the buffer was an approval decision, not a disruption. A
  delayed flight *home* says nothing at all. `src/lib/flights/status.ts`.
- **A carrier re-timing a flight is not a delay, and never touches the scheduled columns.**
  `provider_scheduled_departure` / `_arrival` and `schedule_changed_at` sit beside the plan
  the ticket was bought and approved against; delay is then measured from the carrier's new
  schedule, or every re-timed flight reads as permanently late by however much it moved.
- **An unchecked flight is not an on-time flight.** `scheduled` is the default and renders
  as the calm one, so a board nobody has refreshed shows a full slate of on-time flights.
  Staleness is judged against the flight's own timeline; a flight past its departure that
  nobody could check is `unknown`; and a lookup that found **no record patches nothing** —
  not even `last_checked_at`, because a successful-looking stamp on a failed lookup is how
  a board goes stale while claiming to be fresh.
- **A flight alert is keyed to the standing it reports, not to the estimate.** A deadline's
  date moves rarely and deliberately, so §5a keys on the date. An arrival estimate moves
  every time anybody asks, so the same key would send "your flight is late" all night. The
  key carries `inside_buffer` / `after_move_in` / `cancelled` and the leg's scheduled
  instant. `src/lib/flights/alerts.ts`.
- **Ticketing writes the itinerary, not just the order.** A booking row is what an audit
  needs; `flights` is what a person needs, and for twelve steps nothing wrote it, so every
  ticket the agent bought was invisible on My Itinerary, the show's Travel tab and the
  board. Materialization is idempotent on `(booking_id, segment_index)` and slice 0 is what
  makes `leg_direction` a fact rather than a guess.
- **Nothing in this app rebooks a cancelled flight, and the alert says so.** Same shape as
  cancelling a ticketed request: the airline has the ticket. `SCOPE.md` §5f.
- **The status provider is never chosen by falling back either.** AeroAPI with a key,
  `recorded` only when `FLIGHT_STATUS_PROVIDER=recorded` says so, otherwise an error naming
  the variable. The temptation is stronger here than for fares — nobody spends money on a
  delay reading — but the sentence it produces is "your colleague will make move-in".
- **A crate has a window, not a deadline, and early is a failure too.** An advance
  warehouse holds freight for weeks and closes on a published cutoff; show-site receiving
  does not open until move-in, and anything that arrives before a staffed dock is refused,
  stored at the carrier's rate, or returned — an outcome every status column in every
  carrier payload calls `delivered`. `shipments.consignment` picks the rule, a show-site
  row cannot be saved without `receiving_opens_at`, and `too_early` is a real standing.
  An advance-warehouse cutoff is **never** defaulted from move-in: it is one to three weeks
  earlier, so a helpful prefill is wrong by a fortnight and looks right.
  `src/lib/shipping/status.ts`, `SCOPE.md` §5g.
- **Delivered is the carrier's word; received is a person's.** Between the dock the carrier
  signed at and the booth sits drayage — a separate contractor on its own schedule that
  this app cannot see. A delivered crate stays a *live* row until somebody sets
  `received_at`, and confirming it is available to **anybody**, because the person who finds
  the crate is whoever is standing in the booth at 7am. A confirmation only a manager can
  give is one that never gets given, after which every delivered crate stays flagged and the
  flag stops meaning anything. Same rule as `show_attendees.responded_at`, from a fourth
  direction.
- **Silence is the failure mode, and no status field reports it.** A stalled crate has a
  healthy payload: the carrier is still promising Thursday and there has been no scan since
  Tuesday. So the *absence* of scans is what raises it, with a threshold generous enough for
  LTL freight (which really does scan once a day) that tightens near the deadline. A
  tracking number with no scan at all is a label nobody handed over; a deadline with no
  tracking number is a plan, not a crate, and the engine says so rather than making a claim
  about a truck that does not exist.
- **§5f's rule about the leg home inverts for freight.** A delayed flight home says nothing;
  a return crate is the one that actually goes missing, and you find out a quarter later
  when the booth is not there for the next show. So the sharpest alert in the product has
  **no row behind it**: a show that moved out, had outbound freight, and has nothing
  recorded coming back. `src/lib/shipping/alerts.ts`.
- **A shipment alert is keyed to the deadline *and* the standing.** §5a keys on a date
  because dates move deliberately; §5f keys on the standing because estimates move hourly.
  Shipping has both in one row, so the key carries both and carries the estimate nowhere.
- **A carrier's timeline is returned whole on every poll, not as a delta.** So a scan
  carries a `fingerprint` — instant, phase, location, deliberately *not* the message, since
  carriers reword scan text between polls — and `(shipment_id, fingerprint)` is unique.
  Without it a nightly sweep grows the timeline by its own length every night.
- **The tracking provider is never chosen by falling back either.** EasyPost with a key,
  `recorded` only when `SHIPMENT_TRACKING_PROVIDER=recorded` says so, otherwise an error
  naming the variable. The sentence it produces is "the booth will be there before the doors
  open".
- **Presence never answers for safety.** A badge scan at 8:04 makes somebody *more* urgent
  to reach about a 10am incident, not less. Presence decides who to call first; only an
  answer closes a name. There is no timeout turning silence into assent, no inference from a
  scan, and **no bulk "mark everyone safe"** — the obvious button, and the only control that
  could produce a complete headcount without anybody having spoken. `src/lib/safety/`.
- **Nothing in duty of care reads a device.** Every standing is inferred from a row the app
  already kept for another reason. The moment something reads a position, this stops being a
  feature about who to call and becomes one about watching staff — a ceiling on what the
  feature is, not a gap in it.
- **A response is a response to a request**, so a roll call is a row and answers carry the
  one they answer. Otherwise "checked in safe" from last March marks somebody accounted for
  during this morning's evacuation, on the headcount somebody reads aloud.
- **A relayed answer counts and is labelled — §5e inverted, twice.** A `confirmed` typed by
  somebody else is hearsay in a staffing number and is refused; "I have her on the phone, she
  is fine" is the same shape and is exactly what a roll call needs. And where booth coverage
  declines to flag an unrecorded travel window, a roll call sorts that person **first** — the
  same gap, read the other way, because the cost of the two mistakes has swapped places.
- **Contactable is not contacted.** "12 of 14 reached" over a roster where three have no
  phone number is a lie about reach. They are counted apart and named, and the moment that is
  useful is *before* an incident — which is why the screen says it when nothing is happening.
- **An interval that contains now does not age; an observation does.** Staleness is keyed by
  **basis**, never by kind: a badge scan and a landing perish, a travel window and a hotel
  stay do not. Marking a current window stale says "we have not heard in 18 hours" when the
  truth is "we never had a signal, only a plan". Their coarseness is already carried by their
  producing `in_town` rather than `at_venue`.
- **Drayage rounds per shipment, never in aggregate.** Two 150 lb crates are two shipments,
  each takes the card's 200 lb minimum, and 400 lb is billable. Summing first gives 300 lb
  and bills three hundredweight — 25% light, in the flattering direction, on a figure nobody
  has an invoice to check against yet. Nothing about the wrong version looks wrong.
  `src/lib/drayage/estimate.ts`.
- **A drayage estimate never joins the cost total.** `creditFundedCents` and `consumedCents`
  sit outside it because they are real money in the wrong period; this sits outside because
  **nobody has been billed it**. It stays beside the invoice once the invoice lands, which is
  the point — a gap between the two is usually freight that went in loose.
- **There is no default for how a rate card charges.** Reading a round-trip card as each-way
  halves the largest line on the show; reading it the other way doubles it. No database
  default, no pre-selected option in the form, and the manual states which.
- **A crate with no weight is not a weightless crate, and `unknown` packing is not `crated`.**
  Both are counted, named, and make the figure a floor. A card silent on special handling has
  not said the surcharge is nil either. `numeric` arrives as a string and `Number(null)` is
  0, so the weight rule lives or dies on one line in `drayage/store.ts`.
- **Setting drayage rates is money; saying how a crate is packed is a fact.** The rates are
  the multiplier on every crate on the show, so they sit with whoever runs it. Crated or
  pad-wrapped is knowable only by somebody standing next to it in the warehouse at 6am —
  `canConfirmReceipt`'s rule, and a gate there would leave every row at "nobody has said"
  forever, after which the sentence stops meaning anything.
- **A condition with no clock is not an alert.** Every one of the seven engines fires on
  something that changes with time. "This show has freight and no rate card" is true the
  moment freight is recorded, stays true until somebody types one, and never sharpens — a
  permanently-true alert that never escalates is a nag, and one of those teaches a team to
  close the next alert unread. `/cost` says it where somebody is reading a shipping figure.
  **Do not add an eighth engine for it.**
- **The assistant's access model is its tool list, not its prompt.** Every tool is an
  existing org-scoped store function, called as the asking actor, through the same
  `access.ts` gate a screen goes through. "Which room is Shelley in" is refused because
  `travelerScope` narrowed the query before the agent saw anything — the row is never
  retrieved, so there is nothing to leak and no rule for an injected instruction to
  override. **Adding one tool that queries around the actor breaks the whole posture**, and
  so would adding a way to read somebody else's transcript. `src/lib/assistant/tools.ts`.
- **A tool the actor may not hold is never described, and naming it gets "not a tool".**
  Telling a model that a capability exists but is withheld is a map to aim at next.
- **Nothing in the system prompt is load-bearing.** If a rule would be dangerous to have
  disobeyed, it is in code. `prompt.ts` carries *tense* — which is the product, and the
  thing a summary destroys.
- **The assistant drafts; it never confirms its own parse.** A drafted travel request is
  filed with the person's own words and `constraints_confirmed_at` null, the agent refuses
  to search until a human confirms, `confirmConstraints` is not a tool, and the
  `FlightProvider` it is handed rejects on every method. Filing without raw text would mark
  the parse human-confirmed, so the draft path refuses rather than defaulting. `SCOPE.md`
  §6a and §6f.
- **A replayed model plans tools; it never writes prose.** The `recorded` rule everywhere
  else — describe a shape, assert nothing about this workspace — has no prose form. A
  canned sentence about a workspace is a fabricated figure under the app's byline, which is
  the failure the §5a engine exists to prevent.
- **A transcript replays prose, never stale tool results.** A tool result is a snapshot of
  rows at the moment it ran, and "has it landed yet?" is a question about the row that has
  moved since.
- **A conversation is scoped to a user, not an org** — the only table here that is —
  because every result inside it was fetched under that person's scope.
- **Reserved is not available, and available is not serviceable.** A reservation is a claim
  on a thing that may already be promised elsewhere, and a thing promised to nobody may
  still be a booth with a cracked panel. `availabilityFor` returns three different refusals
  with a reason on each, and an unserviceable asset promised to an upcoming show gets its
  own alert — because the condition is a label on one screen and the reservation is a row
  on another, and nothing else in the product joins them. `src/lib/assets/custody.ts`.
- **An asset clash is between reservation windows, and show dates *under*-report it.** The
  exact inverse of §5e: comparing show dates over-flags a person's double-booking and
  under-flags an asset's, because the booth is gone for a month around a three-day show.
  And adjacent is not clear — under 120 hours between two reservations is a `possible`
  finding, because the crate has to get home, be opened and be re-crated.
  `src/lib/assets/conflicts.ts`.
- **A reservation window is never prefilled from the show.** Same refusal as an
  advance-warehouse cutoff, in both directions at once. It is typed, and then checked
  against the show's actual freight by `freightCoverage` — which returns `unverified`, not
  a pass, when there is no freight to check it against.
- **Condition is recorded at both ends, and a check-in is the only place it moves.**
  `assets.condition` is mutable, so a single value cannot say when the damage started;
  `condition_on_checkout` makes the delta a fact. A return worse than the checkout needs a
  written note — §5d's rule on `skipped`, from a third direction — and there is deliberately
  no condition field on the asset edit form, because that would be a second way to set the
  same fact.
- **Signing an asset out and checking it in is available to anybody**, like confirming a
  crate at the booth. The person in the warehouse at 6am is not a Travel Manager, and a
  `returned_at` only a manager can set is one that stays null — after which every
  reservation reads overdue and the flag stops meaning anything. Counting a shelf is the
  same act. `src/lib/assets/access.ts`.
- **On hand is not available.** Stock promised to a show that has not packed yet is not
  stock, so low stock is judged on `on hand − committed` and promising more than we hold is
  its own critical standing. The on-hand figure is the one on every screen and it reads
  fine right up to the morning of the pack. `src/lib/assets/inventory.ts`.
- **An uncounted return is not a zero return, and an allocation is not a movement.**
  `quantity_returned` is nullable on purpose: reading null as zero writes off stock we own,
  reading it as full ships the next show short, so the app refuses to guess and names both
  guesses in the alert. And promising stock is a claim while picking it off the shelf is a
  movement — only the second touches `quantity_on_hand`, which is a projection of the
  append-only `collateral_entries`, moved only by appending a signed delta with a stated
  reason. The credit ledger's rule, applied to things.
- **Past the point where an asset can turn up, "return it" is the wrong sentence.** A booth
  nobody has seen in six weeks is an insurance and replacement conversation. §5a's tense
  rule, at the end of the chain of custody. `src/lib/assets/alerts.ts`.
- **A lead count that does not say who did not capture is a fabricated bill.** §8a's rule on
  the return side. A count is introduced with "at least" whenever anybody rostered on a
  booth shift recorded nothing, and the silent people are *named* — "on the booth" is a
  shift assignment, not attendance, because counting every attendee flags every show and
  flagging every show is the same as flagging none. An unrostered show is `unknown`, never
  0 of 0, which renders as perfect. `src/lib/leads/coverage.ts`, `SCOPE.md` §5j.
- **Cost per lead is withheld over a thin count, never caveated.** The error runs *high*,
  which reads as a bad show, so a quotient over an undercount drives exactly the decision
  §8c warns about. `mayQuotePerLead` is the refusal, and step 19 has to obey it rather than
  route around it.
- **A duplicate lead inflates in the flattering direction.** Identity is the scanner's own
  reference, then the email, and **within a show only** — the same person met at two shows
  is two engagements with two costs, and collapsing them hands one show credit for the
  other's conversation. Name-plus-company is a *suspicion*, surfaced and never auto-merged.
- **A refusal to auto-merge is only honest if something later asks.** The `possible` pair is
  offered on the tab and settled by a person, because the machine deliberately will not:
  marking one **moves the lead count**, so it sits with changing the plan, and it is
  reversible in both directions because it was a judgement about two strangers who share a
  name. Nothing is merged or deleted — the row keeps its own consent record and its own
  retention clock and simply stops being counted twice. Chains are refused, or "how many
  leads" would depend on the order somebody clicked in. `src/lib/leads/dedupe.ts`.
- **An import accounts for every row it read.** Accepted + rejected + duplicate equals the
  row count, always; the rejections keep their row numbers and reasons; the batch record is
  written even when nothing was accepted. The column mapping is proposed and **confirmed**,
  never applied silently. An imported lead is attributed to nobody — crediting the uploader
  makes one person's capture coverage perfect and everybody else's worse.
- **A lawful basis is never manufactured out of an absent column.** `leads.consent_basis`
  has no database default, `unknown` is a recorded answer, and consent claimed with no
  timestamp or no record of what the person was told is a claim about consent rather than
  consent. Refusing to market is not refusing to keep: an unknown-basis lead stays, stays
  counted, and is withheld from anything outbound. `src/lib/leads/consent.ts`.
- **Erasure is redaction, because erasing the person must not erase the count.** Deleting
  the row would move every ROI figure that show ever produced, silently, months later, and
  cost per lead would improve on its own. The personal columns are nulled — including
  `crm_external_id`, or the erasure is a fiction with a footnote — and the shell keeps the
  show, the capturer, the timestamp and the source. A withheld row renders as a labelled
  shell rather than a blank name, because blank is indistinguishable from erased and those
  are opposite facts.
- **A retention promise nothing enforces is worse than no promise.** `delete_after` has a
  finite default because a limit nobody configured must still be some number, the sweep
  actually erases, and `retention_overdue` is `critical` from the first night — the only
  alert in the product that reports our own non-compliance rather than a supplier's.
- **Capturing a lead is anybody's; erasing one is not.** A capture flow gated on a role
  produces §8c's bad count by construction — the person holding the badge at hour six of
  day two is a Member. Erasure is irreversible, so it sits with changing the plan. The
  *count* is everybody's and the *person behind it* is narrowed in the query to whoever
  captured it plus the approvers. `src/lib/leads/access.ts`.
- **An intake key is not an `Actor`, and that is a type rather than a check.** A service
  user with a role would flow through `getActor()` into every store function in the app; an
  `IntakePrincipal` is the wrong type for all of them. Only the hash is stored, the key is
  scoped to one show wherever possible, and revocation is a timestamp so "which key wrote
  these forty leads" stays answerable. `src/lib/leads/intake.ts`.
- **A retry on the intake endpoint is a success, not a conflict.** A scanner on
  convention-centre wifi retries requests whose responses it never saw. 409 teaches the
  integration to treat a recorded lead as a failure, after which somebody writes the retry
  loop that manufactures the duplicates the endpoint exists to prevent. `external_ref` is
  unique per show, and that index is what makes idempotency true rather than intended.
- **The assistant holds lead counts and never a lead.** `lead_capture` returns coverage and
  no personal data; `listShowLeads` is not a tool. A model's context window is somewhere
  data goes and does not obviously come back from, and nothing anybody asks the concierge
  needs a stranger's phone number in it.
- **Two floors in a quotient do not cancel.** A lead floor pushes cost-per-lead *up* and a
  cost floor pushes it *down*, and neither magnitude is known — so the combination is
  unbounded in both directions while looking better founded than either input. A figure over
  two floors is **withheld**, never averaged and never caveated. `mayQuotePerLead` was
  written a step early for this exact division and step 19 obeys it rather than routing
  around it. `src/lib/roi/rollup.ts`, `SCOPE.md` §5k.
- **A replayed pipeline withholds its ratios, not just its banner.** The other three
  `recorded` providers replay a shape, and a banner discharges the rule. An opportunity has
  no shape separable from its claim — "$290,000 sourced by MedTech" is a sentence about this
  company, next to a real cost, in a headline. So the CRM replay carries a *conversion*
  shape onto dates we really met people, invents nobody it was not asked about, returns
  nothing dated in the future, **refuses to report a write it did not make**, and every
  figure derived from it is withheld. A reader who has learned to skim a banner has not
  learned to skim a multiple.
- **First touch is decided across the whole calendar, never within a show.** "Created after
  this show and inside the window" hands every recurring buyer's opportunity to whichever
  show met them most recently — annually, silently, flatteringly. §5j's identity rule
  inverts here: within a show for **counting**, across shows for **crediting**. One
  opportunity is sourced to at most one show ever, or the portfolio's sourced pipeline
  exceeds the pipeline; and when first touch falls outside the window, nobody sources it —
  the runner-up does not inherit. `src/lib/roi/attribution.ts`.
- **Influenced pipeline does not sum, and a portfolio must never add it up.** The same deal
  is legitimately influenced by three shows; that is what the model means. The portfolio
  prints the value of the **distinct** opportunities any show influenced, which is always
  smaller than the sum of the per-show figures and is the only one with a referent.
- **Matching by email is an outbound transfer; matching by id is not.** An id the CRM gave
  us sends nothing about the person. An email sends a stranger's address to a third party,
  so it is gated on `marketabilityOf` — step 18's refusal, biting on a number. The interface
  keeps them as two methods so no adapter can quietly collapse them into one convenient
  `match()`. `src/lib/roi/store.ts`.
- **Withheld is us refusing; unmatched is the CRM answering.** They are never added, never
  shown as one "match rate", and never described in the same sentence. Collapsing them
  presents a deliberate refusal as a vendor's data-quality problem, which is the misreading
  that gets the refusal removed. A third state, `unsynced`, is "nobody has looked", and only
  that one is fixable by pressing a button.
- **A show inside the maturity horizon reports its figures and withholds its verdict.** §8e:
  ROI is not final for 6–12 months, so a show scored the week it ends always looks like a
  loss. Closed-won is not quoted before it has had time to land, and the portfolio is ranked
  by **cost** rather than by multiple — ranking by multiple puts every recent show at the
  bottom by construction, and somebody cancels one.
- **Nothing alerts on a low multiple, deliberately.** It is the obvious thing to alert on and
  it would be this product telling somebody to cut a show over a figure it has just finished
  explaining is not final for a year. The seventh engine reports that the ROI *question* is
  unanswered — a real cost whose leads have never been offered to a CRM. It does not answer
  it. `src/lib/roi/alerts.ts`.
- **An unbuilt adapter must be incapable of returning a result.** "We captured 41 leads and
  the CRM knows none of them" is a real and alarming finding this product exists to surface,
  so a stub returning `[]` manufactures it out of its own absence — §8a's fabricated bill
  wearing the costume of a placeholder. Every HubSpot method throws, `isConfigured()` is
  false even with a key, and `selectCrmProvider` answers `hubspot` with what building it
  takes rather than "not a CRM this app has", because the second sentence is false.
- **The CRM interface has exactly one write method, and that is the design.** §8b says never
  sync contacts, own the pipeline, or duplicate CRM objects. An interface with
  `upsertContact` on it is an invitation, and the second customer asks for it. The way not to
  become a CRM is to be structurally unable to.
- **Attribution is derived at read time and never stored.** `crm_opportunities` holds the
  CRM's facts; which show sourced one is computed from capture dates and the window, so
  changing the window re-derives every figure instead of requiring a migration and leaving
  the old answers lying around looking authoritative. The credit ledger's rule — a balance is
  a projection, never assigned — applied to pipeline.
- **The seed clears with `TRUNCATE … CASCADE`, never a delete.** Three foreign keys are
  `restrict` on purpose — `lodgings` and `side_events` protect their cost center, `approvals`
  its approver — and `RESTRICT` is checked immediately, per row, while the order Postgres
  processes sibling cascade constraints in is unspecified. So `delete from organizations`
  was refused by a lodging that was itself about to be deleted a moment later. `TRUNCATE`
  truncates every table that transitively references this one rather than firing per-row
  referential actions, which is order-free and cannot rot when somebody adds the next
  `restrict` FK for a good reason. **It hid for twenty steps because `pnpm db:reset` deletes
  `.pglite` first**, so in the path the docs recommend the statement ran against an empty
  database and did nothing.
- **A runtime guard over an enum is derived from the exhaustive record, never hand-written
  beside it.** `alerts/store.ts` kept its own `SOURCES` array; adding a source to the type
  compiled everywhere, wrote correct rows, and read every one back as `unknown`. Nothing
  failed and a whole engine's output was mislabelled. `SOURCE_LABEL` is a
  `Record<AlertSource, string>` the compiler already checks, so the guard reads its keys and
  one check does both jobs.
- **Only a sweep resolves an alert; a person only ever says they have seen it.**
  `acknowledged_at` is "I read this" and `resolved_at` is "this stopped being true", and a
  screen that let one set the other would be the acknowledged-and-forgotten failure with a
  nicer interface. Resolution is absence from tonight's plan, which is sound **only**
  because every engine plans over its whole population rather than over what changed — an
  engine that planned over a subset would silently close every row it did not look at.
  `src/lib/alerts/store.ts`.
- **A recurrence is news, and the old dedupe swallowed it.** `onConflictDoNothing` meant a
  condition that ended and came back under the same key reused a row somebody had
  acknowledged, arriving pre-dismissed. A resolved row that recurs comes back
  un-acknowledged, with `occurrences` reset and its clock restarted.
- **An engine dedupes a fact; a feed dedupes a sentence.** Eleven people on one re-timed
  flight is eleven correct rows and one piece of news for whoever receives all eleven.
  Grouping is a view concern and never a change to a dedupe key.
- **An alert nobody has re-checked is not a current alert**, and nothing here runs on a
  schedule yet. `unchecked` is a standing of its own, counted on the page — §5f's rule
  about the unchecked flight, applied to the thing that reports the flights.
- **There is no org-wide alert read, including for an admin.** Every engine writes one row
  per recipient, so the audience was decided where the reasoning lives. A feed-level
  "everybody's alerts" would be a second, dumber audience model, and its first act would be
  showing a manager a Member's personal flight home. `src/lib/alerts/access.ts`.
- **A row is not a message, and the transport refuses five ways before it interrupts
  anybody.** An `info` condition stays on `/alerts` and a *notice* goes at any severity,
  because a notice is an event that happened once. Eleven rows are one sentence, through the
  feed's own `groupFeed` and never a second grouping. Switching a transport on does not
  replay history. Only somebody who was told is told it ended. And a personal alert never
  reaches a shared room — the only one of the five that is about entitlement rather than
  noise. `src/lib/notify/plan.ts`, `SCOPE.md` §5m.
- **A destination is the subject's own, and not an admin's.** Every engine addresses its
  rows to a person, and `alerts/access.ts` refuses an org-wide read precisely so a Travel
  Manager never sees a Member's personal flight home. An admin who could point that Member's
  alerts at an address of their choosing reopens the same door from the transport side,
  where nothing on the alerts screen would show it. The address is **resolved by the
  transport from the person's own email, never typed**: a wrong Slack id does not bounce, it
  is accepted, logged as sent, and never seen.
- **A replayed transport is the one replay this codebase cannot have.** The other five
  `recorded` providers replay a supplier's *answer*, and describing a shape asserts nothing.
  A transport produces an event in the world — somebody's phone buzzed — and there is no
  shape of that which is not a claim. `console` composes the real message and reports
  **`rendered`**, never `sent`; `reachesPeople` is false; and the settings page says "nothing
  has ever left this workspace" rather than hiding it.
- **Slack reports failures with HTTP 200, so `res.ok` is the wrong check here and only
  here.** A bad token, an unknown person, an archived channel and a malformed payload all
  arrive as `200 {"ok": false}`. The failure has no symptom: the log fills with `sent` and
  nobody's phone buzzes. Everything goes through one `call()` that reads `ok` first.
  `src/lib/integrations/notify/slack/client.ts`.
- **The delivery rail inherits the alert store's recurrence decision and never makes its
  own.** `(alert, channel, phase, alert_created_at)`: a condition holding nine nights keeps
  one `created_at` and is carried once; a condition that resolved and came back has its clock
  restarted by `alerts/store.ts` and is carried again, because it is news again. A second
  dedupe rule beside the first is the `SOURCE_LABEL` trap in another costume.
- **A failed send is recorded as failed and retried when it is planned again, never in a
  loop.** A rate limit clears by tomorrow and an archived channel does not; the transport
  says which. Retrying a permanent failure forever is `outbox.ts`'s badge that is always on.
- **The nightly job sweeps, then erases, then carries — and stops rather than delivering
  last night's answers as tonight's.** The order is the argument: a `retention_overdue` alert
  raised in stage 1 and satisfied in stage 2 is closed by tomorrow's stage 1, rather than
  personal data being erased before the engine that reports on it has looked. Every run
  writes its row before it does anything and closes it either way, because a half-failed
  sweep that reported success is how a board goes quiet and one that reported nothing is the
  same thing with no evidence left. `src/lib/schedule/nightly.ts`.
- **A job that did not run is not a quiet night.** `scheduled_runs` is append-only and
  `manual_only` is a standing of its own, because "somebody ran it yesterday" and "it runs"
  are different assurances and only one will still be true next week. §5f's unchecked flight,
  applied to the thing that runs the engines. Until step 21 a workspace whose scheduler had
  been broken for a week and one with nothing wrong looked identical on `/alerts`.
- **A missing `CRON_SECRET` is a refusal, not an open door.** That endpoint erases every lead
  past its retention date, and an endpoint that destroys personal data because nobody set a
  variable is step 7's `authMode()` bug on the write side. The principal it resolves to is a
  `SchedulerPrincipal` and deliberately not an `Actor` — §5j's rule on a caller that erases
  rather than appends — and the route takes **no org parameter**, so there is nothing to
  enumerate and no way to misconfigure it into sweeping nobody while answering 200.
- **`/api/cron` is public in Clerk mode for a sharper reason than `/api/intake`.** A
  scheduler has no browser: a Clerk bounce answers 302 to a sign-in page, and every hosted
  cron reads that as a success. The job would silently never run, nightly, with a green tick
  beside it.
- **A provider-selecting CLI loads `.env.local`, because otherwise it disagrees with the
  app.** `pnpm alerts --sweep` used to report the flight and freight engines as *could not
  run* on a workspace where they were configured — the sentence the whole design leans on,
  produced by the script's own env loading rather than by the workspace.
- **A cost figure that does not say what it is missing is a fabricated bill.** §5a's rule at
  the scale of a show. A total is only called a total when everything that exists carries a
  figure and nothing structural is absent; otherwise the word is *at least*, and the line
  says why. A **silent** line is not a zero: a show with no booth-space figure is not a
  cheap show, it is a show nobody has entered the invoice for. `src/lib/cost/rollup.ts`.
- **A dry run is not spend, a credit is not a discount, consumption is not an outlay, and
  committed is not paid.** `bookings.live` is the provider's word and the rollup is the
  thing it was always protecting — the seeded workspace is made entirely of dry runs, so a
  rollup that summed charged amounts would have been fiction on day one. A credit-funded
  fare was bought last year on a cancelled ticket and belongs to that show, so it is a memo
  beside the total. Stock issued off a shelf was paid for when it was printed. And
  `expenses.paid` is the only tense marker in the money.
- **Staff time is counted in days and never priced.** §11.8 is open and there is no loaded
  rate in this workspace; a dollar figure would be one we invented, which is the thing the
  page exists to refuse.
- **A show's cost is Travel Manager and Admin.** It is every colleague's fare in one figure,
  and `travelerScope` narrows a Member's own travel queries precisely so a colleague's fare
  is never on their screen. The tab is not rendered for a Member rather than rendered and
  refused.
- **A cached screen must say how old it is, and stop making present-tense claims.** §5f's
  unchecked flight, applied to a whole page. A day-of snapshot carries one instant, every
  reader passes a clock, and `degradeVerdicts` takes the standing off a crate line past
  forty-five minutes — while leaving the recorded facts, because *delivered to a dock,
  unconfirmed at the booth* is a signature rather than a guess about a truck and blanking it
  removes the most useful sentence on a move-in morning. `src/lib/dayof/snapshot.ts`.
- **The day-of page's server half fetches nothing, and that is the design.** Its HTML is
  cached and served again tomorrow, so data rendered into it would be a second copy of the
  show's facts with no instant attached — and the freshness line would be a claim about the
  half a person is not reading. One copy, in IndexedDB, stamped.
- **A queued capture is not a recorded lead, and the two counts never merge.** §8c's whole
  mitigation is that a thin number is visibly thin; a count including rows on a phone is that
  failure with a friendlier cause. The word is "on this device" rather than "pending" —
  a location, not a process. `src/lib/dayof/outbox.ts`.
- **Every queued item is accounted for, and a rejected one is kept.** `reconcile` throws
  rather than dropping something the server did not answer about: there is no file to re-read
  and no row number to point at, and the person who had the conversation is the only record
  left. A refused item stays, blocked and visible with the server's sentence on it, because
  deleting it destroys the only copy of a real conversation and retrying it forever leaves a
  badge that is always on.
- **A re-send is a success, and it is `leads.external_ref` again.** The device mints its ref
  when the person types and never changes it, so a retry after a lunch break, a browser kill
  or a different network finds its own row. **`already` and `duplicate` stay different
  answers** — only one of them is news, and collapsing them tells somebody their colleague
  met the buyer when in fact their own phone did.
- **A queued lead is written through `captureLead`, as the person who typed it.** Same
  validation, same dedupe, same consent rules, same permission check — a leaner insert for
  the offline path is how an offline lead ends up with a lawful basis nobody chose. And
  deliberately **not** through the intake endpoint: an intake key writes leads attributed to
  nobody, and that attribution is the entire input to §8c's coverage figure.
- **A device's clock is trusted backwards and never forwards.** A lead typed at 10:14 in a
  hall with no signal happened at 10:14, not when the wifi came back — but a fast clock would
  file a conversation that has not happened yet, which sorts to the top of every list forever
  and lands in a shift that has not run. The EasyPost replay's rule, from the client side.
- **Target matching is exact after normalising legal suffixes, and never fuzzy.** The failure
  of a loose match here is not a wrong row on a screen: it is a person at a booth telling a
  stranger their company is one we came for, with no way to check it. "Group", "Partners" and
  "Technologies" are deliberately not suffixes — stripping them merges two real accounts
  silently. `src/lib/dayof/targets.ts`.
- **Whether a target was met is derived from the leads, never stored.** There is no `met_at`
  column. An erasure takes the evidence and the claim together, and "6 of 9 met" cannot
  disagree with the list under it. The credit ledger's rule and the ROI attribution rule, from
  a third direction. A must-meet with no owner escalates rather than going quiet — §5a's
  unowned deadline exactly.
- **Reading the target list is everybody's; editing it is not.** A target nobody at the booth
  can see is a target nobody meets. Adding a must-meet moves the denominator of every "targets
  met" figure the show will report, so it sits with skipping a task and waiving a deadline —
  and it is edited on the show's Leads tab, by somebody sitting down, rather than on the
  screen for people who are standing up.
- **The service worker caches only the day-of pages.** A cache is a copy that outlives the
  session allowed to read it, so caching `/cost` or `/travel` would leave a colleague's fares
  on a device long after sign-out. The snapshot carries the actor it was built for, and a
  mismatch **wipes** IndexedDB and every cache rather than filtering what is drawn.
- **The offline screen only works if it was opened online first**, and the page says so. A
  browser cannot cache a page it has never seen. That is a sentence to put in front of
  somebody the week before the show, not a defect to engineer around.
- **A clone never carries a confirmation, and never carries a shipment.** Cloned
  deadlines arrive unconfirmed, cloned attendees re-invited, and shipments, flights,
  lodging, expenses, and the booth number do not come at all. A cloned asset *reservation*
  carries its window and never its custody log: "signed out by Marcus on 9 July, returned
  damaged" copied onto next year's show is a chain of custody for a trip nobody took. Dates shift on the local
  calendar, not by elapsed milliseconds. `SCOPE.md` §5c.
- **A declined show is kept.** Intake decisions are append-only rows with a written
  reason; `shows.status` is the projection. The declines are the half that argues with
  next year's calendar.
- **Scheduled times are immutable.** Live/estimated times go in separate columns.
- **Money is integer cents.** Providers send decimal strings — parse with
  `src/lib/money/decimal.ts`, never `parseFloat`.
- **Flight times are local airport time.** Resolve with `src/lib/datetime/zoned.ts`
  against the airport's IANA zone, never `new Date()`.
- **A form input's date and time come from `zonedDateInput` / `zonedTimeInput`, never
  from `toISOString()`.** On a 5pm-Pacific due date `toISOString().slice(0, 10)` returns
  *tomorrow*, so a round trip through the edit form moves the deadline a day. The view
  layer had reimplemented this four times, untested, which is how it stayed wrong.
  `<ZonedDateTime>` in `_components/form-ui.tsx` is the pair of inputs, labelled with the
  zone read at the instant being edited.
- **No screen names a palette colour.** `border-border`, never `border-zinc-200`, and no
  `dark:` variant anywhere in `src/app` — one semantic token in `globals.css` carries both
  themes. A `dark:` twin per coloured line is a thing to forget, and forgetting it is
  invisible to anybody working in light mode.
- **A rule enforced on a table nothing can write is a feature that does not exist.** Four
  tables were read by screens and written only by `scripts/seed.ts`, so the seeded workspace
  worked and a real one silently could not: no traveler could be ticketed (`users.born_on`,
  `users.phone`), no invoice could be filed (`expenses`), no financial row of any kind could be
  saved (`cost_centers`, which §4 requires on all of them), and the booking agent refused to
  search at all (`travel_policies`). **Re-run the check when adding a feature**: for each
  `pgTable`, does anything outside the seed insert or update it?
- **A figure that decided a purchase carries the terms that produced it.** `offer_snapshots`
  stores the preference credit beside `score` rather than leaving it in `agent_runs.detail`,
  which is a log, and never re-derives it on read — allowances move, and a re-derived one
  restates last quarter's purchase in this quarter's numbers. And a premium is measured against
  **the cheapest fare the policy allowed**, never the cheapest seen: a denied fare was never an
  option, so measuring against one invents money that was never available. An allowance is a
  **ceiling, not a spend** — report what was paid, name what was authorized.
  `src/lib/travel/review.ts`.
- **`money()` drops cents on purpose, so a difference needs `moneyExact`.** Two decimals on
  every row of a board is noise; two decimals on a $15.55 gap between two fares is the point,
  and `money` renders it "$16 more". They are two functions rather than one with a flag so the
  choice is made rather than defaulted.
- **A check that can skip has to say when it did.** `pnpm smoke` drops `/travel/[id]` whenever
  no request is visible to `DEV_ACTOR_EMAIL` and the approvals queue is empty, and still printed
  "all 200" over the most complex page in the app with the route count as the only signal. §5f's
  unchecked flight, applied to the thing that checks the screens. A **clean seed covers it** —
  `seed:ingrid:lhr` is left pending on purpose; `pnpm booking:dry-run` is what empties the queue,
  because every request it creates ends in a terminal state.
- **A measurement taken against a database something else is writing is not a measurement.**
  Two wrong conclusions in one sitting came from this: a `pkill` that aborted a compound command
  before its `db:reset` ran, and a `booking:dry-run` fired from a second process while `next dev`
  held the `.pglite`. Both returned answers that *confirmed* the wrong story. Kill `next dev`
  before anything writes, and when a measurement contradicts a comment the code has carried for
  twenty-four steps, re-derive the state before believing the measurement.
- **A carrier list that nothing pays for is a sentence, not a preference.** The org's
  `preferredAirlines` produced an advisory and moved no money for twenty-four steps, which was
  documented intent and still meant an org could name its negotiated carriers and be ignored.
  Both lists are priced now and **both still only rank** — `airlineRules` cannot deny or
  escalate, and `advisory` never changes a verdict. They **stack** when an offer satisfies both,
  because two admin-typed numbers are two authorizations; the audit keeps the halves apart so
  whoever disagrees is sent to the right screen. `validatePolicy` warns on a list with no price
  and a price with no list, since both leave a screen looking configured and an agent behaving
  as though nothing were set.
- **A personal preference ranks; it never rules.** `users.preferred_airlines` is read by no
  rule and sits on `EvaluationContext` rather than on `TravelPolicy`, so `evaluate()` cannot
  reach it. A per-person *constraint* is how a preference becomes an agent that stops finding
  fares, diagnosable by nobody. It is priced by an admin in absolute cents (never a percentage —
  that scales up on the expensive international fares nobody audits), null means tie-break only,
  it is all-or-nothing across the carriers actually flown, and `scoreOffer` **clamps** the
  discounted score to the decision tier's floor so no number anybody can type crosses a tier or
  rescues a blocked carrier. `src/lib/policy/rank.ts`.
- **A choice the price alone does not explain has to say why, in the audit.** Offers vanish from
  the provider within the hour, so "we bought the $452 United over the $430 Delta" is
  unanswerable a day later unless the run recorded it. `preferenceCreditCents` is on every offer
  in the `search` step's detail and the summary names the fare that lost — and only when the
  preference actually changed the pick, because saying it every time is noise.
- **A default is a prefill at the point of entry, never a fact re-derived at read time.**
  `users.home_airport` fills "From" on a new request and `travel_requests.origin_airport` stays
  `notNull`, because that origin is a constraint the policy engine ruled against and the offers
  were priced from. Re-deriving it later would silently re-write the question a booked ticket
  answered. And it is **the traveler's** default, not the requester's — a travel manager filing
  for a colleague is asking where *they* leave from, and the wrong one is a plausible airport
  nobody would query.
- **A field the adapter already maps is not a feature until something fills it.** 24a's check
  was "does anything outside the seed write this table"; this is the same question one layer in.
  `SearchRequest.passengers.loyaltyAccounts` and its Duffel mapping both shipped in step 5 and
  `agent.ts` never populated it, so every ticket ever bought here earned no miles — and the unit
  test on the passenger builder passed the whole time, because the builder was right and nothing
  called it with anything. **Assert a wiring against the caller, not the callee.**
- **A loyalty number is passed on, never confirmed.** Nothing in a search or an order response
  says whether the carrier recognised one, so a saved row is a record that we sent it and never
  a claim that miles are crediting — the screen says exactly that. A mistyped number's only
  symptom is a year of trips that earned nothing, which is the silent-failure class §19's
  Salesforce join is named for, so it is `duffel-capture.ts`'s Q4 rather than an assumption.
- **A preference nothing reads is a promise nothing keeps.** Hotel and car rental preferences
  are deliberately not collected — §5 records hotels rather than booking them and car rental is
  out of scope — and `/settings/profile` says so on the page instead of offering a field. The
  same reason a personal airline preference is refused: `preferredAirlines` is an org policy
  input, and a per-person one quietly becomes a constraint the agent cannot find fares under.
- **Where a board row already knows its target, the write belongs on the row.** `go-to-show.tsx`
  is right for a write with no single target and wrong for one with an obvious one — confirming
  *this* crate, answering for *this* person. A second *action* that revalidates different paths
  is fine; a second *write path* that skips the store's rules is not.
- **A route may not import a module out of another route's folder when the path contains a
  dynamic segment.** `import … from '../shows/[id]/safety/forms'` type-checks, builds, renders,
  and 404s every tab under `/shows/[id]`. Nothing but `pnpm smoke` catches it.
- **A required-field check that tests for key presence under a non-nullable type is a type that
  lies.** `resolvePolicy` asked `f in merged`, so a policy leaving `preferredAirlines` blank
  resolved to `null` under a `string[]` and `rules.ts` threw on `.length`. Lists resolve to `[]`
  on the base layer; an override still yields `undefined` so it can decline to speak.
- **Never run `pnpm dev` and `pnpm test` against the same `.pglite`.** Concurrent access leaves
  it damaged and every DB-touching test then fails with `RuntimeError: Aborted()`, naming
  nothing. `pnpm db:reset` fixes it.
- **A hand-written list beside a thing that grows is the `SOURCE_LABEL` trap, and prose is not
  an exception.** It has appeared three times now: a runtime guard, a blurb naming five engines
  when there were seven, and the overview's capability list, frozen at step 8 beside a nav that
  reached twenty-three entries. Nothing failed in any of them. `_components/nav.ts` is the one
  list of screens, `does` is a **required** field on an entry, and the compiler is what makes a
  new screen impossible to add without saying what it is for.
- **A command name on an end-user screen is a vocabulary leak the scan could not see.** §17's
  pattern greps `§`, `SCOPE.md`, `a floor`, `lawful basis` and `x(s)`; `pnpm deadlines` in a
  paragraph is the most literal case of a doc comment wearing page copy's clothes — it asks
  somebody who reached the product through a browser to open a terminal. Add `pnpm [a-z:-]+` to
  the scan. The one exception is `NoDevActor`, which renders only for somebody running this
  locally with no Clerk keys and is addressed to exactly the right reader.
- **A workspace that is not set up is a screen, not an engine.** `travel_policies` and
  `cost_centers` had write paths and nothing told anybody they had to be used first, so a real
  organization met `NoPolicyError` on the screen where they were trying to do something else.
  `src/lib/setup/` says so on the overview and disappears when done — it is **not** an eighth
  alert engine, because a condition with no clock is not an alert. A step names what stops
  working rather than the chore, a step the reader cannot do names who can, and it is **not
  dismissible**: a hidden setup step and a finished one look identical from every other screen.
- **A count is derived once and badged, never counted again in SQL.** The sidebar's alert badge
  is `feed.summary.outstanding` — the same number the overview prints — because what counts as
  outstanding is `standingOf`'s decision, and a predicate that agrees with it today is the
  `SOURCE_LABEL` bug waiting. `_request.ts` makes that affordable with **zero-argument**
  `cache()` wrappers: `cache()` keys on argument identity, so `getAlertFeed(actor)` called from a
  layout and a page is two different objects and two misses.
- **Two copies of a rule kept in step by a comment is a rule with a wrong version and nothing to
  say which.** `missingForTicket` sat in `profile/edit.ts` describing itself as a mirror of
  `passengers.ts`, and they had drifted: `splitName` gives a one-word name a given and family
  name that are the same word, so the agent's check passed a traveler the screen was correctly
  refusing — a real ticket in a name that cannot match an ID. One function, beside the thing that
  throws, and the test asserts it **against the caller**. Grep for "mirrors" in a doc comment.
- **Every navigation needs a `loading.tsx` and every throw needs an `error.tsx`.** Pages here are
  `force-dynamic` and read the database, so without one a click leaves the *previous* page on
  screen and a slow board is indistinguishable from a broken one. `(app)/error.tsx` deliberately
  renders `error.message`, because the config and provider errors here are written to be read and
  Next already genericizes anything it did not expect. `notFound()` had five call sites and no
  boundary, so each one landed outside the shell with no navigation and no way back.
- **`@theme`, never `@theme inline`, and there is no `tailwind.config.*`.** `inline` bakes
  token values at build time and breaks runtime theming. Tailwind v4 is CSS-first; theming
  lives in `src/app/globals.css`.

## Commands

```bash
pnpm db:reset     # rm .pglite, push schema, seed — safe any time
pnpm db:seed      # reseed only, keeping the schema — works on a populated db again
pnpm booking:dry-run  # the whole booking loop, headless, no keys, no purchases
pnpm booking:audit <id | idempotency-key>   # the audit trail for one request
pnpm credits          # credit exposure and every live credit
pnpm credits <id>     # one credit's ledger, entry by entry
pnpm credits --sweep  # write off what expired, warn about what will
pnpm deadlines        # the deadline register, its exposure, and tonight's alerts
pnpm deadlines --sweep # write those alerts; run twice, nothing is written the second time
pnpm rollcall         # duty of care: who is expected where, and who could not be reached
pnpm rollcall <show id>  # one show: who to call, in the order to call them
pnpm roster           # booth coverage everywhere: target, assigned, who can actually work it
pnpm roster <show id> # one show, shift by shift
pnpm flights          # every tracked leg, worst first, and what the engine would say
pnpm flights --sync   # ask the status provider, write the changes and the alerts
pnpm shipping         # every crate, worst first, and what the engine would say
pnpm shipping <show id>  # one show's freight
pnpm shipping --sync  # ask the tracking provider, write the scans and the alerts
pnpm assets           # the register worst-first, the clashes, the shelf vs. what is free
pnpm assets <show id> # one show's reservations and allocations
pnpm assets --sweep   # write tonight's asset alerts; run twice, nothing is written again
pnpm alerts           # what one person is actually owed, worst first
pnpm alerts --as priya@…  # the same feed as somebody else; the access model, not a filter
pnpm alerts --sweep   # run all seven engines; prints what each raised *and resolved*
pnpm drayage          # every show's drayage, biggest estimate first, and what it is missing
pnpm drayage <show id>  # one show, crate by crate, with the arithmetic showing
pnpm cost             # every committed show's true cost, biggest first, with its coverage
pnpm cost <show id>   # one show line by line, every gap named
pnpm leads            # every show's capture, worst first, with what the count is missing
pnpm leads <show id>  # one show: its leads, its meetings, and tonight's alerts
pnpm leads --sweep    # write tonight's lead alerts; run twice, nothing is written again
pnpm leads --retention # erase everything past its date — the count does not move
pnpm roi              # every show: cost against pipeline, and every figure it will not print
pnpm roi <show id>    # one show, and every opportunity behind its figure, openable
pnpm roi --sync       # match leads to the CRM, cache opportunities, write attribution back
pnpm roi --sync --no-write  # read only; put nothing into a database we do not own
pnpm nightly          # the whole nightly job: sweep, erase what is overdue, carry what is owed
pnpm nightly --dry    # plan and compose; print every message verbatim, send and record nothing
pnpm nightly --deliver  # the delivery pass only; run twice — the second carries nothing
pnpm nightly --standing # when did the job last run, and does anything run it but you
pnpm manual                    # which shows have had a manual read, and which never have
pnpm manual <show id> <file.pdf>   # read a manual into that show's register, unconfirmed
pnpm manual <show id>          # every reading of it, with what each one refused
pnpm manual:probe <file.pdf> --opens YYYY-MM-DD   # the capture-equivalent: what a stupid
                  # date sweep found in the document that the extractor did not claim
pnpm day-of           # which show is on the floor, nearest to now first
pnpm day-of <show id> # one show's snapshot, exactly as a device would hold it
pnpm day-of <show id> --stale 90   # the same snapshot read later; watch the verdicts go
pnpm assistant "..."  # ask the concierge; prints every tool that ran and what it returned
pnpm assistant --as priya@… "..."   # the same question as somebody else; the results differ
pnpm assistant --tools  # the tool surface per role — the access model as a table
pnpm duffel:capture   # record what the real Duffel API says into fixtures/live/ (needs a test key)
pnpm duffel:capture --search   # stop after search; create no orders
pnpm salesforce:capture        # the same loop for Salesforce (needs a Developer Edition org)
pnpm salesforce:capture --read-only   # probe everything; write nothing into their CRM
pnpm clerk:verify     # what a real Clerk instance returns, vs. what our code assumes
pnpm dev          # the app: shows, itinerary, security; no Clerk keys needed
                  # /settings/travel-policy · /settings/cost-centers · /settings/profile are
                  # the three screens that make a *non-seeded* org usable at all
pnpm smoke        # fetch all 39 routes against a running `pnpm dev`; 200 + expected text
                  # (/day-of/[id] is the one page whose *content* it cannot check)
pnpm test         # vitest; no keys, no network, no browser
pnpm typecheck
pnpm lint
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user whenever Clerk is not
configured. Seeded roles: `shelley@` admin, `marcus@` travel_manager, `priya@` member.
Set both Clerk keys (see `.env.example`) and the seam switches to real sessions.

## Layout

```
src/db/schema.ts              ~40 tables, the domain model
src/app/(app)/                the app shell and its screens; never prerendered
  travel/                     the request list, the form, the audit trail as a page,
                              and the approvals queue
  alerts/                     the feed: seven engines' output, grouped, with each standing —
                              and no way for a person to resolve one
  cost/                       the true-cost portfolio + `_present.tsx`, the vocabulary it and
                              the show's Cost tab both render through
  roi/                        cost against pipeline, ranked by cost rather than by multiple;
                              `_present.tsx`'s `Figure` is the only way a per-unit number
                              reaches a page, so a withheld one cannot be printed
  leads/                      capture across the calendar + `_present.tsx`, the one sentence
                              in front of every count, shared with the tab
  readiness/ flights/         the portfolio rollups; `shipping/_present.tsx` and
  shipping/ assets/           `assets/_present.tsx` are shared with the Logistics tab
  safety/                     duty of care: who to call, in the order to call them
  drayage figures             live on the Logistics and Cost tabs, not on a board
  assistant/                  the concierge and one conversation, with each tool step
                              rendered beside the answer rather than behind it
  day-of/                     the offline screen: a picker, and `[id]/_client.tsx` — the only
                              page here that is not a Server Component, whose server half
                              deliberately fetches nothing; `_device.ts` is IndexedDB and
                              `_register.tsx` installs the worker
  shows/[id]/                 ten tabs: overview · readiness (+ the deadline register and
                              `manual-forms.tsx`) · travel · team · lodging · logistics
                              (freight + its timeline, the assets it carries with their
                              custody chain, the collateral, the drayage card) · cost (not
                              rendered for a Member) · leads · roi (ditto) · safety
  settings/                   security · crm · intake (admin) · notifications (the only
                              entry that is not admin-only)
  _components/                the shared vocabulary: ui.tsx (Card, Badge, Table, formatting),
                              form.ts (one FormState + FormData helpers, dependency-free),
                              form-ui.tsx (Input/Field/Message/Submit/ZonedDateTime), cn.ts,
                              nav.ts (the one list of screens; `does` is required, and the
                              overview renders it), sidebar.tsx, go-to-show.tsx (a chooser,
                              not a shortcut)
  _request.ts                 currentActor / currentFeed — zero-argument cache() wrappers, so
                              the layout and a page share one lookup and one feed query
  setup-card.tsx              what this workspace still needs, on the overview, until it does
  loading/error/not-found     the boundaries every navigation and every throw lands in
src/app/api/intake/leads/     POST from a badge scanner: the only route that authenticates
                              without getActor(), and a retry answered as a success
src/app/api/day-of/           snapshot (GET: the whole screen as data) and sync (POST: a
                              device's queue, every item answered)
src/app/api/cron/nightly/     POST from a scheduler: no org parameter, no GET, and a refusal
                              when no secret is set
public/sw.js                  hand-written, caches the day-of pages and nothing else
src/app/manifest.ts           the installable manifest; start_url is /day-of
src/lib/policy/               the decision layer — pure, deterministic, 47 tests
src/lib/travel/               the spine — state machine, policy store, booking agent, kill
                              switch, passenger identity, credit ledger, audit trail,
                              notifications; review.ts (pure: what approving does, who may
                              act), provider.ts (env → provider, no fallback), queue.ts
src/lib/shows/                the planning core — pure clone planner, pure intake, the
                              visibility rule, proximity.ts, the org-scoped store
src/lib/readiness/            scoring (a breakdown, `null` for unplanned), the built-in
                              templates + idempotent apply planner, edit rules, the pace
                              model, the store
src/lib/deadlines/            the §5a engine — alerts.ts (pure: thresholds, audience, tense,
                              dedupe-by-date, the one exposure model), edit.ts, access.ts,
                              store.ts (org-scoped rows + the sweep)
src/lib/manual/               §5a's other half — pdf.ts (the only file that touches a PDF),
                              anchor.ts (a citation checked against text we hold, or the
                              deadline never exists), candidates.ts (six refusals, every
                              candidate accounted for), coverage.ts (the deliberately stupid
                              arbiter), provider.ts (no fallback, no zero-key mode), store.ts,
                              fixtures.ts
src/lib/team/                 coverage.ts (assigned vs. able to be there, `overstated`,
                              personal clashes), conflicts.ts (travel windows; certain vs.
                              possible), edit.ts, access.ts, store.ts
src/lib/lodging/              hotels, room assignments, and the cutoff that derives a register
                              row rather than a second clock
src/lib/flights/              status.ts (freshness, the §7 buffer re-run live, a re-timing
                              kept apart from a delay), alerts.ts, board.ts, provider.ts,
                              store.ts (rows, the sweep, materializing a booking)
src/lib/shipping/             status.ts (the two-edged receiving window, the stall model,
                              delivered-vs-received, the reconciler), alerts.ts (the one alert
                              with no row behind it), carrier.ts (pure inference from a
                              tracking number), board.ts, edit.ts, provider.ts, store.ts
src/lib/drayage/              §5n — estimate.ts (hundredweight + six refusals), edit.ts
                              (`basis` has no default), access.ts, store.ts
src/lib/assets/               custody.ts (the chain, three-refusal availability,
                              freightCoverage), conflicts.ts (windows, not show dates),
                              inventory.ts (on hand vs. free, the ledger projection),
                              alerts.ts, board.ts, edit.ts, store.ts (scoped through the
                              asset's own org)
src/lib/leads/                coverage.ts (the count that says what it is missing, and the
                              withheld per-lead figure), consent.ts, parse.ts, dedupe.ts,
                              alerts.ts, intake.ts (a principal that is not an Actor),
                              edit.ts, access.ts, store.ts
src/lib/roi/                  attribution.ts (first touch across the whole calendar),
                              rollup.ts (§5k), alerts.ts (never on a low multiple),
                              access.ts, provider.ts, store.ts
src/lib/profile/              your own traveler details — edit.ts (validation, and the two
                              things it refuses to check: an airport list and whether a carrier
                              took a loyalty number), store.ts (your own row only, plus the one
                              read the ticketing path makes by user id)
src/lib/setup/                what a workspace needs before it works — checklist.ts (pure:
                              the consequence, and who can fix it), store.ts. Deliberately not
                              an alert engine; see the ground rules
src/lib/safety/               §5o — presence.ts (evidence → a standing, staleness keyed by
                              *basis*), rollcall.ts (presence never answers for safety),
                              access.ts (the loosest gate here), store.ts
src/lib/dayof/                targets.ts and outbox.ts (pure, and the first two modules here
                              shipped to the *browser*), snapshot.ts, access.ts, store.ts
src/lib/alerts/               feed.ts (the five standings, ordering, grouping a sentence
                              rather than a fact), access.ts (no org-wide read), store.ts
                              (the one writer every engine shares), sweep.ts
src/lib/cost/                 rollup.ts (the lines, the six refusals, coverage as a shape),
                              store.ts, access.ts
src/lib/notify/               plan.ts (the five refusals), store.ts (the only caller of a
                              transport), access.ts, provider.ts
src/lib/schedule/             nightly.ts (sweep → erase → carry), principal.ts
src/lib/assistant/            tools.ts (the access model), access.ts (subtractive),
                              prompt.ts (tense, never access), loop.ts, draft.ts,
                              serialize.ts, provider.ts, store.ts (scoped to a *user*)
src/lib/integrations/         flights/ (Duffel) · flightstatus/ (AeroAPI) · shipping/
                              (EasyPost) · llm/ (Anthropic + a `scripted` model that replays
                              tool plans, never prose) · crm/ (Salesforce + a HubSpot seam
                              that throws) · notify/ (Slack + a `console` transport that
                              reaches nobody) · extract/ (Anthropic structured output, and
                              deliberately no `recorded` provider)
src/lib/auth/                 the seam — getActor(), the Clerk adapter, login-method control
src/proxy.ts                  Next 16's Middleware: Clerk's context, or a pass-through
src/lib/money/ datetime/      correctness primitives; see ground rules
scripts/seed.ts               the only place seed data lives
```
