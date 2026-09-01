# Trade Show Concierge — Scope & Expectations

**Status:** draft for review · **Last updated:** 2026-08-31

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
| Day-of experience | **Offline-first PWA, v1.5** | Show-floor wifi is genuinely unusable. Offline is an architecture decision, not a screen. §10 step 20. |
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

**What "see all users' travel" does not settle** — added at step 18. Leads are personal
data about people who are not our users and never agreed to anything with us (§9.8), so the
question is not the one §3's table answers. It splits: a lead **count** is everybody's,
because it is the show's scoreboard and §8c's whole mitigation is that a thin number is
visible to the person who could fix it; the **personal detail** is narrowed to whoever
captured it plus the approvers, in the query rather than in the markup. Capturing is
anybody's — gating it produces §8c's bad count by construction — and erasing is not, because
it is irreversible. Issuing an **intake key** sits one bar higher again, with Admin, because
a key writes into this workspace from outside every gate above: it is authentication, not
data. §5j.

**Where this is enforced, as of step 9:** in the query, in `src/lib/travel/queue.ts` and
`src/lib/shows/store.ts`. A Member asking the travel list for the whole org gets
themselves — `scope: 'all'` is a request, not an authorization — and a Member loading a
colleague's request by id gets *not found* rather than *forbidden*, because "forbidden"
would confirm that a colleague is flying somewhere. The approvals queue deliberately
still lists a Travel Manager's *own* pending request, with the reason it is not theirs to
sign, so the queue cannot quietly disagree with the request's own page.

**What "see own shows" actually scopes** — corrected at step 8. The table above draws
its line around *travel*, not around shows, and reading it as "a Member may only see
shows they are staffed on" is the wrong split: the show calendar is the org's plan, and
hiding next quarter's calendar from the engineer who will staff it makes the app less
useful without making anything safer. So the show list and every planning fact on a show
— tasks, deadlines, roster, assets, the intake record — are org-wide. What is scoped is
the per-person rows hanging off a show: flights, lodging assignments, and travel
requests, narrowed to the actor unless they may approve travel. The narrowing happens in
the query (`travelerScope` in `src/lib/shows/store.ts`), not in the markup, so a Member's
page never contains a colleague's fare in the first place.

**What a checklist edit needs** — settled at step 10. The table above puts "Manage
shows" behind Admin, which taken literally puts every tick of a checkbox behind an admin;
that is not a security posture, it is an unused feature. The line that actually holds:
**reporting progress is not a privilege, changing the plan is.** Anyone may move a task
they are assigned to between not-started, in-progress, blocked and complete. Adding,
deleting, re-weighting, re-assigning, and applying a template need travel-manager or admin
— the same bar as cloning, because it is planning, not spending. **Skipping sits with the
second group despite looking like the first**, because a skipped task leaves the readiness
denominator, so letting a task's owner skip it lets anyone raise the show's score by
declaring their own work unnecessary. `src/lib/readiness/access.ts`, and §5d.

**The same line, twice more.** Step 11 reached it from the deadline register (anyone may
report a deadline done; re-dating one, or marking it not-applicable, is changing the plan)
and step 12 from the roster. On the roster it falls hardest, because booth coverage
*counts confirmations*: staffing a show, building shifts and assigning people belong to
whoever runs it, but **answering your own invitation and setting your own arrival and
departure belong to you** — a `confirmed` somebody else typed on your behalf is hearsay
inside a staffing number, and §1's "for a Member, this app should be almost invisible" says
the invitation cannot be answered by email and keyed in later. Recording that you were
actually at the booth is looser still, for a reason of failure modes: an over-tight gate
there produces an empty `shift_presence` table, which destroys §4's rostered-versus-present
insight altogether. `src/lib/team/access.ts`, and §5e.

**Impersonation** (admin support tool) lands post-v1, and only with three rules: the
session is banner-marked, every action logs *both* identities, and **impersonation can
never authorize a purchase or approve a travel request**. The separation-of-duties rule
above is worthless if an admin can simply become the approver.

**Cost centers** are an org-level dimension referenced by `expense`, `flight`,
`shipment`, `travel_request`, `travel_policy`, and — as of step 12, which found the gap —
`lodging` and `side_event`. Two reasons they can't wait: financial
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
  from these, not from show dates — **but never by defaulting to them.** Step 14
  found the asymmetry: show-site receiving genuinely opens *at* move-in, so
  `shipments.receiving_opens_at` is that instant and a show-site row cannot be saved
  without it; an advance-warehouse cutoff is one to three weeks *earlier* and is
  published in the service manual, so prefilling it from move-in would be wrong by a
  fortnight in the expensive direction and would look right on every screen. §5g.
- **`lodging.room_block_cutoff`** is first-class. Missing the room-block date is among
  the most common and expensive trade show mistakes — which is what the §5a deadline
  engine is *for*, so as of step 12 a cutoff owns a register row rather than being warned
  about separately. `show_deadlines.lodging_id` is that link, unique, and the date is
  editable only on the lodging record. §5e.
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
  what the agent was actually charged, every `lodging` night, every `shipment.cost_cents`,
  and `expense` rows for the rest. Nobody assembles it. This is what makes §8 credible —
  and step 17 found that deriving it is the easy half: the figure has to carry what it is
  missing, or it is a confidently wrong number under the app's own byline. §8a.
- **`lead` carries `crm_external_id`.** The CRM owns the truth about pipeline; we own
  the attribution link. We never try to become the CRM.
- **`show_deadline` carries a `penalty_estimate`.** A deadline without a dollar figure is
  a nag; one that says "$2,800 surcharge if missed" gets acted on. See §5a.
- **`booth_shift`, `shift_assignment` and `shift_presence` are three tables.** Rostered ≠
  present, and the gap between them is the staffing insight — but step 12 found a third
  state in front of both: *assigned* is not *able to be there*. An assignment to somebody
  who has not accepted the show, or who lands after the shift starts, is a hole that
  renders as a filled slot. §5e.
- **`ticket_credit` expiry is per-airline**, not a single constant — carriers range from
  6 to 24 months. See §5b.
- **`shipment.consignment` decides what its dates mean**, and `shipment_events` is
  append-only with `status` as the projection — the same shape as a credit balance over
  its entries. `delivered_at` is the carrier's word; `received_at` is a person's, and
  the gap between them is drayage, which this app does not integrate with and must not
  pretend to see. `owner_id` is nullable, and unownedness escalates rather than mutes.
  §5g.
- **`asset_reservation` is a log, not a flag** — and step 16 is where it stopped being one
  in name only. Who took the booth, when it came back, and in what condition; the condition
  is recorded at **both** ends, because `assets.condition` is mutable and a single value
  cannot say when the damage started. The window it carries is when the asset is
  *unavailable*, which is longer than the show at both ends and must never be prefilled
  from it — the same refusal §5g makes about an advance-warehouse cutoff, in both
  directions at once. §5h.
- **Every financial row carries `cost_center_id`.** Set at creation, never inferred later.

---

## 5. Feature scope

### In scope — v1

| Area | What it does |
|---|---|
| **Show calendar** | Create/edit shows; venue, booth, budget, goals, move-in/out windows. **Clone a prior show** with its tasks, deadlines, and asset reservations — calendars are ~80% the same events yearly. What a clone must *not* carry is the harder half; §5c. |
| **Show intake** | "Should we do this show?" proposal → `prospect` status → commit or decline, each with a **written rationale kept permanently** in `show_decisions`. Closes the ROI loop: last year's numbers argue for next year's calendar, and the shows we declined argue hardest. §5c. |
| **Readiness** | Weighted checklist with categories, owners, due dates. 0–100 score per show — or *unplanned*, which is not the same as 0 — rolled up to a portfolio ranked by how far behind pace each show is. Templates seed ~25 standard tasks and merge on re-apply. §5d. |
| **Service deadlines** ⭐ | Exhibitor-manual deadlines with dollar penalties and escalating alerts. The highest-hard-dollar feature in the product. §5a. |
| **Team & shifts** | Attendees per show, roles, confirm/decline, arrival windows. **Booth shift coverage by hour**, plus actual presence vs. roster. Double-booking detection across overlapping shows. |
| **Side events** | Dinners, demos, seminars around the show, with RSVPs and guest lists. Often where the pipeline actually gets made. |
| **Assets & collateral** ⭐ | Capital assets with reservations and chain of custody — and *reserved* never means available, because a promised asset may be committed elsewhere or unfit to go. Collateral inventory whose on-hand figure is a projection of an append-only ledger, and whose low-stock alert is judged on what is *free*. Shares a model with shipping — "what's in the crate" is the same question. §5h. |
| **My itinerary** | Per-user view: my shows, my flights, my hotel, my requests. The Member's home screen. |
| **Lodging** | Hotel, confirmation, check-in/out, rate, room assignments, room-block cutoff warnings. Manually entered. |
| **Flight tracking** | Live status per flight. Delays, gate changes, cancellations surfaced against the show's move-in time. |
| **Travel requests** | User submits constraints; agent searches, books within policy or escalates. §6. |
| **Travel policy** | Admin sets spend ceilings, cabin caps, advance-booking windows, approval bands. Versioned. §7. |
| **Approvals** | Queue for Travel Managers. Approve/reject with reason, full offer context. |
| **Ticket credits** ⭐ | Ledger of unused airline credits with per-carrier expiry, expiry alerts, and automatic use by the agent before any new purchase. §5b. |
| **Cost centers** | Every dollar — flights, lodging, shipping, expenses — carries a cost center. Chargeback/showback reporting; per-cost-center spend caps. |
| **Shipping** | Outbound and return crates across UPS / USPS / FedEx from one screen, with event history and a receiving-**window** check — which has two edges, because freight that arrives before a show-site dock opens is refused rather than early. Delivered is the carrier's word and received is a person's. §5g. |
| **Alerts** | One feed: delayed flight, stalled shipment, shipment missing move-in, room-block cutoff, overdue task, request awaiting approval. |
| **True cost** | Auto-rolled per show from flights, lodging, shipping, booth fees, **booth services** (electrical, carpet, AV, rigging, drayage, I&D labor), expenses. Actuals vs. budget, no spreadsheet. |
| **Lead & meeting capture** | Log leads and on-site meetings against a show. CSV import **and a REST intake endpoint** so any scanner can feed us; manual entry as the floor. |
| **ROI** | Cost vs. pipeline and closed revenue per show. Cost-per-lead, cost-per-meeting, **cost-per-impression**, pipeline multiple. Impressions and **forecast** revenue alongside actuals. Year-over-year and show-vs-show comparison. |
| **Audit log** | Every agent decision and approval, immutable, exportable. |
| **Assistant** ⭐ | One box that answers across the workspace and **drafts** travel and lodging requests for a person to commit. Never books, buys, approves or confirms. Its access model is the tool list, not a prompt: every tool is an existing org-scoped store call as the asking actor. §6f. |

### Explicitly out of scope — v1

- **Slack interface** — the web request form is the v1 entry point. The agent is built
  behind an interface so Slack becomes a second adapter, not a rewrite. §6.
- Hotel *booking* (tracking only) · car rental · rail
- **Native mobile lead-capture app** — a product, not a feature: offline sync, two app
  stores, badge parsing, OCR. We integrate (CSV + REST) in v1 and revisit only if lead
  data quality proves to be the ROI bottleneck. §10 step 20 covers the day-of PWA instead.
- **Badge-scanner hardware integration** — vendors differ per show and most export CSV.
- **Becoming a CRM** — we read pipeline from Salesforce/HubSpot and write the show
  attribution back. Opportunities live there.
- **Virtual/hybrid event planning** — ExhibitDay covers it; it dilutes the physical-
  logistics thesis that is our actual advantage.
- Booth design tooling · vendor RFPs · organizer-side tooling (selling booth space)
- Expense reimbursement, receipts, approvals
- Native mobile apps (responsive web in v1; offline PWA in v1.5 — §10 step 20)
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

**Corrections from building it (step 11).** "A registry, penalties, and escalating alerts
at T-30 / T-14 / T-3 / day-of" is four sentences of spec that turn into four different
alerts, and three of them are not the one that sentence describes.

1. **An unconfirmed deadline alerts about itself, not about its money.** The rule above —
   a human confirms a date "before it becomes an alert" — read literally means *silence*
   on precisely the rows most likely to be wrong, including every deadline a clone
   predicted by shifting last year's date (§5c), which is a guess by construction. Silence
   is the worst outcome available: not noticing a date pass is the whole thing this
   feature exists to prevent. But "$3,125 at risk on Feb 3" for a date nobody checked is a
   fabricated bill, and one of those is enough to teach a team to close the next one
   unread. So an unconfirmed deadline raises a **confirm this date** alert, earlier than
   the money alerts (45 days) and without quoting the penalty as established.
   *Confirmation gates the claim about money, not the reminder.* It follows that typing a
   deadline never confirms it, and that moving a confirmed deadline's date withdraws its
   confirmation — otherwise an edit launders a guess into a quoted figure.
2. **Past the date the tense changes, and so does the audience.** "T+1: $3,125 at risk" is
   false — the surcharge is not at risk, it has been incurred, and there is nothing left to
   hurry about. And the person who needed the reminder is not the person who needs the
   fact: a missed advance order stops being the owner's to-do and becomes the show lead's
   cost. So a missed deadline produces one past-tense alert, addressed to whoever runs the
   show, and it does not repeat nightly. The portfolio (§5d) counts these cents as incurred
   for the same reason and no longer calls them "exposed".
3. **An unowned deadline is the most likely to be missed and, addressed to its owner, the
   least likely to reach anybody.** `owner_id` is nullable and real registers are full of
   nulls. An engine that mails the owner sends *zero* alerts on exactly those rows, and
   silently. So unownedness escalates rather than mutes: the alert goes to whoever runs the
   show and names the missing owner as the thing to fix first.
4. **An alert is a claim about a date, so the dedupe key carries the date.** The credit
   ledger keys expiry warnings on the bucket alone (§5b), which is sound because a credit's
   expiry never moves. A deadline's does — that is half of what editing the register is
   *for*. Keyed on the bucket alone, moving a deadline from March to May leaves a "3 days
   left" warning standing for a date that no longer exists while suppressing the one the
   new date deserves.

Two smaller rules fell out of the same work. **A deadline carries a local time of day, not
just a date**: a checklist task can be due "the 4th" and land at 5pm local, but a warehouse
that closes at 4:00pm does not, and an hour here is a drayage penalty. And
**`not_applicable` is an edit wearing a status** — it removes a dollar figure from the
show's exposure without anybody doing the work, so it needs a written reason and the
authority to change the plan. That is exactly the rule `skipped` needed in §5d, arrived at
from an unrelated direction, which is the reason to trust it.

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

### 5c. Cloning and intake — what step 8 corrected

Both features are about *records that survive a year*, and both turned out to be defined
by what they refuse to do.

**A clone is a draft, and it lands as a `prospect`.** Cloning drafts next year's show; it
does not commit to one. That also means a Travel Manager can build next year's calendar
for review without admin rights, while the commit stays an admin act.

**A clone that copies too much is worse than no clone at all**, because the copied rows
look like this year's facts. Three rules fell out of building it, and they live in the
header of `src/lib/shows/clone.ts`:

1. **Dates shift on the local calendar, not by elapsed milliseconds.** A 5:00pm
   advance-order deadline moved 364 days by arithmetic lands at 4:00pm or 6:00pm across a
   DST boundary — and a §5a deadline an hour early is a surcharge nobody can appeal.
   `shiftDaysPreservingLocalTime` in `src/lib/datetime/zoned.ts` is the primitive.
2. **Confirmation is never carried.** Every cloned deadline arrives *unconfirmed* and
   every cloned attendee arrives *invited*. Last year's exhibitor manual is not evidence
   about this year's, and a shifted date is a prediction until somebody re-reads the new
   manual. Presenting last year's "yes" as this year's is precisely the mechanism by
   which a $312,500 surcharge gets missed.
3. **The "shipping plan" is not the shipments.** The original scope line said a clone
   carries the shipping plan. In this schema a shipment row carries a carrier, a tracking
   number, and a delivery history — copying one *fabricates a shipment*. What is
   genuinely plannable is which assets are reserved and the deadlines that gate them, so
   those clone and shipments do not. Flights, lodging with its confirmation codes,
   expenses, leads, meetings, outcomes, and the booth number (halls reassign them) are
   dropped for the same reason, and the clone screen lists them on the page rather than
   in a tooltip.

**Intake's value is in the declines.** `shows.status` can say a show is `cancelled`; it
cannot say we passed on it in March because booth space rose 40% and last year sourced
$190k against $61k all-in. So each transition is an append-only `show_decisions` row with
the deciding actor and a required written rationale, `shows.status` is the projection of
the latest one, and **a declined show is kept, never deleted**. Anyone may propose;
only an admin commits or declines; the status change and its reason are written in one
transaction, because a status with no recorded reasoning is the thing the table exists to
prevent. Only a `prospect` is decidable — cancelling committed work has contracts and
refunds attached and is a different decision, not this one.

### 5d. Readiness — what the score must refuse to say (step 10)

The readiness percentage is the number a show lead glances at, so what it is allowed to
claim matters more than how it is computed. Three things the naive version got wrong,
each corrected in code:

**A show with no checklist is not 100% ready.** The step-3 placeholder scored an empty
task list as 100 — a rounding decision on one page and a lie on a portfolio, because the
show nobody had touched then sorted above every show somebody was working on. So the
score is `number | null`, `null` means **unplanned**, and it renders as "No checklist"
rather than as 0% (which reads as behind) or 100% (which reads as done).
`src/lib/readiness/score.ts`.

**A percentage alone hides the shape of what is left.** Blocked and not-started both earn
zero credit and are not the same problem; an overdue task does not move the number at all,
because the score has no clock in it. Scoring therefore returns a breakdown — counts by
status, overdue against an explicit `asOf`, and the share of remaining weight sitting in
blocked tasks — and every screen leads with what is *wrong* rather than with the headline.

**Skipping is a change to the plan wearing the costume of a status.** A skipped task
leaves the denominator entirely, which makes "skip it" the fastest way to raise a
readiness score without doing any work. So a skip needs a written reason, and it needs the
same authority as deleting the task — while *reporting progress* needs none, because a
checklist whose tasks only their manager can tick is a checklist maintained by asking
around, which is the spreadsheet we are replacing. §3 records the split.

**Templates are code, and applying one merges.** The ~25-task standard list lives in
`src/lib/readiness/templates.ts`, in git, where changing it is a reviewed diff; an
org-editable template builder is deferred until the standard list has been used and argued
with. Applying a template to a show that already has a checklist is the *normal* case (a
clone arrives with last year's list), so it adds only what is missing and never re-dates a
task somebody has started — and the guarantee is a unique index on
`(show_id, template_key)`, not the plan, because two people on one screen both compute
their plan against an empty checklist. Due dates are offsets from the show's opening day
resolved on the **local calendar**, the same correction §5c made for cloning. Items whose
date has already passed are created and flagged, not hidden: a show seeded three weeks out
genuinely *is* late on its advance order, and a checklist that quietly omits the deadline
you already missed is how the miss stays invisible.

**The portfolio ranks on pace, never on score.** A show 40% ready eight months out is on
schedule; a show 70% ready in nine days is the emergency, and a list sorted by percentage
puts the emergency underneath it. `src/lib/readiness/portfolio.ts` assumes planning runs
linearly over the 120 days before open and ranks on the gap — a crude model, stated as one
on the page, whose value is that it reads the same way week to week. Step 11 corrected one
of its columns: penalties behind a deadline that has already passed are reported as
**incurred**, never as "exposed" or "at risk", because past the date there is nothing left
to save. §5a, correction 2.

### 5e. Team, coverage and lodging — what "staffed" and "covered" must refuse to mean (step 12)

Four corrections, all of the same family: a count that reassures is worse than no count.

**A roster count lies about the future the way a presence count reports the past.** §4
already separates `booth_shift` from `shift_presence` — "rostered ≠ present, and the gap
between them is the staffing insight." Building the roster surfaced a second gap, earlier
and cheaper than presence: "3 of 3 assigned" is computed from `shift_assignments` alone,
and any of those three can be somebody who never accepted the invitation, somebody who
*declined the show*, somebody nobody put on the roster at all, or somebody whose flight
lands after the shift starts. Each is a hole that renders as a filled slot, and a filled
slot is the one thing nobody looks at again. So coverage counts people who are on the
roster, confirmed, and in town for the whole slot; `assignedCount` sits beside
`effectiveCount` because the gap between them is the work list; and a shift that is fully
assigned and still short is flagged **overstated**, which is the only figure on the page
nobody would have gone looking for. An *unknown* travel window is not absence — plenty of
people drive, and treating it as a hole would flag the entire roster, which is the same as
flagging nobody. `src/lib/team/coverage.ts`.

**Confirmation has to come from the person, or coverage is counting hearsay.** Because the
model counts confirmations, a `confirmed` typed in by whoever built the roster is a number
standing in for a conversation nobody had. So staffing a show only ever *invites*;
`show_attendees.responded_at` records that the subject answered for themselves; and
answering an invitation, along with setting your own arrival and departure, is the one
control on the tab a Member gets. That is `readiness/access.ts`'s split — reporting is not
a privilege, changing the plan is — reached from a third direction, and §1's "for a Member,
this app should be almost invisible" is what settles it.

*Corrected 2026-08-31.* Recording the column was not the same as counting it. `standingFor`
read `attendee_status` alone for three steps, so an admin-typed `confirmed` still filled a
slot — the write path obeyed the rule, the screen showed the distinction, and the **number**
ignored both. Coverage now requires `responded_at` before a `confirmed` counts. The result
is a fifth standing, `secondhand`, held apart from `unconfirmed` on purpose: "said yes,
chase them to confirm" and "has not answered" are different work items, and collapsing them
throws away the half that is nearly done. `responded_at` gates *confirmed* only — a decline
recorded on somebody's behalf still stands, because the wrong direction to be wrong in is
counting them. `SCOPE.md` §11.12.

**A double-booking is between travel windows, not between show dates.** The obvious
implementation flags anyone staffed on two shows whose dates overlap, and it is wrong in
both directions. Two three-day shows in the same week are not a conflict for somebody at
one Monday–Tuesday and the other Thursday–Friday, which is an ordinary way to work a busy
quarter — and a warning that fires on the normal case is one nobody reads. But a *missing*
window is not an absence of conflict either; most rosters are half-empty of arrival dates,
and a strict window comparison silently clears exactly the rows nobody has planned yet. So
the comparison is `arrives_on → departs_on`, falling back to the show's dates where a
window is missing, and the finding is marked `possible` rather than `certain` and says
which side it had to guess. `declined` and `waitlist` are not commitments and a cancelled
show conflicts with nothing. `src/lib/team/conflicts.ts`.

**One date, one editable home: the room block cutoff belongs to the deadline engine.**
§4 makes `lodging.room_block_cutoff` first-class because missing it is among the most
expensive routine mistakes in this business — which is a description of the engine §5a
already built, with thresholds, an audience, a tense, a dedupe key that voids itself when
the date moves, and an exposure model. Building a room-block warning on the lodging screen
would have been a second, weaker copy of all of that, on a different schedule, and the two
would have disagreed: whichever screen the person was not looking at would hold the
version they needed. So a lodging row with a cutoff **owns** a register row
(`show_deadlines.lodging_id`, unique). The date is edited on the hotel record and refused
in the register; the owner, the penalty estimate and completion stay register facts. Two
properties fall out of the composition rather than being designed: moving the cutoff moves
the deadline, which withdraws its confirmation, and a derived row arrives unowned, which
the engine escalates to the show runners instead of addressing to nobody. Room block rows
carry **no penalty estimate** — blowing a block does not bill a surcharge, it drops the
party to walk-up rates in a city that is sold out that week, and §5a's rule is that an
unpriced, unconfirmed date is chased as a date and never quoted as an amount.
`src/lib/lodging/store.ts`.

**And un-staffing somebody cancels nothing outside this app** — the same shape as §6d's
cancel correction, answered the same way. Taking a person off a show is allowed, because
people drop off shows constantly; doing it without seeing that a ticket in their name is
still with the airline is not. The store names what is attached and refuses once; the
second press carries the acknowledgement. Their shift assignments and RSVPs *are* dropped,
because an assignment for somebody not on the show is precisely the phantom the coverage
model has to special-case.

### 5f. Flight tracking — what a delay has to cost before it is news (step 13)

The feature reads as "show live flight status", and built that way it produces a screen
nobody uses. Five things had to be got right instead, four of them corrections to the
obvious version.

**A delay is not news; a delay that costs something is.** Forty minutes on a flight
landing three days before move-in is weather. The same forty minutes on a flight landing
4h20m before move-in has just spent the arrival buffer §7's policy rule *required before
the ticket could be bought* — and nobody would ever find out, because that rule was
evaluated once, against an offer, at the moment of purchase, and never again. That gap is
what this step closes. The tracker re-runs the buffer against live times, reads the
required hours out of the **resolved travel policy** rather than writing a second copy of
"4 hours" that would drift from the org's own setting, and only speaks when the verdict
changes. `brokenSincePurchase` is the specific claim: this cleared the buffer when it was
bought and does not now. A flight booked inside the buffer to begin with was an approval
decision, not a disruption, and is not reported as one every night.
`src/lib/flights/status.ts`.

**A re-timed flight is not a delayed flight.** Airlines move flights weeks out. Written
into `estimated_*` that reads as a three-hour delay on a flight running perfectly; written
into `scheduled_*` it erases the itinerary the policy verdict was computed from, which the
"scheduled times are immutable" rule exists to prevent. It is a third thing:
`provider_scheduled_departure` / `_arrival` and `schedule_changed_at` sit *beside* the plan
of record, delay is then measured from the carrier's new schedule rather than from ours,
and the alert is written in its own words — the plan changed under an approved ticket,
with weeks of room to do something about it, which a day-of delay does not have.

**Not knowing is not the same as on time, and it is the default.** An unchecked row reads
`scheduled`, which renders on a board as the calm one — so a board that has not refreshed
in eight hours shows a full slate of on-time flights, which is the most dangerous thing
this screen could do. Staleness is judged against the flight's own timeline (a flight three
weeks out cannot change; one boarding in ninety minutes can change everything), an
unchecked flight past its departure is `unknown`, and the *one* case where silence is
itself the alert is a flight inside twelve hours that nobody has been able to check. A
provider with no record of a flight patches nothing at all — not even `last_checked_at`,
because stamping a successful check on a failed lookup is how a board goes stale while
claiming to be fresh. Facts (`cancelled`, `diverted`, `landed`) survive any amount of
staleness; predictions do not.

**An alert is keyed to the fact that changed, not to the number.** §5a keys a deadline
alert on the deadline *and its date*, which is right there because a date moves rarely and
deliberately. An arrival estimate moves every time anybody asks — four minutes out, two
back — so the same key shape would send "your flight is late" all night, each one
technically a new claim. The key carries the **standing** instead (`inside_buffer`,
`after_move_in`, `cancelled`) plus the scheduled instant that identifies the leg. It fires
once on crossing into the buffer, once more on crossing past move-in, and never for jitter.
And only an *inbound* leg can miss move-in: a delayed flight home is somebody's evening,
and a feed that cries wolf on the way back is one nobody reads on the way there. Where the
direction was not recorded at purchase it is inferred from the show's dates and the alert
says it inferred it — `conflicts.ts`'s `possible`-versus-`certain` rule, reached from a
third direction.

**And the booking spine was buying tickets that the tracking layer could not see.** Nothing
in the app had ever written a `flights` row: the agent recorded an *order* — provider,
order id, reference, ticket numbers, cost — which is exactly right for an audit and is not
an itinerary. My Itinerary, the show's Travel tab and the flight board all read `flights`,
so every ticket the product's own agent had bought was absent from all three, and the
feature would have shipped tracking nothing but hand-typed rows. Ticketing now materializes
the purchased slices into flight rows, idempotently on `(booking_id, segment_index)`, and
slice 0 is where `leg_direction` stops being a guess. Two smaller things fell out of it:
`flights.show_id` had to become nullable, because `travel_requests.show_id` always was and
a trip with no show is still a trip (the buffer verdict for one is `not_applicable`, which
is the answer `policy/rules.ts` already gives for a missing move-in); and the airports'
IANA zones are now carried through `Segment` and stored, because Duffel had been sending
`airport.time_zone` all along and the normalizer read it for the conversion and dropped it
— leaving no way to say what time a departure is at the airport the traveler is standing
in.

### 5g. Shipping — what "on time" has to mean when a crate can also be too early (step 14)

The feature reads as "track our shipments", and built that way it is a delivery-date
column that agrees with the carrier's website. Five things had to be got right instead,
and three of them are inversions of rules this document already settled elsewhere.

**A crate has a window, not a deadline, and early is a failure too.** A flight cannot land
too soon. Freight can, and routinely does. These are two different rules wearing the same
date: an **advance warehouse** accepts freight for weeks and stops on a published cutoff —
arriving early is the entire point of using one — while **show-site receiving** does not
open until move-in does, and a crate that turns up two days before a staffed dock is
refused, held at the carrier's rate, or sent back. Every status column in every carrier
payload calls that outcome `delivered`. So `shipments.consignment` decides which rule
applies, a show-site row cannot be saved without the time the dock opens, and `too_early`
is a real standing rather than an impossible one. The same Tuesday means "held for you" at
one and "refused" at the other, and a screen that shows only the far edge is confidently
wrong in the expensive direction. Also: an advance-warehouse cutoff is **not** move-in and
must never be defaulted to it — warehouses close one to three weeks earlier, so a
helpfully-prefilled date would be wrong by a fortnight and would look right.
`src/lib/shipping/status.ts`.

**Delivered is not received, and only a person can close that gap.** The carrier's claim is
that a dock signed for it. Between that dock and the booth sits **drayage** — a separate
contractor, on its own schedule, which this app cannot see and does not integrate with.
The most expensive thing this model could do is render `delivered` as done while the crate
sits in a marshalling yard and the booth stands empty on the first morning. So
`shipments.delivered_at` is the carrier's word and `received_at` is a person's, the board
counts a delivered-but-unconfirmed crate as a **live** row rather than a finished one, and
the alert fires only once move-in has actually started. This is §5e's hearsay rule reached
from a fourth direction: the same reason `show_attendees.responded_at` gates a confirmation
in the coverage count. It is also why confirming receipt is available to **anybody** — the
person who finds the crate is whoever is standing in the booth at 7am, and a confirmation
only a manager can give is one that never gets given, after which every delivered crate
stays flagged and the flag stops meaning anything. `src/lib/shipping/access.ts`.

**Silence is the failure mode, and no status field reports it.** A stalled crate has a
perfectly healthy payload: the carrier is still promising Thursday, the status still reads
`in_transit`, and there simply has not been a scan since Tuesday. Nothing anywhere says
anything is wrong, so the *absence* of scans has to be what raises it — and the threshold
has to be generous, because long-haul LTL genuinely scans once a day and can sit a weekend
in a terminal with nothing wrong. It tightens as the deadline approaches, when the same
silence stops being ordinary. Two neighbouring cases fall out: a tracking number with **no
scan at all** is a label that was printed and never handed over, which is the commonest way
an outbound crate misses a show and is invisible because the row looks complete; and a
shipment with a deadline and **no tracking number** is a plan rather than a crate, which
the engine says in those words rather than making a claim about a truck that does not
exist.

**§5f's rule about the leg home inverts.** A delayed flight home says nothing, because it
is somebody's evening and a feed that cries wolf on the way back is one nobody reads on the
way there. Freight is the opposite: the **return** crate is the one that actually goes
missing, and the loss surfaces a quarter later when the booth is not there for the next
show, the tracking number was never recorded, and the claim window has closed. So a return
shipment is chased exactly as hard as an outbound one — and the sharpest alert in this step
has **no shipment row behind it at all**: a show whose move-out has passed, which had
outbound freight, and which has nothing recorded coming back. It fires on an absence.

**And an alert here needs both keying rules at once.** §5a keys a deadline alert on the
deadline *and its date*, because a date moves rarely and deliberately. §5f keys a flight
alert on the *standing*, never the estimate, because an arrival time moves every time
anybody asks. Shipping has both kinds of moving part in one row — a receiving deadline that
is edited a handful of times a year, and a carrier estimate that drifts hourly — so the key
carries the deadline and the standing, and carries the estimate nowhere near it. The same
composition rule applies to the **timeline**: a tracker returns its *whole* history on every
call rather than a delta, so an append with no identity turns a nightly sweep into a
timeline that grows by its own length every night. Carriers issue no stable event ids, so
the fingerprint is derived from the scan — instant, phase and location, deliberately *not*
the message, because carriers reword scan text between polls — and a unique index on
`(shipment_id, fingerprint)` is what makes that a fact rather than an intention.

One smaller correction, found by a test rather than by argument: **`expectedArrival` must
not trust an estimate on a shipment with no tracking number.** Whatever is in that column
came from a voided label or somebody's typing, and returning it made the engine report
*"will miss the receiving deadline"* — a confident claim about a truck, sourced from
nothing — on precisely the rows whose real problem is that no truck exists.

### 5h. Assets & collateral — what "reserved" and "on hand" have to refuse to mean (step 16)

The schema comment on `asset_reservation` has said "a log, not a flag" since step 1, and
for fifteen steps it was a flag with extra columns: a row with a window, and nothing ever
written into `checked_out_at` or `returned_at`. Six things had to be got right, and four of
them are rules this document already settled elsewhere, arriving from a new direction.

**Reserved is not available, and available is not serviceable.** §5e found that an assigned
booth shift is not a covered one, because the person may not be able to stand there. An
asset has the same gap and one more beyond it. A reservation is a claim on a thing that may
already be committed to another show; and a thing committed to nobody may still be a
touchscreen with a cracked panel. `assets.condition` is a fact recorded on the *last*
return, every screen renders it as a label, and **nothing joins it to the reservation three
weeks out that it invalidates**. That is the same failure shape as `overstated` coverage: a
filled slot is the one thing nobody looks at again. So availability is a verdict with three
refusals in it — `unserviceable`, `committed`, `tight_turnaround` — each carrying its
reason, and a reservation that is promised while unfit gets an alert of its own.

**The reservation window is not the show window, and it is longer at both ends — which
inverts §5e exactly.** Freight leaves for an advance warehouse one to three weeks before
move-in (§5g) and comes home weeks after move-out. §5e's correction was that comparing
*show dates* **over**-reports a person's double-booking, because Monday–Tuesday in Detroit
and Thursday–Friday in Chicago is an ordinary week. For an asset the same comparison
**under**-reports, because the booth is physically gone for a month around a three-day
show. Whichever way it errs, the fix is the same: compare the window that describes the
thing. And there is a second finding with no counterpart on the people side — **adjacent is
not clear.** Two reservations that do not overlap can still be impossible: `reserved_to` on
the 8th and `reserved_from` on the 10th gives the crate 48 hours to cross the country, be
opened, be inspected and be re-crated. That is `possible`, not `certain` — two shows really
can share a floor — which is §5e's certainty distinction reached from the opposite
direction: there the doubt was about the *data*, here it is about the *world*.

**"In what condition" is only answerable as a delta, so the reservation records both ends.**
`assets.condition` is mutable. By the time anybody asks whether Automate cracked the panel,
the column reads `needs_repair` and cannot say when it started. `condition_on_checkout` is
snapshotted when the asset is signed out and `condition_on_return` when it comes back, so
the log reads on its own — and a return *worse* than the checkout needs a written note, the
same rule §5d put on `skipped` and §5a on `not_applicable`, because that is the moment the
record stops being routine. A check-in is also the **only** place `assets.condition` moves:
a form that could type it would be a second way to set the same fact, and the two would
disagree.

**Signing an asset out and checking it back in is available to anybody** — §5g's
`canConfirmReceipt`, one layer up. The person who wheels the crate onto the truck is
whoever is in the warehouse at 6am, and the person who finds it back on the dock is whoever
unloads it. A `returned_at` only a Travel Manager can set is a `returned_at` that stays
null, after which every reservation is flagged overdue and the flag stops meaning anything.
Recording a physical count of a shelf is the same act, for §5d's reason: inventory only a
manager may touch is inventory maintained by asking around, which is the spreadsheet this
product replaces. What needs authority is everything that changes what is *promised*.

**On hand is not available, and this is the collateral half of the first correction.** 640
datasheets on the shelf with 400 promised to a show next week is 240 available, and a
low-stock threshold checked against `quantity_on_hand` reports "fine" every day until
somebody opens the cupboard to pack the crate. Availability is `on hand − committed`, low
stock is judged on it, and promising more than we hold — `oversubscribed` — is its own
critical standing, because the show that finds out is whichever one packs *last* rather
than whichever was promised last.

**An uncounted return is not a zero return, and an allocation is not a movement.**
`collateral_allocations.quantity_returned` is nullable and that nullability is load-bearing:
"nobody counted" and "counted, none came back" are different facts, and 280 datasheets
given away at a booth is an ordinary result while a box still sitting in Warehouse A is
not. Reading null as zero writes off stock we own; reading it as full ships the next show
short; so the app refuses to guess and says which two guesses it is refusing. Separately,
*promising* stock is a claim and *picking it off the shelf* is a movement, so an allocation
has three states — planned, issued, reconciled — and only the second touches
`quantity_on_hand`. That column is a projection of the append-only `collateral_entries`,
moved only by appending a signed delta: the credit ledger's ground rule from step 6,
applied to things instead of money, which is what makes "what did Automate actually consume"
a query rather than an argument.

**Where assets meet freight.** A reservation window is a claim about when the thing cannot
be promised elsewhere; the shipment rows are the record of when it is actually gone. If the
crate must be at the dock on the 3rd and the reservation opens on the 9th, the asset left
six days before anybody had it booked — and those six days are invisible to the
availability check. `freightCoverage` compares the two, and returns `unverified` rather
than `covers` when a show has no freight recorded, for §5f's reason about an unchecked
flight: not knowing is not the same as fine.

**Alerts.** Both dedupe-key shapes appear here, as they did in §5g, because assets have
both kinds of moving part: a reservation alert is keyed to the reservation *and its window*
(§5a — move the dates and every claim about them is void), while a stock alert is keyed to
the item and a *bucket* (§5b — a quantity moves every time somebody picks a box). Audience
is §5a's third correction for the fifth time, and sharper here: on `never_collected` and
`unserviceable_reservation` there is *never* a holder by construction, so an
addressed-to-the-holder engine would be silent on exactly the two alerts nothing else in
the product reports. And §5a's tense rule reappears at the end of the chain: past the point
where a $84,000 booth can plausibly turn up, "return it" is the wrong sentence — the alert
switches from chasing to an insurance and replacement conversation, and stops nagging.

### 5i. The alerts feed — what a written alert stops being able to say (step 17)

Five engines wrote to the `alerts` table — deadlines (§5a), flights (§5f), shipping (§5g),
assets (§5h) and the credit sweep (§5b) — and for twelve steps nothing read it. Every one
of those steps ended by noting that a CLI was how a person heard any of it. Building the
screen turned out not to be a rendering job: **an alert row is a record that a notification
was owed at some instant, and a feed shows it later**, and four things can have happened in
between that the row cannot express.

**A condition can end, and only the engine can say so.** "This crate has not scanned in
five days" stops being true when the crate scans. Nothing in the table could represent
that, so the feed's first design question was who is allowed to take an alert down. Not a
person: a dismiss button that cleared the board would be the acknowledged-and-forgotten
failure with a nicer interface. The answer falls out of a property all five engines already
have for their own reasons — **each plans over its whole population, not over what
changed** (§5g states the sharpest version: an engine that speaks on transitions cannot
report a stall, which is the failure with no transition in it). So a key an engine no
longer plans is a condition that has ended, and the sweep resolves it. That precondition is
load-bearing: an engine that planned over a subset would silently close every row it did
not look at, which is a screen going quietly green.

**Acknowledging is not fixing, and the two must not share a column.** A person may say "I
have seen this" about their own row; the crate is still in the wrong city, so the alert
stays on the screen under its own heading and the next sweep still finds it.

**The old dedupe muted recurrences, and only a feed could make that reachable.** Every
writer used `onConflictDoNothing`, so a condition that ended and came back under the same
key reused the row somebody had acknowledged weeks earlier — arriving pre-dismissed, with
nobody told. The writer upserts now: `last_seen_at` and `occurrences` move each night a
condition still holds, and a row that had resolved comes back un-acknowledged with its
clock restarted, because a recurrence is news. This is also why the five near-identical
fan-out blocks were consolidated into one writer — they had already drifted (three counted
what was inserted, one counted what was attempted), and none of them could express an
ending.

**An unswept alert is not a current alert.** Nothing in this product runs on a schedule yet
(step 21), so a row's claim is exactly as fresh as the last sweep. `unchecked` is a standing
of its own and a figure on the page — §5f's rule that an unchecked flight is not an on-time
flight, applied to the thing reporting the flights.

**An engine dedupes a fact; a feed has to dedupe a sentence.** Eleven people on one re-timed
flight is eleven correct rows — each traveler's own feed shows exactly one — and one piece
of news for the show runner who receives a copy of all eleven. No engine can see that,
because each only ever looks at one leg. Grouping is therefore a view concern and
deliberately not a change to any dedupe key: keys are how an engine avoids writing twice,
grouping is how a person avoids reading twice.

**There is no org-wide read**, including for an admin. Every engine writes one row per
recipient, so the audience was decided when the alert was planned, by code that knew what
it was about — and a feed offering "everybody's alerts" would be a second, dumber audience
model whose first act would be showing a manager the delay on a Member's personal flight
home, which §5f addresses to the traveler alone.

---

### 5j. Leads & meetings — what a lead count has to say before it says a number (step 18)

§8c already called the lead count the weakest link in the whole ROI story, and blamed rep
behaviour: a booth staffer at hour six of day two does not open a CRM. That is right about
the cause and it turned out to be about a third of the problem. Building capture found two
more mechanisms, and one obligation that changes what "delete" is allowed to mean.

**A count that does not say who did not capture is a fabricated bill.** §8a's rule at the
scale of a show's return side. "34 leads" is a number with the authority of a computed one,
and if three of six people on the booth recorded nothing then it is a floor wearing a
total's clothes. So a count is introduced with **"at least"** whenever anybody rostered on
a booth shift captured nothing, the silent people are *named* rather than counted, and the
sentence is computed once in `coverage.ts` so the portfolio and the show's tab cannot
disagree. **"On the booth" is a shift assignment, not attendance** — the analyst at two
briefings and the engineer demoing in a partner's suite are at the show and are not where
badges get scanned, and counting them makes every show look under-covered, which is §5e's
rule that a warning firing on the ordinary case is one nobody reads. Where nothing is
rostered, coverage is **unknown**, never 0 of 0, which would render as perfect.

**And the ratio is withheld rather than published with an asterisk.** Cost per lead over an
undercounted denominator comes out too *high*, which reads as a bad show — so the number a
thin count produces does not merely mislead, it drives the specific wrong decision §8c
warns about, which is cutting a show that worked. §19 owns that figure; what step 18 owes
it is a denominator that refuses.

**Duplicates inflate in the flattering direction, which is the direction nobody audits.**
Two staff scan the same badge an hour apart; a scanner re-exports; somebody imports the
same file twice. Cost per lead is a quotient, so a 15% duplicate rate makes a show look 15%
cheaper per lead than it was. Identity is the scanner's own reference first and the email
second, **within a show only** — meeting the same person in June and in October is two real
engagements with two costs — and name-plus-company is a *suspicion* that is surfaced and
never auto-merged, because silently dropping a real second lead is the same failure
pointing the other way.

**Import must account for every row it read.** A parser that skips a malformed row reports
a smaller number with the same confidence as a correct one, and nobody re-counts a CSV. So
accepted + rejected + duplicate always equals the row count, the rejections are kept with
their row numbers and reasons on the `lead_imports` record, and the batch is written *even
when nothing was accepted*. The column mapping is proposed and confirmed rather than
applied: a column called `Company` that is really the exhibitor's would be filed as every
lead's employer, plausibly, forever. And an imported lead is attributed to **nobody** — not
to whoever uploaded the file — or one person's capture coverage reads as perfect and
everyone else's as worse.

**A lawful basis is never manufactured from an absence.** §9.8 makes lead PII regulated
from the first row, and the practical form of that is one column with no default. A badge
vendor's export has no consent field, so an import that wrote `consent` because the field
was missing would be inventing a lawful basis out of the absence of one — §5a's fabricated
bill, in a jurisdiction that fines for it. `unknown` is a real recorded answer; consent
claimed with no timestamp, or with no record of what the person was told, is refused for
outbound use the same way. **Refusing to market is not refusing to keep**: a business card
handed over at a booth is lawfully held for the follow-up the person started, so an
unknown-basis lead stays, stays counted, and is withheld from anything outbound.

**Erasure must not erase the count.** The sharpest of the six. A retention date that
expires, or a person exercising their right to be forgotten, cannot be honoured by deleting
the row: every ROI figure that show has ever produced would move, silently, months later,
and cost per lead would improve on its own. So erasure is **redaction** — the personal
columns are nulled (including `crm_external_id`, or our erasure is a fiction with a
footnote), and the shell keeps the show, the capturer, the timestamp and the source. The
person is gone; that a conversation happened is not personal data. Retention is a finite
default rather than a policy screen, because a limit nobody has configured must still be
*some* number, and `retention_overdue` is `critical` from the first night: it is the only
alert in the product that reports our own non-compliance, and a retention promise nothing
enforces is worse than no promise.

**The intake endpoint is the first principal in this product that is not a person**, and it
is deliberately not an `Actor`. A service user with a role would flow through `getActor()`
and reach every store function in the codebase; an `IntakePrincipal` is the wrong *type*
for all of them, so the compiler enforces a boundary a role check would only describe. It
is §6f's lesson in a different costume. Three properties fall out: only the hash of a key
is stored and the plaintext is shown once; a key is scoped to one show wherever possible,
because a scanner rented for three days has no business writing to next year's show; and
revocation is a timestamp, so "which key wrote these forty leads" stays answerable. **A
retry is a success, not a conflict** — scanners on convention-centre wifi retry requests
whose responses they never saw, and answering 409 teaches an integration to treat a
recorded lead as a failure, after which somebody writes the loop that manufactures the
duplicates the endpoint exists to prevent.

**Who reads a stranger's phone number is a narrower question than who reads a colleague's
fare.** The count is everybody's — it is the show's scoreboard, and §8c's entire mitigation
is that a thin number is visible to the person who could fix it. The personal detail is
yours and your approvers', narrowed in the query the way `travelerScope` narrows travel,
and a withheld row renders as a labelled shell rather than a blank name, because blank is
indistinguishable from erased and those are opposite facts. Capturing is **anybody's** — a
capture flow gated on a role produces §8c's bad number by construction — and erasing is
not, because it is irreversible. The assistant gets `lead_capture`, which returns counts and
coverage and **no personal data at all**: `listShowLeads` is not a tool, because a model's
context window is somewhere data goes and does not obviously come back from, and nothing
anybody asks the concierge needs a stranger's phone number in it.

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

**What step 9 added, putting a screen on this:** the sentence above is a rule about
the *engine*, and an approver never sees the engine. Shown a fare beside an Approve
button, a person reasonably believes they are authorizing that fare — and roughly half
the time they are not, because the offer died hours ago and approving will re-search.
So the standing of an offer is now a first-class thing the UI states, in four cases:
**live**, **held with the fare guaranteed**, **held with the fare *not* guaranteed**,
and **expired**. The middle pair is the one §6b already warned about and the one a
screen most easily elides.

The predicate that decides it lives in `src/lib/travel/review.ts` and the agent imports
it — it used to be written inline in `approveRequest`. Two copies of "is this offer
still good?" would eventually disagree, and the copy that drifted would be the one
talking to the human. One definition, rendered on the queue row and re-read at the
moment of purchase.

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
**A gap step 9 made visible, and how it is handled meanwhile.** `cancelRequest` closes
our record, releases any credit the booking consumed, and writes a cancelled
non-refundable ticket off as a new credit. It does **not** call the airline:
`FlightProvider.cancel()` is implemented and, as of step 9, is called by nothing. That
was invisible while cancelling was something only a script could do. Putting a button on
it makes the gap reachable by a person who will reasonably assume the ticket is gone, so
the button on a ticketed request reads "Close this record" and says in as many words that
the carrier still has to be called. Wiring it properly is the void/refund work above, and
a half-wired cancel that *sometimes* reaches the carrier would be worse than one that
never claims to.

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

### 6f. The conversational assistant — what makes "read and draft only" true (step 15)

§6a's rule is unchanged and this step is its first real exercise: **the LLM parses and
narrates; the deterministic policy engine authorizes.** What step 15 adds is the parser
the seam has been waiting for since step 4 — `raw_request_text`,
`constraints_confirmed_at`, and an agent that refuses to search an unconfirmed parse were
all built and tested before anything could produce one.

**The access model is the tool list, and it is not a prompt.** The assistant gets no
database access of its own. Every tool is an existing org-scoped store function, called
with the asking `Actor`, through the same `access.ts` gate the screen goes through. So
"which room is Shelley in" asked by a Member is not refused by an instruction a model can
be argued out of — `getLodgingBoard` calls `travelerScope(actor)` and narrows the query,
so the row is never retrieved, there is nothing in the transcript to leak, and there is no
rule for an injected instruction to override. `people` returns only the asker for a
Member, which is why "book Shelley a flight" fails on the same list the form's dropdown is
built from. **Adding one tool that queries around the actor is the single thing that
would break the whole posture**, and `src/lib/assistant/tools.ts` says so in its header.

Five corrections came out of building it.

1. **A withheld tool is not described, and naming one gets the same answer as inventing
   one.** The subtractive half is obvious: `access.ts` filters the tool list, so a Member
   is never *told* `draft_lodging` exists. The half that is easy to get wrong is the reply
   when a model names it anyway. "That tool exists but is not available to you" is a map —
   it confirms the capability, names it, and invites a second route to it. "That is not a
   tool" ends it. Both cases now return the identical sentence.

   More generally: **nothing in the system prompt is load-bearing for access.** If a rule
   would be dangerous to have disobeyed, it is in code. What the prompt carries is *tense* —
   that an unconfirmed deadline is a date and not an amount, that "delivered" is the
   carrier's word, that an unchecked flight is not an on-time flight. Those distinctions
   are four steps of work, and a narrator that flattens them back into "two deadlines at
   risk, flights on time" undoes all of it in the register a person actually reads.

2. **A `recorded` provider can replay a payload. It cannot replay prose.** The other three
   integrations obey one rule: a replay may describe a *shape* and must not assert a fact
   about this workspace — EasyPost's replay projects a recorded journey onto the crate's
   real transit window, AeroAPI's projects a recorded delay onto the real block time.
   Prose has no equivalent move. "MedTech is 62% ready and two deadlines are at risk" is
   not a shape that can be projected onto anything; it is a sentence about a different
   workspace, and replaying it puts a fabricated figure on screen under the app's own
   byline — the exact failure §5a spends an entire engine avoiding. So the `scripted`
   model replays **only tool plans**: it decides which tools a question calls for, those
   tools then run for real against the real database as the real actor, and it closes with
   one fixed sentence that characterises nothing. The test asserts that sentence contains
   no digits.

3. **`submitTravelRequest` inferred human confirmation from the *absence* of raw text, and
   that inference inverts for this caller.** No raw text meant "a human typed these
   constraints into a form, so they are confirmed by construction" — correct for both
   callers it had, the form and the dry-run script. An assistant filing a request without
   raw text would have had its parse marked human-confirmed, and the agent would have
   searched a reading nobody read. The draft path therefore refuses to file without the
   person's own words rather than defaulting. Two more things make the boundary
   structural rather than stated: the assistant does not hold `confirmConstraints` as a
   tool, and the `AgentDeps` it is handed carry a `FlightProvider` whose every method
   rejects with a sentence naming the rule. (`travel/actions.ts` passes `null as never`
   there for the same reason, which works and reads as an oversight; from a language model
   the difference between a refusal and `Cannot read properties of null` is worth the
   fifteen lines.)

4. **A follow-up must not be answered from the previous turn's tool result.** The
   transcript is replayed to the model **without** tool results. A tool result is a
   snapshot of rows as they were when it ran, and "has it landed yet?" is precisely a
   question about the row that has since moved. Feeding the old snapshot back is how an
   assistant becomes confidently stale, and it would do so most reliably on the questions
   people ask twice. The prose stays — it is what the conversation is *about* — and
   anything factual is looked up again.

5. **A transcript belongs to the person in it — the only table in this app scoped to a
   user rather than an org.** Not a privacy flourish. Every tool result inside a transcript
   was retrieved under the scope of whoever was talking; `travelerScope` had already
   narrowed it. A second reader — an admin, a travel manager — would be reading rows that a
   query narrowed for somebody else, which is the lateral path the whole posture exists to
   close. So there is no "read another user's conversation" function, and adding one would
   be the second way to break the posture after adding an ungated tool.

**And one thing that got easier.** This is the first integration where a vendor SDK
exists, so there is no `wire.ts` beside the adapter and no fixture file of payloads we
invented. Duffel, AeroAPI and EasyPost are hand-transcribed published schemas checked
against fixtures we wrote ourselves — a closed loop that proves internal consistency and
structurally cannot catch a misread field name (§10, step 12.5). `@anthropic-ai/sdk` ships
the wire types with the client, so the compiler checks the shape and there is nothing for
a capture script to arbitrate. What remains unverified for this adapter is only
*behavioural* — whether the model uses the tools well — and not structural.

**What is deliberately not built.** Streaming: a server action returns the whole answer at
once, which is worse to watch and keeps every tool call inside the request, running as the
actor `getActor()` resolved, with no token the browser holds. That is a presentation
change and moves no access decision. Hotel *booking* stays out of v1 per §5, so a lodging
draft creates a record; its room block cutoff is deliberately left blank, because a cutoff
owns a row in the §5a register (§5e) and a guessed one becomes a deadline the engine
chases and eventually quotes money against.

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

**What step 17 established, building it.** The addition really is a query, and it is not
the work. The work is that **a total which does not say what it is missing is a fabricated
bill** — §5a's rule about quoting a penalty behind an unconfirmed date, at the scale of a
whole show. A computed figure carries an authority a spreadsheet never had, so a
confidently wrong one is worse than the spreadsheet it replaced. Every line therefore
carries its coverage, and a total is called a total only when everything that exists
carries a figure and nothing structural is absent; otherwise the word is **"at least"**.
Six things the rollup refuses to do, each a way the number would have been wrong:

1. **A dry run is not spend.** `bookings.live` is the provider's word (§6c) and exists to
   protect exactly this figure — a Duffel *test* key issues orders that look real in every
   respect. The seeded workspace is made entirely of dry runs, so a rollup that summed
   charged amounts without reading `live` would have looked plausible and been fiction from
   its first day.
2. **A credit is not a discount, and a credit-funded trip is not a free one.**
   `chargedCents` is new money; the credit covered the rest and was bought last year, on a
   ticket for a trip somebody cancelled. Counting the fare charges the same dollars to two
   shows; counting only the cash and saying nothing makes a trip flown entirely on credit
   look free. So cash is the line and the credit is a memo beside it.
3. **Stock consumed is not stock bought, and only one of them is money.** A print run is an
   outlay on the show that ordered it; what a later show takes off the shelf is a valuation
   of things already paid for. Consumption sits outside the total, and where a show has
   both, the overlap is named rather than silently resolved — only a person knows whether
   the print run *was* this stock.
4. **A lodging row is one reservation.** `lodging/store.ts` already refuses to invent a
   room count, so nights × rate is per reservation and a block recorded as one row with
   four guests is an undercount. Named, not fixed: the fix is a number somebody has to type.
5. **Committed is not paid.** `expenses.paid` is the only tense marker in the money, and
   before a show most of a cost is a commitment — §5a's distinction between at risk and
   incurred, one table over.
6. **Staff time is days, not dollars.** §11.8 is open and there is no loaded rate anywhere
   in this workspace, so attendee-days are counted and deliberately not priced. A dollar
   figure there would be a number we invented, which is the one thing this page exists not
   to do.

Two consequences worth stating. **A silent line is not a zero**: a show with no booth-space
figure is not a cheap show, it is a show nobody has entered the invoice for, and because
that line is usually the largest one, its absence is what decides that a figure is *thin*
rather than merely incomplete. And **a prospect is absent rather than shown at $0**, for
§5d's reason: a zero in a cost table reads as a bargain instead of as an absence.

**Who sees it.** Travel Manager and Admin — the same audience §3 gives "see all users'
travel and shipments". A show's true cost is every colleague's fare in one figure, and
`travelerScope` narrows a Member's own travel queries precisely so a colleague's fare is
never on their screen; an aggregate that showed them the total would walk around the
narrowing rather than through it. The tab is not rendered for a Member at all, rather than
rendered and refused.

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
2. Make manual entry take under ten seconds in the day-of PWA (§10 step 20).
3. Only then consider gamification.

**What step 18 established, building it.** Mitigation 1 is done and is the whole shape of
the feature: the count is never rendered bare, the word in front of it is "at least"
whenever anybody rostered on the booth captured nothing, and the silent people are named.
Two things the diagnosis above did not have. First, the behavioural problem has two
*mechanical* siblings — duplicates, which inflate the count in the flattering direction and
make a show look cheaper per lead than it was, and silent import loss, which deflates it
with equal confidence. Second, cost per lead is **withheld** over a thin count rather than
published with a caveat, because the error runs in the direction that reads as a bad show
and drives exactly the decision this section warns about. §5j is the long version.

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
   the §10 step 20 PWA, not a nice-to-have — it cannot be retrofitted onto server-rendered pages.
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
- [x] **8.** **Show list · show detail tabs · My Itinerary · cloning · intake.** The
      planning core, read-only except for the two writes that are actually step 8's:
      proposing/deciding a show and cloning one. Added `show_decisions` (append-only,
      a written rationale required in both directions), `src/lib/shows/` — a pure clone
      planner, pure intake validation, a visibility rule, and an org-scoped store — and
      `shiftDaysPreservingLocalTime` / `calendarDaysBetween` in the datetime primitives.
      Screens: `/shows`, `/shows/new`, `/shows/[id]` with five tabs, `/shows/[id]/clone`,
      `/itinerary`. Two corrections folded into §3 and §5c above: "see own shows" scopes
      *travel*, not the calendar; and a clone that carries confirmations or shipments
      manufactures facts. 267 tests.
- [x] **9.** **Travel request UI + approvals queue** — the first screens over the spine.
      `/travel`, `/travel/new`, `/travel/[id]` (the audit trail as a page), and
      `/travel/approvals`. Added `src/lib/travel/review.ts` — pure, and the single
      answer to *what does approving this actually do right now*; `provider.ts` —
      env → provider, with no silent fallback to replayed offers; `queue.ts` — the
      org-scoped, `travelerScope`-narrowed reads. The seed now produces its travel
      requests by **running the real agent against the `recorded` provider** rather
      than writing offer snapshots by hand. Three corrections below. 307 tests.
- [x] **10.** **Readiness — checklist CRUD, templates, scoring, portfolio rollup.** The
      first writable show detail tab. `src/lib/readiness/` replaces the nine-line
      placeholder `lib/readiness.ts` and is split the way the spine and the planning core
      are — `score.ts` (pure; a breakdown rather than a number, and `null` for
      *unplanned*), `templates.ts` (the built-in library plus a pure, idempotent apply
      planner), `edit.ts` (pure validation and the written-reason rule), `access.ts` (who
      may report progress vs. who may change the plan), `portfolio.ts` (the pace model and
      the ranking), and `store.ts` as the only file touching rows. `show_tasks` gained
      `status_note`, `template_key` with a unique index per show, `completed_by_id` and
      `updated_at`. Screens: the readiness tab is writable, and `/readiness` is the
      portfolio. The seed now builds MedTech's checklist by **running the real template
      applier and the real status gate**, the same rule step 9 set for travel requests.
      Four corrections folded into §3 and §5d above: an empty checklist is unplanned, not
      ready; a percentage alone hides blocked and overdue work; skipping is an edit wearing
      a status; and a portfolio ranked by score buries the emergency. 342 tests.
- [x] **11.** **Service manual deadline engine** (§5a) — the register becomes writable, and
      the escalation engine gets built. `src/lib/deadlines/` splits the way the spine and
      the planning core do: `alerts.ts` is pure and holds the whole argument — the
      thresholds, who each alert is addressed to, which tense it is written in, and the
      dedupe key that voids itself when a date moves; `edit.ts` is pure validation plus the
      local-time-of-day rule and the written reason for `not_applicable`; `access.ts` is
      the report/confirm/change-the-plan split; `store.ts` is the only file touching rows,
      org-scoped at the source, and carries the sweep. `show_deadlines` gained `status`,
      `status_note`, `completed_by_id`, `confirmed_by_id` and `updated_at`. The register on
      `/shows/[id]/readiness` is writable — add, edit, own, confirm, complete, waive — and
      shows on each row what the engine will say next and to whom. `pnpm deadlines` prints
      the register, the three exposure figures kept apart, and tonight's alerts;
      `pnpm deadlines --sweep` writes them. The seed grows an unconfirmed, an unowned and a
      missed deadline so all four cases are live, and produces its alerts by **running the
      real sweep**. Four corrections folded into §5a above. 387 tests.
- [x] **12.** **Team & lodging — attendees, booth shifts, coverage, conflicts, hotels, room
      blocks, side events.** `src/lib/team/` and `src/lib/lodging/`, split the way the spine
      and the planning core are: `coverage.ts` is pure and holds the argument — rostered is
      not staffed, and a fully-assigned shift can still be short; `conflicts.ts` is the
      double-booking model, comparing travel windows rather than show dates and marking a
      guessed comparison as such; `edit.ts` / `access.ts` / `store.ts` the same shape as
      steps 10 and 11. Lodging's cutoff **derives a row in the §5a register** rather than
      growing a second clock — `show_deadlines.lodging_id`, unique, date read-only there.
      Schema: `show_attendees.responded_at` + `updated_at`, `booth_shifts.updated_at`,
      `lodgings.cost_center_id` (§4's rule, which lodging had been violating) and
      `updated_at`, `side_events.cost_center_id` + `updated_at`, a unique index on
      `(side_event_id, user_id)`. Screens: the Team tab is writable, and Lodging is a new
      sixth tab. `pnpm roster` is the coverage model without a screen. The seed builds its
      roster, shifts, hotels and guest lists **through the real stores** — every attendee
      arrives `invited` and is confirmed by the person themselves — and grew a fifth show
      overlapping Automate so both the real and the guessed conflict case are live. Four
      corrections folded into §5e above. 431 tests.

### Phase C — logistics, telemetry & ROI

- [x] **13.** Flight tracking — status provider, flight board, delay alerts.
      `src/lib/integrations/flightstatus/` is the second integration behind the usual
      interface: a FlightAware AeroAPI v4 adapter (wire / normalize / client, written to
      the published schema and **never run against a live key**, exactly as Duffel was
      before 12.5) plus a `recorded` replay, chosen by `selectStatusProvider` with **no
      fallback**. `src/lib/flights/` is the model, split the way every step since 8 has
      been: `status.ts` pure (freshness, the buffer verdict read out of the resolved
      travel policy, and the reconciler that keeps a re-timing apart from a delay),
      `alerts.ts` pure (what is worth saying, to whom, and the dedupe key that carries the
      *standing* rather than the estimate), `board.ts` (ordered by what is wrong, not by
      what leaves next), `access.ts`, `store.ts` (org-scoped rows, the sync sweep, and
      materialization). Schema: `flights.show_id` nullable, `leg_direction`,
      `origin_time_zone` / `destination_time_zone`, `provider_scheduled_*`,
      `schedule_changed_at`, `diverted_to_airport`, `status_provider`, `booking_id` +
      `segment_index` (unique), `updated_at`. Screens: `/flights` in the nav, live
      standing on the show's Travel tab and on My Itinerary. `pnpm flights` /
      `pnpm flights --sync` is the engine without a screen. **Ticketing now materializes
      its itinerary into `flights`** — before this step nothing wrote that table at all.
      Five corrections folded into §5f above. 489 tests.
- [x] **14.** Shipping — EasyPost adapter, tracking, event timeline, and the receiving
      *window*. `src/lib/integrations/shipping/` is the third integration behind the usual
      interface: an EasyPost Tracker v2 adapter (wire / normalize / client, written to the
      published schema and **never run against a live key**, exactly as AeroAPI still is)
      plus a `recorded` replay that projects a recorded *shape* onto the real transit
      window and hands back only the scans that have already happened, chosen by
      `selectTrackingProvider` with **no fallback**. `src/lib/shipping/` is the model, split
      the way every step since 8 has been: `status.ts` pure (freshness, the two-edged window
      verdict, the stall model, and the reconciler), `alerts.ts` pure (what is worth saying,
      to whom, and a key that carries the deadline *and* the standing), `board.ts` (ordered
      by what is wrong, not by what is due), `access.ts`, `edit.ts`, `store.ts` (org-scoped
      through the show, the sweep, and the append-only timeline). Schema: `shipments.
      consignment`, `receiving_opens_at`, `owner_id`, `received_at` + `received_by_id`,
      `promised_delivery`, `estimate_changed_at`, `tracking_provider`, `updated_at`;
      `shipment_events.source` + `fingerprint` (unique per shipment). Screens: `/shipping`
      in the nav, and the show's **Logistics tab is writable** — it was the last read-only
      one. `pnpm shipping` / `pnpm shipping --sync` is the engine without a screen. The seed
      grew a live show and a prior-year one, because a calendar where every show is fifty
      days out has no freight in motion and no move-out to have gone quiet after. Five
      corrections folded into §5g above. 571 tests.
- [x] **15.** **Conversational assistant** — a chat agent that answers across the workspace
      and **drafts** travel and lodging requests for a human to commit. §6a is unchanged:
      the LLM parses and narrates, the deterministic policy engine authorizes, and this is
      the first thing to use the parser seam built at step 4.
      `src/lib/integrations/llm/` is the fourth integration behind the usual interface —
      `types.ts` performs one exchange and runs no loop (running a tool means choosing an
      actor, which must not live in an adapter); `anthropic/client.ts` is the Messages API
      through the official SDK, so this is the **first adapter with no hand-written wire
      schema** and nothing for a capture script to arbitrate; `scripted/` replays **tool
      plans, never prose**, because a canned sentence about a workspace is a fabricated
      claim in a way a canned tracking payload is not. `selectAssistantModel` has no
      fallback.
      `src/lib/assistant/` is the model, split the way everything since step 8 has been.
      **`tools.ts` is the access model and the whole point:** every tool is an existing
      org-scoped store function, called as the asking actor, through the same `access.ts`
      gate a screen goes through — so a Member asking about a colleague's room is refused
      by `travelerScope` narrowing the query, not by a rule a model could be talked around.
      `access.ts` is subtractive: a withheld tool is never described. `prompt.ts` carries
      **tense, not access** — no line in it is load-bearing. `loop.ts` is a manual loop with
      three bounds of ours, and dispatch that answers a withheld tool exactly as it answers
      an invented one. `draft.ts` refuses to file a request without the person's own words,
      refuses to guess a time zone, and holds a `FlightProvider` whose every method rejects.
      `store.ts` scopes a conversation to a **user**, the only table in the app that does,
      and replays prose without stale tool results.
      Schema: `assistant_conversations`, `assistant_messages` (append-only, with the tool
      result kept beside the prose because the prose is the paraphrase). Screens:
      `/assistant` and `/assistant/[id]`, first in the nav, with tool steps rendered beside
      the answer rather than behind it. `pnpm assistant` is the loop without a screen and
      `pnpm assistant --tools` prints the surface per role. The seed produces its two
      transcripts by **running the real loop against the real tools** — one as a member and
      one as an admin, asking questions whose *results* differ while nothing about the
      prompt does. Five corrections folded into §6f above. 591 tests.
- [x] **16.** **Assets & collateral — inventory, reservations, chain of custody** (§5h).
      `src/lib/assets/`, split the way everything since step 8 has been.
      `custody.ts` is pure and holds three of the six arguments: the seven-state custody
      chain (`planned` → `due_out` → `out` → `overdue` → `missing`, with `never_collected`
      and `returned` as the two ways it closes), `serviceabilityOf` and the three-refusal
      `availabilityFor` — reserved is not available and available is not serviceable — and
      `freightCoverage`, which is where assets meet §5g and returns `unverified` rather
      than a pass when there is no freight to check against. `conflicts.ts` compares
      *reservation windows* rather than show dates, which inverts §5e's correction, and
      adds `turnaround` as a `possible` finding because adjacent is not clear.
      `inventory.ts` is the collateral half: on hand minus committed, low stock judged on
      what is free, an allocation's three states, and the projection over the ledger.
      `alerts.ts` carries both dedupe-key shapes at once and escalates the two alerts that
      by construction have no holder. `board.ts` orders by what is wrong and counts
      capital outside the building. `edit.ts` requires a condition on return and a written
      note when it comes back worse. `access.ts` puts sign-out, check-in and counting a
      shelf in *anybody's* hands — §5g's receipt rule, one layer up. `store.ts` is the only
      file touching rows, scoped through the asset's own org (a third posture beside
      shipping's show and flights' traveler, and it falls out of the domain: a booth
      belongs to the company between shows, which is most of its life).
      Schema: `assets.cost_center_id` (§4's rule, which assets had been violating) +
      timestamps + a unique asset tag; `asset_reservations.condition_on_checkout`,
      `returned_by_id`, timestamps, unique on `(asset, show)`;
      `collateral_items.cost_center_id` + timestamps + unique SKU; a new append-only
      `collateral_entries` with signed deltas and a `(allocation, kind)` rail;
      `collateral_allocations.issued_at` / `issued_by_id` / `returned_at` / `returned_by_id`.
      Screens: `/assets` in the nav, and the Logistics tab now renders three models on one
      page — the crate, what is inside it, and the collateral — with the joins between
      them visible. `pnpm assets` / `pnpm assets --sweep` is the engine without a screen.
      The assistant gained `asset_register` and `collateral_stock`, both existing
      org-scoped store calls, so the §6f posture is unchanged. The seed builds all of it
      **through the real stores** — including a booth signed out to last spring's Detroit
      show and never checked in, which is the sentence the schema comment has carried since
      step 1. Six corrections folded into §5h above. 656 tests.
- [x] **17.** Alerts feed · **true-cost rollup** — `src/lib/alerts/` and `src/lib/cost/`,
      split the way everything since step 8 has been. `alerts/feed.ts` is pure and holds the
      whole argument: the five standings (`new` / `repeating` / `unchecked` / `acknowledged`
      / `resolved`), `linkFor` (read off `source`, never regexed out of a dedupe key),
      ordering that puts a three-week-old critical above tonight's, and `groupFeed` — an
      engine dedupes a fact, a feed has to dedupe a sentence. `alerts/access.ts` is the
      posture: there is no org-wide read, because every engine already decided the audience.
      `alerts/store.ts` is the **one writer** the five engines now share, and the bug the
      consolidation fixed is the step's sharpest: `onConflictDoNothing` meant a condition
      that ended and recurred under the same key reused a row somebody had acknowledged, so
      the recurrence arrived pre-dismissed. `syncConditionAlerts` records what an engine
      says is true *and closes what it no longer says*, which is the only signal a crate
      arriving produces. `alerts/sweep.ts` runs all five and reports the two that need a
      provider and did not get one, because an engine that could not run is not an engine
      with nothing to say. `cost/rollup.ts` is pure and refuses six things (§8a): a dry run
      is not spend, a credit is not a discount, consumption is not an outlay, a lodging row
      is one reservation, committed is not paid, staff time is days rather than dollars.
      `cost/store.ts` loads every show's inputs in a fixed number of queries so the
      portfolio and a show's own tab cannot disagree about the arithmetic. `cost/access.ts`
      is Travel Manager and Admin, for §3's reason about aggregating other people's fares.
      Schema: `alerts` gained `source`, `kind` (`condition` vs `notice`), `last_seen_at`,
      `occurrences`, `resolved_at` and `acknowledged_by_id`. Screens: `/alerts` and `/cost`
      in the nav, a **Cost** tab on the show that is not rendered at all for a Member, and a
      line on the overview. `pnpm alerts` / `pnpm alerts --sweep` / `pnpm alerts --as` and
      `pnpm cost` / `pnpm cost <show id>` are the two engines without a screen. The seed
      completes one deadline and re-runs the sweep so a **resolved** row exists, and
      acknowledges one alert *as the person it was addressed to*. 693 tests.
- [x] **18.** Leads & meetings — **CSV import · REST intake endpoint · the GDPR posture** —
      `src/lib/leads/`, split the way everything since step 8 has been.
      `coverage.ts` is pure and holds the argument §8c was missing: a count is
      introduced with **"at least"** whenever anybody rostered on a booth shift captured
      nothing, the silent people are named, "on the booth" is a shift assignment rather
      than attendance, an unrostered show is `unknown` and never 0 of 0, and
      `mayQuotePerLead` **withholds** cost per lead over a thin denominator rather than
      publishing it with a caveat — the error runs in the direction that reads as a bad
      show. `consent.ts` is the GDPR half and refuses three things: a lawful basis is
      never manufactured from an absent column, consent with no timestamp or no recorded
      notice is a claim about consent rather than consent, and **erasure is redaction** —
      the personal columns are nulled and the shell stays, so honouring a request does not
      move every ROI figure that show ever produced. `parse.ts` is an RFC-4180-enough CSV
      reader plus an import planner in which accepted + rejected + duplicate always equals
      the row count, with a mapping that is proposed and confirmed rather than applied.
      `dedupe.ts` is identity within a show — the scanner's reference, then the email, and
      name-plus-company as a *suspicion* that is never auto-merged. `alerts.ts` is the
      **sixth engine**, whose sharpest alert has no lead row behind it (a show that ran,
      was staffed, and recorded nothing) and whose `retention_overdue` is the only alert in
      the product reporting our own non-compliance. `intake.ts` is the first principal here
      that is not a person, and deliberately **not an `Actor`**, so the compiler enforces a
      boundary a role check would only describe. `access.ts` splits the count (everybody)
      from the personal detail (whoever captured it, plus approvers), capture (anybody)
      from erasure (approvers), and puts issuing a key with Admin. `store.ts` is the only
      file touching rows, org-scoped through the show. Schema: `leads` gained `source`,
      `import_id`, `external_ref` (unique per show), `duplicate_of_id`, `consent_notice`,
      `redacted_at` / `_by_id` / `redaction_reason` and `updated_at`; `meetings` gained
      `no_show_at` and timestamps; new `lead_imports` (append-only, keeps every rejection)
      and `intake_keys` (hash only, show-scoped, revoked rather than deleted). Screens:
      `/leads`, a **Leads** tab on every show, `/settings/intake`, and
      `POST /api/intake/leads` — the first route in this product that authenticates without
      `getActor()`. The assistant gained `lead_capture`, which returns counts and coverage
      and no personal data at all. `pnpm leads` / `pnpm leads <show id>` /
      `pnpm leads --sweep` / `pnpm leads --retention` is the engine without a screen. The
      seed captures at the booth, posts through the *real* intake path (including the retry
      a scanner makes), imports a CSV through the real parser, and sweeps **before and
      after** the import so a genuinely resolved lead alert exists. Six corrections folded
      into §5j above. 770 tests.
- [ ] **19.** CRM read/write adapter, attribution, ROI dashboard with coverage indicators

### Phase D — v1.5 and beyond

- [ ] **20.** Offline day-of PWA — my shift, booth, crate status, fast lead/meeting entry,
      target-company alerts
- [ ] **21.** Slack adapter · hosting · SSO rollout
- [ ] **22.** Backlog: duty of care · sponsorship campaigns · drayage estimator · public
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
   SSO needs no further build here. What still waits for step 21 is the rollout —
   a real IdP connection, and the domain-to-org mapping that goes with it.
3. **Approval routing:** single Travel Manager queue for the org, or per-department
   approvers? Recommending a single queue for v1; per-department is a schema addition
   that's cheap now and expensive later if wrong.
4. **Hotels:** tracking-only in v1 as scoped, or does the agent book those too? Hotel
   booking is a separate provider integration and roughly doubles §6.
5. **Scale:** how many travelers and shows per year? Under ~50 travelers, some of the
   policy machinery can be simpler. Above a few hundred, background job durability
   needs real attention at step 4, not step 21.
6. **Which CRM?** Salesforce and HubSpot are different enough that I'd build one well
   rather than both adequately. This gates step 19.
7. **Attribution default:** sourced (recommended) or influenced? And what window —
   90, 180, or 365 days? Changes what every ROI number means.
8. **Is staff time in the cost?** Including attendee-days × a loaded rate usually
   doubles the true cost of a show and is the honest number. Some organizations find
   that unwelcome. Your call whether it's on by default, optional, or absent.
   **Step 17 built the half that does not need the answer:** attendee-days are counted
   and shown beside every show's total, and never priced, because there is no loaded rate
   in this workspace and inventing one would be the fabricated figure §8a exists to
   refuse. Deciding this adds a rate and a line; it changes nothing already built.
9. **Pricing model.** ExhibitDay is per-seat ($99–199/mo); Trade Show PRO is **per event**
   (€990, unlimited users). Per-event matches how trade show budgets actually work —
   budgeted individually, often by different owners — and sidesteps the "we only do four
   shows a year" objection. Recommending a hybrid: platform subscription for the always-on
   travel/planning spine, plus a per-show fee where the value concentrates. Not urgent, but
   it shapes what "workspace" means in the data model.
10. **Data residency.** Lead PII plus EU shows may require EU hosting. Competitors lead
    with it. Decide before step 18, since it constrains hosting at step 21.
    **Step 18 built the half that does not need the answer, and it turned out to be most
    of it.** Consent is recorded at capture with a lawful basis that is never defaulted,
    retention has a finite default and a sweep that actually erases, erasure is redaction
    so honouring it does not silently move a year of ROI figures, and who may read a
    stranger's personal data is narrower than who may read a colleague's fare. None of that
    depends on where the database is. What still does: residency is a *hosting* decision
    (step 21), and it is the half that a European customer's procurement team asks about
    first. The posture is portable; the region is not yet chosen.
11. ~~**How wide should the UI rework go, and when?**~~ — **resolved 2026-08-31: option B**,
    the consolidation *and* a full visual pass, brief "modern, bright colors, easy to
    navigate". Not started; step 12.5 (verifying Duffel and Clerk) was taken first. `src/app/` has been growing by
    copy-paste since step 8 — deliberately, because the shape was still being discovered,
    and `ui.tsx` said so in its header. Step 12 tipped it: five drifted copies of
    `FormState`, 42 hand-wired form call sites, and one zone-formatting helper written
    twice *within that one step*. **`UI-REWORK.md` has the measurements, the plan in four
    tranches, and the argument.** Recommending option A there — the plumbing consolidation
    plus one framing defect on the roster, no restyling — because it is the only option
    that gets more expensive with every step and the only one that makes step 13 cheaper.
    A visual pass is worth deferring past steps 13, 16 and especially 19 (the offline PWA),
    which is a change to how the client works rather than a reskin.

    **Update 2026-08-31 — tranches 1–4 shipped.** One `FormState` and one set of form
    helpers; one input / message / submit vocabulary in `_components/form-ui.tsx`; the
    zone→input formatting moved into `lib/datetime/zoned.ts` where it is finally tested
    (there were **four** hand-rolled copies, not the two this was scoped against);
    `team/forms.tsx` split along the three cards the page renders; and the §2a defect fixed
    — an admin no longer gets a first-person "I'm going" form on every colleague's row.
    `pnpm smoke` is new and checks all 17 routes render.

    **Complete 2026-08-31 — all eight tranches.** The visual half too: OKLCH semantic tokens
    in the two-stage `:root`/`.dark` + non-inline `@theme` pattern, a collapsible sidebar
    with an icon rail and a three-state theme control, an extended component vocabulary
    (`Table` with sticky headers and right-aligned money, `PageHeader`, `Stat`), and a sweep
    of all 17 routes. The measurement that says it worked: **`src/app` contains zero `dark:`
    variants** — one token carries both themes, so there is no twin class left to forget.
    `UI-REWORK.md` §10 and §11 are what the work found that the plan did not predict.

12. ~~**Should booth coverage count a confirmation the subject never made?**~~ —
    **resolved 2026-08-31: no, and it no longer does.** Found while fixing §11.11's roster
    defect. §5e and the ground rules already said a confirmation typed on somebody's behalf
    is hearsay inside a staffing number, and two of the three layers already obeyed it —
    `respondToInvitation` stamps `responded_at` only when the subject is the actor, and the
    team tab already rendered a "not answered by them" badge on exactly those rows. Only
    `standingFor` did not: it branched on `attendeeStatus` alone, so an admin-typed
    `confirmed` read as "Confirmed and in town" and filled a slot. The screen was telling
    the truth and the number was not, which is the worse half — the number is what a lead
    reads and stops at. `AssignedStaff` now carries `respondedAt` and there is a fifth
    `Standing` kind, `secondhand`, deliberately kept apart from `unconfirmed` because
    "said yes, chase them to confirm" and "has not answered" are different work items.
