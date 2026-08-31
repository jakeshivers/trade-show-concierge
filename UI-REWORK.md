# UI rework — the case, the plan, and the one decision it needs

**Status:** proposed, not started · **Written:** after step 12 (2026-08-30) · **Gates:** nothing

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

## 4. What this deliberately does **not** do

No visual redesign — no typography pass, no density system, no dashboard rework, no nav
restructure. That is a real and separate job, and it is worth *waiting* on, for a reason
this document should be honest about rather than pretending the two are the same size:

- **Step 13** (flight tracking) and **step 16** (the alerts feed) each add screens, and an
  alerts feed in particular is a new layout primitive, not another table.
- **Step 19** is an offline day-of PWA. That is a genuine change to how the client works —
  not a reskin — and it is the first screen with a hostile environment (show-floor wifi) and
  a real interaction budget. Design decisions made now get remade there.
- The nav is flat with 7 entries and grows one per screen. It needs restructuring *once*,
  against the final set, not twice.

The tranches above are all invariant to that. They are plumbing, and plumbing done early is
cheaper; visual design done early is done twice.

---

## 5. The decision this needs

Recorded as `SCOPE.md` §11 item 11. The options, with what each costs:

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

## 6. How to verify it, and why that is enough

**All 431 tests are pure** — no DOM, no rendering, no database. None of them touch
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
pnpm typecheck && pnpm lint && pnpm test    # 431, no keys
pnpm roster && pnpm deadlines               # the two CLIs that read what these screens show
```

**One rule while doing this work:** no behaviour changes except the §2a fix, which is named
here and belongs in its own commit with its own reasoning. A refactor that quietly alters
what a screen permits is indistinguishable from a bug six months later, and this app's
permission split (`readiness/access.ts`, `deadlines/access.ts`, `team/access.ts` — the same
line found three times from three directions) is the part least safe to disturb by accident.
