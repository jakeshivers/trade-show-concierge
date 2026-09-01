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

Phase A (**the vertical slice through the booking spine**) is done; Phase B is done; Phase D
has started. Step 21 is **half done and marked `[~]` in §10**: the transport and the
scheduler shipped, hosting and the SSO rollout did not and cannot here — both need a cloud
account or a real IdP, and §9's ground rule forbids wiring one unasked.

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
clock; and flight tracking — a status provider behind the usual interface, a board ordered
by what is wrong rather than by what leaves next, and delay alerts that only speak when a
delay costs the arrival buffer the ticket was approved under; and shipping — an EasyPost
adapter behind the usual interface, an event timeline that a nightly poll cannot double,
and a receiving *window* with two edges, because freight that arrives before a show-site
dock opens is refused rather than early; and the conversational assistant — a chat agent
whose access model is its tool list rather than its prompt, which reads through the same
org-scoped stores a screen reads through and drafts requests a person still has to
confirm; and assets & collateral — a chain of custody that is finally a log rather than a
flag, an availability verdict that refuses a booth three different ways, and an inventory
whose on-hand figure is a projection of a ledger rather than a number somebody typed; and
the alerts feed and the true-cost rollup — one screen that finally reads what five engines
have been writing to the `alerts` table since step 11, and a cost figure that leads with
what it is missing rather than with the number; and leads & meetings — capture that anybody
can do, a count that says "at least" and names who recorded nothing, an import in which
every row read is accounted for, a lawful basis that is never manufactured out of a blank
column, an erasure that removes the person without moving the count, and a REST intake
endpoint whose principal is deliberately not an `Actor`; and ROI — a CRM adapter narrow
enough that it cannot become a CRM, an attribution model that decides first touch across the
whole calendar, and a dashboard whose most important output is the list of figures it
refuses to print; and the offline day-of PWA — one screen that holds its own data, says how
old it is, takes a capture with no network and re-sends it on the same rail a badge scanner
retries on, and tells somebody at the booth that the person in front of them is one of the
accounts the booth was bought for; and the notification transport and the nightly job — a
Slack adapter behind the usual interface, a planner that refuses five different ways before
it interrupts anybody, a zero-key transport that composes the real message and delivers it
to nobody rather than pretending, and a job whose *absence* is now a thing the alerts page
can say out loud.
932 tests, no keys required.

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
count would have called full. `pnpm flights` prints the flight board and what the alert
engine would say tonight — which, on most legs, is nothing. `pnpm shipping` prints every
crate worst-first, the receiving window each is judged against, and the one alert that has
no shipment behind it: a show that moved out with freight and nothing recorded coming back.
`pnpm alerts` prints what one person is actually owed — `--as` somebody else and the table
is different, which is the access model rather than a filter — and `pnpm alerts --sweep`
runs all five engines and reports what each one *resolved* as well as what it raised.
`pnpm cost` prints every show's true cost worst-first with its coverage, and
`pnpm cost <show id>` prints one show line by line with every gap named in the words the
screen uses. `pnpm leads` prints capture worst-first — the count, the word in front of it,
who on the booth recorded nothing, and why cost per lead is being withheld — and
`pnpm leads --retention` is the one command in this product that destroys data on purpose,
erasing the person and leaving the count exactly where it was.

**What step 21 added, and where:** `src/lib/integrations/notify/` — the sixth integration
behind the usual interface, and the first that carries something **out** of the workspace
rather than asking a supplier a question. That inverts the risk the other five manage: a
transport cannot report a false crate, but it can put a colleague's fare in a room that was
never entitled to it, and unlike a wrong reading that cannot be corrected on the next poll.
So `types.ts` takes a **resolved address and a rendered message and does nothing else** — no
database, no audience, no idea what an alert is. `slack/` is the Web API (wire / client),
written to the published reference and **never run against a live workspace**, in the same
words AeroAPI's, EasyPost's and Salesforce's headers use; it asks for exactly three scopes
and is write-only. `console/` is deliberately **not** a `recorded` provider (below).
`notify/provider.ts` selects with no fallback, with one difference from the other five: unset
is a legitimate state and resolves to `console`, while a *name this app does not have* still
throws, because a typo must not quietly resolve to the transport that reaches nobody.

`src/lib/notify/` is the model, split the way everything since step 8 has been.
**`plan.ts` is the whole step**: pure, and five refusals — an `info` condition stays on the
screen while a notice goes at any severity, eleven rows are one sentence (through
`groupFeed`, never a second grouping), switching a transport on does not replay history,
only somebody who was told is told it ended, and a personal alert never reaches a shared
room. It takes **no user id and does no lookup**, so the only rows it can put in a message
are rows a query already narrowed — `assistant/tools.ts`'s posture, one layer out.
`store.ts` is the only caller of a transport and the only writer of the two tables.
`access.ts` puts a destination in the **subject's own hands and not an admin's**.
`src/lib/schedule/` is the job: `nightly.ts` (sweep → erase → carry, and it stops rather than
delivering last night's answers as tonight's) and `principal.ts` (the second principal here
that is not an `Actor`, and the first that erases).

Schema: **`notification_channels`** (a person's destination, resolved by the transport and
never typed; `kind` exists so the planner can refuse a channel), **`notification_deliveries`**
(append-only, and the rail is `(alert, channel, phase, alert_created_at)` — the last segment
inherits `alerts/store.ts`'s own recurrence decision rather than inventing a second one), and
**`scheduled_runs`** (append-only; `trigger` keeps "somebody ran it" and "it runs" apart).
`FeedAlert` gained `userId`, carried so the channel refusal can be a pure function.
Routes: `POST /api/cron/nightly`, and `/api/cron` is public in Clerk mode for a sharper reason
than `/api/intake` — a scheduler has no browser, so a Clerk bounce answers 302 and every
hosted cron reads that as success. Screens: `/settings/notifications`, **the only entry under
Settings that is not admin-only**, and one line on `/alerts` that the feed could never say
about itself. `pnpm nightly` / `--dry` / `--deliver` / `--standing` is the job without a
screen. The seed connects two people **through the real store**, runs the delivery pass
**twice** (the second carries nothing — the rail holds), and records one `manual` run, which
is the honest standing of a freshly seeded workspace.

**The five corrections step 21 turned up, and one repair:**

1. **A `recorded` transport is the one replay this codebase cannot have.** The other five
   obey a single rule — describe a *shape*, assert nothing about this workspace — and they
   work because what is replayed is a supplier's *answer*. A transport has no answer. What it
   produces is an event in the world: somebody's phone buzzed. There is no shape of that
   which is not simply a claim, and a fixture returning `sent` would fill the delivery log
   with the exact lie the feature exists to prevent — a screen saying everybody was told, on
   a workspace where nothing has ever been carried anywhere. So `console` composes the real
   message, from the real alerts, through the real planner, and delivers it **to nobody**:
   `outcome: 'rendered'`, `reachesPeople: false`, and `/settings/notifications` leads with
   the sentence rather than hiding it.
2. **Slack answers failures with HTTP 200, and the correct client for every other provider
   here is the wrong one.** Duffel, AeroAPI, EasyPost and Salesforce all use status codes, so
   `if (!res.ok) throw` is right four times and catastrophic the fifth: a bad token, a person
   not in the workspace, an archived channel and a malformed payload all arrive as
   `200 {"ok": false, "error": …}`. A client that checks `res.ok` records all of them as
   delivered, and **that failure has no symptom** — the log fills with `sent`, the screen says
   everybody was told, and nobody's phone ever buzzes. One `call()` reads `ok` before anything
   else, and it is the one thing about this adapter a docs-written fixture *can* catch.
3. **Idempotency had to be inherited rather than invented, and a recurrence is the proof.**
   The tempting rail is "one delivery per alert". That is right for a condition holding nine
   nights and wrong for one that resolved and came back — which is news, and which
   `alerts/store.ts` already marks by restarting `created_at`. So the rail carries
   `alert_created_at` and the transport gets both cases from the alert store's own decision. A
   second, quietly different dedupe rule beside the first is the `SOURCE_LABEL` trap in
   another costume.
4. **Turning a transport on must not replay a year of alerts at somebody.** The obvious first
   run against an existing workspace delivers every standing alert at once, and the person it
   happens to turns the integration off inside a minute and is right to. Anything raised
   before the destination existed is **suppressed with that reason recorded**, so the log can
   say why somebody was not told rather than being silent about it — and a recurrence is
   still news, because `created_at` restarts.
5. **The order the refusals run in changes what a number means.** Judging "is there anywhere
   to send this" before "is this worth an interruption" makes the run report a person with
   nine `info` rows and no Slack account as nine missed notifications — a shortfall the
   transport was never going to fill, growing every time an engine says something quiet. The
   floor comes first, so `unreachable` counts **alerts worth carrying**; and the
   never-told check comes before it too, so an absent destination is not blamed for a
   resolution nobody was owed.

**The repair:** `pnpm alerts --sweep`, `pnpm flights` and `pnpm shipping` ran without
`dotenv`, while `next dev` loads `.env.local`. So the CLI and the app disagreed about the
environment: `pnpm alerts --sweep` reported the flight and freight engines as **could not
run** on a workspace where they were configured, and the endpoint running the same sweep a
minute later ran them. "Could not run is not nothing to say" is a sentence the whole design
leans on, and it was being produced by the script's own env loading rather than by the
workspace. All four provider-selecting CLIs load `.env.local` now.

**What step 20 added, and where:** `src/lib/dayof/` — the offline day-of screen, and the
first step that changes how the *client* works rather than adding another model behind
another screen. Split the way everything since step 8 has been, with two files that are new
in kind: **`targets.ts` and `outbox.ts` are pure and shipped to the browser**, because a
target-company alert has to fire while the name is being typed and a queue has to be
reconciled with no server to ask. `targets.ts` matches a company **exactly, after stripping
legal suffixes, and never fuzzily** — the failure of a loose match is not a wrong row, it is
somebody at a booth telling a stranger their company is one we came for — and *met* is
derived from the leads rather than stored. `outbox.ts` is the device queue: every item is
accounted for, `reconcile` throws rather than dropping one, a rejected item is **kept and
marked** instead of retried forever, and our own re-send (`already`) is deliberately a
different answer from somebody else's duplicate. `snapshot.ts` carries one instant and
`degradeVerdicts` takes the present tense off a crate line past forty-five minutes while
leaving the recorded facts standing. `access.ts` puts the screen and the target list in
**anybody's** hands and editing the list in an approver's. `store.ts` builds the snapshot in
a fixed number of queries and drains the queue **through the real `captureLead`**, as the
person who typed it.

Schema: a new **`show_targets`** — with no `met_at` column, deliberately — and
`meetings.external_ref`, unique per show, which is `leads.external_ref`'s idempotency rail
extended to the other thing a booth records. Routes: `GET /api/day-of/snapshot` is the only
screen in this product whose data leaves the server as data, and `POST /api/day-of/sync`
answers **every** item it is sent. Screens: `/day-of` (a picker, ordered by proximity to
*now*), `/day-of/[id]` — **the only page here that is not a Server Component, whose server
half deliberately fetches nothing** — and a Target accounts card on the show's Leads tab.
`public/sw.js` is hand-written and caches only the day-of pages; `src/app/manifest.ts` is the
installable manifest and starts at `/day-of`. `pnpm day-of` / `pnpm day-of <show id> --stale
90` is the model without a screen. The seed grows four target accounts on the live show
through the real store: one met, one met under a different spelling, one must-meet that is
unmet *and* unowned, and one watch.

**The eight corrections step 20 turned up:**

1. **A cached screen is §5f's unchecked flight with every row at once, and it is worse.**
   There, an unrefreshed leg rendered `scheduled` — the calm one — so a board nobody had
   asked anything in eight hours showed a full slate of on-time flights. A cached page has
   the same defect with *no visible cause*: it is drawn, the numbers are there, and nothing
   about a phone with no bars says the crate reading is from Tuesday. One instant on the
   snapshot, a clock passed by every reader, and the age is a line at the top.
2. **A fact and a verdict age differently, and blanking both is not the cautious option.**
   "Booth 2209" does not move because a phone lost signal; "crate on time" is computed from
   an estimate that moves hourly. So `derivedFrom` splits them, and the line that survives
   going stale is the one that matters most on a move-in morning — *on a dock, nobody has
   confirmed it at the booth* is a signature, not a guess about a truck. Withholding
   everything would have removed the most actionable sentence on the screen in the name of
   safety.
3. **The server half of the page must fetch nothing.** Whatever HTML it returns is cached and
   served again tomorrow, so data rendered into it would be a second copy of the show's facts
   with no instant attached — two sources, one of them invisible, disagreeing on a morning
   when somebody is deciding whether the booth will arrive. There is exactly one copy on the
   device, in IndexedDB, and it carries the moment it was true. What the document holds is
   the shell and an identity.
4. **A queued capture is not a captured lead, and the counts never merge.** §8c's mitigation
   is that a thin number is visibly thin; a count that quietly included rows sitting in a
   phone would be that failure with a friendlier cause, resolving itself — wrongly — the
   moment somebody walked past a wifi point. The word is *device* rather than *pending*,
   because what a person needs to understand is a location, not a process.
5. **A rejected item is kept, and that is not the obvious call.** Deleting it destroys the
   only copy of a real conversation because a field was blank. Retrying it forever leaves a
   badge that is always on, which is a badge that is off. So it stays, blocked, with the
   server's own sentence on it, and it is the one thing in this app a person fixes by editing
   what they typed.
6. **Our own re-send and somebody else's duplicate must stay different answers.** Both are
   duplicates to the database and only one is news. `already` means an earlier attempt landed
   and we never heard — the ordinary case, and a success. `duplicate` means a colleague met
   this person, which is worth saying out loud. Collapsing them tells somebody their
   colleague got the buyer when in fact their own phone did.
7. **A cache outlives the session that was allowed to read it.** Every row in a snapshot was
   fetched under one person's scope and a phone in a booth gets handed to whoever is free, so
   the snapshot carries its actor, a mismatch **wipes** IndexedDB and the worker's caches
   rather than filtering what is drawn, and `sw.js` caches only the day-of pages — caching
   `/cost` or `/travel` would leave a colleague's fares on a device long after the session
   ended.
8. **`pnpm smoke` cannot check this page, and that is the first time.** Every other route's
   content is server-rendered, so a 200 plus a phrase proves the page resolved its data. Here
   the phrase in the HTML is the *shell*, and everything real arrives from IndexedDB and a
   fetch after hydration. The check is kept because it still catches a broken import, and the
   gap is named rather than papered over: this page was verified by driving a headless
   browser against a running dev server, which is not in `pnpm test` and should not be —
   "no keys, no network, no browser" is a ground rule.

**What step 19 added, and where:** `src/lib/integrations/crm/` — the fifth integration
behind the usual interface, and the first where §11.6's "one well rather than both
adequately" resolved to *one at a time* rather than to one. `types.ts` decides nothing and
carries **exactly one write method**, because §8b's "never own the pipeline" only survives
contact with a second customer if the interface is structurally unable to widen; it also
splits `matchByExternalId` from `matchByEmail`, because one sends nothing about a person
and the other sends a stranger's address to a third party. `salesforce/` is REST v60 + SOQL
(wire / normalize / client, written to the published reference and **never run against a
live org**, in the same words AeroAPI's and EasyPost's headers use). `hubspot/client.ts` is
**declared and throws on every method**. `recorded/` replays a conversion *shape*, not a
pipeline. `roi/provider.ts` selects between them with **no fallback**, and answers
`hubspot` with what finishing it takes rather than a spelling complaint.

`src/lib/roi/` is the model, split the way everything since step 8 has been.
`attribution.ts` is pure and is the honest hard part: five refusals, of which the first —
first touch is decided across the **whole calendar** — is the one a naive implementation
gets wrong forever and silently. `rollup.ts` is pure and holds §5k: the two-floors rule,
the replayed-pipeline withholding, matching coverage as a third floor, §8e's maturity
horizon as an enforcement rather than a footnote, and `Quotable` — a figure or the sentence
saying why there is not one. `alerts.ts` is the **seventh engine**, reports an unanswered
question rather than a broken thing, and deliberately never alerts on a low multiple.
`store.ts` gates email matching on `marketabilityOf` and keeps `withheld` apart from
`unmatched` in every count it produces. `access.ts` inherits the cost gate rather than
choosing a new one, and the assistant gained `show_roi` — **the second tool ever withheld
from a Member**, for the same reason the Cost tab is not rendered for one.

Schema: new `crm_links` (how a match was made, and whether the attribution went back),
`crm_opportunities` (the CRM's facts, cached — and **no attribution stored**, because it is
derived at read time so changing the window re-derives rather than migrates), and
`crm_sync_runs` (append-only, keeps every refusal); `show_outcomes` gained
`attribution_model`, `source` and `replayed`. Screens: `/roi` in the nav, a **ROI** tab on
the show — the ninth, and not rendered for a Member — and `/settings/crm`. `pnpm roi` /
`pnpm roi <show id>` / `pnpm roi --sync` is the engine without a screen. **The seed grew an
eighth show and that was the finding**: every show was either in the future or six weeks
closed, so every ROI verdict was correctly withheld and the dashboard could not be shown
working at all. MedTech Summit 2025 is fourteen months back with a *complete* cost — the
only show on the calendar whose multiple is quotable — and one buyer on it was met again at
Automate 2025, so cross-show first touch is a row rather than an assertion in a test.

**The six corrections step 19 turned up, and one repair:**

1. **Two floors in a quotient do not cancel; they widen.** A lead floor pushes cost-per-lead
   up and a cost floor pushes it down, and the tempting reading is that they roughly offset.
   Neither magnitude is known, so the combination is unbounded in both directions while
   *looking* better founded than either input — it is further from the missing data. So a
   figure built on two floors is withheld rather than averaged or caveated, and
   `mayQuotePerLead`, written a step early for exactly this, is obeyed rather than routed
   around.
2. **A replayed opportunity is a different object from a replayed crate, and a banner is not
   enough.** The other three replays describe a *shape* and asserting it here is harmless. A
   pipeline figure has no shape separable from its claim: "$290,000 sourced by MedTech" is a
   sentence about this company, landing beside a real cost in a headline. So the replay is a
   *conversion* shape projected onto dates we really met people, it invents no person it was
   not asked about, it hands back nothing dated in the future (the EasyPost rule), it
   **refuses to report a write it did not make**, and every ratio derived from it is withheld
   as well as labelled.
3. **First touch is a fact about our own data, and the naive test favours the newest show
   forever.** "Created after this show, inside the window" hands every recurring buyer's
   opportunity to whichever show met them most recently — annually, silently, in the
   flattering direction. First touch is the earliest capture of that person *anywhere*,
   which inverts §5j: identity is within a show for **counting** and across shows for
   **crediting**. Two more fell out: influenced deliberately does not sum, so the portfolio
   prints the distinct total; and when first touch lands outside the window the runner-up
   does not inherit the credit — found by a test written to assert something else.
4. **Our own consent posture is a hole in the pipeline figure, on purpose, and it must not
   look like the vendor's fault.** Matching by email transmits personal data, so it is gated
   on `marketabilityOf`; every badge-scanner lead in this workspace therefore never reaches
   a CRM. That is step 18 working. **Withheld is us refusing and unmatched is the CRM
   answering**, and a single "match rate" collapsing them would present a deliberate refusal
   as a data-quality problem — which is the misreading that gets the refusal deleted.
5. **An unbuilt adapter must not be able to produce a finding.** The obvious HubSpot stub
   returns `[]` and `noMatch`. But "we captured 41 leads and the CRM knows none of them" is
   a real, alarming, correct answer this product exists to surface — so a stub returning it
   out of its own absence is §8a's fabricated bill wearing the costume of a placeholder, on
   the screen a budget is set from. Every method throws. Not-built and nothing-found have to
   stay different answers.

6. **Three defects in the Salesforce client that a fixture written from the docs could
   never have caught, and one of them is §5j's import rule in an adapter.** `query()` did
   not follow `nextRecordsUrl` — Salesforce pages at 2,000 records — so a large customer
   would have got a pipeline figure that was quietly short, reported with exactly the same
   confidence as a correct one, with nothing to re-count against; `wire.ts` had already
   described that field as "a path we follow rather than ignore", so the comment was right
   and the code had not caught up. `opportunitiesFor` interpolated *every* matched contact
   id into one SOQL string that rides in a GET query string, which is fine on the eighteen
   leads in the seed and breaks at exactly the customer size where the feature earns its
   place. And `CurrencyIsoCode` exists **only in a multi-currency org** — selecting a field
   an org lacks is a hard `INVALID_FIELD`, not a null — so the obvious query fails outright
   on the majority of Salesforce orgs; it is now probed once and falls back to the org's own
   `DefaultCurrencyIsoCode`, *read* rather than defaulted to `USD`, because a currency label
   is part of a money figure. All three are covered by unit tests against a mock transport,
   which is what is verifiable without an org — the four things that are not are Q1–Q4 in
   `pnpm salesforce:capture`.

**The repair:** `alerts/store.ts` kept a hand-written `SOURCES` array beside the union in
`feed.ts`, and adding `'roi'` to the type compiled everywhere, wrote correct rows, and read
every one of them back as `unknown` — so a whole engine's output was labelled "Other" and
`linkFor` sent it to the wrong page. Nothing failed. It was caught by reading the CLI's
output, which is how step 17 found `onConflictDoNothing`. The guard is now derived from
`SOURCE_LABEL`, whose `Record<AlertSource, string>` the compiler already checks
exhaustively, so one check does both jobs.

**What step 18 added, and where:** `src/lib/leads/` — capture, and the first table in this
product holding personal data about somebody who is not our user. Split the way everything
since step 8 has been. `coverage.ts` is pure and is the argument §8c was missing: a count is
introduced with **"at least"** whenever anybody rostered on a booth shift recorded nothing,
the silent people are *named*, "on the booth" is a shift assignment rather than attendance,
an unrostered show is `unknown` and never 0 of 0 — and `mayQuotePerLead` **withholds** cost
per lead over a thin denominator instead of publishing it with an asterisk. `consent.ts` is
the GDPR half: `unknown` is a recorded answer rather than a default, consent with no
timestamp or no recorded notice is a claim about consent, and **erasure is redaction**.
`parse.ts` is a CSV reader (quotes, embedded newlines, CRLF, Excel's BOM) plus an import
planner in which accepted + rejected + duplicate always equals the row count. `dedupe.ts` is
identity *within a show* — the scanner's reference, then the email, and name-plus-company as
a suspicion that is never auto-merged — and `findPossiblePairs` is what makes that refusal
honest rather than a nicer word for discarded, offering the pair to somebody who was there.
`alerts.ts` is the **sixth engine** and mostly says nothing. `intake.ts` is the REST credential, and an `IntakePrincipal` is deliberately not an
`Actor`. `access.ts` splits the count from the person behind it, and capture from erasure.
`edit.ts` is pure validation. `store.ts` is the only file touching rows, org-scoped through
the show.

Schema: `leads` gained `source`, `import_id`, `external_ref` (unique per `(show, ref)`),
`duplicate_of_id`, `consent_notice`, `redacted_at` / `redacted_by_id` / `redaction_reason`
and `updated_at`; `meetings` gained `no_show_at`, `created_by_id` and timestamps; new
append-only **`lead_imports`** (which keeps every rejection with its row number) and
**`intake_keys`** (hash only, show-scoped, revoked rather than deleted). Screens: `/leads`
in the nav, a **Leads** tab on every show — the eighth, and shown to everybody — and
`/settings/intake` under Settings. `POST /api/intake/leads` is the first route here that
authenticates without `getActor()`, and `src/proxy.ts` marks `/api/intake` public in Clerk
mode because it carries its own credential. The assistant gained `lead_capture` — counts and
coverage, and no personal data at all. `pnpm leads` / `pnpm leads <show id>` /
`pnpm leads --sweep` / `pnpm leads --retention` is the engine without a screen. The seed
captures at the booth as four different people, posts through the **real** intake path
including the retry a scanner makes on bad wifi, imports a CSV through the **real** parser
(one row with no name, one duplicate — both rejected by the planner rather than by hand),
and runs the sweep **before and after** the import so a genuinely resolved lead alert exists.

**The six corrections step 18 turned up:**

1. **A lead count that does not say who did not capture is §8a's fabricated bill, on the
   return side.** §8c blamed rep behaviour, which is the cause and about a third of the
   problem. "34 leads" carries the authority of a computed figure; if three of six people on
   the booth recorded nothing it is a floor wearing a total's clothes. So the count is never
   rendered bare, the silent people are named rather than counted, and the sentence is
   computed once so the portfolio and the show's tab cannot disagree. And **cost per lead is
   withheld**, not caveated: over an undercount it comes out too *high*, which reads as a
   bad show, so a thin count does not merely mislead — it drives the exact decision §8c
   warns about, cutting a show that worked.
2. **Duplicates inflate in the flattering direction, which is the direction nobody audits.**
   Cost per lead is a quotient, so a 15% duplicate rate makes a show look 15% cheaper per
   lead than it was. Identity is the scanner's own reference, then the email, **within a
   show only** — the same person met in June and October is two engagements with two costs —
   and name-plus-company is surfaced and never auto-merged, because silently dropping a real
   second lead is the same failure pointing the other way.
3. **An import that skips a row reports a smaller number with the same confidence.**
   Accepted + rejected + duplicate always equals the row count; the rejections keep their
   row numbers and reasons on the batch record; the batch is written even when nothing was
   accepted, or a person is certain they imported and the screen is certain they did not.
   The mapping is confirmed rather than applied — a `Company` column that is really the
   *exhibitor's* would be filed as every lead's employer, plausibly, forever. And an imported
   lead is attributed to **nobody**, not to whoever uploaded the file, or one person's
   coverage reads as perfect and everybody else's as worse.
4. **A lawful basis is never manufactured out of an absent column.** A badge vendor's export
   has no consent field, so a default would invent a basis from the absence of one — §5a's
   fabricated bill in a jurisdiction that fines for it. `unknown` is a real answer; the row
   is still lawfully held for the follow-up the person started, still counted, and withheld
   from anything outbound. Refusing to market is not refusing to keep.
5. **Erasure must not erase the count.** Deleting the row would move every ROI figure that
   show ever produced, silently, months later — cost per lead would improve on its own. So
   erasure nulls the personal columns (including `crm_external_id`, or our erasure is a
   fiction with a footnote) and keeps the shell: the person is gone, and that a conversation
   happened is not personal data. `retention_overdue` is `critical` from the first night,
   being the only alert in the product that reports our own non-compliance.
6. **The intake endpoint is the first principal here that is not a person, and it must not
   be an `Actor`.** A service user with a role flows through `getActor()` into every store
   function in the codebase; an `IntakePrincipal` is the wrong *type* for all of them, so
   the compiler enforces a boundary a role check would only describe — §6f's lesson in a
   different costume. And **a retry is a success**: scanners on convention-centre wifi retry
   requests whose responses they never saw, and a 409 teaches an integration to treat a
   recorded lead as a failure, after which somebody writes the loop that manufactures the
   duplicates the endpoint exists to prevent.

**What step 17 added, and where:** `src/lib/alerts/` and `src/lib/cost/`, split the way
everything since step 8 has been. `alerts/feed.ts` is pure and is the whole argument: an
alert row records that a notification was **owed at an instant**, and a feed shows it later,
so `standingOf` reports which of five things it has become — `new`, `repeating`,
`unchecked` (nothing has re-run the sweep, which is §5f's rule about an unchecked flight
applied to the thing reporting the flights), `acknowledged` (seen, still true) and
`resolved`. `linkFor` reads `source` rather than regexing a dedupe key. `groupFeed` collapses
one sentence said by many rows. `alerts/access.ts` refuses an org-wide read at all.
`alerts/store.ts` is now the **only** file that writes the table: `syncConditionAlerts`
takes an engine's complete current plan, upserts it, and **closes every key the engine no
longer plans**, which is the only signal a crate arriving produces. `alerts/sweep.ts` runs
all five engines and names the ones that could not run. `cost/rollup.ts` is pure and holds
the six refusals; `cost/store.ts` loads every show's inputs in a fixed number of queries so
the portfolio and a show's tab cannot disagree; `cost/access.ts` is Travel Manager and
Admin.

Schema: `alerts` gained `source`, `kind` (`condition` vs `notice`), `last_seen_at`,
`occurrences`, `resolved_at` and `acknowledged_by_id`. Screens: `/alerts` and `/cost` in the
nav, a **Cost** tab on the show that is not rendered at all for a Member, and one line on
the overview above everything else. The five engines' fan-out logic stayed where it was —
each knows who cares about a stalled crate — and only the write is shared. The seed
completes one deadline and re-runs the sweep so a genuinely **resolved** row exists, and
acknowledges one alert *as the person it was addressed to*.

**The five corrections step 17 turned up:**

1. **`onConflictDoNothing` muted every recurrence, and only a feed made it reachable.** A
   condition that ends and comes back under the same dedupe key reused the row somebody
   acknowledged weeks ago — so the second occurrence arrived pre-dismissed and nobody was
   told. Invisible while nothing read the table, and the first thing a feed would have
   found. The writer upserts now, `occurrences` and `last_seen_at` move each night, and a
   row that had resolved comes back un-acknowledged with its clock restarted.
2. **Only an engine may resolve an alert, and it can only do so because it plans over
   everything.** A person acknowledging is not a person fixing, so the dismiss button that
   clears a board would be the acknowledged-and-forgotten failure with a nicer interface.
   Resolution is therefore absence-from-tonight's-plan — which is sound *only* because all
   five engines plan over their whole population rather than over what changed, each for
   its own already-stated reason. An engine that planned over a subset would silently close
   every row it did not look at.
3. **An engine dedupes a fact; a feed has to dedupe a sentence.** Eleven people on one
   re-timed flight is eleven correct rows and one piece of news for the manager who
   receives all eleven. No engine can see that, because each only ever looks at one leg.
   Grouping is a view concern and deliberately not a change to any dedupe key.
4. **A dry run is not spend, and the seeded workspace is made entirely of dry runs.**
   `bookings.live` is the provider's word and the ground rule above says it exists to
   protect the true-cost rollup — this is the step where something finally read it. A
   rollup that summed charged amounts would have looked plausible and been fiction on day
   one. Same shape three more times: a credit is not a discount (the fare was paid last
   year, on a cancelled ticket, and belongs to that show), stock consumed is not stock
   bought, and committed is not paid.
5. **A cost figure that does not say what it is missing is the fabricated bill §5a
   refuses to quote, at the scale of a show.** A computed number carries authority a
   spreadsheet never had, so a confidently wrong one is worse than what it replaced. Every
   line carries its coverage, the headline word is "at least" unless nothing is missing,
   and a *silent* line is not a zero — a show with no booth-space figure is not a cheap
   show, it is a show nobody has entered the invoice for.

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

**`UI-REWORK.md` is done — all eight tranches** (option B: consolidation *plus* a full
visual pass; brief "modern, bright colors, easy to navigate"). It gated nothing and step 13
is still next. The plumbing half:

- **`_components/form.ts`** — one `FormState` (`{ error?, ok? }`) plus `formErrorFrom`,
  `optional`, `str`. It had been declared in five files and drifted into three shapes.
  Dependency-free on purpose: client components import the type, so it must not pull
  `next/cache`. `refresh` is deliberately **not** shared — each tab's revalidation set
  differs in load-bearing ways.
- **`_components/form-ui.tsx`** — `Input`/`Select`/`Textarea` (two named densities,
  `compact` for a control inside a list row and `comfortable` for a page that is a form),
  `Field`, `Message`, `Submit`, `QuietSubmit`, `ZonedDateTime`. `useActionState` stays at
  all 42 call sites; only the markup around it is shared. `_components/cn.ts` is the
  `clsx` + `tailwind-merge` pair that was already installed and unused.
- **`lib/datetime/zoned.ts`** gained `zonedDateInput` / `zonedTimeInput` /
  `zonedDateTimeInput`, all derived from `instantToZoned`, with tests.
- **`shows/[id]/team/forms.tsx` is gone**, split into `roster-forms.tsx`,
  `shift-forms.tsx` and `side-event-forms.tsx` — the three cards the page renders.
- **`pnpm smoke`** fetches all routes against a running `pnpm dev` and checks 200 plus
  a phrase only present once the page resolved its data.

And the visual half:

- **`globals.css` is the design system.** OKLCH semantic tokens — `surface`, `panel`,
  `muted`, `border`, `border-strong`, `text`, `text-muted`, `brand`, and the four tones —
  in the two-stage `:root` / `.dark` + **non-inline** `@theme` pattern. `@theme inline`
  bakes values at build time and breaks runtime theming; there is **no `tailwind.config.*`**
  and there must not be one (v4 is CSS-first). Tokens are semantic, never chromatic.
- **Dark mode is a `.dark` class**, applied before first paint by an inline script in
  `src/app/layout.tsx`, with a three-state control (light / system / dark) in the sidebar.
  Absence of the stored key *is* system.
- **`_components/sidebar.tsx`** — collapsible, 64px icon rail, grouped Plan / Travel /
  Settings so steps 13–18 have somewhere to land. `_components/pref.ts` reads both browser
  preferences through `useSyncExternalStore`.
- **`ui.tsx` is a real vocabulary now** — `Table`/`Th`/`Td` (sticky headers, `numeric`
  right-aligns *and* sets tabular figures), `PageHeader`, `Stat`, plus reworked `Card`,
  `Badge`, `Button`, `LinkButton`.

**The measurement worth keeping: `src/app` contains zero `dark:` variants.** Dark mode used
to be a twin class on every line that had a colour, so adding a colour meant remembering its
twin and forgetting was invisible to anybody working in light mode. One token carries both
themes now. `UI-REWORK.md` §10 and §11 are the long version.

**The five corrections the rework turned up:**

1. **"Verbatim" duplication was not verbatim, twice.** `travel/actions.ts`'s `asFormError`
   carries an extra branch that renders any `Error` with a message — the booking agent
   throws bare `Error`s for real explainable conditions — and its `str` trims where the
   other four do not, which matters because an airport code with a trailing space is a
   failed search. Folding either in silently would have made four other screens swallow
   their next genuine bug. Both are kept and named. Read a "verbatim" copy twice before
   deleting it.
2. **The date helper had four copies, not the two the plan counted**, and none was tested.
   `src/lib/datetime` was never the layer with the browser-zone bug; `src/app` was, four
   times over, in the one place nothing was watching. `toISOString().slice(0, 10)` on a
   5pm-Pacific due date returns *tomorrow*, so a round trip through the edit form moves the
   deadline a day — the exact failure the §5a engine exists to prevent, arriving through
   the form that edits it.
3. **The §2a defect was one control serving two different acts.** The permission
   (`mayRespond` = own row *or* an approver) was right and did not change; the framing was
   wrong. Answering for yourself and recording what a colleague told you are different
   acts, and a component given only a boolean cannot tell them apart. `RosterEntry.isSelf`
   plus a separate third-person "Record Tomás's answer" control is the fix.
4. **That defect had a second half in `src/lib`, and it is now fixed too** (its own step,
   after the rework — `SCOPE.md` §11.12). `standingFor` branched on `attendeeStatus` alone
   and never read `responded_at`, so a `confirmed` typed by an admin counted toward booth
   coverage — the hearsay the ground rule forbids. The write path already obeyed the rule
   and the team tab already rendered a "not answered by them" badge on those exact rows;
   only the number ignored both, which is the worse half, because the number is what a lead
   reads and stops at.
5. **A media query is not a preference.** Dark mode was `prefers-color-scheme` only, which
   cannot be overridden by a person, only obeyed — that is *why* there had been no toggle,
   not an oversight beside it. And the control needs three states: "follow the system" is a
   real answer that a two-way toggle silently destroys the first time it is pressed, after
   which the app stops tracking a laptop that switches at sunset with nothing on screen
   saying so.

**What step 16 added, and where:** `src/lib/assets/` — the chain of custody, split the way
everything since step 8 has been. `custody.ts` is pure and holds three of the six
arguments: the seven-state custody chain, `availabilityFor` (three refusals, each with its
reason — **reserved is not available and available is not serviceable**), and
`freightCoverage`, which is where assets meet step 14's shipping rows. `conflicts.ts`
compares **reservation windows rather than show dates**, which is §5e's correction
inverted, and adds `turnaround` as a `possible` finding because adjacent is not clear.
`inventory.ts` is the collateral half — on hand minus committed, low stock judged on what
is *free*, an allocation's three states, and the projection over the ledger. `alerts.ts`
carries both dedupe-key shapes at once (§5a's date for a reservation, §5b's bucket for a
quantity) and escalates the two alerts that by construction have no holder. `board.ts`
orders by what is wrong and counts capital outside the building. `edit.ts` requires a
condition on return and a written note when it comes back worse. `access.ts` puts sign-out,
check-in and counting a shelf in **anybody's** hands. `store.ts` is the only file touching
rows, scoped through the **asset's own org** — a third posture beside shipping's show and
flights' traveler, and it falls out of the domain rather than being chosen: a booth belongs
to the company between shows, which is most of its life and all of the time it goes missing.

Schema: `assets.cost_center_id` (§4's rule, which assets had been violating) + timestamps +
a unique asset tag; `asset_reservations.condition_on_checkout`, `returned_by_id`,
timestamps, unique on `(asset, show)`; `collateral_items.cost_center_id` + timestamps +
unique SKU; a new append-only **`collateral_entries`** with signed deltas and a
`(allocation, kind)` rail; `collateral_allocations.issued_at` / `issued_by_id` /
`returned_at` / `returned_by_id`. Screens: `/assets` in the nav, and the **Logistics tab
now renders three models on one page** — the crate, what is inside it, and the collateral —
with the joins between them visible, which is the whole reason step 16 came after step 14.
`pnpm assets` / `pnpm assets --sweep` is the engine without a screen. The assistant gained
`asset_register` and `collateral_stock`, both existing org-scoped store calls, so the §6f
posture is unchanged. The seed builds all of it **through the real stores** — including a
booth signed out to last spring's Detroit show and never checked in, which is the sentence
the schema comment has carried since step 1.

**The six corrections step 16 turned up:**

1. **Reserved is not available, and available is not serviceable.** §5e found that an
   assigned booth shift is not a covered one. An asset has that gap and one more beyond it:
   a reservation is a claim on a thing that may already be promised elsewhere, and a thing
   promised to nobody may still be a touchscreen with a cracked panel. `assets.condition`
   is a fact recorded on the *last* return, every screen renders it as a label, and nothing
   joined it to the reservation three weeks out that it invalidates. Same failure shape as
   `overstated` coverage — a filled slot is the one thing nobody looks at again.
   `SCOPE.md` §5h.
2. **The reservation window is not the show window, and §5e inverts.** Comparing show dates
   *over*-reported a person's double-booking (Monday–Tuesday in Detroit, Thursday–Friday in
   Chicago is an ordinary week); it **under**-reports an asset's, because the booth is gone
   for a month around a three-day show. And there is a finding with no counterpart on the
   people side: **adjacent is not clear.** Back on the 8th and out again on the 10th gives
   the crate 48 hours to cross the country, be opened, be inspected and be re-crated. That
   is `possible`, not `certain` — two shows really can share a floor — which is §5e's
   certainty distinction reached from the opposite direction: there the doubt was about the
   *data*, here it is about the *world*.
3. **"In what condition" is only answerable as a delta.** `assets.condition` is mutable, so
   by the time anybody asks whether Automate cracked the panel the column reads
   `needs_repair` and cannot say when it started. The reservation snapshots both ends, a
   return worse than the checkout needs a written note (§5d's rule on `skipped`, from a
   third direction), and a check-in is the **only** place `assets.condition` moves — a form
   that could type it would be a second way to set the same fact.
4. **Signing out and checking in belong to anybody** — §5g's `canConfirmReceipt`, one layer
   up. The person who wheels the crate onto the truck is whoever is in the warehouse at
   6am. A `returned_at` only a manager can set is one that stays null, after which every
   reservation is flagged overdue and the flag stops meaning anything.
5. **On hand is not available, and an uncounted return is not a zero return.** 640
   datasheets with 400 promised is 240 available, and a threshold checked against on-hand
   reads fine until somebody opens the cupboard. Separately, `quantity_returned` is
   nullable and that nullability is load-bearing: reading null as zero writes off stock we
   own, reading it as full ships the next show short, so the app refuses to guess and names
   both guesses. And *promising* stock is not *picking it off the shelf*, so an allocation
   has three states and only the middle one moves the quantity — which is a projection of
   the append-only ledger, the credit rule from step 6 applied to things.
6. **Past a point, "return it" is the wrong sentence.** §5a's tense rule at the end of the
   chain: a $84,000 booth nobody has seen in six weeks is an insurance and replacement
   conversation, not a nightly reminder, and the alert stops chasing and says so.

**What step 15 added, and where:** `src/lib/integrations/llm/` — the fourth integration
behind an interface, and the first one where a vendor SDK exists. `types.ts` performs **one
exchange and runs no loop**: running a tool means choosing an actor to run it as, and that
choice must not live inside an adapter. `anthropic/client.ts` is the Messages API through
`@anthropic-ai/sdk`, so unlike Duffel, AeroAPI and EasyPost there is **no `wire.ts` and no
fixture file of payloads we invented** — the vendor ships the types, the compiler checks
the shape, and there is nothing left for a capture script to arbitrate. `scripted/` is the
zero-key model and it replays **tool plans, never prose** (below). `assistant/provider.ts`
selects between them with **no fallback**.

`src/lib/assistant/` is the model, split the way everything since step 8 has been.
**`tools.ts` is the whole step**: fifteen tools, every one an existing org-scoped store
function called as the asking actor through the same `access.ts` gate a screen goes
through — no query, no join, no org id from the model. `access.ts` is subtractive, so a
withheld tool is never described. `prompt.ts` carries **tense and nothing load-bearing**.
`loop.ts` is a manual loop with three bounds of ours (`MAX_TURNS`, `MAX_TOOL_CALLS`, and a
`max_tokens` stop that is never presented as an answer). `draft.ts` refuses to file without
the person's own words, refuses to guess a time zone, and carries a `FlightProvider` whose
every method rejects. `serialize.ts` sends instants rather than formatted local strings and
announces truncation. `store.ts` is the only file touching rows and scopes a conversation
to a **user**.

Schema: `assistant_conversations` (user-scoped, with the provider recorded per
conversation) and `assistant_messages` (append-only; a `tool` row keeps the validated input
and the store's actual result, because the prose is the paraphrase). Screens: `/assistant`
and `/assistant/[id]`, first in the nav, with each tool step rendered *beside* the answer
and openable. `pnpm assistant` is the loop without a screen; `pnpm assistant --tools`
prints the surface per role. The seed produces two transcripts by **running the real loop
against the real tools** — a member and an admin asking questions whose *results* differ
while nothing about the prompt does.

**The five corrections step 15 turned up:**

1. **A withheld tool must not be described, and naming one must get the same answer as
   inventing one.** The first half is easy and `access.ts` does it. The second is the one
   worth arguing about, and a test caught the code contradicting its own comment: "that
   tool exists but is not available to you" is a *map* — it confirms the capability, names
   it, and invites another route to it. "That is not a tool" ends it. Generally: **nothing
   in the system prompt is load-bearing for access.** If a rule would be dangerous to have
   disobeyed it lives in code, and every such rule here does. The prompt carries tense — an
   unconfirmed deadline is a date and not an amount, delivered is the carrier's word, an
   unchecked flight is not on time — because a narrator that flattens those back into "two
   deadlines at risk, flights on time" undoes four steps of work in the register a person
   actually reads. `SCOPE.md` §6f.
2. **A `recorded` provider can replay a payload; it cannot replay prose.** The other three
   replays obey one rule — describe a *shape*, never assert a fact about this workspace.
   EasyPost's projects a recorded journey onto the crate's real transit window. Prose has
   no equivalent move: "MedTech is 62% ready" is not a shape, it is a sentence about a
   different workspace, and it would land on screen under the app's own byline. So the
   `scripted` model replays only **which tools to call**; those run for real, and its one
   canned sentence characterises nothing. The test asserts it contains no digits.
3. **`submitTravelRequest` inferred human confirmation from the *absence* of raw text, and
   that inverts for this caller.** No raw text meant "typed into a form, therefore
   confirmed" — right for the form and the dry-run script, and catastrophic for a parser:
   the request would be marked human-confirmed and searched with nobody having read the
   parse. The draft path refuses rather than defaulting. Two more things make it
   structural: the assistant does not hold `confirmConstraints`, and its `AgentDeps` carry
   a provider whose every method rejects with a sentence naming the rule (`travel/
   actions.ts` passes `null as never` there — fine from a form, worth fifteen lines from a
   language model).
4. **A follow-up must not be answered from the previous turn's tool result.** The
   transcript replays prose *without* tool results. A result is a snapshot of rows as they
   were when it ran, and "has it landed yet?" is exactly a question about the row that has
   since moved — so feeding it back makes the assistant confidently stale on precisely the
   questions people ask twice.
5. **A transcript belongs to the person in it — the only table in this app scoped to a
   user rather than an org.** Every tool result inside one was retrieved under that
   person's scope, so a second reader is reading rows a query narrowed for somebody else:
   the lateral path the whole posture exists to close. There is no admin read, and adding
   one would be the second way to break the posture after adding an ungated tool. (A
   related bug, caught by an empty `/assistant` page: this file's own test cleanup deleted
   *every* conversation rather than its own, wiping the seeded ones — green test run,
   blank screen.)

**What step 14 added, and where:** `src/lib/integrations/shipping/` — the third integration
behind an interface, in the shape the first two settled on. `types.ts` is the provider
contract and it decides nothing; `easypost/` is EasyPost Tracker v2 (wire / normalize /
client, written to the published schema and **never run against a live key**, which its
header says in the same words AeroAPI's does); `recorded/` replays EasyPost-shaped payloads
through the *real* normalizer, projecting a recorded **shape** onto the crate's actual
transit window and handing back only the scans that have already happened — so a replay
can never show a crate delivered on the day its label was printed, and `stalled`, whose
entire content is the *absence* of recent scans, stays distinguishable from `on_time`. Its
scan locations are roles ("Origin hub", "Destination facility"), not cities, because a
replay knows the shape of a journey and nothing about the route.
`shipping/provider.ts` selects between them with **no fallback**.

`src/lib/shipping/` is the model, split the way everything since step 8 has been.
`status.ts` is pure and holds the argument: the two-edged `windowVerdict` (with `too_early`
as a real standing), `stallOf`, `freshnessOf` / `effectiveStatus`, and `reconcile`, which
captures the carrier's promise *once* so `brokenSincePromise` can ever be true.
`alerts.ts` is pure, mostly decides to say nothing, and carries `planReturnGapAlert` — the
one planner in the product that fires on an absence. `board.ts` orders by what is wrong
rather than by what is due, and counts `unreceived` as a live figure. `access.ts` is the
split worth arguing about: confirming a crate reached the booth is available to **anybody**.
`edit.ts` refuses a show-site row with no dock-opening time and refuses to guess an advance
warehouse cutoff. `store.ts` is the only file touching rows: org-scoped through the show
(the mirror of flights, which scopes through the traveler because its show is nullable),
the sweep, and the append-only timeline.

Schema: `shipments.consignment`, `receiving_opens_at`, `owner_id`, `received_at` +
`received_by_id`, `promised_delivery`, `estimate_changed_at`, `tracking_provider`,
`updated_at`, plus an `unknown` status; `shipment_events.source` + `fingerprint` with a
unique index on `(shipment_id, fingerprint)`. Screens: `/shipping` in the nav, and the
show's **Logistics tab is writable** — it was the last read-only one. `_present.tsx` is the
shipment vocabulary both screens render through, because the moment two screens draw a
crate they can disagree about what `too_early` looks like and nothing would catch it.
`pnpm shipping` / `pnpm shipping --sync` is the engine without a screen.

**The seed grew two shows, and that was a finding rather than a convenience.** Every seeded
show was fifty or more days out, which means no crate on the calendar had plausibly
shipped — the recorded provider correctly returned pre-transit trackers with no scans, and
a shipping feature seeded against that calendar would have had an empty timeline on every
row. What was missing was somewhere for freight to *be*. So there is now a **live** show
(move-in this morning: a crate delivered to a dock that nobody has confirmed at the booth,
one that missed show-site receiving outright, and one that has simply gone quiet) and a
**prior-year** show that moved out seven weeks ago with outbound freight and nothing
recorded coming back. Both sweeps are real.

**The five corrections step 14 turned up:**

1. **A crate has a window, not a deadline, and early is a failure too.** A flight cannot
   land too soon; freight can, and the two consignments are two different *rules* wearing
   the same date. An advance warehouse holds freight for weeks and closes on a published
   cutoff. Show-site receiving does not open until move-in, and a crate that turns up two
   days early is refused, held at the carrier's rate, or sent back — which every status
   column in every payload calls `delivered`. A deadline-only model calls that crate
   "clear, with fifty hours spare", right up until the dock turns the truck around. Also:
   an advance-warehouse cutoff must never be prefilled from move-in, because it is one to
   three weeks earlier and a wrong-by-a-fortnight date that looks right is worse than a
   blank one. `SCOPE.md` §5g.
2. **Delivered is not received, and only a person can close that gap.** The carrier signed
   for a dock. Drayage — a separate contractor, on its own schedule, invisible to this app —
   moves it from there to the booth. Rendering `delivered` as done is how a booth stands
   empty on the first morning with every screen in the product showing green. `received_at`
   is a person's word, the way `show_attendees.responded_at` is, and confirming it is
   available to **anybody**: the person who finds the crate is whoever is in the booth at
   7am, and a confirmation only a manager can give never gets given.
3. **Silence is the failure mode, and nothing in the payload reports it.** A stalled crate
   is still being promised for Thursday and still reads `in_transit`; there has just been no
   scan since Tuesday. So the absence of scans is what raises it — with a threshold generous
   enough for LTL freight, which really does scan once a day, tightening as the deadline
   closes. This is also why the sweep plans alerts against *every* shipment rather than only
   the ones that changed: an engine that speaks on transitions is structurally incapable of
   reporting a stall, which is the failure with no transition in it.
4. **§5f's rule about the leg home inverts.** A delayed flight home says nothing, because it
   is somebody's evening. A return crate is the leg that actually goes missing, and it
   surfaces a quarter later when the booth is not there for the next show and the claim
   window has closed. So the sharpest alert here has **no shipment row behind it at all**:
   a show that moved out, had outbound freight, and has nothing recorded coming back.
5. **A poll returns the whole timeline, not a delta — and one small bug proved the general
   rule.** Carriers issue no stable event ids, so a fingerprint is derived from the scan
   (instant, phase, location — deliberately *not* the message, since carriers reword scan
   text between polls) and a unique index makes the claim true rather than intended. The
   bug: `expectedArrival` trusted `estimated_delivery` on a shipment with **no tracking
   number**, so a crate nobody had handed to a carrier was reported as *"will miss the
   receiving deadline"* — a confident claim about a truck, sourced from nothing, that hid
   the actual problem, which is that there is no truck.

**What step 13 added, and where:** `src/lib/integrations/flightstatus/` — the second
integration behind an interface, in the shape the first one settled on. `types.ts` is the
provider contract, and it decides nothing: it reports what a carrier says about one leg at
one moment, and `NoRecord` is deliberately not `phase: 'unknown'` ("we have never heard of
this flight" and "we know it and cannot say where it is" are different things to tell
somebody). `aeroapi/` is FlightAware AeroAPI v4 — wire / normalize / client, written to the
published schema and **never run against a live key**, which its header says in the same
words the Duffel adapter's did before step 12.5. `recorded/` replays AeroAPI-shaped
payloads through the *real* normalizer; what it records is a **shape** (departed on time,
landed forty late) projected onto whichever leg it is asked about, so a canned block time
never reports a transcontinental delay on a shuttle, and a leg that has not departed can
never come back `landed`. `flights/provider.ts` selects between them with **no fallback**.

`src/lib/flights/` is the model, split the way everything since step 8 has been.
`status.ts` is pure and holds the argument: `freshnessOf` / `effectiveStatus` (an unchecked
row is not an on-time row), `bufferVerdict` (the §7 arrival buffer re-run against live
times, with the required hours read out of the *resolved travel policy* rather than written
down again), and `reconcile`, which keeps a carrier's re-timing apart from a delay.
`alerts.ts` is pure and mostly decides to say nothing. `board.ts` orders by what is wrong
rather than by what leaves next, and counts a costless delay in its own quiet figure.
`access.ts` splits refreshing (not a privilege — it is the carrier's answer to a public
question) from correcting a flight record (it moves the times the buffer is judged
against). `store.ts` is the only file touching rows: org-scoped through the *traveler*
rather than through the nullable show, the sync sweep, and `materializeFlights`.

Schema: `flights.show_id` nullable, `leg_direction`, `origin_time_zone` /
`destination_time_zone`, `provider_scheduled_departure` / `_arrival`, `schedule_changed_at`,
`diverted_to_airport`, `status_provider`, `booking_id` + `segment_index` (unique),
`updated_at`. `Segment` in `policy/types.ts` gained the two optional zones, which
`duffel/normalize.ts` had been reading and discarding. Screens: `/flights` in the nav, and
live standing on the show's Travel tab and on My Itinerary — both through the board's model,
never a second one. `pnpm flights` / `pnpm flights --sync` is the engine without a screen.
The seed produces its flight status by **running the real sweep**, pinning which recorded
payload each seeded leg replays so the board tells one coherent story: a red-eye landing six
hours before move-in that loses its buffer, a roomy morning flight that is fine, and a
flight *home* that is late and deliberately silent.

**The five corrections step 13 turned up:**

1. **The booking spine was buying tickets the tracking layer could not see.** Nothing in the
   app had ever written a `flights` row. The agent recorded an *order* — provider, order id,
   reference, ticket numbers, cost — which is exactly right for an audit and is not an
   itinerary, and My Itinerary, the show's Travel tab and the flight board all read
   `flights`. So every ticket the product's own agent had bought was absent from all three,
   and a flight-tracking feature would have shipped tracking nothing but hand-typed rows.
   Ticketing materializes the purchased slices now, idempotent on
   `(booking_id, segment_index)`. Two things fell out: `flights.show_id` had to become
   nullable, because `travel_requests.show_id` always was; and the airport zones had to be
   carried through `Segment`, because Duffel sends them and the normalizer was dropping
   them. `SCOPE.md` §5f.
2. **A delay is not news; a delay that costs the arrival buffer is.** §7's buffer rule was
   evaluated once, against an offer, at purchase, and never again — so a schedule that
   slipped afterwards silently voided a policy verdict nobody re-read. The engine speaks on
   `brokenSincePurchase` (cleared the buffer when bought, does not now), not on delay
   minutes; a flight booked inside the buffer was an approval decision and is not reported
   as a disruption every night; and a delayed flight *home* says nothing at all.
3. **A re-timing is a third thing, beside the plan rather than over it.** Written into
   `estimated_*` it reads as a three-hour delay on a flight running perfectly; written into
   `scheduled_*` it erases what the policy verdict was computed from. So the carrier's
   schedule gets its own columns, delay is then measured from *it* rather than from ours,
   and the alert is written as a change of plan with weeks of room to act — which a day-of
   delay does not have.
4. **Not knowing is not on time, and it is the default.** An unchecked row reads
   `scheduled`, so a board that has not refreshed in eight hours shows a full slate of
   on-time flights. Staleness is judged against the flight's own timeline, an unchecked
   flight past its departure is `unknown`, and a lookup that found no record patches
   *nothing* — not even `last_checked_at`, because stamping a successful check on a failed
   one is how a board goes stale while claiming to be fresh.
5. **An alert is keyed to the fact that changed, not to the number.** §5a keys a deadline
   alert on the deadline *and its date*, which is right because a date moves rarely and
   deliberately. An arrival estimate moves every time anybody asks, so the same key shape
   would send "your flight is late" all night. The key carries the **standing** —
   `inside_buffer`, `after_move_in`, `cancelled` — so it fires once on each crossing and
   never for jitter.

**Next: step 22, and the pick is LLM deadline extraction** (`SCOPE.md` §5a's post-v1
addition, listed last in §10.22). Recommended 2026-09-01 and not started. Three reasons, in
order:

- **It is the missing half of this product's own #1 feature.** `RESEARCH.md` §3a ranks the
  service-manual deadline engine "highest ROI feature found — $2.5–3.5k/show, unique", and
  its table calls LLM extraction the v2 add-on. Today somebody types that register by hand,
  which is precisely the tedious work §1's first job exists to kill.
- **Everything it needs is already built and enforced, not merely planned.**
  `show_deadlines.extracted_from_document` and `confirmed_at` are live columns; the rule
  that nothing extracted is quoted in dollars until a human confirms is enforced by step
  11's engine, which chases an unconfirmed deadline as a **date** and never as an amount;
  the register is writable and confirmation is already a first-class act; and §6a's boundary
  was exercised at step 15 — `llm/types.ts` performs one exchange and runs no loop.
- **It is the only substantial item verifiable end to end on localhost.** There is a working
  `ANTHROPIC_API_KEY`, so unlike Slack, SSO, hosting, AeroAPI and EasyPost this one does not
  ship written-to-the-docs-and-hoped.

**The two risks to settle before writing code, because both are the closed loop step 12.5
named.** Nothing in `package.json` reads a PDF, so this needs the first parsing dependency
in the project; and a real exhibitor manual is somebody's copyrighted document, so the test
corpus has to be **synthetic** — which means the suite proves internal consistency and
structurally cannot catch a layout the real manuals use and ours does not. Decide what plays
the part `pnpm duffel:capture` plays elsewhere *before* building, not after.

Two alternatives, if that is the wrong shape: the **drayage estimator** (pure, no keys, and
it feeds the true-cost rollup's biggest silent line — smaller and less differentiating), or
**HubSpot** (§11.6: a free developer tier makes it the only unverified adapter that could
realistically get the capture script Duffel and Salesforce have — closing a known gap rather
than opening a new one).

**Step 21's remaining two halves are deferred by decision, not left undone** (2026-09-01,
`SCOPE.md` §10.21 `[~]` and §11.2): there is **no real Slack workspace**, this runs on
**localhost only**, and hosting needs a cloud account that §9's ground rule forbids wiring
unasked. Do not pick any of them up speculatively.

- **Slack stays stubbed**, in the sense that matters: the adapter is written and unverified,
  like AeroAPI, EasyPost and Salesforce, and nothing constructs it without `SLACK_BOT_TOKEN`.
  The default transport is `console`, which composes the real message and delivers it to
  nobody. **Do not add a `recorded` Slack provider** — the whole argument for `console`
  existing is that a replayed *delivery* is a claim somebody's phone buzzed.
- **The SSO rollout is a TODO gated on hosting, not on itself.** This project runs on
  localhost, and enterprise SSO is **downstream of a public origin**: a SAML IdP posts its
  assertion to an ACS URL it has to be able to reach, and an enterprise OIDC connection
  wants a redirect URI on a real domain — neither can reach `localhost:3000`. So hosting
  and SSO are one gate, in that order, and there is no useful SSO work to do before it.
  When it does land, the domain-to-org mapping is a **change to a ground rule** rather than
  a feature: today a verified session matching no `users` row gets no access *and no row
  created for it*, and domain-to-org provisioning is precisely a way to create one. Decide
  that deliberately, with a live connection in front of you, not in passing.
- **Hosting** is therefore the one that unblocks the other, and is where §11.10 (data
  residency) stops being deferrable and where the day-of service worker meets a real origin
  and a real TLS certificate for the first time.

§11.5 (scale) is the open decision nearest all three, and step 21 gave it a first concrete
edge: the nightly job is a `for` loop over every org inside one HTTP request, which is right
at this size and is the first thing that stops being right.

**Deliberately not built, and visible as such:** the free-text request box §6a describes
is **built** as of step 15 — the assistant parses "Vegas by Tuesday noon, back Thursday
night" into constraints and files them — but it deliberately stops there: the request is
filed unconfirmed, and reading the parse and confirming it happens on `/travel/[id]`, by
the person whose trip it is. The assistant does not stream (a server action returns the
whole answer, which keeps every tool call inside the request as the actor `getActor()`
resolved), and it books no hotels, because §5 keeps hotel booking out of v1. The readiness tab, its deadline register, the team tab, lodging and
logistics are all writable as of steps 10–14, and Logistics grew chain of custody and
collateral at step 16, Cost arrived at step 17 as the seventh tab, Leads at step 18 as the
eighth and ROI at step 19 as the ninth — **there is no read-only tab and no dead control
left.** **Booth presence has no seed rows**: every seeded show is in the
future and `shift_presence` is a record of what happened, so the check-in control appears on
a shift once it has run rather than inviting somebody to pre-record their own attendance.
**A lead reaches a CRM only if it may, and as of step 19 that is enforced by the code path
rather than only by the screen:** every lead row carries `outbound` — `marketabilityOf`'s
answer to "may this row leave the building", with the reason and the fix — and `roi/store.ts`
*reads that same verdict* rather than re-deriving one. Matching by email transmits personal
data and is gated on it; matching on an id the CRM itself gave us is not, because it sends
nothing about the person. Every seeded scanner lead fails the check, because a badge
vendor's export carries no consent column, and those leads are consequently absent from
every pipeline figure — named on `/roi` as **withheld by us**, deliberately apart from the
leads the CRM did not know. The verdict is still computed on the row rather than at the
point of export, for the original reason: the moment somebody can fix it is the moment they
are looking at the lead, and by the time a sync asks, the person who stood at the booth has
gone home. **Nothing has been written into a real CRM**, because the Salesforce adapter has
never met a live org and the `recorded` provider refuses to report a write it did not make. **`retention_overdue` is now enforced by the nightly job**, which is the promise §5j said
was worse than none while nothing kept it: stage 2 of `runNightly` really erases, and what
it erased goes into the run's summary, because an irreversible act performed by nobody has
to leave a record made by something. Two callers skip it and both have the same reason — the
test suite and the seed would each destroy the demo they exist to build.
`pnpm leads --retention` is still the deliberate, typed version. **Nothing runs the nightly
job on this machine**: without `CRON_SECRET` the endpoint refuses, and until a scheduler is
pointed at a real origin the only things that run it are `pnpm nightly` and a button on
`/settings/notifications` — which is why `manual_only` is a standing of its own. **Alerts now have a transport and a scheduler, and by default neither reaches anybody — and
that is the settled state for as long as this runs on localhost.** There is no Slack
workspace for this project (2026-09-01), so the adapter stays written-and-unverified and the
app keeps reaching nobody unless somebody sets a token. SSO is a TODO on the same footing and
for a sharper reason: an IdP cannot post an assertion to `localhost`, so it is gated on
hosting — see §11.2.
With no `SLACK_BOT_TOKEN` the transport is `console`, which composes every message from the
real alerts and delivers it **to nobody** — recorded as `rendered`, never `sent`, so a
workspace that has told nobody anything can never read as one that has. With no
`CRON_SECRET` the nightly endpoint **refuses**, so the sweeps still run only when somebody
presses *Re-check everything* — which is why `unchecked` is still a standing and a figure on
the page, and why `/alerts` now also says whether anything has run the engines at all.
`pnpm nightly --dry` prints the messages verbatim, which is the only way to read what a
colleague would receive before installing a Slack app. **The transport is still unverified
against a live workspace**, like AeroAPI, EasyPost and Salesforce, and says so in its
header. **Nothing rebooks a cancelled flight**, and the alert says so
rather than implying otherwise: the agent buys against a travel request and the ticket is
already bought, so rebooking is a call to the airline — the same shape as §6d's cancel. The row is the durable record that the notification was owed; a transport added
later cannot erase it. **Extraction from the manual PDF is not built** — §5a's post-v1 LLM
step — but the columns it writes (`extracted_from_document`, `confirmed_at`) and the rule
it must obey (nothing extracted is quoted in dollars until a human confirms it) are both
live and enforced by the engine today. **Checklist templates are code, not rows**: the library in
`src/lib/readiness/templates.ts` is versioned in git and an org-editable template builder
is deliberately deferred until the standard list has been used and argued with, which the
templates card says on the page. The nav still grows one entry per screen
that exists.

**The day-of screen queues, and nothing drains it in the background.** There is no Background
Sync registration and no push: the outbox goes up when the tab is open and the network comes
back, which is the ordinary case on a floor and is not every case. A phone put in a pocket at
4pm with three captures on it still has three captures on it at 9pm — which is exactly why the
count says "on this device" rather than "pending", and why the queue is on the screen rather
than behind a spinner. It also **only captures leads and meetings offline**: confirming a
crate at the booth, answering a shift invitation and every other write in the product are
still server actions that need a connection, because each of them has a store function with
rules the device does not carry. And a target-account alert is a line on the capture form,
not a notification — nothing here asks for notification permission.

**Four adapters have never met a live key**, and each says so in its own header: AeroAPI
(step 13), EasyPost (step 14), Salesforce (step 19) and Slack (step 21). All three are written to published
schemas and tested against fixtures we wrote ourselves — the closed loop step 12.5 named,
which proves internal consistency and structurally cannot catch a wrong field name.

**Salesforce has the capture script; AeroAPI, EasyPost and Slack still do not.** Slack's
case is the mildest of the four and worth stating so nobody over-corrects: its one
docs-catchable defect — the `{"ok": false}` envelope on an HTTP 200 — is covered by unit
tests against a mock transport, and what remains unverified is whether the three scopes are
the right three and whether `conversations.open` behaves as documented for a bot posting its
first DM. A wrong answer there fails loudly on the first send, which is the opposite of
Salesforce's failure mode. **And there is no workspace to capture against** — that is the
standing decision as of 2026-09-01, not an oversight, so this adapter keeps its header until
somebody has a real one.
`pnpm salesforce:capture` + `tests/salesforce-conformance.test.ts` are `pnpm duffel:capture`'s
shape reused: they record a real org's answers into `fixtures/live-salesforce/` and check our
wire types and the *unmodified* normalizer against them, skipping cleanly when there are no
captures so a clean clone still needs zero keys. It was built first here rather than in step
order because **this is the adapter where a wrong field name would look like the truth**. A
wrong field on a tracking payload gives a crate with no scans and looks broken within a
minute; a wrong field here gives a dashboard where *nothing is ever attributed* — every show
carrying a real cost and no pipeline — which is indistinguishable from the honest finding
§8c says is normal at most companies. Nobody would go looking. The four questions are
labelled Q1–Q4 in the script and asserted by name in the suite:

- **Q1 — the join.** An Opportunity has **no** `ContactId`; the join is
  `OpportunityContactRole`. Reading the former compiles, returns `undefined` forever, and
  attributes nothing. This is the one whose wrong answer is invisible, so it is asked first.
- **Q2 — won versus open.** Stage *names* are per-org free text ("Closed Won", "6 -
  Closed/Won", and plenty not in English), so classification reads `IsWon` / `IsClosed` and
  never a name. The suite prints the org's own stage vocabulary as the evidence.
- **Q3 — money and dates.** `Amount` arrives as a JSON *number* where every other provider
  here sends a decimal string, so it is stringified through `money/decimal.ts` rather than
  multiplied by 100; `CloseDate` is a bare date anchored at midday, because `new Date()` on
  it lands at UTC midnight and therefore in the *previous* quarter in every American zone.
- **Q4 — currencies.** `CurrencyIsoCode` exists only in a multi-currency org and selecting a
  field an org lacks is a hard `INVALID_FIELD`, so the query is probed once and falls back to
  `Organization.DefaultCurrencyIsoCode` — read, never defaulted to `USD`, because a currency
  label is part of a money figure.

Captures are gitignored and the script redacts emails, names and phone numbers before
writing; the suite asserts it did. §5j is about a stranger's details not travelling somewhere
they were never collected for, and a git history is the least reversible such place.

**The Anthropic adapter (step 15) has never met a live key either, and is in a different
category.** It uses the vendor's own SDK, so there is no hand-written wire schema to be
wrong about and no capture script that would tell us anything — the compiler already
checks the shape. What is unverified there is *behavioural*: whether the model chooses
tools well, keeps the tenses `prompt.ts` asks for, and stops at drafting. None of that is
load-bearing for access, which is the point of putting the access model in `tools.ts`.

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
pnpm smoke        # fetch all 34 routes against a running `pnpm dev`; 200 + expected text
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
src/db/schema.ts              ~38 tables, the domain model
src/app/(app)/               the app shell and its screens; never prerendered
src/app/(app)/travel/        the request list, the form, the audit trail as a page,
                              and the approvals queue
src/app/(app)/alerts/        the feed: seven engines' output, grouped, with the standing
                              of each — and no way for a person to resolve one
src/app/(app)/cost/          the true-cost portfolio, and `_present.tsx` — the vocabulary
                              it and the show's Cost tab both render through
src/app/(app)/roi/           cost against pipeline, ranked by cost rather than by multiple,
                              and `_present.tsx` — where `Figure` is the only way a per-unit
                              number reaches a page, so a withheld one cannot be printed
                              anyway by the other screen
src/app/(app)/shows/[id]/roi/    the ninth tab: both halves of §8 side by side, with every
                              opportunity behind the figure openable
src/app/(app)/settings/crm/  the connection, the attribution model, and every sync run with
                              what it refused
src/app/(app)/leads/         capture across the calendar, worst first, and `_present.tsx` —
                              the one sentence in front of every count, shared with the tab
src/app/api/intake/leads/    POST from a badge scanner: the only route that authenticates
                              without getActor(), and a retry answered as a success
src/app/(app)/settings/intake/  issuing and revoking intake keys; admin, because a key is
                              a credential rather than data
src/app/(app)/day-of/        the offline screen: a picker, and `[id]/_client.tsx` — the only
                              page here that is not a Server Component, whose server half
                              deliberately fetches nothing; `_device.ts` is IndexedDB and
                              `_register.tsx` installs the worker
src/app/api/day-of/          snapshot (GET: the whole screen as data) and sync (POST: a
                              device's queue, every item answered)
public/sw.js                  hand-written, caches the day-of pages and nothing else
src/app/manifest.ts           the installable manifest; start_url is /day-of
src/app/(app)/readiness/     the portfolio rollup, ranked on pace rather than on score
src/app/(app)/flights/       the flight board, ordered by what is wrong with a leg
src/app/(app)/shipping/      the shipping board, and `_present.tsx` — the shipment
                              vocabulary both it and the Logistics tab render through
src/app/(app)/assets/        the asset register and the collateral shelf, plus the forms
                              and `_present.tsx` the Logistics tab renders through too
src/app/(app)/assistant/     the concierge and one conversation, with each tool step
                              rendered beside the answer rather than behind it
src/app/(app)/shows/[id]/team/     the writable roster, booth coverage, side events
src/app/(app)/shows/[id]/lodging/  hotels, room blocks, and the derived deadline
src/app/(app)/shows/[id]/leads/    the eighth tab: capture, the CSV import with its whole
                              arithmetic on the page, meetings, and erasure
src/app/(app)/shows/[id]/cost/     the show's true cost, not rendered at all for a Member
src/app/(app)/shows/[id]/logistics/  three models on one page: writable freight and its
                              timeline, the assets it carries with their custody chain,
                              and the collateral allocated to the show
src/app/(app)/_components/   the shared vocabulary: ui.tsx (Card, Badge, formatting),
                              form.ts (one FormState + FormData helpers, dependency-free),
                              form-ui.tsx (Input/Field/Message/Submit/ZonedDateTime), cn.ts
src/app/(app)/shows/[id]/team/  roster-forms · shift-forms · side-event-forms, one per card
src/lib/alerts/               the feed — feed.ts (pure: the five standings, ordering,
                              grouping a sentence rather than a fact, where each source
                              links), access.ts (no org-wide read), store.ts (the one
                              writer every engine shares; records a plan and closes what
                              it no longer contains), sweep.ts (all seven, and the ones that
                              could not run)
src/lib/cost/                 true cost — rollup.ts (pure: the lines, the six refusals, and
                              coverage as a shape rather than a percentage), store.ts (every
                              show's inputs in a fixed number of queries), access.ts
src/lib/roi/                  the third north-star job — attribution.ts (pure: five
                              refusals, and first touch decided across the whole calendar
                              rather than within a show), rollup.ts (pure: §5k — two floors
                              do not cancel, a replayed pipeline withholds its ratios,
                              maturity enforced rather than printed), alerts.ts (the seventh
                              engine; never alerts on a low multiple), access.ts (inherits
                              the cost gate), provider.ts (env → CRM, no fallback), store.ts
                              (matching gated on `marketabilityOf`; withheld kept apart from
                              unmatched)
src/lib/integrations/crm/     provider interface with exactly one write method + a Salesforce
                              adapter + a HubSpot seam that throws + a `recorded` replay of a
                              conversion shape rather than of a pipeline
src/lib/notify/               the transport — plan.ts (pure: the five refusals, and the
                              grouping borrowed from the feed rather than rebuilt), store.ts
                              (the only caller of a transport; the delivery log and its
                              rail), access.ts (a destination is the subject's own),
                              provider.ts (env → transport; unset is `console`, a wrong name
                              still throws)
src/lib/integrations/notify/  transport interface + a Slack Web API adapter that reads `ok`
                              rather than the HTTP status + a `console` transport that
                              composes the real message and delivers it to nobody
src/lib/schedule/             the job — nightly.ts (sweep → erase → carry, and whether it
                              ever ran), principal.ts (the second principal that is not an
                              Actor, and the first that erases)
src/app/api/cron/nightly/     POST from a scheduler: no org parameter, no GET, and a refusal
                              when no secret is set
src/app/(app)/settings/notifications/  where your alerts go, what ran the engines, and the
                              delivery log — the only Settings entry that is not admin-only
src/lib/dayof/                the day-of model — targets.ts and outbox.ts (pure, and the
                              first two modules in this product shipped to the *browser*:
                              an exact-after-normalisation match, and a queue that loses
                              nothing), snapshot.ts (one instant, and what stops being
                              claimable when it ages), access.ts (the screen is anybody's,
                              the target list is not), store.ts (one object in a fixed
                              number of queries; the queue drained through `captureLead`)
src/lib/leads/                capture — coverage.ts (pure: the count that says what it is
                              missing, and the withheld per-lead figure), consent.ts (pure:
                              a basis never defaulted, and erasure that keeps the count),
                              parse.ts (CSV + an import planner that loses no row),
                              dedupe.ts (identity within a show, never across),
                              alerts.ts (the sixth engine; its sharpest alert has no lead
                              row behind it), intake.ts (a principal that is not an Actor),
                              edit.ts, access.ts, store.ts
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
src/lib/flights/              tracking — status.ts (pure: freshness, the §7 arrival buffer
                              re-run against live times, a re-timing kept apart from a
                              delay), alerts.ts (pure: what is worth saying, keyed to the
                              standing not the estimate), board.ts, access.ts, provider.ts
                              (env → status provider, no fallback), store.ts (rows, the
                              sweep, and materializing a booking into an itinerary)
src/lib/assets/               capital and collateral — custody.ts (pure: the custody
                              chain, the three-refusal availability verdict, and where a
                              reservation window meets the freight), conflicts.ts (windows
                              not show dates; certain vs. possible), inventory.ts (on hand
                              vs. free, the three allocation states, the ledger
                              projection), alerts.ts (both dedupe-key shapes at once),
                              board.ts, access.ts, edit.ts, store.ts (rows, scoped through
                              the asset's own org, and the sweep)
src/lib/shipping/             freight — status.ts (pure: the two-edged receiving window,
                              the stall model, delivered-vs-received, the reconciler),
                              alerts.ts (pure, and the one alert with no row behind it),
                              board.ts, access.ts, edit.ts, provider.ts (env → tracking
                              provider, no fallback), store.ts (rows, the sweep, the
                              append-only timeline)
src/lib/integrations/flightstatus/  provider interface + AeroAPI adapter + `recorded` replay
src/lib/integrations/shipping/      provider interface + EasyPost adapter + `recorded` replay
src/lib/integrations/llm/     provider interface + Anthropic adapter (the first with no
                              hand-written wire schema) + a `scripted` model that replays
                              tool *plans* and never prose
src/lib/assistant/            the concierge — tools.ts (the access model: every tool is an
                              existing org-scoped store call as the asking actor),
                              access.ts (subtractive — a withheld tool is not described),
                              prompt.ts (tense, never access), loop.ts (a manual loop with
                              our own bounds), draft.ts (files unconfirmed, guesses no
                              zone, holds a provider that cannot fly), serialize.ts,
                              provider.ts (env → model, no fallback), store.ts (rows,
                              scoped to a *user*)
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
