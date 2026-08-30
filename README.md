# Trade Show Concierge

Enterprise trade show management — shows, readiness, people, travel, lodging, booth
shipments, and ROI — built around a **policy-governed agent that buys plane tickets**
inside admin-defined spend and schedule constraints.

The planning side is a known quantity; [ExhibitDay](https://www.exhibitday.com/) and
others do it well. The booking agent is the part nobody self-serve has built, and it is
the part this repository is actually about.

```
pnpm install && pnpm db:reset && pnpm booking:dry-run
```

No API keys. No cloud accounts. No Docker. The whole booking pipeline runs on a clean
clone in about three seconds.

---

## The idea

Three jobs, in priority order:

1. **Cut the tedious work.** Booking flights, chasing confirmations, and re-keying
   tracking numbers should mostly stop happening.
2. **Be the single hub for the material things.** Where is the booth crate, who flies
   when, which hotel, is the banner printed.
3. **Answer "was it worth it?"** True cost against actual pipeline, per show.

The third job is the interesting one, and it falls out of the first two for free.
Most companies cannot answer *what did Dreamforce actually cost us* without a week of
spreadsheet archaeology across expense reports — and they get it wrong. Because this
system **does** the booking and **holds** the shipping, the number is a query.

That is why the booking spine got built before a single screen.

---

## The architecture call

> **An LLM must never be the thing that decides to spend money.**

Comparing a fare against a spend ceiling and a time window is a deterministic
constraint-satisfaction problem. It is testable, explainable, and auditable. An LLM
doing it is none of those, and a hallucinated ceiling comparison is a real charge on a
real card.

So the split is drawn deliberately:

| Layer | Implementation |
|---|---|
| Parse *"I need to be in Vegas by Tuesday noon, back Thursday night"* → constraints | **LLM** |
| Search offers | Provider API (Duffel) |
| Rank and filter against constraints and policy | **Deterministic code** |
| Decide: auto-book / escalate / reject | **Deterministic policy engine** |
| Explain the decision in prose | **LLM** |
| Execute the purchase | Provider + idempotency key |

The LLM proposes and narrates. It never authorizes. Structured output is validated
before it reaches the policy engine, and a human confirms the parsed constraints before
anything is searched — an unreviewed misparse must never be laundered into an
authorized purchase.

---

## Watch it run

`pnpm booking:dry-run` walks the whole loop against seeded data. Within policy, the
agent books without asking anyone:

```
━━ 1. Within policy → booked without asking anyone ━━

    ▸ off_00009htYpSCXrwaB9DnUm0     $430.55  0 stop  economy          auto_approve
      off_00009htYpSCXrwaB9DnHold    $612.00  0 stop  premium_economy  needs_approval  approval_band, fare_ceiling, cabin_ceiling
      off_00009htYpSCXrwaB9DnCon     $318.20  1 stop  economy          deny            departure_window, connection_time

    submit          submitted                  priya@ opened a request: SFO → DTW
    search_start    submitted → searching      Searching SFO → DTW
    search          ·                          3 offer(s); best at $430.55 → auto_approve
    offers_found    searching → offers_found   Chose off_…Um0 at $430.55 — auto_approve
    booking_start   offers_found → booking     Dry-run booking off_…Um0 at $430.55
    ticketed        booking → ticketed         No money moved.
```

Note the cheapest fare lost. It has a 55-minute connection against a 60-minute policy
minimum, so it was denied outright rather than quietly chosen on price. **Policy says
what is allowed; ranking says what is best among the allowed.** Conflating those two is
how a booking agent ends up justifying a bad itinerary.

Over the auto-approve band, it escalates — and then the hard case:

```
━━ 2. Over the auto-approve band → escalated, offer dies, re-priced on approval ━━

    escalate           offers_found → pending_approval  $1,284.90 is above the $1,200 auto-approve threshold
    approval           ·                                dana@ approved up to $1284.90 — the offer had expired, re-searching
    re_search          pending_approval → searching     Re-searching against the approved ceiling of $1284.90
    offers_found       searching → offers_found         Re-search found off_…Intl at $1284.90
    reprice_accepted   ·                                Re-priced at $1284.90, within the approved $1284.90
    ticketed           booking → ticketed               No money moved.
```

**Airline offers expire in about thirty minutes. Approval queues live overnight.** This
is where most booking integrations break, and it is not really a bug about expiry — it
is a question about meaning. What did the approver actually authorize?

The answer this system commits to: **an approval authorizes an amount, not an offer.**
On approval the agent re-searches, re-runs policy against the new fare, and compares. At
or below the approved price it books. Above it, the request goes back into the queue for
a fresh decision rather than quietly charging the difference.

Where the carrier supports it, the agent holds the seat first — but a hold is not always
a price lock, so a held-but-unguaranteed fare still has to survive the re-price. The
approval screen has to say which of the two it got, because approving an unguaranteed
fare is approving an unknown number.

---

## The safety rails

Non-negotiable, and each one earns its place:

- **A server-side hard ceiling at the moment of purchase**, checked against the resolved
  policy rather than trusted from the verdict that got the request that far. A second,
  dumber check that cannot be argued with.
- **One ticket per request, ever.** Enforced by a unique index, not by good intentions.
  Beyond that, every state transition updates `where status = <expected>`, making the
  status column itself the lock — two workers, a double-clicked button, and a retried job
  all lose the race gracefully instead of producing two tickets.
- **No purchase without a policy verdict recorded first.** No exceptions, no fast path.
- **Dry run by default.** Live purchasing needs an explicit env flag *and* a configured
  real provider. Dry-run bookings are stamped `live: false` with a `dryrun:`-prefixed
  order id, so they can never be mistaken for real ones in a query or a report.
- **Separation of duties.** Nobody approves their own over-policy request. When *no*
  eligible approver exists — a one-admin org would otherwise deadlock — the requester may
  self-approve with a written justification, recorded as a flagged break-glass exception.
  The rule stays real; it just never becomes a trap.
- **An immutable audit trail.** Every offer the agent saw, not just the one it took; the
  resolved rule set as applied, not a pointer to today's defaults; every decision, in
  order.

That last one has teeth. Offers vanish from the provider within the hour, so without a
snapshot the question *"why did it pick the $612 fare?"* becomes permanently
unanswerable.

---

## Correctness primitives

Three classes of bug are expensive enough here to be designed out rather than tested for:

**Money is integer cents.** Providers send decimal strings. `parseFloat` on `"430.55"`
is a rounding error waiting to become a reconciliation dispute, so parsing goes through
`src/lib/money/decimal.ts` and nothing else.

**Flight times are local airport time.** Segment times arrive with no offset and are
meaningless without the airport's IANA zone. Read a 4h50m transcontinental flight as UTC
and it measures 7h50m, which quietly trips every duration-based policy rule. Resolution
goes through `src/lib/datetime/zoned.ts`.

**Scheduled times are immutable.** Live and estimated times live in separate columns, so
"delayed 40 minutes" is a computed difference rather than a mutation that destroys the
original plan.

---

## Try it

```bash
pnpm install
pnpm db:reset          # embedded Postgres (PGlite), schema push, realistic seed
pnpm booking:dry-run   # the whole booking loop, headless
pnpm test              # 131 tests; no keys, no network, no browser
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user until Clerk lands at step 7.
Seeded roles: `dana@` admin, `marcus@` travel manager, `priya@` member.

The offers in a keyless run come from a provider named `recorded`, which replays captured
wire payloads through the **production** normalizer. It is not a fake Duffel: it
announces itself as `recorded` in every row it touches, and its `purchase()` throws
unconditionally — there is no configuration of it that can spend money. Duffel with no
key does not invent a fare either; it names the missing environment variable and stops.

---

## Where the project is

The build order is a vertical slice through the riskiest component first. The early
output is a test suite and a seed script, not screens — a deliberate trade, because the
travel-request tables were written from reasoning rather than from a real payload, and
stacking six steps of UI on top of them would have bought weeks of rework.

That call paid off. Every step so far has corrected something the previous step got
wrong, and the corrections are recorded in `git log` rather than silently fixed.

| | Phase A — the spine | |
|---|---|---|
| ✅ | **1.** PGlite, schema, `getActor()` seam, cost centers, seed | |
| ✅ | **2.** Policy engine — pure, versioned, structured verdicts | 47 unit tests |
| ✅ | **3.** Duffel adapter, booking schema corrected against real payload shapes | |
| ✅ | **4.** State machine + dry-run booking end to end | 131 tests |
| ⬜ | **5.** Live purchase behind the flag, kill switch, audit surfacing | |
| ⬜ | **6.** Ticket credit ledger — expiry alerts, auto-applied before new spend | |

Phase B builds the planning core and the screens, *knowing what the spine needs*. Phases
C and D cover logistics telemetry, ROI attribution, and an offline day-of PWA — show-floor
wifi is genuinely unusable, which makes offline an architecture decision rather than a
feature.

Full build order, domain model, and open decisions: **[`SCOPE.md`](SCOPE.md)**.
Competitive analysis and why the deadline engine and credit recovery are the
differentiators: **[`RESEARCH.md`](RESEARCH.md)**.

---

## Layout

```
src/db/schema.ts                 ~34 tables, the domain model
src/lib/auth/actor.ts            getActor() seam; Clerk swaps in behind it at step 7
src/lib/policy/                  the decision layer — pure, deterministic, no DB
src/lib/travel/                  the spine — state machine, policy store, booking agent
src/lib/integrations/flights/    provider interface, Duffel adapter, recorded replay
src/lib/money/ src/lib/datetime/ correctness primitives
scripts/seed.ts                  the only place seed data lives
scripts/booking-dry-run.ts       the whole loop, headless
```

**Stack:** Next.js 16 · TypeScript · Drizzle ORM · PGlite locally, Postgres in
production · Vitest · Duffel for air content · Clerk for auth (step 7).

---

*Built in the open, one documented step at a time. Each commit message explains what was
learned — including what the previous commit got wrong.*
