import { describe, expect, it } from 'vitest';
import { planDeck, type DeckInputs, type PriorYear } from './plan';

const BASE: DeckInputs = {
  show: {
    name: 'Automate 2026',
    status: 'planning',
    city: 'Detroit',
    region: 'MI',
    country: 'US',
    venueName: 'Huntington Place',
    boothNumber: '3421',
    boothSize: '20x20',
    goals: 'Twelve qualified conversations with tier-one integrators.',
    budgetCents: 8_000_000,
  },
  dates: { range: 'Oct 30 – Nov 2, 2026', moveIn: 'Oct 29, 8:00 AM', daysUntil: 52 },
  priorYear: null,
  attendees: { confirmed: 2, invited: 4, names: ['Priya Raman'], unconfirmed: ['Ingrid Sato'] },
  readiness: { score: 36, done: 9, total: 25 },
  deadlines: { total: 8, unconfirmed: 3, missed: 0, exposureCents: 312_500 },
  targets: { mustMeet: 2, total: 9, unowned: 1 },
  freight: { crates: 2, unconfirmed: 0 },
  cost: { committedCents: 4_130_000, isFloor: true, missing: ['booth space', 'shipping'] },
  builtAt: new Date('2026-09-09T15:00:00Z'),
  builtBy: 'Shelley Shivers',
  timezone: 'America/Detroit',
};

const priorYear: PriorYear = {
  name: 'Automate 2025',
  dates: 'Oct 25 – Oct 28, 2025',
  costCents: 7_400_000,
  costIsFloor: false,
  costMissing: [],
  leads: 41,
  leadsIsFloor: false,
  pipeline: { value: '$290,000', refusal: null },
  won: { value: '$88,000', refusal: null },
  multiple: { value: '3.9×', refusal: null },
  attendees: 5,
  withinHorizon: false,
};

const find = (d: ReturnType<typeof planDeck>, title: string) =>
  d.slides.find((s) => 'title' in s && s.title.startsWith(title));

const textOf = (d: ReturnType<typeof planDeck>): string => JSON.stringify(d.slides);

describe('the executive brief', () => {
  it('leads with the show and stamps when it was built', () => {
    const deck = planDeck(BASE);
    expect(deck.slides[0]).toMatchObject({ kind: 'title', title: 'Automate 2026' });
    expect(deck.slides[0]).toHaveProperty('stamp', expect.stringContaining('snapshot'));
  });

  it('names the file on the show’s own calendar day, not UTC', () => {
    // 15:00Z on the 9th is still the 9th in Detroit; the guard is that this
    // never goes through toISOString, which has moved a date in this repo six
    // times.
    expect(planDeck(BASE).fileName).toBe('automate-2026-brief-2026-09-09.pptx');
  });
});

describe('last year', () => {
  it('says nothing rather than guessing when no prior year is linked', () => {
    const slide = find(planDeck(BASE), 'Last year');
    expect(JSON.stringify(slide)).toContain('No prior year is linked');
    // The refusal has to explain itself, or somebody assumes the show is new.
    expect(JSON.stringify(slide)).toMatch(/name/i);
  });

  it('reports the linked show’s figures when there is one', () => {
    const deck = planDeck({ ...BASE, priorYear });
    const slide = find(deck, 'Last year');
    expect(JSON.stringify(slide)).toContain('Automate 2025');
    expect(JSON.stringify(slide)).toContain('$290,000');
    expect(JSON.stringify(slide)).toContain('3.9×');
  });

  it('prints a refusal in place of a figure, never a blank', () => {
    const deck = planDeck({
      ...BASE,
      priorYear: {
        ...priorYear,
        multiple: { value: null, refusal: 'Cost is a floor, so a multiple would flatter it.' },
      },
    });
    const slide = JSON.stringify(find(deck, 'Last year'));
    expect(slide).toContain('would flatter it');
    // An empty cell reads as zero, and a zero is a claim.
    expect(slide).not.toMatch(/"value":""/);
  });

  it('warns when last year is still inside the maturity horizon', () => {
    const deck = planDeck({ ...BASE, priorYear: { ...priorYear, withinHorizon: true } });
    expect(textOf(deck)).toMatch(/not final/i);
    expect(JSON.stringify(find(deck, 'What this brief'))).toMatch(/flatters the older one/);
  });
});

describe('figures that must not be rounded into a claim', () => {
  it('says “at least” on a floor, and names what is missing', () => {
    const slide = JSON.stringify(find(planDeck(BASE), 'This year'));
    expect(slide).toContain('At least');
    expect(slide).toMatch(/booth space and shipping/);
  });

  it('drops the hedge when the cost is complete', () => {
    const deck = planDeck({
      ...BASE,
      cost: { committedCents: 4_130_000, isFloor: false, missing: [] },
    });
    expect(JSON.stringify(find(deck, 'This year'))).not.toContain('At least');
  });

  it('renders an unplanned show as unplanned, never 0%', () => {
    const deck = planDeck({ ...BASE, readiness: { score: null, done: 0, total: 0 } });
    const slide = JSON.stringify(find(deck, 'Where preparation'));
    expect(slide).toContain('Not planned');
    expect(slide).not.toContain('0%');
  });

  it('counts only confirmed deadlines in the penalty figure, and says so', () => {
    expect(JSON.stringify(find(planDeck(BASE), 'Where preparation'))).toMatch(
      /counting only deadlines somebody has confirmed/,
    );
  });
});

describe('what the actor may not see is absent, not empty', () => {
  it('omits cost entirely for somebody who cannot see it', () => {
    const deck = planDeck({ ...BASE, cost: null });
    expect(JSON.stringify(find(deck, 'This year'))).not.toMatch(/Committed/);
  });
});

describe('attendees', () => {
  it('separates confirmed from invited, because only the person confirms', () => {
    const slide = JSON.stringify(find(planDeck(BASE), 'Who is going'));
    expect(slide).toContain('2 confirmed of 4 invited');
    expect(slide).toMatch(/have not answered for themselves|has not answered for themselves/);
  });
});

describe('the closing slide', () => {
  it('lists every gap, so the rest of the deck is quotable', () => {
    const gaps = JSON.stringify(find(planDeck(BASE), 'What this brief'));
    expect(gaps).toMatch(/No prior year is linked/);
    expect(gaps).toMatch(/not confirmed against this year/);
    expect(gaps).toMatch(/floor/);
    expect(gaps).toMatch(/not confirmed they are going/);
  });

  it('says so plainly when nothing is missing', () => {
    const deck = planDeck({
      ...BASE,
      priorYear,
      readiness: { score: 90, done: 22, total: 25 },
      deadlines: { total: 8, unconfirmed: 0, missed: 0, exposureCents: 0 },
      cost: { committedCents: 7_000_000, isFloor: false, missing: [] },
      attendees: { confirmed: 4, invited: 4, names: ['A', 'B'], unconfirmed: [] },
    });
    expect(JSON.stringify(find(deck, 'What this brief'))).toMatch(/complete as far as/);
  });
});

describe('a figure with no referent', () => {
  it('never prints $0 for pipeline when the underlying answer is a refusal', () => {
    // Found by reading `pnpm deck`: with no CRM connected, closed-won and the
    // multiple both refused while pipeline printed "$0" — which states that the
    // show sourced nothing, rather than that nobody has looked.
    const deck = planDeck({
      ...BASE,
      priorYear: {
        ...priorYear,
        pipeline: { value: null, refusal: 'No CRM is connected.' },
        won: { value: null, refusal: 'No CRM is connected.' },
        multiple: { value: null, refusal: 'No CRM is connected.' },
      },
    });
    const slide = JSON.stringify(find(deck, 'Last year'));
    expect(slide).not.toContain('$0');
    expect(slide.match(/No CRM is connected/g)).toHaveLength(3);
  });
});
