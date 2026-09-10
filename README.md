# Trade Show Concierge

Enterprise trade show management — shows, readiness, deadlines, people, travel, lodging,
freight, leads and ROI — built around a **policy-governed agent that buys plane tickets**
inside admin-defined spend and schedule constraints.

```bash
pnpm install && pnpm db:reset && pnpm booking:dry-run
```

No API keys. No cloud accounts. No Docker. The whole booking pipeline runs on a clean
clone in about three seconds, and so does everything else in this README.

The planning side is a known quantity; [ExhibitDay](https://www.exhibitday.com/) and
others do it well. Two things here are not: **an agent that actually spends money inside
a policy**, and **a set of numbers that refuse to lie to you**. The second one turns out
to be most of the work.

---

## Contents

- [The idea](#the-idea) · [The architecture call](#the-architecture-call) · [Watch it run](#watch-it-run)
- [The safety rails](#the-safety-rails)
- **[What it does](#what-it-does)** — the full feature surface
- [What every number refuses to say](#what-every-number-refuses-to-say)
- [Correctness primitives](#correctness-primitives) · [The command line](#the-command-line)
- [Integrations, and which have met a live key](#integrations-and-which-have-met-a-live-key)
- [Deliberately not built](#deliberately-not-built) · [Layout](#layout) · [Try it](#try-it)

---

## The idea

Three jobs, in priority order:

1. **Cut the tedious work.** Booking flights, chasing confirmations and re-keying
   tracking numbers should mostly stop happening.
2. **Be the single hub for the material things.** Where is the booth crate, who flies
   when, which hotel, is the banner printed, who is on the stand at 2pm.
3. **Answer "was it worth it?"** True cost against actual pipeline, per show.

The third falls out of the first two for free. Most companies cannot answer *what did
that show actually cost us* without a week of spreadsheet archaeology, and they get it
wrong. Because this system **does** the booking and **holds** the freight, the number is
a query.

That is why the booking spine got built before a single screen.

---

## The architecture call

> **An LLM must never be the thing that decides to spend money.**

Comparing a fare against a spend ceiling and a time window is a deterministic
constraint-satisfaction problem. It is testable, explainable and auditable. An LLM doing
it is none of those, and a hallucinated ceiling comparison is a real charge on a real
card.

| Layer | Implementation |
|---|---|
| Parse *"Vegas by Tuesday noon, back Thursday night"* → constraints | **LLM** |
| Search offers | Provider API (Duffel) |
| Rank and filter against constraints and policy | **Deterministic code** |
| Decide: auto-book / escalate / reject | **Deterministic policy engine** |
| Explain the decision in prose | **LLM** |
| Execute the purchase | Provider + idempotency key |

The LLM proposes and narrates. It never authorizes. A human confirms the parsed
constraints before anything is searched, because an unreviewed misparse must never be
laundered into an authorized purchase.

---

## Watch it run

`pnpm booking:dry-run` walks the whole loop against seeded data — nine scenarios, no
keys, no purchases.

```
━━ 1. Within policy → booked without asking anyone ━━

    ▸ off_00009htYpSCXrwaB9DnUm0     $430.55  0 stop  economy          auto_approve
      off_00009htYpSCXrwaB9DnHold    $612.00  0 stop  premium_economy  needs_approval  approval_band, fare_ceiling
      off_00009htYpSCXrwaB9DnCon     $318.20  1 stop  economy          deny            departure_window, connection_time

    submit          submitted                  priya@ opened a request: SFO → DTW
    search          ·                          3 offer(s); best at $430.55 → auto_approve
    ticketed        booking → ticketed         No money moved.
```

The cheapest fare lost: a 55-minute connection against a 60-minute policy minimum, so it
was denied outright rather than quietly chosen on price. **Policy says what is allowed;
ranking says what is best among the allowed.** Conflating the two is how a booking agent
ends up justifying a bad itinerary.

Then the hard case:

```
━━ 2. Over the auto-approve band → escalated, offer dies, re-priced on approval ━━

    escalate           offers_found → pending_approval  $1,284.90 is above the $1,200 threshold
    approval           ·                                shelley@ approved up to $1284.90 — offer expired, re-searching
    reprice_accepted   ·                                Re-priced at $1284.90, within the approved $1284.90
```

**Airline offers expire in about thirty minutes. Approval queues live overnight.** This
is where most booking integrations break, and it is not a bug about expiry — it is a
question about meaning. What did the approver authorize?

The answer this system commits to: **an approval authorizes an amount, not an offer.** On
approval the agent re-searches, re-runs policy and compares. At or below the approved
price it books; above it, the request goes back to the queue rather than quietly charging
the difference.

---

## The safety rails

Non-negotiable, and each earns its place:

- **A server-side hard ceiling at the moment of purchase**, checked against the resolved
  policy rather than trusted from the verdict that got the request that far.
- **One ticket per request, ever** — a unique index, not good intentions. Every state
  transition updates `where status = <expected>`, so the status column is the lock: two
  workers, a double-clicked button and a retried job all lose the race gracefully.
- **No purchase without a policy verdict recorded first.** No fast path.
- **Dry run by default.** Live purchasing needs an explicit env flag, a configured real
  provider *and* a spend ceiling the adapter cannot raise. Dry-run bookings are stamped
  `live: false` with a `dryrun:`-prefixed order id.
- **`booking.live` comes from the provider, never from our intent.** A test key issues
  real-looking orders with `live_mode: false`; recording those as spend would corrupt the
  cost rollup.
- **Separation of duties.** Nobody approves their own over-policy request. Where no
  eligible approver exists, the requester may self-approve with a written justification,
  recorded as a flagged break-glass exception — the rule stays real without becoming a
  trap.
- **An immutable audit trail.** Every offer the agent saw, the resolved rule set as
  applied, every decision in order. Offers vanish from the provider within the hour, so
  without a snapshot *"why did it pick the $612 fare?"* is permanently unanswerable.
- **A traveler's identity is never defaulted.** No date of birth means no ticket and an
  error naming the missing fields — a plausible placeholder buys a real ticket that fails
  at the gate.

---

## What it does

Ten tabs per show, 39 routes, 23 navigation entries, seven alert engines and a CLI for
every one of them. Everything below is built and runs with no keys.

### Shows and planning
Propose, commit or decline a show with a written reason — **declines are kept**, because
they are the half that argues with next year's calendar. Clone a show into next year with
a plan of what carries and what deliberately does not: cloned deadlines arrive
unconfirmed, attendees are re-invited, and shipments, flights, lodging and the booth
number do not come at all. Dates shift on the local calendar, not by elapsed
milliseconds.

### Readiness and the deadline engine — the differentiator
A checklist with a **breakdown rather than a number**, and `null` for a show nobody has
planned: an empty checklist is *unplanned*, never 0% and never 100%. Built-in templates
(25-task standard, 8-task tabletop) apply idempotently and create already-late tasks
rather than hiding them.

The **service-manual deadline register** is the feature this product exists for. Exhibitor
manuals bury dates with real money behind them — advance-order discounts, drayage cutoffs,
electrical, rigging — and missing one costs a percentage. The engine escalates at T-30,
T-14, T-3 and day-of, chases confirmation from 45 days out, addresses each alert to a
specific person, and **writes it in the right tense**: past its date a penalty is
*incurred*, not *at risk*, and the audience changes from the owner to whoever runs the
show. A date nobody has confirmed against this year's manual is chased as a **date** and
never quoted as an amount.

**Read the manual with an LLM** (`pnpm manual`): a PDF becomes numbered pages of plain
text *here*, and only the text goes to the model — so every extracted deadline cites a
page and a verbatim quote that is checked against text we hold before anybody sees it. A
snippet that is not on the page it cites never becomes a row. A penalty figure must appear
**inside** the verified quote or it is dropped.

### Travel
Request a trip (a form, or free text the assistant parses), watch the agent price it
against policy, approve what exceeds it. Per-show and personal travel views, an approvals
queue, and the full agent decision log rendered as a page. **Ticket credits** from
cancellations are a ledger — the balance is a projection of append-only entries, expiry
writes the loss off as an entry, and credit-first purchasing is policy-controlled.
Traveler profiles carry a home airport (prefilled, never re-derived), loyalty numbers sent
at search *and* order, and carrier preferences that **rank but never rule** — priced by an
admin in absolute cents, all-or-nothing across the carriers flown, clamped so no allowance
can cross a decision tier.

### Flight tracking
Booked legs materialize into an itinerary. The tracker re-runs the arrival-buffer rule
against live times and **only speaks when a flight that cleared the buffer stops clearing
it** — a delay is not news; a delay that costs somebody their move-in is. A carrier
re-timing a flight is kept apart from a delay and never touches the scheduled columns. An
unchecked flight is not an on-time flight: staleness is judged against the flight's own
timeline, and a lookup that found no record patches nothing.

### Logistics — freight, drayage, assets, collateral
**Crates have a window, not a deadline**, and early is a failure too: an advance warehouse
closes on a published cutoff, show-site receiving does not open until move-in, and
anything arriving before a staffed dock is refused or stored at the carrier's rate — an
outcome every carrier payload calls `delivered`. **Delivered is the carrier's word;
received is a person's**, and confirming a crate reached the booth is open to anybody.
Silence is the failure mode and no status field reports it, so the *absence* of scans is
what raises a stall.

**Drayage** is the largest silent line in a show budget — everything after the dock, billed
off a rate card in that show's own manual, often more than the freight itself. The
estimator does hundredweight with the card's minimum and **rounds per shipment, never in
aggregate** (summing first bills 25% light). No rate card, no number.

**Assets** carry a seven-state custody chain, reservation-window conflict detection (not
show dates — a booth is gone for a month around a three-day show), and condition recorded
at both ends. **Collateral** is an append-only ledger where on-hand is a projection and
low stock is judged on what is *free*.

### People
Staffing, booth shifts and coverage that distinguishes **assigned from staffed from
present**: a shift can be fully rostered and still short once travel windows are read, and
that case is flagged *overstated* because nobody would have gone looking. Only the person
confirms their own attendance — a status typed on somebody's behalf lands as `secondhand`,
visible and uncounted. Cross-show double-booking is compared on travel windows, marked
`possible` where a window had to be guessed. Hotels, room assignments, and a room-block
cutoff that owns a register row rather than getting a second clock.

**Duty of care** turns badge scans, flights, hotel stays and travel windows into a
standing with what it rests on and how old it is. **Presence never answers for safety**:
the person who badged in twelve minutes ago is who you most need to hear from about a 10am
incident, so presence decides who to call *first* and only an answer closes a name. No
timeout turns silence into assent, and there is no bulk "mark everyone safe".

### Leads and meetings
Capture at the booth, import a scanner CSV, or POST through a show-scoped intake key (a
retry is answered as a success, not a 409). **A count that does not say who did not
capture is a fabricated bill**: it is introduced with "at least" whenever anybody rostered
on a shift recorded nothing, and the silent people are named. Duplicates are identified
within a show only, and name-plus-company is a *suspicion* surfaced for a person to settle
rather than auto-merged. GDPR consent is a recorded answer, never manufactured from an
absent column; **erasure is redaction**, because erasing the person must not erase the
count.

### Day-of — an offline PWA
Installs to a phone, starts at `/day-of`, and works with no signal: your shift, the booth,
the crates, target accounts and lead capture. Captures queue on the device — **every item
accounted for, a rejected one kept and marked rather than retried forever** — and drain
through the *real* `captureLead`, as the person who typed it. Target matching is exact
after stripping legal suffixes and **never fuzzy**, because the failure is telling a
stranger their company is one you came for. A cached screen says how old it is and stops
making present-tense claims past forty-five minutes.

### Money and ROI
True cost per show across booth space, travel, lodging, freight, drayage, collateral and
staff time — where **a total is only called a total when nothing is missing**, and
otherwise it is "at least", with the silent lines named. A dry run is not spend, a credit
is not a discount, consumption is not an outlay, and committed is not paid.

ROI matches leads to a CRM and attributes pipeline with **first touch decided across the
whole calendar**, never within a show — the naive version hands every recurring buyer to
whichever show met them most recently, annually, silently and flatteringly. Two floors in
a quotient do not cancel, so a figure over an undercounted numerator *and* an
under-recorded denominator is withheld rather than caveated. A show inside the 6–12 month
maturity horizon reports its figures and withholds its verdict.

### Alerts, notifications and the nightly job
**Seven engines** — deadlines, flights, freight, assets, leads, ROI and ticket credits —
write to one feed where each row reports which of five things it has become: new,
repeating, unchecked, acknowledged, resolved. Only a sweep resolves an alert; a person only
ever says they have seen it. There is **no org-wide alert read, including for an admin**,
because every engine already decided its audience.

A nightly job sweeps, erases what is past its retention date, then carries what is owed to
a transport. Notifications go to a destination the **subject** sets, never an admin, and
the transport refuses five ways before interrupting anybody.

### The assistant
Ask about your shows and trips in plain language. **The access model is the tool list, not
the prompt**: 21 tools, every one an existing org-scoped store function called as the
asking actor through the same gate a screen goes through. "Which room is Shelley in" is
refused because the query was narrowed before the model saw anything — the row is never
retrieved, so there is nothing to leak and no rule for an injected instruction to override.
A tool the actor may not hold is never described. It drafts a travel request and stops:
filing without a human confirming the parse is the one thing it cannot do.

### The executive brief
`pnpm deck <show id>`, or a Download link on any show: a PowerPoint for a leadership
audience — last year's results, this year's dates and committed spend, who is going, what
you are going for, where preparation stands, and a closing *what this brief does not know*.
**A deck is the artifact that leaves the building**, so every hedge is louder than on
screen: "at least" and the named gaps sit on the same slide as the number, a withheld
figure prints its refusal where the number would be, and last year is the show you actually
cloned from — never a name match.

---

## What every number refuses to say

This is the part that took the most work and is easiest to miss.

Every figure in this product is built to say what it is missing, because the alternative
is a confident wrong number that somebody cancels a show over:

- An **empty checklist** is *unplanned* — never 0% (reads as behind) and never 100%.
- A **cost** with a silent line is "at least", and the silent line is named. A show with
  no booth-space figure is not a cheap show.
- A **lead count** says "at least" and names who has not entered theirs.
- **Cost per lead** over a thin count is **withheld, never caveated** — the error runs
  high, which reads as a bad show.
- A **deadline** nobody confirmed is chased as a date; its penalty is never quoted.
- A **drayage estimate** never joins the cost total, because nobody has been billed it.
- **Pipeline** with no CRM connected prints the refusal, not `$0`.
- An **unchecked flight** is not an on-time flight; an **unrun sweep** is not a quiet
  night; **unknown** is not absent.
- **Withheld** (us refusing to transmit a lead) and **unmatched** (the CRM not knowing
  them) are never added and never described in one sentence.

---

## Correctness primitives

Three classes of bug are expensive enough to be designed out rather than tested for:

**Money is integer cents.** Providers send decimal strings; `parseFloat("430.55")` is a
reconciliation dispute waiting to happen. Parsing goes through `src/lib/money/decimal.ts`.

**Flight times are local airport time.** Segment times arrive with no offset. Read a
4h50m transcontinental flight as UTC and it measures 7h50m, quietly tripping every
duration rule. Resolution goes through `src/lib/datetime/zoned.ts` — and form inputs go
through `zonedDateInput`, because `toISOString().slice(0,10)` on a 5pm-Pacific date
returns *tomorrow*. That bug was found six times in this repo.

**Scheduled times are immutable.** Live and estimated times live in separate columns, so
"delayed 40 minutes" is a computed difference rather than a mutation that destroys the
plan a ticket was approved against.

---

## The command line

Every feature has a CLI, and reading its output is how most of the real defects in this
repo were found — none of them by a test, because in each case the test had been written
to the same wrong rule.

```bash
pnpm booking:dry-run          # the whole booking loop, headless, no keys
pnpm booking:audit <id>       # the audit trail for one request
pnpm credits [--sweep]        # credit exposure, one ledger, or write off what expired
pnpm deadlines [--sweep]      # the register, its exposure, and tonight's alerts
pnpm manual <show> <file.pdf> # read a service manual into the register, unconfirmed
pnpm manual:probe <file.pdf>  # what a stupid date sweep found that the extractor did not
pnpm roster | rollcall        # booth coverage · duty of care
pnpm flights [--sync]         # every tracked leg, worst first
pnpm shipping [--sync]        # every crate, worst first
pnpm assets [--sweep]         # register, clashes, shelf vs. what is free
pnpm drayage                  # every show's drayage, and what it is missing
pnpm cost | leads | roi       # true cost · capture coverage · cost against pipeline
pnpm alerts [--as <email>]    # what one person is owed — the access model, not a filter
pnpm nightly [--dry]          # sweep, erase, carry; --dry prints messages and sends none
pnpm day-of <show>            # the offline snapshot, exactly as a device holds it
pnpm deck <show> [--out f]    # the executive brief, as an outline then a .pptx
pnpm assistant "..."          # ask the concierge; prints every tool that ran
pnpm smoke                    # fetch all 39 routes; 200 + expected text
pnpm test | typecheck | lint  # 1,176 tests; no keys, no network, no browser
```

---

## Integrations, and which have met a live key

Honesty about this is part of the design. Each adapter sits behind an interface with a
`recorded` sibling that replays captured payloads through the **production** normalizer —
never a fake that invents data.

| Integration | Used for | Live key? |
|---|---|---|
| **Duffel** | flight search, hold, purchase | ❌ never — capture script ready |
| **Anthropic** (assistant) | parsing requests, narrating verdicts | ✅ |
| **Anthropic** (extraction) | reading service manuals | ✅ |
| **AeroAPI** | flight status | ❌ never |
| **EasyPost** | shipment tracking | ❌ never |
| **Salesforce** | CRM matching and attribution | ❌ never — capture script ready |
| **HubSpot** | CRM | declared; every method throws |
| **Slack** | notifications | ❌ never — `console` transport is the default |
| **Clerk** | authentication | ❌ never — `pnpm clerk:verify` ready |

The four marked "never" are written to published schemas and tested against fixtures we
wrote ourselves — a closed loop that proves internal consistency and **structurally cannot
catch a wrong field name**. `pnpm duffel:capture`, `pnpm salesforce:capture` and
`pnpm clerk:verify` exist to break that loop against a real account, and each names the
open questions it would answer.

**A provider is never chosen by falling back.** Duffel with a key, `recorded` only when an
env var says so explicitly, otherwise an error naming the variable. A screen quietly
serving replayed offers is indistinguishable there from real availability.

---

## Deliberately not built

- **Nothing rebooks a cancelled flight**, and the alert says so — the ticket is with the
  airline, so it is a phone call.
- **Cancelling does not tell the airline.** The UI says so on a ticketed request rather
  than implying the ticket is gone.
- **No hotel or car booking.** Hotels are recorded, not booked.
- **The day-of outbox has no background sync.** It goes up when the tab is open and the
  network returns, which is why the count says "on this device" rather than "pending".
- **No `recorded` Slack transport and no seeded extraction.** A replayed *delivery* is a
  claim somebody's phone buzzed; a seeded extraction is a claim about a document nothing
  read. Both are refusals, not gaps.
- **Hosting, SSO and a real scheduler.** Each needs a cloud account, and wiring one
  unasked is against the ground rules. `UX-BACKLOG.md` and `SCOPE.md` §11 hold the rest.

---

## Layout

```
src/db/schema.ts        55 tables, the domain model
src/app/(app)/          the screens; never prerendered, resolved per actor
src/lib/policy/         the decision layer — pure, deterministic, 65 tests
src/lib/travel/         the spine — state machine, agent, credits, audit trail
src/lib/deadlines/      the service-manual engine · manual/ reads the PDF
src/lib/{shipping,drayage,assets,team,lodging,flights}/
src/lib/{leads,roi,cost,alerts,notify,safety,dayof,deck}/
src/lib/integrations/   every third party, behind an interface with a recorded sibling
src/lib/auth/           the seam — getActor(), Clerk adapter, login-method control
scripts/seed.ts         the only place seed data lives
```

Every module is the same split: **pure decisions in one file, rows in another.** The pure
half is where the arguments live and where the tests are.

---

## Try it

```bash
pnpm install
pnpm db:reset          # embedded Postgres (PGlite), schema push, realistic seed
pnpm booking:dry-run   # the whole booking loop, headless
pnpm dev               # the app, on the dev seam, with no accounts
pnpm test              # 1,176 tests; no keys, no network, no browser
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user when Clerk is not configured.
Seeded roles: `shelley@` admin, `marcus@` travel manager, `priya@` member — try the same
screen as each; the results differ because the access model is real. Set both Clerk keys
and the same seam serves real sessions and **stops consulting `DEV_ACTOR_EMAIL`
entirely**, because a dev fallback that survives into a configured deployment is a back
door.

Three screens make a non-seeded org usable at all: `/settings/travel-policy`,
`/settings/cost-centers` and `/settings/profile`. The overview says so until they are done.

> **Two rules worth knowing before you run anything.** Restart `pnpm dev` after
> `pnpm db:reset` — a running server holds the deleted database and will serve it back to
> you with no error. And never run `pnpm dev` and `pnpm test` against the same `.pglite`;
> they corrupt it, and every DB test then fails naming nothing.

---

**Further reading:** `SCOPE.md` is the contract · `CLAUDE.md` is the ground rules ·
`UI-REWORK.md` and `UX-BACKLOG.md` are the app layer · `git log` is the reasoning record,
and every commit explains what was learned rather than what changed.
