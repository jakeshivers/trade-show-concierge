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

## Where we are

Building **Phase A: the vertical slice through the booking spine** (`SCOPE.md` §10).
Steps 1–3 done: local Postgres + schema + actor seam, the policy engine, and the Duffel
adapter with the corrected booking schema. **Step 4 is next**: travel request state
machine + dry-run booking end-to-end, headless.

Deliberately not built yet: any product UI. Phase B builds screens *after* the spine
has shown what they need. A `next dev` today serves the default template.

## Ground rules that are easy to violate

- **No fake data behind a real integration.** Missing key → an error naming the env var,
  never an invented fare or delay. Seed data lives only in `scripts/seed.ts`.
- **An LLM never decides to spend money.** It parses requests into constraints and
  narrates verdicts. The policy engine is deterministic, pure, and the only thing that
  authorizes. `SCOPE.md` §6a.
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
src/lib/policy/               the decision layer — pure, deterministic, 60+ tests
src/lib/integrations/flights/ provider interface + Duffel adapter
src/lib/money/ src/lib/datetime/  correctness primitives; see ground rules
scripts/seed.ts               the only place seed data lives
```
