import { instantToZoned, shiftDaysPreservingLocalTime, zonedToInstant } from '@/lib/datetime/zoned';
import type { TaskCategory } from './edit';

/**
 * The built-in checklist templates, and the pure planner that applies one.
 *
 * SCOPE.md §5: "Templates seed ~25 standard tasks." Two decisions inside that:
 *
 * **The library is code, not rows.** An org-editable template builder is a CRUD
 * surface with versioning, ownership, and a migration story for shows already
 * seeded from an older version — and none of that is worth building before anyone
 * has used the standard list and said what is missing from it. So the templates
 * live here, in git, where changing one is a reviewed diff. A show that has been
 * seeded keeps *its* tasks; editing a template never reaches back into shows
 * already built from it. `SCOPE.md` §10 step 10 records this as deferred, not
 * done.
 *
 * **Due dates are offsets from show open, resolved on the local calendar.** An
 * advance-order deadline is "30 days before the doors open at 5pm local", not "a
 * fixed number of milliseconds before". Resolving it by arithmetic lands it at
 * 4pm or 6pm across a DST boundary — the same correction step 8 made for cloning,
 * and the same primitive fixes it.
 *
 * The planner is pure and returns a plan rather than writing: applying a template
 * to a show that already has a checklist is the normal case, not the exception
 * (a cloned show arrives with last year's list), so the caller has to be able to
 * show what will be added and what is already there *before* anything is written.
 */

/** The local hour a template-seeded task falls due, in the show's zone. */
const DUE_HOUR = '17:00:00';

export type TemplateItem = {
  /** Stable across template edits — it is what makes re-applying idempotent. */
  key: string;
  title: string;
  description?: string;
  category: TaskCategory;
  /** Weight 1–5; 3 is "this show does not happen without it". */
  weight: number;
  /** Days relative to show open. Negative is before, which is nearly all of them. */
  dueOffsetDays: number;
};

export type ChecklistTemplate = {
  key: string;
  name: string;
  blurb: string;
  items: TemplateItem[];
};

/**
 * The standard exhibitor checklist.
 *
 * Ordered by when the work happens, not by category, because that is the order a
 * show lead reads it in. The offsets are the ones the research in `RESEARCH.md`
 * and §5a describe: the advance order deadline sits 21–30 days out and is the
 * expensive one, warehouse receiving closes before it, and the follow-up tasks —
 * the ones that decide whether the show was worth anything — fall *after* open
 * and are the ones a checklist that stops at move-in never captures.
 */
const STANDARD: ChecklistTemplate = {
  key: 'standard-exhibitor',
  name: 'Standard exhibitor checklist',
  blurb:
    '25 tasks covering contract through post-show follow-up, dated from the show’s open. ' +
    'The dollar-bearing ones — advance order, warehouse cutoff, room block — carry weight 3.',
  items: [
    { key: 'contract', title: 'Sign booth space contract', category: 'legal', weight: 3, dueOffsetDays: -180 },
    { key: 'budget-approved', title: 'Get show budget approved', category: 'budget', weight: 3, dueOffsetDays: -175 },
    { key: 'goals', title: 'Agree show goals and target accounts', category: 'marketing', weight: 2, dueOffsetDays: -150, description: 'What would make this show worth repeating? Written down before it starts, not reconstructed after.' },
    { key: 'booth-design', title: 'Confirm booth design & graphics', category: 'booth', weight: 3, dueOffsetDays: -120 },
    { key: 'room-block', title: 'Reserve hotel room block', category: 'lodging', weight: 3, dueOffsetDays: -110, description: 'The block cutoff releases rooms to public inventory at rack rate. §5a.' },
    { key: 'staff-roster', title: 'Pick the booth staff roster', category: 'staffing', weight: 3, dueOffsetDays: -100 },
    { key: 'service-manual', title: 'Download the exhibitor service manual and log its deadlines', category: 'booth', weight: 3, dueOffsetDays: -75, description: 'Every deadline in it goes on the Deadlines register, with its penalty. This is the task the deadline engine depends on.' },
    { key: 'sponsorship', title: 'Decide on sponsorships and submit artwork', category: 'marketing', weight: 1, dueOffsetDays: -70 },
    { key: 'travel-requests', title: 'Open travel requests for the roster', category: 'travel', weight: 3, dueOffsetDays: -60 },
    { key: 'collateral-print', title: 'Print datasheets & case studies', category: 'collateral', weight: 2, dueOffsetDays: -45 },
    { key: 'swag', title: 'Order branded swag', category: 'collateral', weight: 1, dueOffsetDays: -45 },
    { key: 'demo-build', title: 'Build and rehearse the booth demo', category: 'booth', weight: 3, dueOffsetDays: -40 },
    { key: 'advance-order', title: 'Submit advance service order (electrical, carpet, AV, rigging, labor)', category: 'booth', weight: 3, dueOffsetDays: -30, description: 'The single most expensive deadline on this list: 25–40% surcharge on the whole services order after it. §5a.' },
    { key: 'badges', title: 'Register booth staff badges', category: 'staffing', weight: 2, dueOffsetDays: -30 },
    { key: 'lead-capture', title: 'Confirm lead capture app & licenses', category: 'follow_up', weight: 3, dueOffsetDays: -28, description: 'Ordered late, this is the reason a show produces a stack of unreadable badge scans.' },
    { key: 'warehouse-ship', title: 'Ship booth crate to the advance warehouse', category: 'shipping', weight: 3, dueOffsetDays: -25 },
    { key: 'shift-schedule', title: 'Build the booth shift schedule', category: 'staffing', weight: 2, dueOffsetDays: -21 },
    { key: 'meetings', title: 'Book customer meetings and dinners', category: 'marketing', weight: 2, dueOffsetDays: -21 },
    { key: 'preshow-email', title: 'Pre-show email campaign to target accounts', category: 'marketing', weight: 2, dueOffsetDays: -14 },
    { key: 'briefings', title: 'Schedule analyst and press briefings', category: 'marketing', weight: 1, dueOffsetDays: -14 },
    { key: 'staff-brief', title: 'Brief the staff: messaging, qualifying questions, shift plan', category: 'staffing', weight: 2, dueOffsetDays: -7 },
    { key: 'followup-sla', title: 'Agree the post-show follow-up SLA with sales', category: 'follow_up', weight: 3, dueOffsetDays: -5, description: 'Agreed before the show, because after it nobody has the leverage to.' },
    { key: 'crate-return', title: 'Book outbound crate return', category: 'shipping', weight: 2, dueOffsetDays: 2 },
    { key: 'leads-upload', title: 'Upload and de-duplicate the lead list', category: 'follow_up', weight: 3, dueOffsetDays: 4 },
    { key: 'reconcile', title: 'Reconcile the show budget against actuals', category: 'budget', weight: 2, dueOffsetDays: 30, description: 'The input to next year’s intake decision. §5c.' },
  ],
};

/** A table in the corner of somebody else's booth is not a 25-task project. */
const TABLETOP: ChecklistTemplate = {
  key: 'tabletop',
  name: 'Tabletop / small stand',
  blurb: 'Eight tasks for a show with no built booth, no drayage, and one or two staff.',
  items: [
    { key: 'contract', title: 'Sign booth space contract', category: 'legal', weight: 3, dueOffsetDays: -90 },
    { key: 'goals', title: 'Agree show goals and target accounts', category: 'marketing', weight: 2, dueOffsetDays: -75 },
    { key: 'staff-roster', title: 'Pick who is going', category: 'staffing', weight: 3, dueOffsetDays: -60 },
    { key: 'travel-requests', title: 'Open travel requests for the roster', category: 'travel', weight: 3, dueOffsetDays: -45 },
    { key: 'collateral-print', title: 'Print datasheets', category: 'collateral', weight: 2, dueOffsetDays: -21 },
    { key: 'lead-capture', title: 'Confirm lead capture app & licenses', category: 'follow_up', weight: 3, dueOffsetDays: -14 },
    { key: 'badges', title: 'Register staff badges', category: 'staffing', weight: 2, dueOffsetDays: -14 },
    { key: 'leads-upload', title: 'Upload and de-duplicate the lead list', category: 'follow_up', weight: 3, dueOffsetDays: 4 },
  ],
};

export const TEMPLATES: ChecklistTemplate[] = [STANDARD, TABLETOP];

export function findTemplate(key: string): ChecklistTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/* ---------------------------------- apply ---------------------------------- */

export type PlannedTask = {
  templateKey: string;
  title: string;
  description: string | null;
  category: TaskCategory;
  weight: number;
  dueOn: Date;
  sortOrder: number;
  /** True when this task's due date has already passed at apply time. */
  alreadyLate: boolean;
};

export type TemplatePlan = {
  template: ChecklistTemplate;
  create: PlannedTask[];
  /** Items skipped because this show already carries them, keyed by template key. */
  alreadyPresent: string[];
  /**
   * Plain-language summary for the screen. The apply button says what it will do
   * before it does it, for the same reason the clone screen does.
   */
  notes: string[];
};

export type TemplateTarget = {
  startsOn: Date;
  timezone: string;
  /** The show's existing checklist — only `templateKey` and `sortOrder` matter. */
  tasks: { templateKey: string | null; sortOrder: number }[];
};

/**
 * Resolve a template against a show.
 *
 * Applying twice adds nothing the second time: an item whose key is already on
 * the show is reported as present rather than re-created. That is enforced again
 * by a unique index, because "the caller checked first" is not a constraint — two
 * people hitting Apply on the same screen would otherwise both see an empty
 * checklist and both write twenty-five rows.
 *
 * Items whose date has already passed are still created, and flagged. Dropping
 * them would be the tidier screen and the worse product: a show seeded three
 * weeks before it opens genuinely *is* late on the advance order, and a checklist
 * that quietly omits the deadline you already missed is how the miss stays
 * invisible.
 */
export function planTemplate(
  template: ChecklistTemplate,
  target: TemplateTarget,
  asOf: Date,
): TemplatePlan {
  // Anchor: the show's opening day at 5pm local, so every offset is a whole
  // number of calendar days from a fixed local clock time.
  const openDay = instantToZoned(target.startsOn, target.timezone).slice(0, 10);
  const anchor = zonedToInstant(`${openDay}T${DUE_HOUR}`, target.timezone);

  const present = new Set(
    target.tasks.map((t) => t.templateKey).filter((k): k is string => k !== null),
  );
  const nextSort = target.tasks.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;

  const create: PlannedTask[] = [];
  const alreadyPresent: string[] = [];

  for (const item of template.items) {
    const key = `${template.key}:${item.key}`;
    if (present.has(key)) {
      alreadyPresent.push(key);
      continue;
    }
    const dueOn = shiftDaysPreservingLocalTime(anchor, item.dueOffsetDays, target.timezone);
    create.push({
      templateKey: key,
      title: item.title,
      description: item.description ?? null,
      category: item.category,
      weight: item.weight,
      dueOn,
      sortOrder: nextSort + create.length,
      alreadyLate: dueOn.getTime() < asOf.getTime(),
    });
  }

  const late = create.filter((t) => t.alreadyLate).length;
  const notes: string[] = [];
  notes.push(
    create.length === 0
      ? 'Nothing to add — every task in this template is already on the show.'
      : `Adds ${create.length} ${create.length === 1 ? 'task' : 'tasks'}, due between ` +
        `${offsetLabel(Math.min(...template.items.map((i) => i.dueOffsetDays)))} and ` +
        `${offsetLabel(Math.max(...template.items.map((i) => i.dueOffsetDays)))} days ` +
        'around the show’s opening day.',
  );
  if (alreadyPresent.length) {
    notes.push(
      `${alreadyPresent.length} already on this show and left alone — applying a template ` +
        'never edits a task you have already started.',
    );
  }
  if (late) {
    notes.push(
      `${late} ${late === 1 ? 'arrives' : 'arrive'} already past due, because the show is closer ` +
        'than the template assumes. They are added anyway: the work is genuinely late, and ' +
        'hiding it is how a missed advance-order deadline stays missed.',
    );
  }
  notes.push('Nothing is assigned. An owner is a decision, and a default one is nobody.');

  return { template, create, alreadyPresent, notes };
}

function offsetLabel(days: number): string {
  return days >= 0 ? `+${days}` : String(days);
}
