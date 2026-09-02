# UI rework — the case, the plan, and the one decision it needs

**Status:** complete — tranches 1–8 shipped · **Written:** after step 12 (2026-08-30) ·
**Updated:** 2026-08-31 with the foundation survey, the scope call, and the results of
tranches 1–4 · **Gates:** nothing

> **Where this stands: done.** All eight tranches are committed and verified —
> `pnpm typecheck && lint && test` green at 441 tests, `pnpm smoke` 17/17. §10 records what
> the work found that this plan did not predict, including one defect (§10 item 6) that is
> **still open and needs a call**, tracked as `SCOPE.md` §11.12.

> **Decision made (2026-08-31): option B — the plumbing tranches *and* a visual pass.**
> Brief: "modern, bright colors, easy to navigate." §4 below argued for deferring the
> visual half; that argument was heard and overruled, and it is kept unedited because
> parts of it stay true and should be designed *around* rather than forgotten. §6 is the
> foundation survey done at decision time; §7 is what the research changed. Step 12.5
> (verifying Duffel and Clerk) was taken first and is complete through Part A.

This is the pickup document for a piece of work that is *not* in `SCOPE.md` §10's build
order, because it is not a feature. It is the consolidation the app layer has been
deferring since step 8, plus one defect that consolidation would have prevented.

Read this with `src/app/(app)/_components/ui.tsx` open. That file's header is what
scheduled this work:

> Deliberately plain: step 8's job is to make the domain legible, and a design system
> invented before there are ten screens to test it against is a guess.

That was the right call and it named its own expiry. **There are now 16 routes.** The
precondition has been met, and the strain is measurable rather than aesthetic.

---

## 1. Why now, in one paragraph

Every step from 9 to 12 added a `forms.tsx` and an `actions.ts` by copying the previous
one. That was correct while the shape was still being discovered — three examples is when
you learn what the abstraction actually is, and inventing it at one would have been the
guess `ui.tsx` warned about. Step 12 is where it tipped: it produced the *fourth and fifth*
copies, and it duplicated one helper **twice inside a single step**, in two files written
hours apart. Step 13 would have made that three. The cost of this work only goes up, and
unlike a visual redesign it is not invalidated by anything in Phase C.

---

## 2. What is actually wrong

### 2a. A defect, not just duplication — the roster offers you somebody else's answer

On `/shows/[id]/team`, `AttendeeControls` renders `AnswerForm` for every row where
`entry.mayRespond` is true (`team/forms.tsx:71`). `mayRespond` is
`canRespondForAttendee(actor, attendee)` (`lib/team/store.ts:263`), which is *own row **or**
`canApprove`* — and that second clause is deliberate and correct, because people go on
leave and a roster nobody but its subject can correct accumulates permanently stale rows.

The permission is right. The **framing** is wrong. An admin opening the tab is shown a
first-person form on all five colleagues' rows:

```
Tomás Iglesias   confirmed   Technical demos
  [ Not answered | I'm going | I can't make it | Waitlist ]  lands __ leaves __  [Save]
```

Shelley is not going to be Tomás. Answering *for* somebody is a legitimate act with a
different name, a different label, and arguably a different affordance — and the rendered
output above is from the actual smoke test, not a hypothetical.

This is exactly the class of bug a shared form vocabulary prevents: the control was written
once for the person's own row and then rendered, unexamined, everywhere the permission
happened to allow.

**Related, same screen:** each roster row carries three separate forms — answer (always
visible), edit (collapsed), un-staff (always visible) — so a read-mostly list renders five
controls per person. Side events do the same: every event renders its full edit form and a
full guest-invite form inline. The page is correct and unreadable.

### 2b. Duplication, measured

| | count | note |
|---|---:|---|
| routes under `(app)` | 16 | `ui.tsx` said ten |
| `useActionState` call sites | 42 | each hand-wires hidden inputs, submit, pending, error |
| exported server actions | 42 | one per call site; the 1:1 is the tell |
| files declaring their own `FormState` | 5 | **and they have drifted — see below** |
| files hand-rendering inline error text | 11 | the same `text-rose-700 dark:text-rose-400` span |
| copies of the same `input` class string | 6 | verbatim |
| identical `Intl.formatToParts` date→input helpers | 2 | both written in step 12 |
| uses of the same bordered-row Tailwind | 16 | `border-b border-zinc-100 …` |

Two of these are worse than the raw count suggests.

**`FormState` has drifted into three incompatible shapes**, which is what happens when a
type is re-declared rather than shared:

```
settings/security/actions.ts:8   { error?: string; saved?: string }
shows/actions.ts:11              { error?: string }
travel/actions.ts:26             { error?: string; ok?: string }
shows/[id]/readiness/actions.ts  { error?: string; ok?: string }
shows/[id]/team/actions.ts:35    { error?: string; ok?: string }
```

`saved` versus `ok` is a success message that renders in one place and silently does not in
another. And the drift already forced a bad import: `shows/[id]/lodging/actions.ts:12` does
`import type { FormState } from '../team/actions'` — the lodging tab now depends on the
team tab's action module for a type that belongs to neither.

**The date helper was written twice in one step**, at `team/forms.tsx:106` (`iso`) and
`lodging/forms.tsx:40` (`local`). Same `Intl.formatToParts` call, same hour-24 workaround,
same purpose: render an instant as the wall-clock strings a `<input type="date">` and
`<input type="time">` want, in the *show's* zone. This one is not cosmetic — it is the
browser-zone bug that `src/lib/datetime/zoned.ts` exists to prevent, reimplemented by hand
in the view layer, twice, with no test covering either copy.

### 2c. One file is out of control

```
761  shows/[id]/team/forms.tsx      ← 16 useActionState calls
398  shows/[id]/readiness/deadline-forms.tsx
375  shows/[id]/readiness/page.tsx
352  travel/[id]/page.tsx
346  shows/[id]/team/page.tsx
331  shows/[id]/readiness/forms.tsx
319  shows/[id]/lodging/forms.tsx
190  _components/ui.tsx             ← the entire shared vocabulary
```

`team/forms.tsx` is twice the next largest file and four times the shared vocabulary it is
supposedly built from. That ratio is the whole argument in one line.

---

## 3. The plan

Four tranches, ordered so each is independently committable and the risky one is last.

**Tranche 1 — one `FormState`, one error surface.** Move `FormState` to
`src/app/(app)/_components/form.ts` with a single shape (`{ error?, ok? }`; migrate
`security`'s `saved`). Add the `asFormError` / `refresh` / `optional` / `str` helpers that
all five `actions.ts` files already define privately, verbatim. Delete the
lodging→team type import. *Buys:* the drift cannot recur, and step 13's actions file starts
from a shared base instead of a copy.

**Tranche 2 — a `<Field>` / `<SubmitRow>` pair.** One component owning the `input` class
string, the pending state, the disabled-submit rule, and the error/ok span. The 42 call
sites keep `useActionState` — that is React's API and there is nothing to wrap — but stop
hand-rendering the four things around it. *Buys:* ~11 inline error spans and 6 class-string
copies collapse; a change to how errors look is one diff.

**Tranche 3 — `<ZonedDateTimeField>`.** One component that takes an instant and a zone and
emits the paired date/time inputs, replacing both hand-written helpers and labelling itself
with the zone. Push the formatting into `src/lib/datetime/zoned.ts` beside
`instantToZoned`, where it is *testable* — currently neither copy is covered. *Buys:* the
one item on this list that is a correctness risk, not a tidiness one.

**Tranche 4 — split `team/forms.tsx` and fix §2a.** Break it into `roster-forms.tsx`,
`shift-forms.tsx`, `side-event-forms.tsx` (matching the page's three cards). While in
there: render `AnswerForm` only on the actor's own row, and give the approver path its own
control, labelled as answering *for* somebody. Collapse the per-row control stack so the
default state of a roster row is readable. *Buys:* the defect goes, and the file stops being
the place nobody wants to open.

---

## 4. What this originally deferred — kept, because half of it still holds

**Superseded as policy by the decision above; preserved as argument.** The visual pass is
now in scope. What stays true is the *timing risk* it names, and the answer is to design so
that steps 13/16/19 extend the system rather than contradict it — see §7.

No visual redesign — no typography pass, no density system, no dashboard rework, no nav
restructure. That is a real and separate job, and it is worth *waiting* on, for a reason
this document should be honest about rather than pretending the two are the same size:

- **Step 13** (flight tracking) and **step 17** (the alerts feed) each add screens, and an
  alerts feed in particular is a new layout primitive, not another table.
- **Step 19** is an offline day-of PWA. That is a genuine change to how the client works —
  not a reskin — and it is the first screen with a hostile environment (show-floor wifi) and
  a real interaction budget. Design decisions made now get remade there.
- The nav is flat with 7 entries and grows one per screen. It needs restructuring *once*,
  against the final set, not twice.

The tranches above are all invariant to that. They are plumbing, and plumbing done early is
cheaper; visual design done early is done twice.

*Standing where it landed:* the tranches come first regardless, because a redesign touches
every form anyway — so the consolidation stops being separate work and becomes the surface
the new visual language is applied to. Doing it the other way means restyling six copies of
the same input and then deleting five of them.

---

## 5. ~~The decision this needs~~ — resolved 2026-08-31: **option B**

Recorded as `SCOPE.md` §11 item 11. Kept for the record; the options, with what each cost:

| Option | Scope | Note |
|---|---|---|
| **A** *(recommended)* | Tranches 1–4 | Plumbing plus the defect. No restyling. |
| **B** | Tranches 1–4 + a visual pass | Bigger, more subjective, partly redone at 13/16/19. |
| **C** | Tranche 4 only | Fixes what is actively misleading, leaves the duplication. |
| **D** | Defer entirely | Step 13 writes the third copy of the date helper. |

**Recommending A.** It is the one that gets strictly more expensive with every step, it
carries the correctness item (§2b, the untested hand-rolled zone formatting), and it is the
only one that makes step 13's screens cheaper rather than more of the same.

---

## 6. The foundation survey (2026-08-31)

Done at decision time, because the visual half depends entirely on what is already there
and none of this was written down. **Every finding below was surprising in a useful
direction.**

### 6a. Three dependencies are installed and completely unused

```
lucide-react     ^1.37.0   ← zero icon usage anywhere in src/app
clsx             ^2.1.1    ← no cn() helper exists
tailwind-merge   ^3.6.0    ← ditto
```

The app renders **no icons at all** today. So a modern, dense, navigable UI — icon rail,
status glyphs, affordances on buttons — needs **no new packages**, which removes the main
objection to doing this work at all. `clsx` + `tailwind-merge` is exactly the standard
`cn()` pair, already paid for.

### 6b. Tailwind **v4**, CSS-first — and there is no config file

`tailwindcss: ^4` with `@tailwindcss/postcss`. **No `tailwind.config.*` exists** and none
should be created; v4 moved theming into CSS via `@theme`. Anyone reaching for a JS config
out of habit will be confused for an hour.

### 6c. The dark-mode trap, which is the single most expensive thing to get wrong

`globals.css` currently uses **`@theme inline`**. Per the v4 guidance, `@theme inline`
**bakes values at build time and breaks runtime theme switching.** The working pattern is
two-stage:

```css
:root  { --brand: 62% 0.19 256; }        /* raw channels, light */
.dark  { --brand: 72% 0.16 256; }        /* same names, dark */
@theme { --color-brand: oklch(var(--brand)); }   /* NOT inline */
```

Discovering this after building the palette means rebuilding the palette. It is written
here so that does not happen.

Related, and worth fixing in the same pass: **OKLCH** is the modern choice for the scale
(perceptually uniform, so a 10-step ramp is visually even rather than bunching in the
mid-tones) — which matters a lot for "bright colors" that must stay legible at small sizes.

### 6d. `globals.css` is still Next.js boilerplate

The entire file is two color tokens plus a stray rule:

```css
body { font-family: Arial, Helvetica, sans-serif; }
```

…which fights the Geist font `layout.tsx` loads via `next/font`. The Tailwind `font-sans`
class on `<body>` currently wins on specificity, so the app *looks* right by accident. This
file is not a foundation to extend; it is boilerplate to replace.

Fonts themselves are fine and already wired: `Geist` and `Geist_Mono` via `next/font/google`
exposing `--font-geist-sans` / `--font-geist-mono`.

### 6e. Dark mode has no toggle

It is `prefers-color-scheme` only. Every screen is already written with `dark:` variants, so
the work is a token swap plus a control — not a re-authoring.

---

## 7. What the navigation research changed

The brief was "easy to navigate," and the current nav is a **flat horizontal bar with 7
entries** that grows by one per screen — `/`, `/shows`, `/readiness`, `/itinerary`,
`/travel`, `/travel/approvals`, `/settings/security`, with steps 13–18 each adding more.

Current practice for exactly this product shape — data-dense B2B with many sub-modules — is
a **collapsible left sidebar at 240–280px with a 64px collapsed icon rail**, because it
scales vertically as sections are added instead of cramming a horizontal bar. That directly
answers the objection §4 raised ("it needs restructuring *once*, against the final set"):
a sidebar **is** the structure that absorbs steps 13–18 without another restructure, so
building it now is what makes it a one-time job rather than the reason to defer.

Two more findings that fit this app specifically:

- **Right-align financial columns and make dense list headers sticky.** This app is full of
  money columns (fares, penalties, nightly rates, exposure) and long scrolling registers.
- **Active state needs real contrast, not a subtle shift** — orientation inside a deep nav
  is the thing dense products get wrong. Relevant here because show detail already has six
  tabs nested under a nav entry.

Deliberately *not* adopting: drag-and-drop rearrangeable dashboard widgets, which the
sources push as a 2026 trend. This app has one dashboard and a strong point of view about
what belongs on it; user-arrangeable widgets would dilute that and is a feature, not a
redesign.

### Sources

- [SaaS UI/UX design best practices 2026](https://www.theskinsfactory.com/uiux-design-blog/saas-ui-ux-design-best-practices-2026)
- [Anatomy of high-performance SaaS dashboard design](https://www.saasframe.io/blog/the-anatomy-of-high-performance-saas-dashboard-design-2026-trends-patterns)
- [Dashboard design patterns 2026](https://artofstyleframe.com/blog/dashboard-design-patterns-web-apps/)
- [Design system tokens with Tailwind v4 `@theme inline`](https://kuray.dev/blog/ui-ux-design/design-system-tailwind-v4-semantic-tokens-072025)
- [Tailwind v4 practical guide — CSS-first tokens, dark mode, a11y](https://tomodahinata.com/en/blog/tailwind-css-v4-css-first-design-tokens-production-guide)
- [Theming in Tailwind v4: multiple color schemes](https://medium.com/@sir.raminyavari/theming-in-tailwind-css-v4-support-multiple-color-schemes-and-dark-mode-ba97aead5c14)

---

## 8. Revised order of work

Tranches 1–4 from §3 are unchanged and still come first — a redesign restyles every form,
so consolidating them first means styling one input rather than six. The visual work then
layers on:

**Tranche 5 — tokens.** Replace `globals.css` wholesale: OKLCH semantic scales
(`surface`, `text`, `border`, `brand`, plus the four existing tones good/warn/bad/info) in
the two-stage `:root` / `.dark` + non-inline `@theme` pattern from §6c. Add `cn()` over the
already-installed `clsx` + `tailwind-merge`. Delete the Arial rule.

**Tranche 6 — the shell.** Collapsible left sidebar with icon rail, replacing the flat top
nav. Group the 7 entries (Plan / Travel / Settings) so steps 13–18 have somewhere to land.
Add the dark-mode toggle §6e is missing.

**Tranche 7 — the component vocabulary.** Extend `ui.tsx` from 190 lines to a real set:
`Card` with density variants, `Table` with sticky headers and right-aligned money,
`Badge`/`Tone` on the new tokens, `Button` variants, `EmptyState`, and lucide icons
throughout.

**Tranche 8 — the sweep.** Apply across all 16 routes, screen by screen, verifying each
renders. `/` and `/readiness` carry the most visual weight and should go last, once the
vocabulary has been proven on the simpler screens.

**One rule that does not change:** the §2a defect fix is still its own commit with its own
reasoning, not folded into a restyle. A behaviour change hidden inside a 2,000-line visual
diff is invisible to review.

---

## 9. How to verify it, and why that is enough

**All 436 tests are pure** — no DOM, no rendering, no database. None of them touch
`src/app/`. That is a genuine safety net for this work and a genuine gap in it, and both
facts matter:

- The *safety* is that no tranche here can break a test without also breaking `pnpm
  typecheck`, because the only coupling between `src/lib` and `src/app` is types.
- The *gap* is that nothing proves a page still renders. So the check is manual and it is
  cheap: `pnpm db:reset && pnpm dev`, then fetch all 16 routes and confirm 200 plus
  expected text. That is exactly how step 12 was verified; the strip-tags one-liner is in
  that session's history and worth committing as `scripts/smoke.ts` as part of tranche 1.

Also run, unchanged and expected green:

```bash
pnpm typecheck && pnpm lint && pnpm test    # 436 passed, 11 skipped, no keys
pnpm roster && pnpm deadlines               # the two CLIs that read what these screens show
```

**One rule while doing this work:** no behaviour changes except the §2a fix, which is named
here and belongs in its own commit with its own reasoning. A refactor that quietly alters
what a screen permits is indistinguishable from a bug six months later, and this app's
permission split (`readiness/access.ts`, `deadlines/access.ts`, `team/access.ts` — the same
line found three times from three directions) is the part least safe to disturb by accident.


---

## 10. What tranches 1–4 found that this document did not predict

Written as they landed, because each one corrects a measurement in §2.

**1. `FormState`'s drift had a third victim, and "verbatim" duplication was not
verbatim.** Two of the helpers that looked identical across five files were not.
`travel/actions.ts`'s `asFormError` carries an extra branch that renders any `Error` with a
message — the booking agent throws bare `Error`s for real, explainable conditions — and
folding it into the shared helper silently would have made four other screens swallow their
next genuine bug. Its `str` trims and the other four do not, which matters because an
airport code with a trailing space is a failed search. Both are kept, named, with the reason
at the definition. **Read a "verbatim" copy twice before deleting it.**

**2. `refresh` should not be shared, and §3 was wrong to list it.** Each tab's revalidation
set differs in load-bearing ways — lodging revalidates the deadline register because a room
block cutoff owns a row in it, team revalidates lodging because un-staffing moves a room
assignment. A shared version would take the paths as an argument, which is `revalidatePath`.

**3. `Field` was duplicated too, and had already drifted in a way that matters.**
`shows/new` renders the hint *above* the control and `travel/new` *below* it. Not cosmetic:
several hints carry the only warning a person gets about something this codebase treats as
a correctness rule ("deadlines are read in the show's local time, not yours"), and a
warning printed under the box you have already typed in is decoration. The shared `Field`
puts the hint first.

**4. §2b undercounted the date helper. There were four copies, not two.** `iso` (team),
`local` (lodging), `dateInput` (checklist), `localPart` (deadline register) — four
hand-rolled `Intl.formatToParts` calls, none tested. `lib/datetime/zoned.ts` now owns
`zonedDateInput` / `zonedTimeInput` / `zonedDateTimeInput`, all derived from
`instantToZoned`, with five tests including one that asserts the `toISOString().slice(0,10)`
failure directly so the reason cannot be refactored away by somebody who reads the helpers
as trivial. `<ZonedDateTime>` labels itself with the zone, read **at the instant being
edited** rather than at now — a shift in July is CDT and one in January is CST.

**5. The smoke check had to stop asking the database which travel request exists.**
`limit(1)` off `travel_requests` is not the same set as what `/travel` links to, because
`travelerScope` narrows the queue to the acting user unless they can approve. The script
404'd intermittently on a row that was correctly refused. A smoke check that fails on
correct authorization is one people learn to ignore, which would have made the whole safety
net worthless by tranche 8. It now reads the id out of the approvals queue.

**6. The §2a defect had a second half, in `src/lib`.** ← *resolved 2026-08-31, in its own
step; `SCOPE.md` §11.12*

`RosterEntry.isSelf` and the separate "Record Tomás's answer" control fix what the *screen*
claimed. But the ground rule says: *"Only the person confirms their own attendance …
Coverage counts confirmations, so one typed on somebody's behalf is hearsay inside a
staffing number."* The store honours the first half — `respondToInvitation` stamps
`responded_at` only when `attendee.userId === actor.userId`. **`standingFor` never reads
`responded_at`.** It branches on `attendeeStatus !== 'confirmed'` alone
(`src/lib/team/coverage.ts:126`), so a status of `confirmed` typed by an admin — through the
proxy control, or through the roster Edit form, which also carries a status select — yields
"Confirmed and in town" and **counts toward booth coverage**, with `responded_at` still
null recording that the subject never answered.

So the hearsay the ground rule forbids does reach the staffing number today. It was not
caused by this work and is not fixed by it.

It was left open through the rework deliberately — a domain decision rather than a refactor,
and this tranche's one rule is that behaviour does not change — then fixed immediately
afterwards as its own step. `standingFor` now requires `responded_at` before a `confirmed`
counts, producing a fifth standing, `secondhand`, kept apart from `unconfirmed` because
"said yes, chase them to confirm" and "has not answered" are different work items.

Worth keeping for the pattern, which is the general lesson of the whole rework: **the write
path obeyed the rule, the screen displayed the distinction, and the number ignored both.**
Two of three layers being right is what made it survive three steps — every place a person
would have gone looking was correct.


---

## 11. What tranches 5–8 changed, and the one measurement that says it worked

**Tranche 5 — tokens.** `globals.css` replaced wholesale: OKLCH semantic scales in the
two-stage `:root` / `.dark` + non-inline `@theme` pattern §6c warned about, the Arial rule
deleted, `cn()` added over the already-installed `clsx` + `tailwind-merge`. Dark mode became
a **class** with a synchronous no-flash script in the root layout, because a media query
cannot be overridden by a person — only obeyed — which is why there had been no toggle.

**Tranche 6 — the shell.** A collapsible sidebar with a 64px icon rail, grouped Plan /
Travel / Settings, lucide icons, and the three-state theme control ("follow the system" is a
real answer that a two-way toggle destroys the first time it is pressed). Both preferences
read through `useSyncExternalStore` rather than useState-plus-effect: React 19 flags the
latter, and it paints one frame of the default before correcting, so somebody who collapsed
the nav watches it open and shut on every navigation.

**Tranche 7 — the vocabulary.** `Table`/`Th`/`Td` with sticky headers and a `numeric` flag
that right-aligns *and* sets tabular figures; `PageHeader`; `Stat` whose `note` is not
optional decoration; `Card`, `Badge`, `Button`, `LinkButton` reworked. There is deliberately
**no `danger` button variant** — every destructive action here is either reversible in the
app or irreversible *outside* it, and a red button implies the app can undo what it cannot.

**Tranche 8 — the sweep.** All 17 routes, ~300 palette classes.

### The measurement

**`src/app` now contains zero `dark:` variants.** That is the number worth keeping, because
it names the bug class the old approach carried: dark mode was a twin class on every line
that had a colour, so adding a colour meant remembering to add its twin, and forgetting was
invisible to anybody working in light mode. One token now carries both themes.

Four page headings stayed hand-rolled on purpose. `/shows/[id]` and `/travel/[id]` are
detail headers carrying badge rows and a tab bar; pushing that into `PageHeader` would put
shape into a shared component exactly one caller wants — which is the thing this rework
spent eight tranches unwinding.

## 12. The ninth thing, found by a user rather than by the plan (2026-09-02)

The rework made every screen *look* consistent and left a defect none of its eight tranches
was shaped to catch: **the portfolio boards have no calls to action.** Asked on `/shipping`,
"how does a user enter a new tracking number?", the honest answer was *click a crate, land on
its show's Logistics tab, scroll past everything, find the form* — and if there had been no
crates at all, the `Empty` state said so in a sentence that disappeared the moment the board
had one row. Ten screens were like this: `/shipping`, `/readiness`, `/leads`, `/safety`,
`/flights`, `/itinerary` and `/assets` all rendered a `PageHeader` with no `action`, and
`PageHeader` had supported one since tranche 5.

**The cause is structural rather than cosmetic, which is why it survived a visual pass.**
Every board reads across the whole calendar; every *write* belongs to one show, because a
crate, a task, a lead and a roll call cannot exist without one. That is the right model. It
just means the boards have nowhere to put a button that a single `href` could satisfy.

`_components/go-to-show.tsx` is the answer, and the important thing about it is what it
refuses. It is a **chooser, not a shortcut**: it will not guess the show. "The next one" is
wrong about as often as it is right — there is nothing on a board that says which show the
reader has in mind — and a wrong guess files a crate against the wrong show as readily as the
right one, which is `§5j`'s identity rule from the navigation side. It is a `<details>`
element, so it is a Server Component with no client JavaScript, and its list is real rows
ordered by proximity to *now* (the `/day-of` picker's rule) rather than alphabetically.

Three things fell out of building it:

1. **A call to action must carry the same gate as the form it points at.** `Add freight` is
   behind `canManageShipments`, `Start a roll call` behind `canStartRollCall`, and the two
   asset buttons behind `canManageAssets` — the same predicate that renders the form further
   down the page. A CTA that scrolls a Member to nothing is worse than no CTA, because it
   reads as a broken product rather than an unavailable one. `Capture a lead` and `Open a
   checklist` are deliberately ungated: capture is anybody's and reporting progress is
   anybody's, and gating either would be the `§8c` bad-count-by-construction failure.
2. **An anchor is part of the destination, not of the link.** `#new-freight`, `#new-asset`
   and `#new-collateral` are ids on the destination pages with `scroll-mt-6`, so the form is
   on screen rather than under the fold of a Logistics tab that renders three models.
3. **`/flights` and `/itinerary` get a plain `Request travel` link, and that is the honest
   CTA.** Nothing in this app types a flight in: legs are materialized from a ticketed
   booking (step 13's first correction). A "Add a flight" button would have been a nicer-looking
   lie about where flights come from.

**Do not run `prettier` on this repo.** There is no `.prettierrc`, so its defaults rewrite
every string to double quotes and re-wrap every JSX blurb — 132 lines of churn in one file to
add six. `pnpm lint` is the formatter of record here.

## §13 — "Needs help" was a one-way door, and only on screen

Reported by the same reader, 2026-09-02, after marking a colleague `needs_help` on
`/shows/[id]/safety`: *what does that mean, and how do I move them back?*

Both halves were real, and the second is the more serious.

1. **The control disappeared the moment anybody answered.** `page.tsx` rendered `AnswerFor`
   under `open && !p.response`, so a person's first answer was also their last. The model had
   never agreed with that: `safety_responses` is append-only, `recordSafetyResponse`'s own
   comment says *"somebody who said they need help and later says they are fine has said two
   things"*, and `buildRollCall` deliberately keeps the **latest** response per person. The
   store had been built for a second answer for a whole step and the screen never offered
   one. So the fix is not a new write, a status field or an undo — it is rendering the
   control that was already there, with `standing` passed in so the buttons read *"Ingrid is
   OK now"* and *"Actually, needs help"* rather than repeating the first-time wording. The
   earlier answer stays in the record, which is the point of the table being append-only.
   **The cost of getting this wrong is specific**: a name that cannot be reopened is one
   somebody works around by starting a *second* roll call, and `forms.tsx` already says in
   its own copy that the second one gets answered by fewer people than the first.
2. **The word was never explained where it is pressed.** `needs_help` is the most alarming
   thing this product can render and the app's part in it is small — it changes an order and
   holds a name open. Nothing calls anybody. A screen that does not say so invites the
   opposite assumption at exactly the wrong moment, so the banner now states what it does,
   what it does *not* do, and how to close it.

And a third thing, from the same message: **the module's prose had leaked onto the page.**
*"Ordered by what their silence would cost, not by how sure we are they are here"* is an
accurate sentence from `rollcall.ts`'s header and it is written for somebody who has read the
module. On the one screen in this product read while something is going wrong, by whoever is
holding the laptop, it is a puzzle. The subtitles, the evidence line (*"Why we think so:
badged into a booth shift · 12m ago"*), the staleness note, the close-out copy and the three
action confirmations are now written for a person who has never seen the code. The
distinctions are unchanged — none of the refusals moved — only who the sentences are aimed at.
**Doc comments explain the design to the next engineer; page copy explains the act to the
person doing it, and the two are not the same text.**

## §14 — The docs' vocabulary had leaked onto the screens

Same reader, same day, two more: *"a floor — where did this chip come from?"* on the leads
tab, and *"why is this text block there?"* about the notes under the count.

Both are one defect. `SCOPE.md` argues about **floors**, **coverage**, **lawful basis** and
**withheld** because those distinctions are the product. Somewhere between the argument and
the screen, the argument's *words* were pasted onto badges and bullets that a show lead reads
while deciding what to do this afternoon.

- **"a floor" was a badge next to a headline that already said "At least 7 leads, from 2 of 4
  people on the booth".** It named the *shape* of the number to somebody who wanted to know
  what was wrong with it, and it was strictly redundant with the "At least" two inches to its
  left. It is **"undercounted"** now. `sound` → "complete count", `unknown` → "no booth
  roster". `/cost`'s badge had the same leak twice: "a floor" → "some costs missing", "thin" →
  "most costs missing".
- **The notes under the count were `SCOPE.md` §8c in the first person.** *"This is the number
  a rep can still change while they are standing there"* explains **why the feature exists**;
  it does not tell a show lead to ask two colleagues to enter their leads. Every note now
  states the fact and what fixing it looks like, and the names are joined with an "and".
- **`lead(s)` and `row(s)` were the tell.** Four notes were built by concatenating a count to
  a singular noun with a parenthesised plural, which is what template text looks like when
  nobody has read it back as a sentence. There is a `plural()` helper now, and one for names.
- **`mayQuotePerLead`'s refusal was reasoning, not an explanation.** "Dividing by an
  undercount overstates cost per lead, which reads as a bad show" is the correct argument for
  *why the rule exists*. What the reader needs is the consequence and the remedy: too few
  leads makes each look dearer, that is the number people cut a show over, and it appears once
  everyone has entered theirs. The two tests that asserted on the old sentence now assert on
  the direction of the error, which is the thing that must not change.

**The rule, stated once for the next screen:** a doc comment is addressed to whoever maintains
the decision; page copy is addressed to whoever lives with it. When the same sentence is doing
both jobs, it is doing the second one badly. Symptoms to grep for: a term of art on a `Badge`,
a `(s)` plural, and any sentence that explains why we chose something rather than what is true
and what to do.

## §15 — The rest of `/leads`, and two defects the copy pass found underneath

Same reader, one instruction: *"I don't want copy on the page that I cannot explain to end
users."* §14 fixed the badges and the notes on the leads tab. This is both leads screens
swept end to end — and the sweep is what surfaced the two real defects below, neither of
which is about wording.

**What came off the screens.** The portfolio's closing paragraph was §8c arguing with itself
about why there is no year-to-date total; that argument belongs in the file's doc comment,
where it already was, and the paragraph is gone rather than reworded — a footnote explaining
a design decision is exactly what the reader objected to. `Counts that are floors` was the
term §14 removed from a badge, still sitting on a stat tile. `Leads with no lawful basis` →
`Leads with no consent record`; `Lawful basis: not recorded` → `Why we may follow up: not
recorded`. The `Basis` and `Retention` column headings named our concepts rather than what is
in the columns, and the second one holds a date: `Consent` and `Erase by`. `outbound ok` →
`ok for marketing`, beside a refusal that already said "marketing". `Cost per lead is
withheld` → `is not shown yet` — the reason under it was already in plain words after §14,
and only the label was still ours. The duplicate-pair card, the meetings and target empty
states and the CSV import blurb each explained the reasoning behind a rule; all four now
state what is true and what the reader does about it.

**Two things the reader could not have known, and one they would have.**

1. **A note in the wrong tense, on a show that closed a year ago.** *"Asking them to add what
   they have is the quickest way to make this number right"* is the correct sentence during a
   show. It rendered under Automate 2025, status `complete`, telling a show lead to go and
   chase two colleagues about a show that ended. The note had hedged it in prose — "**if** the
   show is still on" — which is what a sentence does when the code has not been asked the
   question. `hasClosed` is `hasOpened`'s mirror now (status overrides the calendar in both
   directions, for the same reason), it is carried on `LeadCoverage` so both screens read one
   fact, and past the show the note says the count is final and why that matters when this
   show is compared with another. §5a's tense rule, reached from the return side. Three tests.
2. **Eight more `(s)` plurals, four of them in text nobody sees until they press a button.**
   §14 named `lead(s)` and `row(s)` as the tell and fixed the ones on the page; the rest were
   in `actions.ts` success messages and a submit label. `plural` and `names` moved out of
   `leads/_present.tsx` into **`_components/text.ts`**, dependency-free for `form.ts`'s reason
   turned around — that file stays clear of `next/cache` so a *client* component may import
   it, and this one stays clear of React so a **server action** may. A helper sitting beside a
   `<Badge>` would otherwise drag components into an action module.
3. **`pnpm smoke` had been red for a commit and nobody had run it.** §13's safety pass deleted
   the sentence *"Nothing on this page reads a device"* — correctly; it was page copy
   explaining why the feature has the ceiling it has — and the smoke check still looked for
   it. So the check that exists because "a check done by hand every time is a check that
   eventually is not done" was itself only done by hand. It now takes a card heading. **Run
   `pnpm smoke` in the same breath as `pnpm test`**: the suite is pure and touches nothing in
   `src/app`, so a copy pass is invisible to all 1,029 of them.

**Both defects came from reading the rendered page, not from a test** — `curl` piped through a
tag-stripper, which is `pnpm smoke`'s trick with the output actually read. That is the sixth
and seventh time on this project, after `onConflictDoNothing`, `SOURCE_LABEL`, a deduplicated
reading, a crate count and two in one sitting on presence. It generalises to copy: **a page's
words are output, and output is for reading.** A sentence with a hedge in it (`if`, `where
applicable`, `may have`) is worth a second look — it is often a fact the code holds and was
never asked for.

**Still to do:** the same sweep on the other screens. `/roi`, `/cost` and `/alerts` are the
demo path and carry the remaining spec citations — `§8e` and `SCOPE §11.7` are on `/settings/crm`
and `/roi` verbatim, and `§4` is a field hint on the asset form. Grep is `§`, `SCOPE`, `(s)`,
and any sentence that says why we chose something.

## §16 — Three things a reader could not find, and one they could not do

The same reader, working through `/leads` and the show's Leads tab in order. Three of the
four are the same defect at different scales: **a control that exists is not a control that
can be found, and an instruction with nothing behind it is worse than no instruction.**

- **"I see Target accounts and can add to that, but I cannot see a way to add a new lead."**
  The form was there. It was the last thing in a card *titled* "Capture" whose first 130 words
  were the count, its coverage notes and the cost-per-lead refusal — so the one control for
  the act the tab is named after sat under six lines of reporting, and a reader looking for
  "add a lead" found a report and stopped. One card was doing two jobs and the reporting half
  was winning. It is two cards now: **Add a lead**, first on the tab and holding only the
  form, and **Lead count**, next to the list it counts. §14's rule about page copy has a
  layout half — **a card is named for what somebody does in it.**
- **The CTA landed at the top of a long tab.** `GoToShow` has documented a `hash` prop since
  it was written — *"Anchor on the destination tab, so the form is on screen rather than below
  the fold"* — and **no caller could pass one**, because `Card` had no `id` and there was
  nothing on any destination to anchor to. Half-built, in the half nobody sees. `Card` takes
  an `id` now (with `scroll-mt`, or the anchor sits flush against the viewport and reads as a
  mis-scroll), `/leads` passes `hash="add-lead"`, and the other five boards can do the same.
- **`Capture` → `Capture lead`** on the submit button. A verb with no object, on a button
  under seven unlabelled fields.

**And the fourth, which was not a copy defect at all: there was no way to edit a captured
lead.** `captureLead`, `commitImport`, `intakeLead`, `markDuplicate`, `redactLead` — and
nothing between "record it" and "erase it". Two lines already on the screen told the reader to
do it anyway: the coverage note's *"Open the lead to record it"* and `consent.ts`'s fix line,
*"Record what the person was told at the booth."* Both pointed at a control that did not
exist. `canManageLeads`'s own doc comment had described the rule — *"editing a lead somebody
else captured"* — so the permission was designed and the function was never written.

`updateLead` is the fourth write path. Four things it inherits rather than decides:

1. **It re-checks identity, because `dedupe.ts` claimed it could.** That file said a
   `same_scan` or `same_email` pair *"cannot exist among stored leads, because all three write
   paths refuse those before they are written"*. An edit that skipped the check would have
   made that sentence quietly false — type a colleague's address into the email field and the
   show has two rows for one person, which is §5j's inflation in the flattering direction. The
   comment now says **four**, and the check is what keeps it true. The candidate list excludes
   the row being edited, or every lead collides with itself.
2. **`external_ref` is not editable and is not on the form.** It is the rail a badge scanner
   retries against, so editing it either collides with a real row or orphans the retry that is
   coming in ten minutes on bad wifi. The store carries the stored value through.
3. **A redacted lead is refused; a duplicate is not.** Erasure nulled those columns and an
   edit would write personal data back into the row that proves it was honoured. A duplicate
   keeps its own consent record and its own retention clock — which is exactly what marking it
   did not touch — so it stays editable.
4. **Editing has the same reach as reading.** Your own, or an approver's. A row nobody
   captured (imported, or posted by a scanner) has a null capturer and is therefore an
   approver's, which falls out rather than being chosen and is right: there is no "person who
   was there" to defer to.

**The one thing it decides is the consent timestamp, and it is the honest half.**
`consent_captured_at` answers *when somebody recorded this basis*, and the entire reason it is
a separate column from `captured_at` is that the two differ. Recording at 4pm what was said at
10am is the ordinary case; back-dating it to the capture would manufacture evidence that the
notice was given at the booth, which is the one thing `consent.ts` exists to refuse. So it
moves when the **claim** moves — the basis or the notice — is **cleared** when the basis
returns to `unknown` (a timestamp on an absence turns "nobody has said" into a record of an
event), and is left alone by an edit that only fixes a phone number. Nine tests.

**The pattern across all four:** every one was found by a person using the product, and none
of them could have been found by `pnpm test`. Three were invisible to the suite because they
are layout and wording; the fourth was invisible because **a missing feature has no failing
test** — nothing asserts the absence of a function nobody wrote. The signal that would have
caught it is cheaper than a test and was sitting on the screen the whole time: **page copy
telling somebody to do a thing is a claim the product should be checked against.** Grep the
screens for imperatives — "open the", "record what", "add a" — and confirm each one has a
control at the other end.

## §17 — `/roi` and `/cost`, and the sweep found a sixth date bug

The same pass as §14 and §16, run over the two money screens and the CRM settings page they
link to. Most of it was the expected work; three things were not.

**The expected work.** Fifteen `§`/`SCOPE` citations came off the screens — `§8b`, `§8d`,
`§8e`, `§5a`, `§5g`, `§11.7`, `§11.8`, `§3` twice, and `SCOPE.md §5` — each replaced by the
sentence it was standing in for, since a reader who cannot open `SCOPE.md` was getting a
footnote reference instead of a fact. `"Figures that are floors"` was **"a floor" for the
fourth time** (a stat tile on `/cost`), and `cost is a floor` / `count is a floor` were the
fifth and sixth, on badges in `roi/_present.tsx`. Four inline `? '' : 's'` plurals became
`plural()`. Three access refusals stopped citing §3 and just say who can see the page. The
`ReplayBanner`, the attribution explainer and the CRM page's consent note were rewritten from
arguments into statements.

**Three things that were not just wording:**

1. **`/roi` was using "withheld" for two different acts at once.** A *figure* we decline to
   print, and a *lead* we decline to transmit — on the same page, in the same table, in the
   same sentence at one point. They are unrelated decisions with opposite fixes: one is
   waiting on more data, the other is waiting on somebody recording what a person was told.
   Figures are **"not shown"** now and leads are **"not sent"**, and `MatchTable`'s header
   comment records why the vocabulary split.
2. **A sixth `toISOString().slice(0, 10)`, live in `src/app`.** The show's ROI tab rendered
   `as of {roi.asOf.toISOString().slice(0, 10)}` — a *timestamp* printed as a UTC calendar
   date, so a page read at 5pm Pacific was stamped tomorrow. Finding 2 of this document found
   four of these and step 22 found a fifth in `scripts/`; this is the sixth, and it survived
   because `asOf` is a `Date` that nobody thinks of as a due date. It reads
   `showDate(roi.asOf, detail.show.timezone)` now, which meant the tab had to load the show —
   worth it, since every other date on every other tab is already rendered in the show's zone
   and this one was silently not.
3. **`"Beside the total, not in it"` promised three figures and renders four.** Credits,
   stock, drayage and attendee-days. The subtitle was written when there were three and the
   drayage memo was added at step 23 without anybody re-reading the sentence above it. It no
   longer counts.

**And two tests had to be re-pointed, which is the recurring lesson.** Both asserted on the
exact wording of a refusal — `toContain('ceiling')` and `toContain('this app refusing, not the
CRM failing')` — so a copy pass broke them without breaking anything true. §14 hit this and
fixed it the same way: **assert the thing that must not change.** The first now matches
`/flatter|too high|overstate/` against the *direction* of the error, which is the half that
drives a decision. The second is better than what it replaced: it asserts that `12` and `8`
both appear and that `20` never does, which tests the actual rule — our refusals and the CRM's
answers are never summed — rather than the sentence that happens to express it.

**Measurement, and it is the one worth keeping.** A scan of every route in the app for `§`,
`SCOPE.md`, `a floor`, `floors`, `lawful basis`, `reporting artifact`, `fixture` and `x(s)`
now returns **nothing** — where before these three passes it returned hits on fifteen screens.
The scan is four lines of shell against a running `pnpm dev` and belongs in the same habit as
`pnpm smoke`:

```
curl -s localhost:3000$route | strip-tags | grep -oiE '§[0-9]+|SCOPE\.md|\ba floor\b|lawful basis|[a-z]\(s\)'
```

**The rule these three sections add up to.** The docs argue in a vocabulary — floors,
coverage, lawful basis, withheld, fixtures, artifacts — and that vocabulary is *correct*, which
is exactly why it leaks: the word that ends an argument feels like the word that should go on
the badge. It is not. **A doc comment is addressed to whoever maintains the decision; page copy
is addressed to whoever lives with it.** When one sentence does both jobs it is doing the
second one badly, and the tell is always the same: a term of art on a `Badge`, a `(s)` plural,
a section number, or a sentence explaining why we chose something rather than what is true and
what to do about it.

## §18 — The rest of the screens, and the sentence that had been wrong for two steps

The sweep finished across every remaining route. The vocabulary scan was already returning
nothing after §17, so what this pass was actually looking for was the other two symptoms —
`x(s)` plurals and copy that explains a decision instead of stating a fact. It found both, and
one thing that was neither.

**`/alerts` and the overview said there were five engines. There have been seven since step
19.** The blurb promised *"deadlines, flights, freight, assets and ticket credits"* and
rendered a **Leads** alert two inches underneath it. Nothing failed and no test could have
noticed: the sentence was true when it was written and stopped being true two steps later,
which is the `SOURCE_LABEL` bug in prose rather than in a guard — a hand-written list beside an
enum that grew.

So the prose is derived now. `feed.ts` exports `EngineSource` (the enum minus `booking` and
`unknown`, neither of which anything sweeps), `ENGINE_NOUN` as a `Record` over it, and
`ENGINE_COUNT` / `engineList()`. **Adding an engine to `AlertSource` now fails to compile until
somebody says what to call it on screen**, and the two pages read the count rather than
asserting one. Same fix shape as the `SOURCE_LABEL` guard: one exhaustive record, checked by
the compiler, doing both jobs.

**Seven `in 1 days`.** The overview, the shows list, My Itinerary, the readiness portfolio and
the show-detail header shared by all ten tabs — `in ${daysUntil(x)} days`, hard-coded, and the
live show is one day out so five of the seven were visible right now. Plus eleven more `(s)`
in places the earlier passes could not reach.

**And that is why `plural` moved to `src/lib/text.ts`.** §16 put it in `_components/text.ts`,
which was right for the screens and useless for the strings that needed it most: a credit
expiry **alert title**, four **audit-trail notes** on `/travel/[id]`, and seven **sweep summary
lines** are all composed in `src/lib` and rendered in `src/app`, so the helper the view layer
owned was unreachable from exactly the code carrying `credit(s)`, `leg(s)` and `offer(s)`.
`_components/text.ts` re-exports it — one definition, two import paths, and the app-side one
stays free of React so a server action can still use it.

**Smaller, and each its own kind of wrong:**

- **`"Weather. Nobody needs to do anything."`** on the flight board's *Late, buffer holds*
  tile. Most delays are not weather, and the tile's actual point is that the buffer survived
  whatever the cause was. An invented cause on a status board is the fabricated-figure rule
  with a noun instead of a number.
- **`"Duffel is not configured. Set DUFFEL_ACCESS_TOKEN, or FLIGHT_PROVIDER=recorded to replay
  captured payloads instead to enable it."`** Three provider errors build that sentence the
  same way and only the flights one had `to enable it` welded on after a `join(', ')`, so only
  it came out ungrammatical.
- **`"a future claim, a past fact, and nothing else joining them"`** — a stat note on
  `/assets`. Precisely correct about the design and meaningless to a reader, who needs
  *"booked to an upcoming show, and last returned damaged."*
- **Four "lawful basis" strings in `src/lib`** that reach `/alerts` and the leads tab from
  alert titles and consent verdicts — missed by §14 because they are composed outside `src/app`.
- **`"Connect a CRM under Settings → CRM"`** promised a control that does not exist; connecting
  is an environment variable, which that page explains. §16's rule, caught by grepping the
  screens for imperatives.
- **`"Open the lead to record it"`** now says **"Edit the lead"**, because §16 built the control
  and it is called Edit. Copy that asks for an action should name the button.

**One more test asserted on wording** (`batch.notes` had to contain the literal `'lawful
basis'`) and was re-pointed at the fact. That is the fourth across §14–§18, and the pattern is
now clear enough to state as a rule: **a test that asserts on a user-facing sentence is testing
the copy, not the behaviour.** Assert the number, the direction, or the shape.

**Where this leaves things.** The scan across every route and every show tab — `§`, `SCOPE.md`,
`a floor`, `floors`, `lawful basis`, `reporting artifact`, `fixture`, `x(s)`, `in 1 days` —
returns nothing. `pnpm smoke`'s `/assets` check moved to a stat label after the blurb it looked
for was rewritten; that is the **third** smoke expectation a copy pass has invalidated, so the
standing advice holds and is worth repeating here: **run `pnpm smoke` with `pnpm test`, not
after somebody notices.** Prefer a heading or a stat label over a sentence, and never a string
that only renders when the data happens to contain a finding.

## §20 — Two bugs under a red suite, and only the second one mattered

Not a UI finding. `pnpm db:reset && pnpm test` — the ground rule — was leaving nine tests
red, and `pnpm booking:dry-run` died partway through scenario 2. Both were **pre-existing**
(reproduced at `6fcd43e`) and had been hidden all session because the suite was running
against a `.pglite` seeded hours earlier.

**The first bug is a forty-minute hole in the replay.** `recorded/provider.ts` shifts a
fixture onto the *UTC day* of `earliestDeparture` and keeps its naive local departure time —
right for durations, overnight arrivals and local clock times, and silent about the resulting
**instant**. The international fixture leaves SFO at 16:20 local, so it rebases to **23:20Z**;
`pnpm test` and the dry-run both build their window from `now + 45 days`, so between 23:20Z
and midnight UTC the offer departs *before* the window opens, is denied on `departure_window`,
and the request comes back `no_options`. Eight tests fail, every day, for forty minutes — and
pass the other twenty-three hours, which is how it survived twenty-five steps. **A replay that
only works at certain times of day is not a replay, and a suite whose colour depends on when
you run it is worse than one that is red.** `recorded.test.ts` pins the clock across that
hour, because a test reading the wall clock reproduces this about 3% of the time.

**The second bug is the one worth the evening, and fixing the first is what exposed it.**
Shifting those offers by a day moved their arrivals inside twelve hours of move-in, and twenty
inserts failed at once with `invalid input syntax for type integer: "100083278.33333333"`.

`scoreOffer` builds a score in whole cents and then adds
`(12 - hoursBefore) * 2_500`, where `hoursBefore` is milliseconds over 3,600,000. That term is
the only fractional one — and `score` is an **`integer` column in both `offer_snapshots` and
`policy_evaluations`**. So a fractional score is not a ranking nuance: the insert fails, and it
fails inside `snapshotOffers` while the agent is writing its audit row, which takes down the
whole run and leaves nothing to read afterwards.

**It fires only when a show has a move-in time and the offer arrives within twelve hours of
it** — the tight-arrival case the buffer rule exists to reason about. The agent crashed hardest
on precisely the offers it was built to be careful with. Nothing caught it because the recorded
fixtures happened to land outside the twelve hours; the one-day shift moved them inside and
made it unmissable.

Three things worth keeping from how this went:

- **The first fix looked like a regression and was a diagnosis.** Applying it took failures
  from 9 to 31, and the honest first read — "my change broke twenty-two tests" — was wrong.
  They were all the same new crash, surfacing a latent defect the old dates had been hiding.
  Worth remembering before reverting on a count.
- **`pnpm dev` and `pnpm test` cannot share `.pglite`.** Several runs mid-investigation
  reported PGlite `Aborted()` failures that were pure contention, and they cost real time by
  looking exactly like the bug under investigation. `CLAUDE.md` warns about `db:reset` under a
  running server; the same applies to the suite. **Stop the dev server before trusting a test
  count.**
- **The wall clock is an input.** The failure window was 23:20–00:00 UTC and this machine is
  on `MDT`, so an early misread of the offset made the theory look disproved when it was
  right. `date -u` first.
