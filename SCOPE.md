# Trade Show Concierge — Scope & Expectations

**Status:** draft for review · **Last updated:** 2026-08-30

An enterprise system for planning and executing a company's trade show calendar —
shows, readiness, people, lodging, and booth shipments — with live travel telemetry
and a **policy-governed booking agent** that purchases flights on a user's behalf
within admin-defined spend and schedule constraints.

Reference product: [ExhibitDay](https://www.exhibitday.com/) for the planning core.
The booking agent has no equivalent there; it is the differentiator and the hardest
part of this build.

---

## 1. North star

Three jobs, in priority order. Every feature earns its place against one of them.

1. **Cut the tedious work.** Booking flights, chasing confirmations, and re-keying
   tracking numbers should mostly stop happening. The agent (§6) exists for this.
2. **Be the single hub for the material things.** Where is the booth crate, who is
   flying when, which hotel, is the banner printed. One place, live, no spreadsheet.
3. **Answer "was it worth it?"** True cost against actual pipeline, per show — so next
   year's calendar is a decision, not a habit.

**The compounding insight:** because the app *does* the booking and *holds* the
shipping, it knows the true cost of a show without anyone assembling it. Most
companies cannot answer "what did Dreamforce actually cost us" without a week of
spreadsheet archaeology across expense reports, and they get it wrong. Here it is a
query. **That makes job 3 nearly free — but only because of jobs 1 and 2.** The
booking agent isn't just a convenience feature; it's what makes ROI trustworthy.

A corollary that should shape every screen: **for a Member, this app should be almost
invisible.** Submit a request, get a ticket, see your itinerary. If a booth staffer has
to be trained to use this, it has failed job 1.

---

## 2. Guiding decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Next.js 16 (App Router) + TypeScript | Server Components keep data access server-side; one deployable. |
| Database | Postgres via Drizzle ORM | Relational domain, typed schema, real migrations. |
| Local dev | **PGlite** (embedded Postgres, no Docker) | Clone-and-run. Same `pg-core` schema moves to hosted Postgres unchanged. |
| Auth | **Clerk — foundational, not deferred** | Roles gate spend authority. Per-org login-method control is an enterprise security-review blocker. See §3. |
| Hosting | Deferred until the core works | Nothing is wired to a cloud provider yet. |
| External APIs | Behind provider interfaces, off by default | Every integration has a `NotConfigured` state. The app runs with zero keys. |
| Agent decisions | **Deterministic policy engine, LLM only at the edges** | See §6. This is the most important call in the document. |
| Day-of experience | **Offline-first PWA, v1.5** | Show-floor wifi is genuinely unusable. Offline is an architecture decision, not a screen. §10 step 19. |
| Financial dimensions | **Cost centers from day one** | Retrofitting a cost dimension permanently orphans historical spend. §4. |

---

## 3. Roles & permissions

Three org-level roles. Show-level assignment is separate from role.

| Capability | Member | Travel Manager | Admin |
|---|:--:|:--:|:--:|
| See own shows, flights, lodging, itinerary | ✅ | ✅ | ✅ |
| Submit a travel request | ✅ | ✅ | ✅ |
| See *all* users' travel and shipments | — | ✅ | ✅ |
| Approve a request that exceeds policy | — | ✅ | ✅ |
| Set spend thresholds & travel policy | — | — | ✅ |
| Manage shows, budgets, org members | — | — | ✅ |
| View audit log of agent decisions | — | ✅ | ✅ |
| Manage cost centers & per-cost-center caps | — | — | ✅ |
| Restrict permitted login methods | — | — | ✅ |

**Separation of duties:** nobody approves their own over-policy request — a Travel
Manager's escalates to an Admin, and an Admin's needs a different Admin. This is an
ordinary enterprise-audit expectation and is far cheaper to build in now than to bolt on.

**Break-glass.** Strict separation deadlocks a one-admin org: their own over-policy
request would have no eligible approver and sit forever. So when *no* eligible approver
exists, the requester may self-approve — but only with a written justification, and the
audit record is flagged as a break-glass exception rather than a normal approval. The rule
stays real; it just never becomes a trap.

**Provider: Clerk.** Org support, roles, SSO/SAML, and — decisively — **per-org control
over which authentication strategies are permitted**. "Everyone signs in with Okta, no
passwords" is a hard blocker in enterprise security review, not a feature request.
Building that on Auth.js is a quarter of work that isn't our product.

**Clerk says who you are; this database says what you may do.** Role, org, and cost
center come from the `users` row, never from Clerk metadata — spend authority that can
be edited in another vendor's dashboard is spend authority outside our audit trail, and
the separation of duties above would fall to a `publicMetadata` edit. For the same
reason **signing in is not provisioning**: a verified session whose email matches no
`users` row is authenticated and has no access, and we never create the row on the way
past.

**What login-method control actually enforces (corrected at step 7).** The restriction
is enforced at *sign-in*, and we are not present at sign-in — Clerk is. Its session
carries no record of which strategy authenticated it: the Backend `Session` object holds
id, client, user, status, activity and an impersonation actor, and the token claims
carry `factorVerificationAge` but never the factor itself. What the Backend API does
expose is the set of credentials a user **holds** — `passwordEnabled`,
`externalAccounts`, `enterpriseAccounts`, `web3Wallets`. So our gate is a
**standing-credential check, not a sign-in-event check**: an SSO-only org refuses a
session the moment the account holds a password, whether or not it was used — which is
the case that matters, because a forbidden credential that exists is one that can be
used. Clerk's instance settings remain the primary control; `org_login_policies` is the
org's recorded, versioned intent and the input to our second gate. It fails closed: under
an allowlist, an account whose identities cannot be read is refused, never admitted.

**Impersonation** (admin support tool) lands post-v1, and only with three rules: the
session is banner-marked, every action logs *both* identities, and **impersonation can
never authorize a purchase or approve a travel request**. The separation-of-duties rule
above is worthless if an admin can simply become the approver.

**Cost centers** are an org-level dimension referenced by `expense`, `flight`,
`shipment`, `travel_request`, and `travel_policy`. Two reasons they can't wait: financial
data is the worst thing to retrofit (a year of reporting is permanently unattributed),
and because we spend money automatically, a purchase must land in a cost center *at the
moment of purchase*. It also lets §7 express "Sales Engineering gets a $650 domestic cap,
Executive gets $1,800."

---

## 4. Domain model

Implemented in `src/db/schema.ts`. The travel-request tables landed at steps 3–4 and
have since been corrected against real payload shapes and a working pipeline.

```
organization
 ├── user (role: member | travel_manager | admin)
 ├── cost_center           ← finance dimension on every dollar
 ├── org_login_policy      ← permitted sign-in methods, versioned, append-only
 ├── travel_policy         ← thresholds, versioned, optionally per cost center
 ├── asset                 ← booth, displays, furniture (capital)
 │    └── asset_reservation  (which show has it, chain of custody)
 ├── collateral_item       ← swag, print; qty on hand, low-stock threshold
 ├── ticket_credit         ← unused airline credit, with expiry
 ├── show
 │    ├── show_task          (readiness checklist, weighted, assignable)
 │    ├── show_deadline      ← service-manual deadline + penalty if missed
 │    ├── show_attendee      (who's going, role, arrive/depart)
 │    ├── booth_shift        ← rostered coverage by hour
 │    │    └── shift_presence  (who was *actually* there)
 │    ├── side_event         ← dinners, demos, seminars + RSVPs
 │    ├── lodging ─┬── lodging_guest
 │    ├── flight             (scheduled + live status; links to booking)
 │    ├── shipment ─┴── shipment_event
 │    ├── expense
 │    ├── lead               ← captured at the booth
 │    ├── meeting            ← on-site conversations
 │    └── show_outcome       ← pipeline & revenue attributed back
 ├── travel_request        ← user's constraints; the agent's input
 │    ├── policy_evaluation  (which rules passed/failed, at what version)
 │    ├── approval           (who approved, when, why)
 │    ├── offer_snapshot     (what the agent saw, immutably recorded)
 │    └── booking            (the order; one per request, ever)
 ├── agent_run             ← every decision, auditable
 └── alert                 (deduped disruption notices)
```

Modeling choices worth calling out:

- **`show.move_in_at` / `move_out_at`** bracket the show. Floors have hard receiving
  windows; a crate outside one incurs drayage penalties. Shipping deadlines derive
  from these, not from show dates.
- **`lodging.room_block_cutoff`** is first-class. Missing the room-block date is among
  the most common and expensive trade show mistakes.
- **`flight`** stores scheduled *and* live times separately, so "delayed 40 min" is a
  computed diff rather than a mutation that destroys the original plan.
- **`travel_policy` is versioned, never updated in place.** Every evaluation records
  the policy version it ran against, so an audit six months later can reconstruct
  exactly why a purchase was allowed.
- **`offer_snapshot`** stores the full fare the agent chose *and the ones it rejected*.
  Airline offers expire in minutes and vanish; without this, "why did it pick the
  $780 flight?" is unanswerable. **One row per offer *per search*, not per request**
  (corrected at step 4): a request that gets re-searched after its offer expired has
  two legitimate captures of the same itinerary, and the audit needs both.
- **`travel_policy` rows are layers, and null means inherit — on overrides only.** The
  org row is the base, where null is a real answer ("no hotel cap"). A cost-center or
  show override that leaves a column null simply does not speak to that rule. The
  asymmetry is deliberate: an override must be able to tighten or loosen a limit but
  never to *remove* one by omission, because absent must never quietly read as unlimited.
- **`agent_run` carries an explicit `sequence`, not just a timestamp.** Several steps of
  one agent run share a timestamp — the clock is injected so the pipeline is
  reproducible — and an audit log that cannot be put in order is not an audit log.
- **Cost is derived, never entered.** A show's true cost is a rollup of booth/space fees,
  every `flight.price_cents`, every `lodging` night, every `shipment.cost_cents`, and
  `expense` rows for the rest. Nobody assembles it. This is what makes §8 credible.
- **`lead` carries `crm_external_id`.** The CRM owns the truth about pipeline; we own
  the attribution link. We never try to become the CRM.
- **`show_deadline` carries a `penalty_estimate`.** A deadline without a dollar figure is
  a nag; one that says "$2,800 surcharge if missed" gets acted on. See §5a.
- **`booth_shift` and `shift_presence` are separate tables.** Rostered ≠ present. The gap
  between them is the staffing insight, and collapsing them into one destroys it.
- **`ticket_credit` expiry is per-airline**, not a single constant — carriers range from
  6 to 24 months. See §5b.
- **`asset_reservation` is a log, not a flag.** Who took the booth, when it came back, what
  condition — chain of custody, because capital assets get lost between shows.
- **Every financial row carries `cost_center_id`.** Set at creation, never inferred later.

---

## 5. Feature scope

### In scope — v1

| Area | What it does |
|---|---|
| **Show calendar** | Create/edit shows; venue, booth, budget, goals, move-in/out windows. **Clone a prior show** with its tasks, deadlines, and shipping plan — calendars are ~80% the same events yearly. |
| **Show intake** | "Should we do this show?" request → `prospect` status → commit or decline. Closes the ROI loop: last year's numbers argue for next year's calendar. |
| **Readiness** | Weighted checklist with categories, owners, due dates. 0–100 score per show, rolled up to a portfolio view. Templates seed ~25 standard tasks. |
| **Service deadlines** ⭐ | Exhibitor-manual deadlines with dollar penalties and escalating alerts. The highest-hard-dollar feature in the product. §5a. |
| **Team & shifts** | Attendees per show, roles, confirm/decline, arrival windows. **Booth shift coverage by hour**, plus actual presence vs. roster. Double-booking detection across overlapping shows. |
| **Side events** | Dinners, demos, seminars around the show, with RSVPs and guest lists. Often where the pipeline actually gets made. |
| **Assets & collateral** | Capital assets (booth, displays, furniture) with reservations and chain of custody; collateral inventory with low-stock alerts. Shares a model with shipping — "what's in the crate" is the same question. |
| **My itinerary** | Per-user view: my shows, my flights, my hotel, my requests. The Member's home screen. |
| **Lodging** | Hotel, confirmation, check-in/out, rate, room assignments, room-block cutoff warnings. Manually entered. |
| **Flight tracking** | Live status per flight. Delays, gate changes, cancellations surfaced against the show's move-in time. |
| **Travel requests** | User submits constraints; agent searches, books within policy or escalates. §6. |
| **Travel policy** | Admin sets spend ceilings, cabin caps, advance-booking windows, approval bands. Versioned. §7. |
| **Approvals** | Queue for Travel Managers. Approve/reject with reason, full offer context. |
| **Ticket credits** ⭐ | Ledger of unused airline credits with per-carrier expiry, expiry alerts, and automatic use by the agent before any new purchase. §5b. |
| **Cost centers** | Every dollar — flights, lodging, shipping, expenses — carries a cost center. Chargeback/showback reporting; per-cost-center spend caps. |
| **Shipping** | Outbound and return crates across UPS / USPS / FedEx from one screen, with event history and "will this land before move-in?" checks. |
| **Alerts** | One feed: delayed flight, stalled shipment, shipment missing move-in, room-block cutoff, overdue task, request awaiting approval. |
| **True cost** | Auto-rolled per show from flights, lodging, shipping, booth fees, **booth services** (electrical, carpet, AV, rigging, drayage, I&D labor), expenses. Actuals vs. budget, no spreadsheet. |
| **Lead & meeting capture** | Log leads and on-site meetings against a show. CSV import **and a REST intake endpoint** so any scanner can feed us; manual entry as the floor. |
| **ROI** | Cost vs. pipeline and closed revenue per show. Cost-per-lead, cost-per-meeting, **cost-per-impression**, pipeline multiple. Impressions and **forecast** revenue alongside actuals. Year-over-year and show-vs-show comparison. |
| **Audit log** | Every agent decision and approval, immutable, exportable. |

### Explicitly out of scope — v1

- **Slack interface** — the web request form is the v1 entry point. The agent is built
  behind an interface so Slack becomes a second adapter, not a rewrite. §6.
- Hotel *booking* (tracking only) · car rental · rail
- **Native mobile lead-capture app** — a product, not a feature: offline sync, two app
  stores, badge parsing, OCR. We integrate (CSV + REST) in v1 and revisit only if lead
  data quality proves to be the ROI bottleneck. §10 step 19 covers the day-of PWA instead.
- **Badge-scanner hardware integration** — vendors differ per show and most export CSV.
- **Becoming a CRM** — we read pipeline from Salesforce/HubSpot and write the show
  attribution back. Opportunities live there.
- **Virtual/hybrid event planning** — ExhibitDay covers it; it dilutes the physical-
  logistics thesis that is our actual advantage.
- Booth design tooling · vendor RFPs · organizer-side tooling (selling booth space)
- Expense reimbursement, receipts, approvals
- Native mobile apps (responsive web in v1; offline PWA in v1.5 — §10 step 19)
- Multi-currency conversion (currency stored, never converted)

### 5a. Service manual deadline engine

Every show publishes an **exhibitor service manual** — dozens of deadlines for electrical,
carpet, furniture, AV, rigging, labor, and warehouse cutoffs. The **advance order
deadline** typically lands **21–30 days before show open**. Miss it and every service
order is surcharged **25–40%**.

**On a $10,000 services order that is $2,500–$3,500 of pure avoidable waste, per show.**

Nobody in this market automates it; teams track it in a PDF and miss it routinely. We
model deadlines as a registry per show — type, date, penalty estimate, owner — driving
escalating alerts at T-30 / T-14 / T-3 / day-of.

**Post-v1 addition:** an LLM reads the manual PDF and extracts the deadline table. That
is exactly the unstructured-document work models are good at — and **a human confirms
every extracted deadline before it becomes an alert.** Same rule as §6a: the model
proposes, it never authorizes.

This is what makes the readiness score mean something concrete rather than being a
progress bar, and it is directly measurable: "we avoided $3,100 in late fees this quarter."

### 5b. Unused ticket credit recovery

**5–11% of corporate air spend is forfeited every year in expired flight credits**, and
54% of travel buyers name it as a pain point. Credits expire on different clocks per
carrier — roughly 6 to 24 months depending on the airline.

Trade show travel is unusually exposed: shows get cancelled, staffing changes late, and a
non-refundable ticket becomes a credit nobody remembers.

**Because we book the tickets, we already hold every credit.** The ledger tracks them with
per-carrier expiry rules, alerts before expiry, and — the real win — **the booking agent
checks the credit pool before purchasing anything new.**

Both 5a and 5b share one property: they are only possible because we *transact*. A
competitor can copy the UI and still cannot ship them.

**Correction from building it (step 6).** "Auto-apply credits before new spend" reads like
a ledger problem. It is not — it is a *redemption* problem, and the distinction changes
the feature:

- A credit is redeemed by the **carrier**, through whoever sells the ticket. Duffel can
  apply the credits it surfaces on an offer (`available_airline_credit_ids`); it cannot
  apply a credit that exists only as a row in our database, because it has no relationship
  to that ticket coupon.
- So every credit is one of two kinds. **Redeemable here** — we hold a provider id for it,
  the agent passes it at purchase, done. **Redeemable elsewhere** — real money, still ours,
  but it takes a person on the phone to the airline.
- The agent must never pretend to have applied the second kind. It **escalates** instead,
  and alerts the traveler and a travel manager *at the moment cash is about to be spent*,
  carrying the ticket number and record locator they will be asked for. That is why
  `credit_first` is an escalation rule and not a discount calculation.

Three further things the build settled:

- **The balance is derived, never assigned.** `ticket_credits.remaining_value_cents` is a
  cached projection of an append-only entry table. Nothing writes a balance; it appends a
  signed delta. A credit's balance is money, and money that can be silently overwritten
  cannot be audited.
- **Forfeiture is an entry, not a status.** Expiry writes off the remaining value as a
  negative entry rather than flipping a flag, because "how much did we lose to expiry last
  year" is the question that justifies this whole feature — and a status change alone
  leaves it unanswerable.
- **A hold costs the credit.** A credit attaches when an order is *created*; a held order
  was created before anyone approved it. So the hold taken in §6b to give an approver a
  real deadline is mutually exclusive with applying a credit to that itinerary. The agent
  records the trade rather than hiding it. Attaching the credit at hold time is the fix,
  once the provider's hold payload is confirmed against a live response.

---

## 6. The booking agent

The core loop: **user states constraints → agent finds an itinerary → policy engine
rules on it → agent buys it or escalates for approval.**

### 6a. The architecture call

> **An LLM must never be the thing that decides to spend money.**

Fare comparison against a spend ceiling and a time window is a *deterministic
constraint-satisfaction problem*. It is testable, explainable, and auditable. An LLM
doing it is none of those, and a hallucinated ceiling comparison is a real purchase
of a real ticket.

**The split:**

| Layer | Implementation | Why |
|---|---|---|
| Parse "I need to be in Vegas by Tuesday noon, back Thursday night" → structured constraints | **LLM** | Genuine natural-language work. Becomes essential for Slack. |
| Search offers | Duffel API | — |
| Rank & filter against constraints and policy | **Deterministic code** | Must be testable and reproducible. |
| Decide: auto-book / escalate / reject | **Deterministic policy engine** | Auditable. Never probabilistic. |
| Explain the decision in prose to the user | **LLM** | Presentation only; reads the decision, never makes it. |
| Execute the purchase | Duffel + idempotency key | — |

The LLM proposes and narrates. It never authorizes. Structured output is validated
against a Zod schema before it touches the policy engine, and the user confirms parsed
constraints before anything is searched.

### 6b. Request state machine

```
draft → submitted → searching → offers_found
                                    ├─ within policy ────→ booking → ticketed
                                    ├─ needs approval ──→ pending_approval ─┬→ approved → booking → ticketed
                                    │                                        ├→ searching (offer died; re-price)
                                    │                                        └→ rejected
                                    └─ no viable offer ─→ no_options (notify user, suggest relaxations)

any state → cancelled | failed | expired
no_options | expired | failed → searching   (relax a constraint and try again)
ticketed → change_requested → … | cancelled_refunded
```

**Correction from building it (step 4):** the earlier sketch had an `auto_approved`
state between `offers_found` and `booking`. There is no such state. Nothing waits in
it and nothing can observe it, and keeping it would have created a second, weaker
record of a fact the `policy_evaluation` row already holds. An auto-approved request
goes straight to `booking`. The machine is `src/lib/travel/machine.ts`; every write
passes through it, so an illegal transition throws where it happens rather than
surfacing later as a corrupt row.

`expired` is not an edge case. **Duffel offers expire in roughly 30 minutes.** If a
request sits in `pending_approval` overnight, the offer is dead and the agent must
re-search on approval — the approved *price* may no longer exist. The approval UI must
show this, and re-search-on-approval must re-run policy against the new fare. This
single detail is where most booking integrations break.

**What an approval actually authorizes** (settled at step 4): an *amount*, not an offer
id. Approving means "buy this trip, up to the price I signed off on." So when the offer
has died, the agent re-searches, re-runs policy on the new fare, and then compares:
at or below the approved price it books; above it, the request goes back into the queue
for a fresh decision rather than quietly charging the difference. A hold changes this
only where the fare was also guaranteed — a held-but-unguaranteed offer still has to
survive the re-price.

**Hold orders are the mitigation**, and Duffel names this exact use case. When an offer
carries `payment_requirements.requires_instant_payment: false`, we can create a `hold`
order that reserves the space without paying, giving the approver a real deadline
(`payment_required_by`) instead of a 30-minute fuse. Two caveats that shape the UI:

- **Not every carrier supports it.** Availability is per-offer, so the agent must check
  rather than assume, and ranking should mildly prefer a holdable offer when a request is
  likely to need approval.
- **A hold is not always a price lock.** `price_guarantee_expires_at` can be `null`,
  meaning the seat is held but the fare may still move. The approval screen must say which
  of the two it got, because approving a held-but-unguaranteed fare is approving an
  unknown number.

### 6c. Safety rails — non-negotiable

1. **Server-side hard ceiling**, enforced at the moment of purchase, independent of
   the agent's own reasoning. A second, dumber check that cannot be argued with.
2. **Idempotency key per request.** One ticket per travel request, ever. Retries,
   double-clicks, and crashed workers must not produce two tickets.
3. **Immutable audit record** of every decision: inputs, offers seen, policy version,
   outcome, actor.
4. **Dry-run mode** — full pipeline, no purchase. Default in every non-production
   environment. Production booking requires an explicit env flag.
5. **Kill switch** — an admin toggle halting all automated purchasing instantly.
6. **Every purchase notifies the traveler and a Travel Manager** at the moment of
   ticketing, not on a digest.

**How rails 4 and non-negotiable #1 coexist** (step 4): the spine must run end-to-end on
a clean clone with no API keys, and it must never serve invented data from behind a real
integration. Both hold, because the offers in a keyless run come from a separately named
`recorded` provider that replays captured wire payloads through the *production*
normalizer. It announces itself as `recorded` in every snapshot and booking row, stamps
`live: false`, and its `purchase()` throws unconditionally — there is no configuration of
it that can spend money. It is not a fake Duffel; Duffel with no key still refuses to do
anything at all.

**What step 5 established, building it:**

- **`live` on a booking is the provider's word, not ours.** A Duffel *test* key issues
  orders that look real in every respect and carry `live_mode: false`. Stamping those
  as live spend because we asked for a live purchase would quietly inflate every
  show's true cost — and the true-cost rollup is the thing the whole ROI story rests
  on. `PurchaseResult.liveMode` comes back from the provider and the booking row is
  stamped from it.
- **The hard ceiling has to be independent of the policy engine to be worth
  anything.** Rail 1 asks for a second, dumber check; a second check that re-reads the
  same resolved policy the agent read is not one. So there are two: the policy
  ceiling in the agent, and `FLIGHT_BOOKING_MAX_CENTS` inside the provider, which
  knows nothing about the request. Live booking without the latter is refused
  outright.
- **The kill switch halts dry runs too.** It looked like theatre — a dry run spends
  nothing — until the alternative was stated plainly: a rail that only changes
  behaviour when `FLIGHT_BOOKING_LIVE=true` gets its first real exercise during the
  incident it exists for. It also does not throw work away. A halted request is
  searched, judged, and queued as `pending_approval`, so resuming leaves a reviewable
  backlog instead of a hole.
- **`booking` needed an exit for failure.** Its only successors are `ticketed`,
  `failed`, and `cancelled`, and until live purchasing existed nothing ever wrote
  `failed` — a declined card would have left the request wedged. A purchase that
  throws now lands in `failed` with the idempotency key recorded in the trail, which
  is what a safe retry needs: reusing it means a lost response cannot become a second
  charge.
- **A ticket needs an identity we are not allowed to invent.** Airlines require a date
  of birth, and a plausible placeholder would be *accepted* and produce a real ticket
  in a name that does not match the traveler's passport. `passengerForUser` throws
  naming every missing field. The seed has one traveler with an incomplete profile on
  purpose, because half of any real directory looks like that.
- **An offer is a quote, not a price.** Both purchase paths re-read the fare from the
  provider immediately before paying and refuse if it moved, because the gap between
  "policy said yes" and "we paid" is exactly where a fare change would otherwise be
  paid silently.

### 6d. What buying tickets actually entails

The user has confirmed this is in scope. Setting expectations honestly:

- **Duffel** is the realistic self-serve path (NDC + GDS content, merchant of record
  via Duffel Payments). Amadeus Self-Service can search but ticketing needs a
  commercial agreement; Sabre and Travelport are enterprise-contract-only.
- Beyond the happy path, you own: **fare rules, ancillaries (bags/seats), the 24-hour
  void window, involuntary schedule changes, refunds, and exchanges.** Exchanges are
  the hardest — an exchange is a fare-difference calculation plus a new ticket, not an
  edit — and are where booking integrations go to die.
- **Compliance:** purchasing travel on others' behalf carries travel-seller disclosure
  obligations, and registration requirements in some US states. Worth a lawyer's hour
  before go-live, not after.
- **Corporate card handling** touches PCI scope. Duffel Payments keeps card data off
  our infrastructure — strongly recommend it over storing anything ourselves.

**Suggested sequencing within v1** (not a scope reduction — a de-risking order):
search and policy evaluation first with booking in dry-run, then enable live purchase
behind the flag once the policy engine has been exercised against real fares. This
gets the whole pipeline real without the first bug being a real ticket.

### 6e. Slack, later

The agent is invoked through a transport-agnostic interface:

```ts
submitTravelRequest(input: TravelRequestInput, actor: Actor): Promise<TravelRequest>
```

The web form is one caller. A Slack adapter parses a message into the same
`TravelRequestInput` and renders state changes as Slack blocks. **No agent logic moves**
when Slack arrives — which is the whole reason to define this boundary now.

---

## 7. Travel policy — what an admin can set

Versioned per org, with optional overrides **per cost center**, per show, and per role.
A rule set is resolved most-specific-first, and the resolved set is what gets recorded on
the evaluation — so an audit reads the exact rules applied, not the org defaults.

| Rule | Example |
|---|---|
| Max airfare, domestic / international | $650 / $1,800 |
| Approval bands | auto-book under $500 · approval $500–$1,200 · deny over $1,200 |
| Cabin ceiling | economy domestic; premium economy over 6h |
| Advance-booking window | must book ≥ 14 days out, else needs approval |
| Max hotel nightly rate | $300, by city tier |
| Refundability | non-refundable allowed under $400 |
| Carrier rules | preferred carriers; blocked carriers |
| Layover limits | max 1 stop; min 60 min connection |
| Arrival buffer | must land ≥ 4h before the show's move-in time |
| Per-show total travel budget | hard cap across all attendees |
| Per-cost-center caps | Sales Engineering $650 domestic; Executive $1,800 |
| Credit-first | must apply an eligible unused ticket credit before new spend (§5b) |

Evaluation returns a **structured verdict** — every rule with pass/fail and its margin
— not a boolean. That is what makes the approval screen useful ("$40 over the domestic
cap; everything else passes") and what makes the audit log defensible.

---

## 8. ROI — answering "was it worth it?"

The third north-star job. It works only because the rest of the app already holds the data.

### 8a. The cost side — free, and that's the point

True cost of a show is a **query**, not a data-entry exercise:

```
booth & space fees        (expense)
+ booth services          (electrical, carpet, AV, rigging, drayage, I&D labor)
+ travel                  (Σ flight.price_cents — known because we booked them)
+ lodging                 (Σ lodging nights × rate)
+ shipping                (Σ shipment.cost_cents — known because we tracked them)
+ collateral & everything else  (expense)
+ staff time              (attendee-days × loaded rate, optional)
= true cost
```

Most companies cannot produce this number without a week of spreadsheet work across
expense reports, and what they produce is wrong — it usually misses shipping entirely
and undercounts travel. **We get it for free.** That is the strongest argument for
this app existing.

### 8b. The return side — needs a CRM

Leads and meetings we can capture. Pipeline and revenue we cannot invent; they live in
Salesforce or HubSpot. The integration is deliberately narrow:

- **Read:** opportunities linked to leads we captured — stage, amount, close date.
- **Write:** a show attribution field back onto the lead/opportunity, so the CRM can
  answer the question too.
- **Never:** sync contacts, own the pipeline, or duplicate CRM objects.

**Attribution is the honest hard part.** A lead met at a booth in March that closes in
November had a dozen other touches. Two defensible models, and we should show both
rather than pick one and pretend:

| Model | Meaning |
|---|---|
| **Sourced** | The show created the lead — first touch. Conservative, defensible. |
| **Influenced** | The show touched an opportunity at any point. Generous, useful for shows that accelerate rather than originate. |

Pick a default (recommend *sourced* — it's the number a CFO will trust), report both,
and label the attribution window explicitly (recommend 180 days).

### 8c. The weakest link — lead data quality

Cost-per-lead is only as good as the lead count, and **the lead count is bad at most
companies, because reps don't log leads.** A booth staffer at hour six of day two does not
open a CRM.

This is the single biggest threat to the ROI story, and it is a behavioral problem, not a
technical one. Competitors address it with leaderboards and gamification — which looks
like a toy and is actually a fix for the real failure mode.

**If capture is incomplete, our ROI dashboard is *confidently wrong*, which is worse than
empty** — someone will cut a show over a bad number. Mitigations, in order of cost:

1. Show lead-capture *coverage* on the dashboard — "34 leads from 3 of 6 staff" — so a
   thin number is visibly thin rather than silently wrong.
2. Make manual entry take under ten seconds in the day-of PWA (§10 step 19).
3. Only then consider gamification.

### 8d. Metrics

| Metric | Why it earns a place |
|---|---|
| True cost | The foundation. Nobody else has it accurately. |
| Cost per lead / per meeting | Comparable across shows of different sizes. |
| Pipeline sourced & influenced | The number that justifies next year's budget. |
| Pipeline multiple (pipeline ÷ cost) | The single headline number. |
| Closed-won revenue attributed | Lags 6–12 months. Report it, but never as the *only* measure or every recent show looks like a failure. |
| Cost per attendee-day | Catches over-staffing, which is usually the second-largest line after booth space. |

### 8e. Expectation to set

**A show's ROI is not final for 6–12 months.** The dashboard must show cost and
pipeline immediately, then let revenue mature — with the attribution window and the
"as of" date visible on every figure. A show scored the week it ends will always look
like a loss, and that is a reporting artifact, not a finding.

---

## 9. Non-negotiables

1. **Runs offline.** `pnpm install && pnpm db:push && pnpm db:seed && pnpm dev` gives a
   populated, clickable app with zero API keys and zero cloud accounts.
2. **No fake data behind a real integration.** Missing key → "not configured," never an
   invented delay or fare. Seed data lives only in `scripts/seed.ts`.
3. **Original plan never overwritten by live data.** Scheduled times are immutable.
4. **Every external call is rate-budgeted and cached.** Refresh cadence is per-provider
   and scheduler-driven, never triggered by a page render.
5. **No purchase without a policy verdict recorded first.** No exceptions, no fast path.
6. **Every financial row carries a cost center at creation.** Never inferred, never
   backfilled.
7. **The day-of view works with no network.** Show-floor wifi is unusable and convention
   centers charge extortionately for wired drops. This is an architectural constraint on
   the §10 step 19 PWA, not a nice-to-have — it cannot be retrofitted onto server-rendered pages.
8. **Lead PII is handled as regulated data** — consent recorded at capture, retention
   limits, deletion honored. We hold personal data of people who are not our users, and
   the schema must reflect that from the first row.

---

## 10. Build order

**Vertical slice through the spine first.** Steps 1–6 of the earlier plan were CRUD with
no unknowns in them; steps 7–11 hold every real risk in this project. The travel-request
table definitions in §4 were written from reasoning, not from a real Duffel payload — they
are wrong in some way we cannot yet see, and building six steps of UI on top of them buys
weeks of rework.

Two properties drive this order:

- **The riskiest component is also the fastest to iterate on.** The policy engine is pure
  functions — constraints + offers + policy → verdict — testable with zero API keys, zero
  network, and zero browser. That alignment is rare and worth exploiting.
- **Seed data beats CRUD forms early.** A realistic seed makes every later step testable
  and defers form-building until we know what the forms must contain.

**Accepted cost:** there is nothing to demo for the first several steps. The early output
is a test suite and a seed script, not screens. If a stakeholder demo is needed sooner,
invert phases A and C.

### Phase A — foundation & the spine

- [x] **0.** Next.js + Tailwind scaffold, initial Drizzle schema
- [x] **1.** PGlite, migrations, `getActor()` seam, cost centers & roles, realistic seed
- [x] **2.** **Policy engine** — pure functions, versioned rules, resolved most-specific-first,
      structured verdicts, 47 unit tests. No UI, no DB dependency.
- [x] **3.** **Duffel adapter** written against the published v2 schema; `travel_request` /
      `offer_snapshot` / `policy_evaluation` / `approval` / `booking` / `agent_run` schema
      corrected from real payload shapes. Live test-key run still pending.
- [x] **4.** Travel request state machine + **dry-run booking end-to-end**, headless and
      script-driven. Idempotency, offer expiry, re-search-on-approval. Added a
      `travel_policies` table (the engine had rules but nowhere to read them from),
      a DB-backed layer resolver, and the `recorded` provider that replays captured
      wire payloads through the production normalizer so the spine runs with no keys.
      `pnpm booking:dry-run` walks all four outcomes. 131 tests.
- [x] **5.** **Live purchase behind the flag**, kill switch, audit trail surfaced.
      `DuffelProvider.purchase()` implemented for both paths — an instant order, and
      a payment against an existing hold — each re-reading the price from Duffel
      immediately beforehand and refusing a fare that moved. Added an env-level hard
      ceiling the adapter *requires* before it will buy at all, a DB-backed org kill
      switch (`booking_controls`, append-only), traveler passenger identity that
      fails loudly rather than defaulting, a `failed` landing place for a purchase
      that throws, ticketing notifications, and `pnpm booking:audit`. 155 tests.
- [x] **6.** **Ticket credit ledger** (§5b) — expiry alerts, applied before new spend.
      Added `ticket_credit_entries` (append-only, signed) with `ticket_credits`
      demoted to a cached projection of it; per-offer credit matching (carrier,
      currency, expiry, one credit per ticket, redeemable-here preferred);
      settlement from the *provider's* reported figure rather than our intent;
      release on cancellation; a bucketed expiry sweep and alerts; and
      `pnpm credits`. The correction folded back into §5b above — a credit we
      hold is not a credit we can spend — reshaped the feature: the agent
      escalates on unreachable credit instead of silently paying cash.
      205 tests.

### Phase B — the planning core, built knowing what the spine needs

- [x] **7.** **Clerk wired to the `getActor()` seam** · login-method control · app shell.
      The seam now reads a Clerk session when both keys are present and
      `DEV_ACTOR_EMAIL` when they are not — and the switch is one-way, so a
      configured deployment has no dev backdoor. Added `org_login_policies`
      (versioned, append-only, a written reason required in both directions), the
      pure gate in `lib/auth/login-methods.ts`, a first app shell that shows on
      every page who the server thinks you are and how it decided, and the admin
      screen at `/settings/security`. The correction is folded into §3 below:
      Clerk's session does not record *which* method signed it in, so our gate is
      a standing-credential check, not a sign-in-event check. 231 tests.
- [ ] **8.** Show list · show detail tabs · My Itinerary · cloning · intake
- [ ] **9.** Travel request UI + approvals queue (the UI for steps 4–5)
- [ ] **10.** Readiness — checklist CRUD, templates, scoring, portfolio rollup
- [ ] **11.** **Service manual deadline engine** (§5a) — registry, penalties, escalating alerts
- [ ] **12.** Team & lodging — attendees, booth shifts, conflicts, hotels, room blocks, side events

### Phase C — logistics, telemetry & ROI

- [ ] **13.** Flight tracking — status provider, flight board, delay alerts
- [ ] **14.** Shipping — EasyPost adapter, tracking, event timeline
- [ ] **15.** Assets & collateral inventory, reservations, chain of custody
- [ ] **16.** Alerts feed · **true-cost rollup** (nearly free once 12, 14 land)
- [ ] **17.** Leads & meetings — CSV import, REST intake endpoint, GDPR posture
- [ ] **18.** CRM read/write adapter, attribution, ROI dashboard with coverage indicators

### Phase D — v1.5 and beyond

- [ ] **19.** Offline day-of PWA — my shift, booth, crate status, fast lead/meeting entry,
      target-company alerts
- [ ] **20.** Slack adapter · hosting · SSO rollout
- [ ] **21.** Backlog: duty of care · sponsorship campaigns · drayage estimator · public
      API + Zapier · impersonation (§3 rules) · multi-workspace · custom fields · external
      share links · room-block optimizer · gamification · LLM deadline extraction

### A correction to §2 and §3

Those sections call auth "foundational, not deferred." That is half right and was
overstated. What is foundational is the **data model** — roles, cost centers, and a
server-side `getActor()` seam that every query passes through. Those land in step 1.
Wiring Clerk to real sign-in is a swap *behind* that seam and waits until step 7. We get
the benefit of the model without the setup cost blocking the spine.

---

## 11. Open decisions — need your call

1. **Who pays the airline?** Duffel Payments (recommended — keeps card data out of our
   PCI scope) vs. a corporate card we hold vs. per-user cards. Changes §6d materially.
2. ~~**Auth provider**~~ — **resolved: Clerk.** Per-org login-method control decided it.
   Partly settled at step 7: the *policy* half is built and provider-agnostic, and
   enabling a SAML/OIDC connection is Clerk configuration rather than our code, so
   SSO needs no further build here. What still waits for step 20 is the rollout —
   a real IdP connection, and the domain-to-org mapping that goes with it.
3. **Approval routing:** single Travel Manager queue for the org, or per-department
   approvers? Recommending a single queue for v1; per-department is a schema addition
   that's cheap now and expensive later if wrong.
4. **Hotels:** tracking-only in v1 as scoped, or does the agent book those too? Hotel
   booking is a separate provider integration and roughly doubles §6.
5. **Scale:** how many travelers and shows per year? Under ~50 travelers, some of the
   policy machinery can be simpler. Above a few hundred, background job durability
   needs real attention at step 4, not step 20.
6. **Which CRM?** Salesforce and HubSpot are different enough that I'd build one well
   rather than both adequately. This gates step 18.
7. **Attribution default:** sourced (recommended) or influenced? And what window —
   90, 180, or 365 days? Changes what every ROI number means.
8. **Is staff time in the cost?** Including attendee-days × a loaded rate usually
   doubles the true cost of a show and is the honest number. Some organizations find
   that unwelcome. Your call whether it's on by default, optional, or absent.
9. **Pricing model.** ExhibitDay is per-seat ($99–199/mo); Trade Show PRO is **per event**
   (€990, unlimited users). Per-event matches how trade show budgets actually work —
   budgeted individually, often by different owners — and sidesteps the "we only do four
   shows a year" objection. Recommending a hybrid: platform subscription for the always-on
   travel/planning spine, plus a per-show fee where the value concentrates. Not urgent, but
   it shapes what "workspace" means in the data model.
10. **Data residency.** Lead PII plus EU shows may require EU hosting. Competitors lead
    with it. Decide before step 17, since it constrains hosting at step 20.
