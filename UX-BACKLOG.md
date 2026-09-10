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

## 2. ~~A rejected form submit destroys what the person typed~~ — **FIXED 2026-09-09**

Confirmed in a real Chromium, fixed, and re-verified in the same browser. Kept here rather
than deleted because the *shape* of it recurs.

**What was wrong.** React 19 resets an uncontrolled form once a form action completes, whether
or not it succeeded. On a form with no `defaultValue` every field blanked; on one *with* a
`defaultValue` — the travel policy editor — each field silently reverted to the **stored**
value while the error named a different field, so fixing the named field and submitting again
saved the old numbers into a versioned policy row. 42 `useActionState` call sites.

**The fix.** `FormState` gained `values`, `formErrorFrom` fills it from the `FormData` the
action already holds (set on refusal only, so a success still clears the form), and a new
`<Form>` in `_components/form-ui.tsx` restores them.

**`<Form>` writes to the DOM in an effect rather than passing `defaultValue` down, and that
is the part worth remembering.** The obvious fix — `defaultValue={state.values?.x ?? …}` on
each control — was built first and is wrong here: **about ninety of this app's controls are
raw `<input>` / `<select>` / `<textarea>` with local class strings**, not the `Input` /
`Select` / `Textarea` wrappers, because the `UI-REWORK.md` migration moved the form markup and
left those behind. A fix living in the three wrappers covers a minority of the controls **and
looks complete**. The browser said so before the reasoning did: the wrapper version passed on
text fields and failed on the very first checkbox, which was a raw `<input>`.

**Verified in the browser, after:** text fields survive a refusal; the travel policy edit no
longer reverts; a successful add still clears the form for the next one; an unchecked raw
checkbox stays unchecked; and a twelve-field, entirely-raw form (`/shows/new` — text, date,
textarea, select) comes back whole with the store's refusal above it.

**Unit tests** cover the pure contract in `tests/form-state.test.ts` — a refusal carries the
submission, a success does not, a `File` never travels, an unchecked box is absent (which is
how `<Form>` restores one), and a genuine `TypeError` is still rethrown rather than laundered
into a polite red sentence.

**What is still not covered by any test**, and should be understood before trusting the suite
here: the reset itself is DOM behaviour, and this repo's suite is `environment: 'node'` with
no DOM. Nothing in `pnpm test` would notice if `<Form>` stopped restoring. The check is a
browser, by hand or by the harness described below.

**The harness, deliberately not committed.** ~90 lines of Node driving Chromium over CDP
(Node 22 has a built-in `WebSocket`), using a Playwright browser cache that happens to exist on
this machine. It is not in the repo because it depends on a binary a clean clone does not have,
and `pnpm db:reset && pnpm test` with zero keys and zero downloads is a non-negotiable. If this
becomes recurring, the honest version is a real dev dependency and a separate script — never
wired into `pnpm test`.

**Three measurement mistakes while doing this, all the same shape.** The first run reported
*"NOT REPRODUCED"* because the selectors were `document.querySelector('form …')` on a page that
renders a `RenameForm` per cost center — so it drove the wrong form and read `"Renamed."` back
as the refusal. The tell was in the output and nearly went past: `name: 'AExecutive'`, a value
nobody typed. Later, a hydration probe on the *first* `input` on the page timed out, and an
all-raw-form test reported no refusal because the form never submitted — a `required`
`rationale` textarea the script had not filled, which `form.checkValidity()` named in one call.
**When a browser check reports a surprising pass, suspect the selector before the code**, and
read the values a run prints rather than its verdict.

## 2b. The assistant's answers rendered as raw Markdown — **FIXED 2026-09-09**

Reported by a reader looking at a transcript: `**Draft filed:**` and `- **Origin is ORD**` on
screen, asterisks and all. `prompt.ts` never told the model how to format, so it answers in
Markdown, and `/assistant/[id]` rendered the text in a `whitespace-pre-wrap` paragraph.

`src/lib/markdown.ts` parses the subset it writes (paragraphs, bold, italic, inline code, fenced
code, headings, bullet and numbered lists, links) and is **pure**, so it has real tests in a
suite with no DOM — which matters after item 2, whose behaviour could only ever be checked in a
browser. `_components/prose.tsx` maps tokens to React elements: no `dangerouslySetInnerHTML`, and
no raw-HTML escape hatch to leave open. Model output is the least trusted text in the app — it is
shaped by tool results, which are shaped by rows a stranger at a booth typed into a lead form.

Two rules it follows. **Anything unsupported degrades to the lines the model wrote**, never to a
mangled approximation — a table comes out as prose, which is exactly the old behaviour and is
honest. And **a link renders only for a relative, `http(s)` or `mailto` href**; anything else,
`javascript:` first, degrades to the model's *literal token* rather than its link text, because
the href pattern stops at the first `)` and dropping it would leave a stray bracket behind.

**The user's own message is deliberately not passed through it.** Those are their words, and a
stray asterisk there is theirs to keep.

**Bare paths are clickable too, as of the same day.** The model writes `/travel/<id>` in prose
rather than as a Markdown link, so the draft flow told people to open something that was not a
link. Which paths count is `isAppPath` in `nav.ts` — **derived from the nav's own first
segments**, never listed, because a hand-written route set beside a growing nav fails *silently*:
a new section's paths would quietly stop being clickable and nobody would file it. It matches on
the first segment (so `/travel` covers `/travel/<id>` and `/travel/approvals`) and deliberately
does **not** check the row exists — that is a query per path, and a stale id lands on
`not-found.tsx` inside the shell with a way back, which beats refusing to link the thing the
draft flow just told somebody to open. A path inside `code` is never linkified: that is the one
place a path is being *shown* rather than offered.

Emphasis had to start carrying spans rather than a string for this, because the path the reader
actually saw was wrapped in bold — a bold token holding plain text could never make it clickable.

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

1. ~~Item 2~~ — **done 2026-09-09.**
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

---

## Added 2026-09-09 — the executive brief (`pnpm deck`, and a Download button)

Built, not backlog. Recorded here because two things about it are open.

**What it is.** `src/lib/deck/` turns a show into a PowerPoint for a leadership
audience: last year's results, this year's dates and committed spend, who is going, what we
are going for, where preparation stands, and a closing *what this brief does not know*.
`plan.ts` is pure and holds every rule about what a slide may claim; `build.ts` is pptxgenjs
and nothing else; `store.ts` loads through the same store functions the screens call, as the
acting actor. `pnpm deck <show id>` prints the outline then writes the file;
`GET /api/shows/[id]/deck` is the download behind the header link.

**Open 1 — the seed cannot demonstrate the headline slide.** Last year is the show
`show_decisions.cloned_from_id` points at, and **`scripts/seed.ts` never clones**, so every
seeded show reports "no prior year is linked". The slide was verified by cloning a show
through the real `cloneShow` and reading the result, not by a fixture. Either the seed should
clone one pair (Automate 2025 → 2026 is the natural one, and it is what the workspace's own
story already says), or this stays a feature you have to make data for — the same shape as
step 14's finding that every show was too far out to have shipped anything.

**Open 2 — the seeded show names do not match their dates.** "Automate 2025" is dated
July 2026 in the seeded workspace, because the seed places shows relative to today while the
names are fixed. It is harmless on a screen and looks wrong on a slide headed *Last year —
Automate 2025* next to dates two months ago. Pre-existing, not introduced here.

**One defect this found in itself, by reading `pnpm deck`.** The prior-year slide printed
`Pipeline sourced: $0` while closed-won and the multiple both correctly refused — because
pipeline was rendered unconditionally from `pipelineCents`, which is 0 when no CRM is
connected. A printed zero states that the show sourced nothing; the truth is that nobody has
looked. Pipeline now inherits closed-won's refusal, since both derive from the same
attribution. Neither a test nor a type would have caught it: the number was real and the code
was correct.
