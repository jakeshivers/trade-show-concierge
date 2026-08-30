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
