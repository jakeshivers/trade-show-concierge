import { plural } from '@/lib/text';
import { THRESHOLD_DAYS } from './alerts';

/**
 * What one register row *is*, and what somebody should do about it.
 *
 * Reported by a user reading the register: four pills in a row — `sponsorship
 * artwork`, `missed`, `unowned`, `from a room block` — with no way to tell which
 * of them was the problem, what any of them meant, or what to do next. All four
 * rendered at the same weight, and one of them (`sponsorship artwork`) only
 * repeated the words already in the title beside it.
 *
 * The pills were each *true*. The failure is that a badge is a label, and every
 * one of these is really a **state with a consequence and a next action** —
 * which is three things a two-word chip cannot hold. `UI-REWORK.md` §14's rule
 * (page copy says what is true and what fixing it looks like) has a layout half
 * that this row was breaking: **when a reader has to be told what a badge means,
 * the badge was the wrong control.**
 *
 * So a row gets exactly one badge — where it stands against its own date, which
 * is the thing the register exists to report — and everything else becomes a
 * sentence in a short "what to do" list. Pure, so `pnpm deadlines` can print the
 * same sentences the screen shows.
 */

export type DeadlineStanding =
  /** Past its date and still open. */
  | 'missed'
  /** Open, due today. */
  | 'today'
  /** Open, inside the first alert threshold. */
  | 'soon'
  /** Open, and there is time. */
  | 'ahead'
  /** Somebody has ordered it. */
  | 'done'
  /** Deliberately waived this year. */
  | 'waived';

/**
 * The first threshold `alerts.ts` speaks at.
 *
 * Read from `THRESHOLD_DAYS` rather than written down again: the badge says
 * "due in 18 days" in a warning tone precisely because that is when the engine
 * starts speaking, and a second copy of 30 would drift the badge away from the
 * behaviour it is describing.
 */
export const SOON_DAYS = THRESHOLD_DAYS[0];

export type StandingView = {
  standing: DeadlineStanding;
  /** The one badge on the row. */
  label: string;
  /**
   * What somebody should do, in order, most important first — empty when the
   * row needs nothing. Each is a sentence rather than a term, because the whole
   * report was that the terms did not survive being read.
   */
  todo: string[];
};

export type PresentableDeadline = {
  status: string;
  daysUntil: number;
  ownerId: string | null;
  ownerName: string | null;
  confirmedAt: Date | null;
  penaltyEstimateCents: number | null;
  /** Derived from a hotel's room-block cutoff, so its date is not edited here. */
  lodgingId: string | null;
  /** Read out of a manual by the extractor and not yet checked by a person. */
  extractedFromDocument: boolean;
  /** End-of-day was assumed because the manual printed no hour. */
  dueTimeAssumed: boolean;
};

export function standingOf(d: PresentableDeadline): StandingView {
  const standing = standingKind(d);
  return { standing, label: LABEL[standing](d), todo: todoFor(d, standing) };
}

function standingKind(d: PresentableDeadline): DeadlineStanding {
  if (d.status === 'complete') return 'done';
  if (d.status === 'not_applicable') return 'waived';
  if (d.daysUntil < 0) return 'missed';
  if (d.daysUntil === 0) return 'today';
  return d.daysUntil <= SOON_DAYS ? 'soon' : 'ahead';
}

const LABEL: Record<DeadlineStanding, (d: PresentableDeadline) => string> = {
  // Past tense, and no figure: §5a's rule that a missed penalty is incurred
  // rather than at risk, so the badge must not read like something to hurry at.
  missed: (d) => `Missed ${plural(-d.daysUntil, 'day', 'days')} ago`,
  today: () => 'Due today',
  soon: (d) => `Due in ${plural(d.daysUntil, 'day', 'days')}`,
  ahead: (d) => `Due in ${plural(d.daysUntil, 'day', 'days')}`,
  done: () => 'Ordered',
  waived: () => 'Does not apply this year',
};

function todoFor(d: PresentableDeadline, standing: DeadlineStanding): string[] {
  const todo: string[] = [];
  if (standing === 'done' || standing === 'waived') return todo;

  if (standing === 'missed') {
    // First, because it is the only thing left that changes anything. The money
    // is gone either way and the row is still being counted as open work.
    todo.push(
      d.penaltyEstimateCents !== null
        ? 'The date has passed, so this charge is already spent rather than at risk. Mark it ordered, or record that it does not apply, so it stops being chased.'
        : 'The date has passed. Mark it ordered, or record that it does not apply, so it stops being chased.',
    );
  }

  // Ownership before confirmation: an unowned row's reminders go to whoever runs
  // the show rather than to a person, which is the thing most likely to end with
  // nobody acting.
  if (!d.ownerId) {
    todo.push(
      'Nobody owns this. Until somebody does, its reminders go to whoever runs the show rather than to a person — pick an owner below.',
    );
  }

  // A derived row is checked against the *hotel*, not the manual. Sending
  // somebody to the exhibitor manual to verify a room-block cutoff is a
  // confident instruction to look in the wrong document — and it renders on
  // exactly the row whose whole design is that its date has one source.
  if (!d.confirmedAt && standing !== 'missed') {
    todo.push(
      d.lodgingId
        ? 'Nobody has checked this cutoff against the hotel’s contract. It is set on the Lodging tab — confirm it there once it is right, and there is only ever one copy of the date.'
        : d.penaltyEstimateCents !== null
          ? 'Nobody has checked this date against this year’s manual, so reminders name the date and never the amount. Open the manual, and confirm it if it is right.'
          : 'Nobody has checked this date against this year’s manual. Open the manual, and confirm it if it is right.',
    );
  }

  if (d.dueTimeAssumed) {
    todo.push(
      'The manual gave a date but no time, so end of day was assumed. A warehouse that shuts at 4pm is an afternoon of surcharge — set the real hour before confirming.',
    );
  }

  if (d.extractedFromDocument && !d.confirmedAt) {
    todo.push('This was read out of the manual by the assistant. The quote it came from is below.');
  }

  // Only when the confirmation line above has not already said it.
  if (d.lodgingId && d.confirmedAt) {
    todo.push(
      'The date comes from a hotel’s room-block cutoff and is edited on the Lodging tab, so there is only ever one copy of it.',
    );
  }

  return todo;
}
