import { describe, it, expect } from 'vitest';
import { scoreChecklist, isOverdue, type ScorableTask } from './score';
import { planTemplate, findTemplate, TEMPLATES } from './templates';
import { planStatusChange, validateDraft, ChecklistError, MIN_NOTE } from './edit';
import { expectedReadiness, rollUpPortfolio, PLANNING_WINDOW_DAYS } from './portfolio';

/**
 * The pure half of readiness. Everything here runs with no database and a fixed
 * clock, which is the point of `asOf` being a parameter — half these assertions
 * are about what a number means on a particular day.
 */

const NOW = new Date('2026-03-01T12:00:00Z');
const t = (over: Partial<ScorableTask> = {}): ScorableTask => ({
  status: 'not_started',
  weight: 1,
  dueOn: null,
  ...over,
});

describe('scoreChecklist', () => {
  it('scores an empty checklist as unplanned, never as ready', () => {
    // The correction step 10 made: readinessScore([]) used to return 100, which
    // sorted the show nobody had touched above every show somebody was working on.
    const r = scoreChecklist([], NOW);
    expect(r.score).toBeNull();
    expect(r.total).toBe(0);
  });

  it('is unplanned when every task was skipped, not 100%', () => {
    const r = scoreChecklist([t({ status: 'skipped' }), t({ status: 'skipped' })], NOW);
    expect(r.score).toBeNull();
    expect(r.byStatus.skipped).toBe(2);
  });

  it('weights the score and gives in-progress half credit', () => {
    const r = scoreChecklist(
      [t({ status: 'complete', weight: 3 }), t({ status: 'in_progress', weight: 1 })],
      NOW,
    );
    expect(r.score).toBe(Math.round(((3 + 0.5) / 4) * 100));
  });

  it('drops skipped tasks out of the denominator', () => {
    const withSkip = scoreChecklist(
      [t({ status: 'complete' }), t({ status: 'skipped' })],
      NOW,
    );
    expect(withSkip.score).toBe(100);
    expect(withSkip.counted).toBe(1);
    expect(withSkip.total).toBe(2);
  });

  it('reports blocked separately from not-started even though both earn zero', () => {
    const r = scoreChecklist(
      [t({ status: 'complete', weight: 3 }), t({ status: 'blocked', weight: 2 })],
      NOW,
    );
    expect(r.score).toBe(60);
    expect(r.blocked).toBe(1);
    expect(r.blockedShare).toBeCloseTo(2 / 5);
  });

  it('counts overdue against the given clock, and never for done or skipped work', () => {
    const past = new Date('2026-02-01T00:00:00Z');
    const tasks = [
      t({ dueOn: past }),
      t({ status: 'complete', dueOn: past }),
      t({ status: 'skipped', dueOn: past }),
      t({ dueOn: new Date('2026-06-01T00:00:00Z') }),
    ];
    expect(scoreChecklist(tasks, NOW).overdue).toBe(1);
    // The same checklist read a month earlier has nothing overdue on it.
    expect(scoreChecklist(tasks, new Date('2026-01-01T00:00:00Z')).overdue).toBe(0);
    expect(isOverdue(t({ status: 'complete', dueOn: past }), NOW)).toBe(false);
  });
});

describe('templates', () => {
  const show = {
    // Automate-shaped: opens 4 May 2026, US Pacific.
    startsOn: new Date('2026-05-04T16:00:00Z'),
    timezone: 'America/Los_Angeles',
    tasks: [] as { templateKey: string | null; sortOrder: number }[],
  };

  it('ships a standard checklist of about 25 tasks', () => {
    const std = findTemplate('standard-exhibitor')!;
    expect(std.items.length).toBeGreaterThanOrEqual(24);
    // Keys are what makes re-applying idempotent, so they have to be unique.
    for (const template of TEMPLATES) {
      expect(new Set(template.items.map((i) => i.key)).size).toBe(template.items.length);
    }
  });

  it('dates every task from the show’s opening day, at 5pm in the show’s zone', () => {
    const plan = planTemplate(findTemplate('standard-exhibitor')!, show, NOW);
    const advance = plan.create.find((c) => c.templateKey.endsWith(':advance-order'))!;
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).format(advance.dueOn);
    // 30 days before 4 May is 4 April — and the local clock time survives the
    // 8 March DST transition sitting between them, which naive ms arithmetic
    // would shift to 16:00.
    expect(local).toContain('2026-04-04');
    expect(local).toContain('17');
  });

  it('adds nothing the second time it is applied', () => {
    const first = planTemplate(findTemplate('tabletop')!, show, NOW);
    expect(first.create.length).toBe(8);

    const after = {
      ...show,
      tasks: first.create.map((c) => ({ templateKey: c.templateKey, sortOrder: c.sortOrder })),
    };
    const second = planTemplate(findTemplate('tabletop')!, after, NOW);
    expect(second.create).toEqual([]);
    expect(second.alreadyPresent.length).toBe(8);
  });

  it('adds only what is missing to a show that already has a checklist', () => {
    const partial = {
      ...show,
      tasks: [{ templateKey: 'tabletop:contract', sortOrder: 0 }, { templateKey: null, sortOrder: 1 }],
    };
    const plan = planTemplate(findTemplate('tabletop')!, partial, NOW);
    expect(plan.create.length).toBe(7);
    expect(plan.alreadyPresent).toEqual(['tabletop:contract']);
    // Hand-written tasks are untouched and the new rows sort after them.
    expect(plan.create[0].sortOrder).toBe(2);
  });

  it('creates already-late tasks rather than hiding them, and says so', () => {
    // Seeding a checklist three weeks before the doors open: the advance order
    // deadline is genuinely missed, and a template that quietly omitted it is
    // how the miss stays invisible.
    const plan = planTemplate(
      findTemplate('standard-exhibitor')!,
      show,
      new Date('2026-04-20T00:00:00Z'),
    );
    const late = plan.create.filter((c) => c.alreadyLate);
    expect(late.length).toBeGreaterThan(0);
    expect(plan.notes.join(' ')).toContain('already past due');
  });
});

describe('checklist edits', () => {
  it('requires a written reason to block or skip, and not otherwise', () => {
    expect(() => planStatusChange('skipped', 'nope', 'u1', NOW)).toThrow(ChecklistError);
    expect(() => planStatusChange('blocked', null, 'u1', NOW)).toThrow(ChecklistError);
    expect(planStatusChange('in_progress', null, 'u1', NOW).note).toBeNull();
    const skip = planStatusChange('skipped', 'Organizer supplies these this year', 'u1', NOW);
    expect(skip.note).toContain('Organizer');
    expect(skip.note!.length).toBeGreaterThanOrEqual(MIN_NOTE);
  });

  it('stamps who completed a task, and clears it again on re-open', () => {
    const done = planStatusChange('complete', null, 'u1', NOW);
    expect(done.completedAt).toEqual(NOW);
    expect(done.completedById).toBe('u1');

    const reopened = planStatusChange('in_progress', null, 'u1', NOW);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.completedById).toBeNull();
  });

  it('drops a blocked task’s note when it stops being blocked', () => {
    // Carrying "waiting on legal" onto a completed task misreports the history.
    expect(planStatusChange('complete', 'waiting on legal redlines', 'u1', NOW).note).toBeNull();
  });

  it('refuses an unknown status or category rather than storing it', () => {
    expect(() => planStatusChange('donezo', null, 'u1', NOW)).toThrow(ChecklistError);
    expect(() =>
      validateDraft({ title: 'Order carpet', category: 'vibes', weight: 1 }),
    ).toThrow(ChecklistError);
  });

  it('validates the shape of a draft', () => {
    expect(() => validateDraft({ title: 'ok', category: 'booth', weight: 1 })).toThrow();
    expect(() => validateDraft({ title: 'Order carpet', category: 'booth', weight: 9 })).toThrow();
    expect(() =>
      validateDraft({ title: 'Order carpet', category: 'booth', weight: 1, dueOn: '4 May' }),
    ).toThrow();
    const ok = validateDraft({
      title: '  Order carpet  ',
      category: 'booth',
      weight: 2,
      dueOn: '2026-04-04',
      assigneeId: '',
    });
    expect(ok).toEqual({
      title: 'Order carpet',
      description: null,
      category: 'booth',
      weight: 2,
      dueOn: '2026-04-04',
      assigneeId: null,
    });
  });
});

describe('portfolio', () => {
  const show = (over: Partial<Parameters<typeof rollUpPortfolio>[0][number]>) => ({
    id: 'x',
    name: 'A show',
    status: 'committed',
    startsOn: new Date('2026-06-01T12:00:00Z'),
    timezone: 'UTC',
    readiness: scoreChecklist([t({ status: 'complete' })], NOW),
    missedDeadlineCents: 0,
    missedDeadlines: 0,
    openDeadlines: 0,
    unconfirmedDeadlines: 0,
    unownedDeadlines: 0,
    ...over,
  });

  it('expects nothing outside the planning window and everything by opening day', () => {
    expect(expectedReadiness(PLANNING_WINDOW_DAYS + 30)).toBe(0);
    expect(expectedReadiness(PLANNING_WINDOW_DAYS / 2)).toBe(50);
    expect(expectedReadiness(0)).toBe(100);
    expect(expectedReadiness(-5)).toBe(100);
  });

  it('ranks the near, behind show above the distant, less-ready one', () => {
    // The correction the whole file exists for: sorting by score gets this
    // backwards. 40% eight months out is on schedule; 70% in nine days is not.
    const distant = show({
      id: 'distant',
      startsOn: new Date('2026-11-01T12:00:00Z'),
      readiness: scoreChecklist(
        [t({ status: 'complete' }), t(), t(), t(), t()],
        NOW,
      ),
    });
    const imminent = show({
      id: 'imminent',
      startsOn: new Date('2026-03-10T12:00:00Z'),
      readiness: scoreChecklist(
        [t({ status: 'complete' }), t({ status: 'complete' }), t({ status: 'complete' }), t()],
        NOW,
      ),
    });
    expect(distant.readiness.score).toBeLessThan(imminent.readiness.score!);

    const ranked = rollUpPortfolio([distant, imminent], NOW);
    expect(ranked[0].id).toBe('imminent');
    // 75% with nine days left is 18 points behind pace; 20% eight months out is
    // ahead of it, so the less-ready show is the one with nothing to say.
    expect(ranked[0].severity).toBe('warn');
    expect(ranked[0].behindBy).toBeGreaterThan(0);
    expect(ranked[1].severity).toBe('ok');
    expect(ranked[1].behindBy).toBeLessThanOrEqual(0);
  });

  /**
   * And the clock is the key now, with severity breaking ties.
   *
   * The pace model already made this board mostly clock-shaped — that is what
   * the test above is about — but severity-first still put a March emergency
   * above a show opening next week, which is a re-sort the reader has to undo.
   * The pace verdict is on every row in its words and its tone; it decides the
   * order only between two shows opening the same day.
   */
  it('puts the sooner show first even when a later one is in more trouble', () => {
    const soonAndFine = show({
      id: 'soon',
      startsOn: new Date('2026-03-08T12:00:00Z'),
      readiness: scoreChecklist([t({ status: 'complete' }), t({ status: 'complete' })], NOW),
    });
    const laterAndBroken = show({
      id: 'later',
      startsOn: new Date('2026-05-01T12:00:00Z'),
      readiness: scoreChecklist([], NOW),
      missedDeadlines: 3,
      missedDeadlineCents: 400_000,
    });
    const ranked = rollUpPortfolio([laterAndBroken, soonAndFine], NOW);
    expect(ranked.map((r) => r.id)).toEqual(['soon', 'later']);
    // The trouble is still reported, it is just not what decides the order.
    expect(ranked[1].severity).toBe('critical');
  });

  it('breaks a tie between two shows opening the same day on severity', () => {
    const day = new Date('2026-04-01T12:00:00Z');
    const fine = show({ id: 'fine', startsOn: day });
    const broken = show({ id: 'broken', startsOn: day, readiness: scoreChecklist([], NOW) });
    expect(rollUpPortfolio([fine, broken], NOW).map((r) => r.id)).toEqual(['broken', 'fine']);
  });

  it('says a show has no checklist rather than calling it 0% ready', () => {
    const [row] = rollUpPortfolio(
      [show({ startsOn: new Date('2026-03-20T12:00:00Z'), readiness: scoreChecklist([], NOW) })],
      NOW,
    );
    expect(row.behindBy).toBeNull();
    expect(row.concerns[0]).toContain('No checklist');
    expect(row.severity).toBe('critical');
  });

  it('reports a missed deadline as money already incurred, not as money at risk', () => {
    const [row] = rollUpPortfolio(
      [show({ missedDeadlines: 1, missedDeadlineCents: 312_500 })],
      NOW,
    );
    expect(row.severity).toBe('critical');
    expect(row.concerns[0]).toContain('$3,125');
    // Step 11's second correction, asserted rather than described: past the date
    // the surcharge is spent, and calling it "at risk" invites somebody to think
    // it can still be saved.
    expect(row.concerns[0]).toContain('incurred');
    expect(row.concerns[0]).not.toContain('at risk');
  });

  it('raises a show whose remaining work is mostly blocked, however high its score', () => {
    const readiness = scoreChecklist(
      [
        t({ status: 'complete', weight: 3 }),
        t({ status: 'complete', weight: 3 }),
        t({ status: 'blocked', weight: 3 }),
      ],
      NOW,
    );
    expect(readiness.score).toBeGreaterThanOrEqual(66);
    const [row] = rollUpPortfolio([show({ readiness })], NOW);
    expect(row.severity).toBe('critical');
    expect(row.concerns.join(' ')).toContain('blocked');
  });
});
