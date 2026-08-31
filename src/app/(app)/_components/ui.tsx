import Link from 'next/link';

/**
 * The small shared vocabulary the planning screens are built from.
 *
 * Deliberately plain: step 8's job is to make the domain legible, and a design
 * system invented before there are ten screens to test it against is a guess.
 */

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-4">
          {title && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
          )}
          {action}
        </div>
      )}
      <div className="text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <span className="w-44 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

const TONES = {
  neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  bad: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * An empty state says why it is empty and where the thing comes from. "No data"
 * is indistinguishable from a bug.
 */
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-zinc-500">{children}</p>;
}

export function Button({
  children,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const base =
    'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const look =
    variant === 'primary'
      ? 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300'
      : 'border border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800';
  return (
    <button {...props} className={`${base} ${look} ${props.className ?? ''}`}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {children}
    </Link>
  );
}

/* ------------------------------- formatting -------------------------------- */

export function money(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/**
 * Dates render in the *show's* zone, not the reader's. A move-in time shown in
 * the viewer's browser zone is the same class of bug as parsing a flight time
 * with `new Date()` — see src/lib/datetime/zoned.ts.
 */
export function showDate(d: Date | null | undefined, timeZone: string): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function showDateTime(d: Date | null | undefined, timeZone: string): string {
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function dateRange(start: Date, end: Date, timeZone: string): string {
  const sameMonth =
    start.toLocaleDateString('en-US', { timeZone, month: 'short', year: 'numeric' }) ===
    end.toLocaleDateString('en-US', { timeZone, month: 'short', year: 'numeric' });
  if (!sameMonth) return `${showDate(start, timeZone)} – ${showDate(end, timeZone)}`;
  const month = start.toLocaleDateString('en-US', { timeZone, month: 'short' });
  const d1 = start.toLocaleDateString('en-US', { timeZone, day: 'numeric' });
  const d2 = end.toLocaleDateString('en-US', { timeZone, day: 'numeric' });
  const year = start.toLocaleDateString('en-US', { timeZone, year: 'numeric' });
  return `${month} ${d1}–${d2}, ${year}`;
}

export function daysUntil(d: Date): number {
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export function place(show: {
  city: string | null;
  region: string | null;
  country: string | null;
}): string {
  return [show.city, show.region ?? show.country].filter(Boolean).join(', ') || '—';
}

export const STATUS_TONE: Record<string, Tone> = {
  prospect: 'info',
  committed: 'neutral',
  planning: 'neutral',
  ready: 'good',
  live: 'good',
  complete: 'neutral',
  cancelled: 'bad',
};

export function statusLabel(status: string): string {
  return status === 'cancelled' ? 'declined' : status;
}

/**
 * `null` is *unplanned*, not 0% — see `src/lib/readiness/score.ts`. It gets a
 * neutral tone and its own word, because colouring it red says "behind" and
 * colouring it green says "done", and it is neither.
 */
export function readinessTone(score: number | null): Tone {
  if (score === null) return 'neutral';
  if (score >= 80) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

export function readinessLabel(score: number | null): string {
  return score === null ? 'No checklist' : `${score}% ready`;
}
