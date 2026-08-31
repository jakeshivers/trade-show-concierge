/**
 * Airport-local time handling.
 *
 * Flight APIs send segment times as *local time at the airport* with no UTC
 * offset — "2026-03-29T08:15:00" means 08:15 in San Francisco. Parsing that with
 * `new Date()` yields whatever the server's timezone happens to be, which makes
 * a 4h50m transcontinental flight look like 7h50m and silently corrupts every
 * duration-based policy rule.
 *
 * So the airport's IANA zone is required to build an instant.
 */

export class ZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZonedTimeError';
  }
}

/** True when a datetime string already carries a UTC offset or Z. */
export function hasExplicitOffset(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * Interpret a naive local datetime in a given IANA zone as an absolute instant.
 *
 * Two passes: guess the offset by reading the naive time as UTC, then re-read
 * the offset at the corrected instant. The second pass is what makes DST
 * transitions come out right.
 */
export function zonedToInstant(naive: string, timeZone: string): Date {
  const trimmed = naive.trim();

  if (hasExplicitOffset(trimmed)) {
    const explicit = new Date(trimmed);
    if (Number.isNaN(explicit.getTime())) {
      throw new ZonedTimeError(`Invalid datetime: "${naive}"`);
    }
    return explicit;
  }

  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(trimmed)) {
    throw new ZonedTimeError(`Invalid naive datetime: "${naive}"`);
  }

  const asIfUtc = new Date(`${trimmed.replace(' ', 'T')}Z`);
  if (Number.isNaN(asIfUtc.getTime())) {
    throw new ZonedTimeError(`Invalid naive datetime: "${naive}"`);
  }

  let offset: number;
  try {
    offset = offsetMsAt(asIfUtc, timeZone);
  } catch {
    throw new ZonedTimeError(`Unknown time zone: "${timeZone}"`);
  }

  const first = new Date(asIfUtc.getTime() - offset);
  const refined = offsetMsAt(first, timeZone);
  return refined === offset ? first : new Date(asIfUtc.getTime() - refined);
}

/**
 * Render an instant as the naive local datetime a person in `timeZone` reads
 * off the wall — `"2026-11-04T17:00:00"`, no offset. The inverse of
 * `zonedToInstant`, and the halfway point of any calendar arithmetic.
 */
export function instantToZoned(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    throw new ZonedTimeError('Invalid instant');
  }
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new ZonedTimeError(`Unknown time zone: "${timeZone}"`);
  }
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  // Intl renders midnight as hour "24" under hour12:false in some ICU versions.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Move an instant forward by whole calendar days, keeping the local clock time.
 *
 * Adding `days * 86_400_000` milliseconds is the obvious implementation and it is
 * wrong across a DST boundary: a 5:00pm advance-order deadline shifted 364 days
 * that way lands at 4:00pm or 6:00pm. An hour is usually survivable; a deadline
 * that crosses midnight is not, and being an hour off is exactly the failure the
 * deadline engine (SCOPE.md §5a) exists to prevent. So the shift is done on the
 * local calendar and re-resolved to an instant against the zone.
 */
export function shiftDaysPreservingLocalTime(
  instant: Date,
  days: number,
  timeZone: string,
): Date {
  if (!Number.isInteger(days)) {
    throw new ZonedTimeError(`Day shift must be a whole number of days, got ${days}`);
  }
  const naive = instantToZoned(instant, timeZone);
  const [date, clock] = naive.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const iso = shifted.toISOString().slice(0, 10);
  return zonedToInstant(`${iso}T${clock}`, timeZone);
}

/** Whole calendar days between two instants, as read in `timeZone`. */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  const dayOf = (d: Date) => {
    const [y, m, day] = instantToZoned(d, timeZone).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((dayOf(to) - dayOf(from)) / 86_400_000);
}

/* ------------------------- what a form input wants ------------------------- */

/**
 * The wall-clock strings `<input type="date">`, `<input type="time">` and
 * `<input type="datetime-local">` want, read in `timeZone`.
 *
 * These live here, next to `instantToZoned` and covered by its tests, because
 * the view layer had reimplemented them **four times** — `iso` on the team tab,
 * `local` on lodging, `dateInput` on the checklist, `localPart` on the deadline
 * register — each a hand-rolled `Intl.formatToParts` call, and none of them
 * tested. Two of the four were written hours apart in the same step.
 *
 * That is not a tidiness problem. It is the browser-zone bug this whole module
 * exists to prevent, reimplemented in the one layer where nothing was watching:
 * `toISOString().slice(0, 10)` on a 5pm-Pacific due date returns *tomorrow*, so
 * a round trip through the edit form silently moves the deadline a day. A
 * deadline that moves a day is the exact failure the §5a engine is for.
 *
 * All three derive from `instantToZoned`, so there is one `Intl` call site in
 * the codebase and one place for the hour-"24" workaround to be wrong.
 */
export function zonedDateInput(instant: Date | null | undefined, timeZone: string): string {
  return instant ? instantToZoned(instant, timeZone).slice(0, 10) : '';
}

export function zonedTimeInput(instant: Date | null | undefined, timeZone: string): string {
  return instant ? instantToZoned(instant, timeZone).slice(11, 16) : '';
}

/** `"YYYY-MM-DDTHH:MM"` — what `datetime-local` reads and writes. */
export function zonedDateTimeInput(instant: Date | null | undefined, timeZone: string): string {
  return instant ? instantToZoned(instant, timeZone).slice(0, 16) : '';
}
