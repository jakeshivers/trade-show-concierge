import { plural, andList } from '@/lib/text';

/**
 * A show, as an executive pre-show brief — pure.
 *
 * The audience is the argument. This deck answers four questions a leadership
 * team asks before a show: *how did we do here last year, what are we spending
 * and expecting this year, who is going, and what do we still not know.*
 *
 * **A deck is the artifact that leaves the building**, and that is the design
 * constraint the rest follows from. Every other surface here is read by somebody
 * who can click into the caveat — `/cost` says "at least $41,300, most costs
 * missing" with the gaps named a tab away. A slide is read in a room, by people
 * who cannot click anything, and a screenshot of it outlives the workspace. So
 * the app's rules are enforced harder rather than relaxed:
 *
 * 1. **A floor is never printed as a total.** `isFloor` becomes the words "at
 *    least" *and* a line naming what is absent, on the same slide as the number.
 *    A deck saying "$41,300" where the app says "at least $41,300" is §8a's
 *    fabricated bill, laser-printed and handed to the person who sets budgets.
 * 2. **A withheld figure prints the refusal, never a blank.** An empty cell in a
 *    table reads as zero, and a zero is a claim. Cost per lead over a thin count
 *    errs *high*, which reads as a bad show — exactly the decision §8c warns
 *    about — so it prints the sentence instead.
 * 3. **Last year is the show we were actually cloned from**, never a name match.
 *    `shows.cloned_from_id` is the link somebody made deliberately; matching
 *    "Automate 2026" to "Automate 2025" by string is the fuzzy match
 *    `targets.ts` refuses, and here it would attribute another show's cost and
 *    pipeline to this one. With no link the slide says so and prints nothing.
 * 4. **§8e goes on the slide in words.** A show inside the 6–12 month horizon
 *    reports its figures and withholds its verdict, and a deck is precisely
 *    where "last year returned 0.4x" gets quoted for a year afterwards.
 * 5. **Built as the actor.** A Member's deck has no cost or ROI slides at all
 *    rather than empty ones — `shows/[id]/layout`'s call, for its reason.
 *
 * Rendering is `build.ts` and loading is `store.ts`; this file touches neither
 * pptxgenjs nor the database, which is what makes the rules above testable.
 */

export type Bullet = { text: string; sub?: string };

export type Slide =
  | { kind: 'title'; title: string; subtitle: string; stamp: string }
  | { kind: 'bullets'; title: string; note?: string; bullets: Bullet[] }
  | {
      kind: 'stats';
      title: string;
      note?: string;
      stats: { label: string; value: string; note?: string }[];
    }
  | { kind: 'table'; title: string; note?: string; head: string[]; rows: string[][] };

export type Deck = { fileName: string; title: string; slides: Slide[] };

/** A figure this deck may print, or the sentence saying why it may not. */
export type Quoted = { value: string | null; refusal: string | null };

export type PriorYear = {
  name: string;
  dates: string;
  /** Every figure carries its own refusal, so a partial prior year still shows. */
  costCents: number | null;
  costIsFloor: boolean;
  costMissing: string[];
  leads: number | null;
  leadsIsFloor: boolean;
  pipeline: Quoted;
  won: Quoted;
  multiple: Quoted;
  attendees: number | null;
  /** §8e — the prior year may still be inside the horizon. */
  withinHorizon: boolean;
};

export type DeckInputs = {
  show: {
    name: string;
    status: string;
    city: string | null;
    region: string | null;
    country: string | null;
    venueName: string | null;
    boothNumber: string | null;
    boothSize: string | null;
    goals: string | null;
    budgetCents: number | null;
  };
  /** Formatted by the caller in the show's own zone — never `toISOString`. */
  dates: { range: string; moveIn: string | null; daysUntil: number };
  /** Null when nothing was cloned from — see rule 3. */
  priorYear: PriorYear | null;
  attendees: { confirmed: number; invited: number; names: string[]; unconfirmed: string[] };
  readiness: { score: number | null; done: number; total: number };
  deadlines: { total: number; unconfirmed: number; missed: number; exposureCents: number };
  targets: { mustMeet: number; total: number; unowned: number };
  freight: { crates: number; unconfirmed: number } | null;
  /** Null when the actor may not see cost. Committed-to-date against budget. */
  cost: { committedCents: number; isFloor: boolean; missing: string[] } | null;
  builtAt: Date;
  builtBy: string;
  timezone: string;
};

const DASH = '—';

export function money(cents: number | null | undefined): string {
  if (cents == null) return DASH;
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/** A figure, or the sentence saying why there is not one. Never a blank cell. */
function show(q: Quoted): string {
  return q.value ?? q.refusal ?? 'Not recorded';
}

export function planDeck(input: DeckInputs): Deck {
  const { show: s } = input;
  const slides: Slide[] = [];
  const place = [s.city, s.region, s.country].filter(Boolean).join(', ') || 'Location to confirm';

  slides.push({
    kind: 'title',
    title: s.name,
    subtitle: `${input.dates.range} · ${place}${s.venueName ? ` · ${s.venueName}` : ''}`,
    stamp:
      `Prepared ${localDay(input.builtAt, input.timezone)} by ${input.builtBy}. ` +
      'Every figure here moves; this is a snapshot, not a record.',
  });

  slides.push(priorYearSlide(input.priorYear));
  slides.push(thisYearSlide(input));
  slides.push(expectationsSlide(input));
  slides.push(attendeesSlide(input));
  slides.push(readinessSlide(input));
  slides.push(gapsSlide(input));

  return {
    fileName: `${slug(s.name)}-brief-${localDay(input.builtAt, input.timezone)}.pptx`,
    title: `${s.name} — executive brief`,
    slides,
  };
}

/* ------------------------------- last year -------------------------------- */

function priorYearSlide(p: PriorYear | null): Slide {
  if (!p) {
    return {
      kind: 'bullets',
      title: 'Last year',
      bullets: [
        {
          text: 'No prior year is linked to this show.',
          sub:
            'The comparison follows the show this one was cloned from. Matching by name would ' +
            'risk attributing another show’s cost and pipeline to this one, so nothing is shown ' +
            'rather than something unverified.',
        },
      ],
    };
  }
  return {
    kind: 'stats',
    title: `Last year — ${p.name}`,
    note: [
      p.dates,
      p.costIsFloor && p.costMissing.length
        ? `Cost is a floor: ${andList(p.costMissing)} were never recorded.`
        : null,
      p.withinHorizon
        ? 'Still inside the 6–12 months where pipeline lands, so the return below is not final.'
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    stats: [
      {
        label: 'Cost',
        value: `${p.costIsFloor ? 'At least ' : ''}${money(p.costCents)}`,
        note: p.costIsFloor ? 'some costs missing' : 'complete',
      },
      {
        label: 'Leads',
        value: p.leads === null ? DASH : `${p.leadsIsFloor ? 'At least ' : ''}${p.leads}`,
        note: p.leadsIsFloor ? 'not everyone entered theirs' : undefined,
      },
      { label: 'Pipeline sourced', value: show(p.pipeline) },
      { label: 'Closed won', value: show(p.won) },
      { label: 'Return on cost', value: show(p.multiple) },
      { label: 'People there', value: p.attendees === null ? DASH : String(p.attendees) },
    ],
  };
}

/* ------------------------------- this year -------------------------------- */

function thisYearSlide(input: DeckInputs): Slide {
  const { show: s, cost } = input;
  const when =
    input.dates.daysUntil > 0
      ? `${plural(input.dates.daysUntil, 'day', 'days')} out`
      : input.dates.daysUntil === 0
        ? 'on the floor today'
        : `closed ${plural(Math.abs(input.dates.daysUntil), 'day', 'days')} ago`;

  const stats: { label: string; value: string; note?: string }[] = [
    { label: 'Dates', value: input.dates.range, note: when },
    { label: 'Move-in', value: input.dates.moveIn ?? 'Not set' },
    {
      label: 'Booth',
      value: s.boothNumber ?? 'Not assigned',
      note: s.boothSize ?? undefined,
    },
    { label: 'Status', value: s.status.replace(/_/g, ' ') },
  ];

  if (s.budgetCents !== null) {
    stats.push({ label: 'Budget', value: money(s.budgetCents) });
  }
  // Committed spend only where the actor may see cost at all — and always
  // labelled "committed", because `expenses.paid` is the only tense marker in
  // the money and a deck must not turn a commitment into an outlay.
  if (cost) {
    stats.push({
      label: 'Committed so far',
      value: `${cost.isFloor ? 'At least ' : ''}${money(cost.committedCents)}`,
      note: cost.isFloor ? 'recorded to date, some costs missing' : 'recorded to date',
    });
  }
  return {
    kind: 'stats',
    title: 'This year',
    note: cost?.isFloor ? floorNote(cost.missing) : undefined,
    stats,
  };
}

/* ----------------------------- what we expect ------------------------------ */

function expectationsSlide(input: DeckInputs): Slide {
  const bullets: Bullet[] = [];
  if (input.show.goals?.trim()) {
    bullets.push({ text: input.show.goals.trim() });
  }
  if (input.targets.total > 0) {
    bullets.push({
      text: `${plural(input.targets.mustMeet, 'must-meet account', 'must-meet accounts')} of ${input.targets.total} named`,
      sub:
        input.targets.unowned > 0
          ? `${plural(input.targets.unowned, 'must-meet has', 'must-meets have')} nobody assigned to make the meeting happen.`
          : 'Each has somebody responsible for the meeting.',
    });
  }
  if (input.freight && input.freight.crates > 0) {
    bullets.push({
      text: `${plural(input.freight.crates, 'crate', 'crates')} going to the show`,
      sub: input.freight.unconfirmed
        ? `${input.freight.unconfirmed} delivered but not yet confirmed at the booth.`
        : undefined,
    });
  }
  if (bullets.length === 0) {
    bullets.push({
      text: 'No goals, target accounts or freight have been recorded for this show yet.',
      sub: 'Which is itself the finding — there is nothing here to measure the show against afterwards.',
    });
  }
  return { kind: 'bullets', title: 'What we are going for', bullets };
}

/* -------------------------------- who goes -------------------------------- */

function attendeesSlide(input: DeckInputs): Slide {
  const a = input.attendees;
  const bullets: Bullet[] = [];
  if (a.names.length) {
    bullets.push({ text: `Confirmed (${a.confirmed})`, sub: andList(a.names) });
  }
  if (a.unconfirmed.length) {
    // Only the person confirms their own attendance — a status typed on
    // somebody's behalf is not a confirmation, and a headcount that counts it
    // is the number a lead reads and stops at.
    bullets.push({
      text: `Not yet confirmed (${a.unconfirmed.length})`,
      sub: `${andList(a.unconfirmed)} — invited, but they have not answered for themselves.`,
    });
  }
  if (!bullets.length) {
    bullets.push({ text: 'Nobody is staffed on this show yet.' });
  }
  return {
    kind: 'bullets',
    title: 'Who is going',
    note: `${a.confirmed} confirmed of ${a.invited} invited.`,
    bullets,
  };
}

/* ------------------------------- readiness -------------------------------- */

function readinessSlide(input: DeckInputs): Slide {
  const r = input.readiness;
  const d = input.deadlines;
  return {
    kind: 'stats',
    title: 'Where preparation stands',
    // §5a: an unconfirmed date is chased as a date, and its penalty is never
    // quoted. The exposure figure therefore says what it counts.
    note:
      d.total > 0
        ? `Penalties at risk: ${money(d.exposureCents)}, counting only deadlines somebody has confirmed against this year’s manual.`
        : 'No deadlines have been recorded for this show.',
    stats: [
      {
        label: 'Readiness',
        // An empty checklist is unplanned, not 0% — a deck must not round that
        // into a number somebody ranks shows by.
        value: r.score === null ? 'Not planned' : `${r.score}%`,
        note: r.score === null ? 'no checklist started' : `${r.done} of ${r.total} tasks done`,
      },
      { label: 'Deadlines', value: String(d.total), note: `${d.unconfirmed} unconfirmed` },
      {
        label: 'Missed',
        value: String(d.missed),
        note: d.missed ? 'already past their date' : undefined,
      },
    ],
  };
}

/* --------------------------- what we do not know --------------------------- */

function gapsSlide(input: DeckInputs): Slide {
  const gaps: Bullet[] = [];
  if (!input.priorYear) {
    gaps.push({ text: 'No prior year is linked, so there is no like-for-like comparison.' });
  } else if (input.priorYear.withinHorizon) {
    gaps.push({
      text: `Last year’s return is not final.`,
      sub: 'Pipeline from a show keeps landing for 6–12 months; comparing it with an older show flatters the older one.',
    });
  }
  if (input.readiness.score === null) {
    gaps.push({ text: 'No checklist has been started, so readiness is unknown rather than low.' });
  }
  if (input.deadlines.unconfirmed > 0) {
    gaps.push({
      text: `${plural(input.deadlines.unconfirmed, 'deadline is', 'deadlines are')} not confirmed against this year’s service manual.`,
      sub: 'Dates carried from last year move, and a penalty behind a guessed date is not a number to plan with.',
    });
  }
  if (input.cost?.isFloor) {
    gaps.push({
      text: floorNote(input.cost.missing),
      sub: 'The real number is higher, by an amount nobody can size yet.',
    });
  }
  if (input.attendees.unconfirmed.length) {
    gaps.push({
      text: `${plural(input.attendees.unconfirmed.length, 'person has', 'people have')} not confirmed they are going.`,
    });
  }
  return {
    kind: 'bullets',
    title: 'What this brief does not know',
    note:
      gaps.length === 0
        ? 'Nothing structural is missing from the figures above.'
        : 'Read the figures above with these in mind.',
    bullets: gaps.length
      ? gaps
      : [{ text: 'Every figure above is complete as far as this workspace knows.' }],
  };
}

/**
 * What to say about a cost that is a floor.
 *
 * `coverage.silent` names the categories with no figure *at all*, and it is
 * routinely empty while the figure is still a floor — a lodging with no nightly
 * rate makes the total short without making any category silent. The first
 * version interpolated the empty list and produced "Committed cost is a floor:
 * not recorded", a sentence with a hole in it, which is exactly the kind of
 * thing that reads as a rendering bug and gets the caveat ignored.
 */
function floorNote(missing: string[]): string {
  return missing.length
    ? `Committed cost is a floor: ${andList(missing)} not recorded.`
    : 'Committed cost is a floor — some rows carry no figure yet, so the real number is higher.';
}

/* --------------------------------- helpers -------------------------------- */

/** The show's own calendar day, never `toISOString().slice(0,10)`. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'show';
}
