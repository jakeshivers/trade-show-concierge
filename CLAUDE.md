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

Building **Phase A: the vertical slice through the booking spine** (`SCOPE.md` §10).

**Done:** steps 1–5 — local Postgres + schema + `getActor()` seam; the policy engine;
the Duffel adapter with the booking schema corrected against real payload shapes; the
request state machine with dry-run booking end to end; and live purchasing behind the
flag with a kill switch and a readable audit trail. 155 tests, no keys required.

`pnpm booking:dry-run` walks the whole loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the
reasons worth relaxing, the expiry sweep, the kill switch, and the audit trail as a
person reads it. Read that output before reading the code; it is the fastest way to
understand the spine. `pnpm booking:audit <id | idempotency-key>` prints the same
trail for any one request.

**What step 5 added, and where:** `DuffelProvider.purchase()` (both paths — an instant
order, and paying off a hold — each re-reading the fare first and refusing one that
moved); `src/lib/travel/kill-switch.ts` (org-scoped, append-only, admin-only);
`src/lib/travel/passengers.ts` (the traveler identity an airline requires, which is
never defaulted); `src/lib/travel/audit.ts`; `src/lib/travel/notify.ts` (rail 6).

**Next:** step 6 — the ticket credit ledger (`SCOPE.md` §5b). The provider refuses to
purchase while ignoring applicable credits, so that refusal is the marker for where
step 6 plugs in.

**Deliberately not built:** any product UI. Phase B builds screens *after* the spine has
shown what they need, so `next dev` today serves the default template. An off-plan dev
console was started and abandoned — `next.config.ts` and `lib/readiness.ts` are the
surviving pieces; the page itself was never built.

**Outstanding:** the Duffel adapter — search, hold, *and now purchase* — is verified
against fixtures and mocked HTTP written to the published v2 schema, not a live
response. Nothing has ever been bought. A free test key from duffel.com would confirm
it end to end; the normalizer and purchase tests should pass unchanged against recorded
real responses. Purchasing with that key would produce `live_mode: false` orders, which
the pipeline correctly records as not-spend.

## Ground rules that are easy to violate

- **No fake data behind a real integration.** Missing key → an error naming the env var,
  never an invented fare or delay. Seed data lives only in `scripts/seed.ts`.
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
  approval queues do not. Re-price on approval and re-run policy. `SCOPE.md` §6b.
- **Runs with zero API keys and zero cloud accounts.** `pnpm db:reset && pnpm test`
  must work on a clean clone. Hosting is deferred; do not wire a cloud provider.
- **Every financial row carries a cost center at creation.** Never backfilled.
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
pnpm test         # vitest; no keys, no network, no browser
pnpm typecheck
pnpm lint
```

`DEV_ACTOR_EMAIL` in `.env.local` selects the acting user until Clerk lands at step 7.
Seeded roles: `dana@` admin, `marcus@` travel_manager, `priya@` member.

## Layout

```
src/db/schema.ts              ~35 tables, the domain model
src/lib/auth/actor.ts         getActor() seam; Clerk swaps in behind it at step 7
src/lib/policy/               the decision layer — pure, deterministic, 47 tests
src/lib/integrations/flights/ provider interface + Duffel adapter + `recorded` replay
src/lib/travel/               the spine — state machine, policy store, booking agent,
                              kill switch, passenger identity, audit trail, notifications
src/lib/money/ src/lib/datetime/  correctness primitives; see ground rules
scripts/seed.ts               the only place seed data lives
```
