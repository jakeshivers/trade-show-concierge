# UX backlog — what is left, ranked, with the evidence

**Status:** open · **Written:** 2026-09-08, after `UI-REWORK.md` §21–§22 · **Gates:** nothing

This is a pickup document, in the same sense `UI-REWORK.md` was: work that is not in
`SCOPE.md` §10's build order because it is not a feature. Everything here was found by
sweeping the app rather than by hitting it, so each item carries its evidence and its
effort. **Nothing here is started.**

Read `UI-REWORK.md` §21–§22 first if you have not — they are the two passes immediately
before this, and items 2 and 7 below are the same shape as what those found.

---

## How to look, because it is the only thing that has ever worked here

Two habits, and they find different classes of defect:

1. **Run the CLI and read the output.** Found six real defects (`onConflictDoNothing`,
   `SOURCE_LABEL`, a deduplicated reading, an invisible crate count, two on presence).
   Finds wrong **numbers**.
2. **Read the rendered page as somebody who has to act on it.** `curl` piped through a
   tag-stripper, output actually read. Found the stale overview, `1 flights booked`, and
   the one-word-name hole in the booking agent. Finds **rules that outlived the surface
   feeding them**.

Neither is a test. Every defect both found was invisible to a green suite, usually
because the test had been written to the same wrong rule.

### Already verified clean — do not re-investigate

- **Seed-only tables** (the §24a check): only `organizations` and `show_outcomes`, both
  deliberate. Re-run: for each `pgTable`, does anything outside `scripts/seed.ts` write it?
- **Imperatives have controls** (the §16 check): every "Add a…/Record the…/Run a…" on a
  screen has a real control behind it.
- **Vocabulary scan** (§17, now including `pnpm`): returns nothing on any route except
  `NoDevActor`, which is correctly addressed to a developer.
- **Accessibility vocabulary**: `role="status"` on form messages, `scope="col"` on table
  headers, implicit `<label>` wrapping in `Field`, `sr-only` on every icon-only button.
  Better than assumed. Two nits only, both in item 8.
- **Empty states**: all now say where the thing comes from, and the three above gated
  forms branch on the same predicate the form does (§22).

---

## 1. The shell has no mobile breakpoint — the largest item

**Evidence.** `_components/sidebar.tsx:146-151` is a fixed `w-60` / `w-16` column at every
viewport width. `_components/ui.tsx` contains **zero** `sm:` / `md:` / `lg:` variants.
`layout.tsx:80` is `max-w-6xl px-6`.

**Why it matters more than it looks.** `src/app/manifest.ts` sets
`start_url: '/day-of'` — the screen used **standing on a show floor, on a phone**, and the
one screen in this product most likely to be opened by somebody who is not at a desk. On a
390px viewport the sidebar takes 240px and the capture form gets what is left. The offline
PWA work in step 20 is currently delivered through a desktop shell.

**Shape of the fix.** A drawer under `md:` (the sidebar becomes an overlay with a trigger in
the header, which currently holds only the actor's name and has an empty left side —
`layout.tsx:69-79`). Then walk every screen at 390px. `Table` already has
`overflow-x-auto` (`ui.tsx:93`), so tables degrade acceptably; the risk is card padding,
`PageHeader`'s action row, and the show tab strip.

**Effort:** large — it touches every screen and deserves its own commit. **Decision needed:**
none. This is the recommended next piece of work.

---

## 2. A rejected form submit probably wipes what the person typed — **verify this first**

**Evidence.** React 19.2 with `<form action={action}>` and `useActionState`
(`settings/cost-centers/forms.tsx:8-10` is representative; there are **42 call sites**).
React 19 resets an uncontrolled form after a form action completes. `FormState` is
`{ error?: string; ok?: string }` (`_components/form.ts`) — it carries **no submitted
values back**, and every `defaultValue` in the app (126 of them) is populated from *server*
data, not from the rejected submission.

**Why it matters.** This product's entire posture is *refuse with a good sentence*. If the
refusal also costs the person their input, the good sentence is a punishment. The worst
cases are the longest forms, which are also the ones that refuse most: the travel policy
editor (a dozen numeric fields, and `validatePolicy` refuses on incoherence), show intake,
lead capture with seven fields, and the CSV column mapping.

**This is asserted from React's documented behaviour and has NOT been confirmed in a
browser** — no test covers it and `pnpm smoke` only fetches pages. **Confirm before
building anything.** Repro: `pnpm dev`, open `/settings/cost-centers`, type a code that
collides with an existing one, submit, and see whether the field still holds what you typed.

**Shape of the fix if confirmed.** Widen `FormState` to carry back the submitted values and
feed them to `defaultValue` — `{ error?, ok?, values?: Record<string, string> }` — set in
`formErrorFrom`, which every action already routes through, so it is close to one diff.
Alternatively, `useActionState`'s `permalink`/`requestFormReset` escape hatches. Prefer the
first: it keeps the fix in the one helper the 42 sites share.

**Effort:** medium, and mostly in one file if `formErrorFrom` can carry it.
**Decision needed:** none, but confirm the defect first.

---

## 3. Four detail routes light nothing in the navigation

**Evidence.** `sidebar.tsx:isActive` special-cases only `/shows`:

```ts
if (href === '/') return pathname === '/';
if (href === '/shows') return pathname === '/shows' || pathname.startsWith('/shows/');
return pathname === href;
```

So `/travel/[id]`, `/travel/new`, `/assistant/[id]` and `/day-of/[id]` highlight **no** nav
entry — including `/travel/[id]`, which is the most complex page in the app.

**The reason it is not a one-line `startsWith`.** `/travel` and `/travel/approvals` are
**siblings in the nav**, and the existing comment says so: two entries highlighted at once
tells you less than none. The fix is **longest-match-wins** — compute the best matching
entry across all groups rather than testing each in isolation.

**Effort:** small, one function, and it wants a unit test (`isActive` is pure and currently
untested).

---

## 4. No board can be filtered, sorted or searched

**Evidence.** Zero `<select>`, `type="search"` or `searchParams` on `/shipping`,
`/flights`, `/assets`, `/leads`, `/readiness`. No board caps or paginates — no `.slice()`
anywhere on those pages, so every row renders.

**Why it matters, and why it is not urgent.** Ordering is already carefully designed (see
`UI-REWORK.md`: prospective lists soonest-first, retrospective backwards, `/cost` and
`/safety` by proximity to now, severity as the tie-break) and that is the right default at
today's eight shows. `SCOPE.md` §11.5 resolved scale into a **prohibition**: roughly five
shows a year for the anchor customer, offered as a guideline, and **nothing may be
simplified on the strength of that size**. What it buys is permission to *defer*, which is
what this is — but at forty shows `/shipping` is a wall of crates with no way to say "just
the ones that are late".

**Shape of the fix.** `searchParams`-driven filters so it stays a Server Component and the
URL is shareable — which matters here, because "the crates that missed receiving" is a link
somebody sends a colleague. **Do not add client-side sorting**: a comparator in a page is
one two views can disagree about, and `shows/proximity.ts` exists because that already
happened once.

**Effort:** medium. **Decision needed:** which boards, and filter-only vs. filter + sort.

---

## 5. No global search or command palette

**Evidence.** No `cmdk` or equivalent dependency; no `type="search"` input anywhere; no
`keydown` / `metaKey` handler in `src/`. The header's left side is empty
(`layout.tsx:69-79`).

**Scale of the problem:** 23 nav entries plus 8 shows × 10 tabs. Finding "the Automate
crate" is pure navigation today.

**Effort:** medium-large. **Decision needed:** what it searches. Shows and people are easy;
leads are **not** — `leads/access.ts` narrows who may see the person behind a count, and a
search box that ignores that gate reopens what `travelerScope` exists to close. Any search
must go through the same org-scoped store functions as a screen, which is
`assistant/tools.ts`'s posture and the reason that module is safe.

---

## 6. `/settings` is not a route

**Evidence.** Seven pages under `settings/` and no `settings/page.tsx`; there is no
`settings/layout.tsx` either, so no sub-navigation. "Settings" in the sidebar is a **group
label, not a link**.

Typing `/settings` now lands on the root `not-found.tsx` — which is at least styled since
§21, but it is a dead end that reads as deliberate.

**Effort:** small. An index listing the seven, each with the `does` sentence already in
`_components/nav.ts` — the same derivation the overview uses, so it cannot drift.

---

## 7. Two nits from the accessibility pass, and one loading gap

- **`Field`'s `hint` sits inside the `<label>`** (`form-ui.tsx:92-98`), so a screen reader
  announces the hint as part of the field's *name*. It should be `aria-describedby`. Small,
  and it touches one component.
- **`Message` uses `role="status"` for errors as well as successes**
  (`form-ui.tsx:119-120`). `status` is polite; an error arguably wants `role="alert"`.
  Debatable — decide it rather than drifting.
- **There is one `loading.tsx`, at `(app)/`.** Moving between show tabs therefore blanks the
  show header too, even though `shows/[id]/layout.tsx` is not re-rendering. A
  `shows/[id]/loading.tsx` would keep the header and tab strip and skeleton only the panel.
  Small, and the same argument applies to `settings/`.
- **Six `type="number"` and nine `inputMode`** across the app. Worth a sweep *with* item 1,
  since a wrong mobile keypad only hurts on the device item 1 is about.

---

## 8. Carried over — a design decision, not a gap

**`show_outcomes` is written only by the seed, deliberately.** Its `source` column
anticipates `manual` — "a number somebody typed" — and nothing can type one. Unlike the four
tables the UX pass fixed, this is a **real argument with two sides**: §5k withholds every
ratio built on a replayed pipeline, and whether a figure a company types about *itself*
earns more trust than a replayed one has not been decided. **Decide it deliberately rather
than building the form.**

---

## Recommended order

1. **Item 2**, because it is cheap to *check* and, if real, it is the worst thing here —
   every refusal in a product built on refusals currently costs somebody their typing.
2. **Item 3**, small and it makes the app feel located.
3. **Item 1**, the real piece of work, on its own commit.
4. **Item 6**, then **7**, as they fit.
5. **Items 4 and 5** need a decision before they need code.

## Before committing any of it

`pnpm db:reset` → restart `pnpm dev` → `pnpm typecheck && pnpm lint && pnpm test` **with
the dev server stopped** (they cannot share `.pglite`) → `pnpm smoke` in the same breath as
the tests → re-run the vocabulary scan → and **read the rendered page as each of the three
seeded roles** (`DEV_ACTOR_EMAIL` = `shelley@` admin, `marcus@` travel_manager, `priya@`
member). `tests/docs-budget.test.ts` will stop you writing this up at length in
`CLAUDE.md`; that is deliberate — put the narrative in the commit message.
