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

Phase A (**the vertical slice through the booking spine**) is done; Phase B has started.

**Done:** steps 1–7 — local Postgres + schema + `getActor()` seam; the policy engine;
the Duffel adapter with the booking schema corrected against real payload shapes; the
request state machine with dry-run booking end to end; live purchasing behind the flag
with a kill switch and a readable audit trail; the ticket credit ledger; and Clerk wired
to the seam with per-org login-method control and a first app shell. 231 tests, no keys
required.

`pnpm booking:dry-run` walks the whole booking loop headless — auto-book within policy,
escalation with re-price-on-approval after the offer expires, `no_options` with the
reasons worth relaxing, the request expiry sweep, the kill switch, credit-first
escalation, the credit expiry sweep, and the audit trail as a person reads it. Read
that output before reading the code; it is the fastest way to understand the spine.
`pnpm booking:audit <id | idempotency-key>` prints the same trail for any one request,
and `pnpm credits` prints the credit ledger.

**What step 7 added, and where:** `src/lib/auth/mode.ts` — `authMode()`, dependency-free
so `proxy.ts` can read it without pulling PGlite's WASM into the proxy bundle;
`src/lib/auth/clerk.ts` — session → provisioned user, with the three rules that file
exists to hold; `src/lib/auth/login-methods.ts` — the login-method gate, pure and
testable like the policy engine; `org_login_policies` in the schema (versioned,
append-only, a written reason required in both directions) with
`src/lib/auth/login-policy-store.ts` over it; `src/proxy.ts` (Next 16's rename of
Middleware) which is Clerk's context in Clerk mode and a pass-through otherwise; and the
first screens — the app shell under `src/app/(app)/`, the overview, `/settings/security`,
and Clerk's sign-in and sign-up routes.

**The correction step 7 turned up, because it reshaped the feature:** a login-method
restriction is enforced at sign-in, and we are not present at sign-in. Clerk's session
records *that* you are authenticated, never *how* — verified against the installed
`@clerk/backend` 3.16 types, where `Session` has no strategy and the claims carry only
`factorVerificationAge`. So our gate checks the credentials an account **holds**
(`passwordEnabled`, `externalAccounts`, `enterpriseAccounts`, `web3Wallets`) rather than
the one it used: an SSO-only org refuses a session the moment the account still has a
password. It fails closed. The header of `login-methods.ts` is the long version;
`SCOPE.md` §3 has the rest, and `/settings/security` says it on screen so no admin
believes this page turns passwords off inside Clerk.

**Next:** step 8 — show list, show detail tabs, My Itinerary, cloning, intake
(`SCOPE.md` §10, Phase B).

**Deliberately not built:** the planning screens. The shell has two nav entries because
two pages exist; steps 8–12 add the rest, and a nav that promised Shows and Itinerary now
would read as a broken product rather than an unbuilt one. An off-plan dev console was
started and abandoned at step 3 — `next.config.ts` and `lib/readiness.ts` are the
surviving pieces; the page itself was never built.

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
  approval queues do not. Re-price on approval and re-run policy. `SCOPE.md` §6b.
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
pnpm dev          # the app shell; runs with no Clerk keys on the dev seam
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
src/proxy.ts                  Next 16's Middleware: Clerk's context, or a pass-through
src/lib/auth/                 the seam — getActor(), the Clerk adapter, login-method
                              control (pure gate + versioned policy store)
src/lib/policy/               the decision layer — pure, deterministic, 47 tests
src/lib/integrations/flights/ provider interface + Duffel adapter + `recorded` replay
src/lib/travel/               the spine — state machine, policy store, booking agent,
                              kill switch, passenger identity, credit ledger, audit
                              trail, notifications
src/lib/money/ src/lib/datetime/  correctness primitives; see ground rules
scripts/seed.ts               the only place seed data lives
```
