# Competitive Research — Exhibitor-Side Trade Show Tools

**Date:** 2026-08-30 · Companion to [SCOPE.md](./SCOPE.md)

Surveyed the exhibitor-side market (tools for companies *attending* shows, not
organizers running them) to find features worth adding. Sources at the bottom.

---

## 1. The landscape

The market splits into three tiers, and the middle one is where we live.

| Tier | Examples | What they are |
|---|---|---|
| **Exhibitor planning** | **ExhibitDay**, Circa (ex-EventGeek) | Purpose-built for companies attending shows. Our direct competition. |
| **Field-marketing suites** | Cvent, Bizzabo, Splash, Zuddl, Lodago | Broader event marketing; exhibitor use is one mode among many. Heavier, pricier. |
| **On-the-floor execution** | **Trade Show PRO**, Cvent LeadCapture, BoothIQ, Whova | Used *during* the show. Mobile, offline-first, lead capture. See §8. |
| **Generic PM adapted** | monday, ClickUp, Wrike, Smartsheet | What most teams actually use today. The real incumbent is a spreadsheet. |

**The timeline is the real map.** Each tier owns a different phase, and nobody owns all three:

```
   BEFORE the show          DURING the show           AFTER the show
   plan · book · ship       capture · staff · meet    attribute · report
   ─────────────────        ────────────────────      ──────────────────
   ExhibitDay, Circa        Trade Show PRO, Cvent     CRM (Salesforce/HubSpot)
   ◄──────────── us ───────────────────────────────────────────────────►
```

The seam between phases is where data — and therefore ROI — gets lost today.

**Positioning read:** ExhibitDay is the closest analog and is priced as a *planning*
tool — free tier, $99/mo up to 10 users, $199/mo unlimited. It is a **system of record**.
Nothing in this market is a **system of action** — nothing books the flight, buys the
booth services, or catches the deadline for you. That gap is our thesis, and it lines up
exactly with north-star job 1.

---

## 2. ExhibitDay's actual feature set — our parity baseline

| Module | Detail |
|---|---|
| Events | In-person + virtual; conference sponsorship campaigns as a distinct type |
| Tasks | Centralized board, assignment, overdue notifications |
| Budget | Broken out by **booth reservation, booth services, travel, shipments, sponsorship** |
| **Assets** | Reservations for *capital assets* (booth, displays, furniture) + *collateral* inventory (swag, print) with **low-stock alerts** |
| Travel & shipments | Recorded per event |
| **Analytics & ROI** | Leads captured · **impressions** (booth walk-bys, sponsorship, media) · meetings (new vs. existing customers) · revenue (actual **and forecast**) |
| Auto-computed | Cost per lead · cost per impression · meeting metrics · total gross ROI · realized ROI |
| Integration | REST API + Zapier; Microsoft SSO |

**What we're missing vs. them:** assets/collateral inventory, impressions as a metric,
sponsorship-campaign tracking, budget split by booth-services category, forecast revenue,
and a public API. All are cheap. Section 4 folds them in.

**What they don't do — and structurally can't, because they don't transact:**
book travel, buy services, catch a service-manual deadline, or recover an airline credit.

---

## 3. Two features nobody in this market has — and we'd get cheaply

These are the highest-value findings of the research. Both are only possible *because*
we book and ship, which is the same compounding argument as §1 of SCOPE.md.

### 3a. Exhibitor service manual deadline engine 🔴 **highest ROI feature found**

Every show publishes an **exhibitor service manual** — dozens of deadlines for electrical,
carpet, furniture, AV, rigging, labor, and warehouse cutoffs. The **advance order
deadline** typically lands **21–30 days before show open**. Miss it and every service
order is surcharged **25–40%**.

**On a $10,000 services order, that's $2,500–$3,500 in pure avoidable waste, per show.**

Nobody automates this. Teams track it in a PDF and a mental note, and they miss it
routinely. It is the single most expensive recurring mistake in trade show operations.

**What we build:** a deadline registry per show — deadline type, date, penalty if missed,
owner — that drives escalating alerts (T-30 / T-14 / T-3 / day-of). Then the honest
upsell: an LLM that reads the exhibitor manual PDF and extracts the deadline table.
That extraction is *exactly* the kind of unstructured-document work an LLM is good at,
and — critically — **a human confirms every extracted deadline before it becomes an
alert.** Same principle as §6a of the scope: the model proposes, it never authorizes.

**Why this is the best feature in this document:** it is directly measurable ("we saved
$3,100 in late fees this quarter"), it hits north-star job 1 *and* job 3, and it makes
the readiness score mean something concrete rather than being a progress bar.

### 3b. Unused airline ticket credit recovery 💰

Industry data: **5–11% of corporate air spend is forfeited every year in expired flight
credits**, and 54% of travel buyers name it as a pain point. Credits expire on wildly
different clocks — Southwest 6–12 months, American 6–12, JetBlue 12, United 12–24,
Delta 12 (with UATP transfer since 2025).

Trade show travel is unusually prone to this: shows get cancelled, staffing changes late,
and a non-refundable ticket becomes a credit nobody remembers.

**Because we book the tickets, we already hold every credit.** A ledger of credits with
per-airline expiry rules, an alert before expiry, and — the real win — the booking agent
**automatically checking the credit pool before purchasing anything new.**

This is a feature that pays for the software. It requires the booking integration to
exist, so it belongs right after step 9 in the build order.

---

## 4. Full list of feature opportunities

Ranked by (value × how cheaply we get it). ⭐ = recommend adding to v1 scope.

### Tier 1 — add to scope

| # | Feature | Why | Cost |
|---|---|---|---|
| 1 ⭐ | **Service manual deadline engine** (§3a) | $2.5–3.5k/show in avoidable fees. Unique. | Medium; LLM extraction is a v2 add-on |
| 2 ⭐ | **Unused ticket credit ledger** (§3b) | 5–11% of air spend. Only possible because we book. | Low — we own the booking data |
| 3 ⭐ | **Asset & collateral inventory** | ExhibitDay parity. Ties directly into our shipping module: *what is in the crate* is the same question. | Low |
| 4 ⭐ | **Booth staff shift scheduling** | Coverage targets by hour, not just "who's attending." Real gap — ExhibitDay has tasks, not shifts. Also feeds cost-per-attendee-day. | Low |
| 5 ⭐ | **Booth services budget category** | Electrical, carpet, AV, rigging, drayage, I&D labor. Often the largest line after space. Pairs with #1. | Trivial — an expense category |
| 6 ⭐ | **Impressions metric + forecast revenue** | ExhibitDay ROI parity. Cost-per-impression is a number marketing leaders ask for. | Trivial |
| 7 ⭐ | **Show intake / "should we do this?" request** | Captures the decision *before* commitment, and closes the ROI loop: last year's numbers argue for next year's calendar. Our `prospect` status already anticipates it. | Low |
| 8 ⭐ | **Show templates & clone** | Same shows recur annually. Cloning last year's show with its tasks, deadlines, and shipping plan is the single biggest tedium cut after booking. | Low |

### Tier 2 — strong candidates, post-v1

| # | Feature | Why | Cost |
|---|---|---|---|
| 9 | **Duty of care / traveler safety** | Enterprise procurement asks for it. We know where everyone is: "who is on the ground in Chicago right now." Legal obligation for employers, not a nice-to-have. | Medium |
| 10 | **Sponsorship campaign tracking** | Separate from booths — deliverables (logo placement, speaking slot, attendee list), each with its own deadline. ExhibitDay treats it as a first-class type. | Medium |
| 11 | **Drayage / material handling estimator** | Priced per hundredweight, notoriously opaque, routinely 2× the estimate. We know crate weights from the shipping module. | Medium |
| 12 | **Public API + webhooks + Zapier** | Enterprise integration expectation; ExhibitDay has it. | Medium |
| 13 | **On-site day-of mode** | Offline-tolerant mobile view: my shift, booth number, wifi code, who's here, where's the crate. The one screen used *at* the show. | Medium |
| 14 | **Hotel room-block optimizer** | We already track cutoffs; comparing block rate vs. market rate is a small step. | Low |

### Tier 3 — deliberately declining

| Feature | Why not |
|---|---|
| Virtual/hybrid event planning | ExhibitDay covers it; not what you described; dilutes the physical-logistics thesis that is our whole advantage. |
| Native mobile lead-capture app | A product, not a feature — see §8c. Integrate first; build only if lead quality proves to be the ROI bottleneck. |
| Badge scanner *hardware* integrations | Vendors differ per show, most export CSV. Do CSV plus a REST endpoint. |
| Becoming a CRM | Already ruled out in scope §5. |
| Booth design / floor-plan tooling | Different product, different buyer. |
| Organizer-side tooling (selling booth space) | The other side of the marketplace entirely. |

---

## 5. What this changes about the strategy

The research sharpens the positioning rather than redirecting it.

1. **"System of action, not system of record" is the whole pitch.** Every competitor
   stores what you tell it. We book the flight, catch the deadline, and recover the
   credit. Features 1, 2, and the booking agent are the same argument told three ways.
2. **Two of the three highest-value features are only possible because we transact.**
   The credit ledger requires that we bought the ticket. True cost requires that we hold
   the shipping. This is a moat, not a feature list — a competitor can copy the UI and
   still can't ship these.
3. **Hard-dollar savings beat soft ROI in a budget conversation.** Pipeline attribution
   is always arguable. "$3,100 in late fees avoided, $8,400 in credits recovered" is not.
   Lead with the hard number; the ROI dashboard is what keeps them.
4. **Cloning shows is underrated.** Trade show calendars are ~80% the same events every
   year. Feature 8 is cheap and cuts more real tedium than most of the rest combined.

---

## 6. Recommended scope changes — ✅ folded into SCOPE.md (2026-08-30)

Add to v1 (steps renumber in SCOPE.md §10):

- Assets & collateral inventory → alongside step 11 (shipping); they share a data model
- Booth staff shifts → into step 5 (team & lodging)
- Booth services budget category, impressions, forecast revenue → into steps 12 and 14
- Show templates / clone → into step 3, where the show CRUD already lives
- Show intake request → into step 3, using the existing `prospect` status
- **Service manual deadline engine → new step, right after readiness (step 4)** — it is a
  weighted, dated, owned checklist, which is exactly what readiness already is
- **Unused ticket credit ledger → new step, right after live booking (step 9)** — it
  needs booking data to exist

**Promoted to v1 from the Enterprise parity list (§7):**

- **Cost centers** → into step 2 (auth/org model), referenced by every financial table,
  and as a dimension in the policy engine at step 6
- **Login method control** → step 2, and it decides SCOPE.md §11 #2 in favor of Clerk

**From the during-show layer (§8):**

- **Booth presence tracking** (not just scheduled shifts) → with shifts, in step 5
- **Side events** (dinners, demos, RSVPs) → into step 3, alongside show detail
- **Lead/meeting REST intake endpoint** beside CSV import → step 13
- **Offline-capable day-of PWA** → promoted from Tier 2 backlog into a committed v1.5
  workstream, because it is an architectural decision rather than a screen
- **Target company lists** and **cross-event visitor intelligence** → v1.5, with the PWA
- **GDPR posture for lead PII** (consent, retention, deletion, residency) → constrains the
  step 13 schema; decide before writing it, not after

Post-v1 backlog: duty of care · sponsorship campaigns · drayage estimator · public API +
Zapier · room-block optimizer · impersonation (with §7c rules) · multi-workspace · custom
fields · external share links · asset chain-of-custody · gamification.

---

## 7. ExhibitDay's Enterprise tier — the governance parity checklist

Their Enterprise plan gates these behind custom pricing. Read as a list, it is striking:
**almost none of it is trade show functionality.** It is administration, governance, and
control. That is the actual lesson — enterprise deals are won on governance, not on more
domain features.

| ExhibitDay Enterprise feature | Our read | Priority for us |
|---|---|---|
| **Charge expenses to Cost Centers** | Chargeback/showback to departments. Finance will ask for this in the first call. | 🔴 **v1 — see §7a** |
| **Control which login methods users can sign in with** | SSO enforcement — "everyone must use Okta, no passwords." Security review blocker. | 🔴 **v1 — see §7b** |
| **Impersonate other users in the workspace** | Admin support tool: "reproduce what the user sees." | 🟡 v1.5, with hard audit |
| **Multi-workspace configuration** | Separate business units under one account, with a roll-up view. | 🟡 Design for now, build later |
| **API access + Zapier (8,000+ apps)** | Already noted as #12. Confirmed as an *enterprise gate*, not a nice-to-have. | 🟡 Post-v1, but non-optional for the segment |
| **Custom fields on assets** | Generic custom-field support, not asset-specific. | 🟡 Post-v1 |
| **Logistical records for asset reservations** | Chain of custody — who checked the booth out, condition on return. | 🟡 With assets (#3) |
| **Custom Event Boards, shareable or published to your website** | Read-only external share links. Real use: give the booth builder or agency visibility without a paid seat. | 🟢 Post-v1, good land-and-expand |
| **Announcement messages on event tabs** | Lightweight broadcast to the show team. | 🟢 Low value, trivial cost |
| **Special event custom tab** | Per-customer flexibility escape hatch. | 🟢 Skip |
| **"Customize features to your specification"** | This is professional services, not product. | ⛔ Not a feature |

### 7a. Cost centers — promote to v1

Two reasons this can't wait, and both are specific to us rather than to ExhibitDay:

1. **Financial data is the worst thing to retrofit.** Adding a cost center dimension later
   means every historical expense, flight, and shipment is unattributed, and the first
   year of reporting is permanently broken.
2. **We spend money automatically.** When the agent buys a ticket, that purchase has to
   land in a cost center *at the moment of purchase*. And it goes further than ExhibitDay
   can: **spend thresholds in the policy engine (§7 of SCOPE.md) should be settable per
   cost center**, not just per org. "Sales Engineering gets a $650 domestic cap, Executive
   gets $1,800" is a normal enterprise requirement, and our policy engine is already
   versioned and rule-structured to express it.

Add `cost_center` to the org model; reference it from `expense`, `flight`, `shipment`,
`travel_request`, and `travel_policy`. Cheap now, extremely expensive later.

### 7b. Login method control — promote to v1

"Which login methods are permitted" is a hard blocker in enterprise security review, not a
feature request. It also settles SCOPE.md §11 decision #2: **Clerk**, whose organization
tier supports SSO/SAML and per-org authentication-strategy restrictions. Building this on
Auth.js is a quarter of work that isn't our product.

### 7c. Impersonation — build it, but build it right

Genuinely useful for support, and genuinely dangerous in an app that *purchases airline
tickets*. Non-negotiables if we ship it:

- Every impersonated session is banner-marked in the UI, for the admin's own safety
- Every action taken while impersonating is audit-logged with **both** identities
- **Impersonation can never authorize a purchase or approve a travel request** — the
  separation-of-duties rule in SCOPE.md §3 is worthless if an admin can simply become the
  approver

ExhibitDay can treat impersonation as a convenience. We cannot.

### 7d. The strategic read

ExhibitDay charges Enterprise money for *governance*. We should match that governance —
cost centers, SSO control, audit, impersonation, multi-workspace — because it is table
stakes for the segment and none of it is hard. But it is not where we win.

**We win on the transactional features nobody else can build** (§3): the booking agent,
the service-manual deadline engine, and credit recovery. Governance gets us *allowed* into
the enterprise. Transaction is why they'd switch.

One concrete implication for pricing: ExhibitDay's ceiling is $199/mo for unlimited users
before custom pricing. A tool that recovers $3,000/show in late fees and 5–11% of air
spend is not priced against a planning tool — it's priced against the savings. That's a
different conversation, and a much better one.

---

## 8. Trade Show PRO — the during-show layer we hadn't scoped

[tradeshowpro.events](https://tradeshowpro.events/#features) is not an ExhibitDay
competitor. It solves the *opposite half* of the problem: what happens on the floor for
the three days the show is actually running.

| Feature | What it does |
|---|---|
| **Lead Capture** | "Go beyond the business card" — interests, follow-up notes, buying signals |
| **Booth Management** | Who's at the booth and when — **presence**, not just scheduled shifts |
| **CRM Integrations** | HubSpot / Dynamics 365, with campaign attribution and lead scoring |
| **Team Gamification** | Real-time leaderboards, points per connection |
| **Goal Tracking** | Tag conversations by topic and product interest |
| **Offline-First** | "Trade show WiFi is notoriously bad" — works offline, syncs later |
| **Analytics** | Peak hours, staff efficiency, event-over-event trends |
| **Side Events** | Dinners, seminars, demos — RSVPs and guest lists |
| **Team Comms** | Real-time coordination, VIP visitor flagging |
| **Cross-Event Intelligence** | Spot returning visitors across previous shows |
| **Target Company Management** | Upload target account lists, track who showed |
| Platform | Mobile iOS/Android · EU-hosted · GDPR · 4 languages · venue-independent |
| Pricing | **€990 per event**, unlimited users, all features |

### 8a. Why this matters more than it first appears

**Our ROI story depends on data this layer produces.** SCOPE.md §8 computes cost
beautifully and then waves at the return side with "CSV import from badge scanners." But
cost-per-lead is only as good as the lead count — and **the lead count is bad at most
companies, because reps don't log leads.**

That is the real insight behind their gamification feature. Leaderboards look like a toy;
they are a behavioral fix for the actual failure mode. A booth staffer at hour six of day
two does not open a CRM. If they don't scan, our ROI dashboard is confidently wrong — and
a confidently wrong ROI number is worse than none, because someone will cut a show over it.

**This is the weakest link in the current plan and I under-weighted it.**

### 8b. Five things worth taking

1. **Offline-first is architecture, not a feature.** Show floor wifi is genuinely awful and
   convention centers charge extortionate rates for hardwired drops. Anything used *at* the
   show must work with no network and sync after. This cannot be retrofitted onto a
   server-rendered app — it decides how the day-of view is built. It raises my Tier 2 #13
   ("on-site day-of mode") into a real architectural commitment.
2. **Presence vs. schedule.** They track who is *actually* at the booth, not who was
   rostered. That's the input to staff-efficiency and honest cost-per-attendee-day — and it
   catches the classic failure of six people scheduled and two present at 4pm.
3. **Target company lists.** Upload the ABM account list; get alerted when someone from
   Acme scans in. Enterprise B2B teams already have this list. Cheap for us, high perceived
   value.
4. **Cross-event intelligence.** "This person visited our booth at two prior shows." They
   offer it; we're *structurally better positioned* for it because we're multi-show by
   design and they're priced per event. A returning-visitor graph across a whole calendar
   is something a per-event tool can't really build.
5. **Side events.** Dinners, demos, and seminars around the show, with RSVPs. A genuine
   workflow I'd missed entirely — and it's often where the actual pipeline gets made, not
   at the booth.

### 8c. Build it, or integrate it?

Honest assessment: **lead capture is a real product, not a feature.** Offline sync, mobile
apps in two stores, badge-format parsing, and OCR are a team-quarter minimum, and it is
the most crowded part of this market.

**Recommended sequencing:**

1. **v1 — integrate.** CSV import plus a small REST endpoint. Capture leads and meetings
   from whatever tool the team already uses. ROI works.
2. **v1.5 — a lightweight offline PWA for day-of.** Not a lead scanner: my shift, booth
   number, wifi code, who's here, where's the crate, plus a *manual* lead-and-meeting form.
   No app stores, no OCR. This is where I'd put the target-company alert too.
3. **v2 — decide with evidence.** If lead data quality proves to be the ROI bottleneck in
   real use, build or acquire capture. If teams are happy with their scanner and just want
   the numbers to land, never build it.

**Do not build a native mobile lead-capture app in v1.** It would consume the whole build
and it is not the thing only we can do — the booking agent and the deadline engine are.

### 8d. Two things this raises

**GDPR and PII.** Once we hold leads, we're processing personal data of people who are not
our users. Consent capture at scan time, retention limits, deletion requests, and possibly
data residency. Trade Show PRO leads with EU hosting and GDPR because their buyers ask.
Note it now — it constrains the lead schema — even though it lands with step 13.

**Pricing.** €990 **per event**, unlimited users, is a different model from ExhibitDay's
per-seat SaaS, and it's aligned with how trade show budgets actually work: shows are
budgeted individually, by event, often by different owners. Worth considering a hybrid —
a platform subscription for the always-on planning and travel spine, plus a per-show fee
where the value is concentrated. It also sidesteps the "we only do four shows a year"
objection that kills per-seat pricing in this market.

---

## Sources

- [ExhibitDay](https://www.exhibitday.com/) · [Asset Management](https://www.exhibitday.com/Asset-Management) · [Budgeting & ROI](https://www.exhibitday.com/Trade-Show-Budgeting) · [Plans & pricing](https://www.exhibitday.com/Plans) · [API & integrations](https://blog.exhibitday.com/tag/exhibitday-integration/) · [Engagement analytics & ROI](https://blog.exhibitday.com/trade-show-engagement-analytics-and-roi/amp/)
- [ExhibitDay alternatives — G2](https://www.g2.com/products/exhibitday-inc-exhibitday/competitors/alternatives) · [Capterra](https://www.capterra.com/p/182738/ExhibitDay/alternatives/) · [GetApp profile](https://www.getapp.com/customer-management-software/a/exhibitday/)
- **During-show / lead capture:** [Trade Show PRO](https://tradeshowpro.events/#features) · [Cvent LeadCapture](https://www.cvent.com/en/event-marketing-management/lead-capture) · [Zuddl — lead capture apps](https://www.zuddl.com/blog/top-9-trade-show-lead-capture-apps)
- [Circa (ex-EventGeek)](https://www.simplecirca.com/) · [relaunch announcement](https://www.prnewswire.com/news-releases/eventgeek-is-now-circa--event-management-platform-relaunches-as-first-to-help-marketing-teams-succeed-in-new-world-of-virtual--hybrid-events-301104165.html)
- **Service manual deadlines & penalties:** [Pure Exhibits — the 12 line items that blow your budget](https://www.purexhibits.com/trade-show-exhibitor-manual-explained/) · [How to read an exhibitor manual](https://www.purexhibits.com/how-to-read-a-trade-show-exhibitor-manual/) · [Booth electrical explained](https://www.purexhibits.com/trade-show-electrical-explained/) · [Negotiating show services](https://www.purexhibits.com/how-to-negotiate-show-services-and-save-25-on-your-next-event/)
- **Unused ticket credits:** [CTM — unused ticket management strategies](https://us.travelctm.com/blog/top-5-unused-ticket-management-strategies-for-asset-recovery/) · [Itilite — managing unused flight tickets](https://www.itilite.com/blog/unused-flight-tickets-management) · [Routespring — travel manager's handbook](https://routespring.com/the-traveler-managers-handbook-for-unused-airline-tickets) · [Corporate Traveler](https://www.corporatetraveler.us/en-us/resources/insights/how-manage-unused-airline-credits)
- **Travel policy & duty of care:** [Navan — corporate travel policies](https://navan.com/blog/corporate-travel-policies) · [Navan — policy compliance](https://navan.com/resources/glossary/what-is-travel-policy-compliance) · [Navan — duty of care](https://navan.com/resources/glossary/what-is-duty-of-care)
- **Assets, staffing & lead capture:** [Taylor — event asset management](https://www.taylor.com/blog/trade-show-event-asset-management-solutions) · [Accelevents — booth staff tools](https://www.accelevents.com/blog/which-tools-help-manage-booth-staff-and-exhibitor-teams) · [Zuddl — lead capture apps](https://www.zuddl.com/blog/top-9-trade-show-lead-capture-apps) · [Cvent LeadCapture](https://www.cvent.com/en/event-marketing-management/lead-capture)
