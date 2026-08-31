import Link from 'next/link';
import { cn } from './cn';

/**
 * The shared vocabulary the screens are built from.
 *
 * This file's original header said it was deliberately plain, because a design
 * system invented before ten screens exist to test it against is a guess — and
 * it named its own expiry. There are 17 routes now, so this is the version
 * written *against* them rather than ahead of them, and every component here
 * exists because at least three screens had hand-rolled it.
 *
 * Everything is on the semantic tokens in `globals.css`. No screen names a
 * palette colour: `border-border`, never `border-border`. That is what makes
 * a palette change one diff instead of a search.
 */

/* --------------------------------- surfaces -------------------------------- */

export function Card({
  title,
  action,
  subtitle,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-panel p-5 shadow-sm shadow-black/[0.02]',
        className,
      )}
    >
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-sm text-text-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="text-sm text-text">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-border py-1.5 last:border-0">
      <span className="w-44 shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/* ---------------------------------- tables --------------------------------- */

/**
 * A dense list with a header that stays put.
 *
 * The registers in this app scroll — a checklist is 25 rows, a deadline register
 * more — and a column header that scrolls away turns a table of numbers into a
 * table of numbers you have to scroll back up to read. The horizontal scroll is
 * on the wrapper rather than the page, so a wide table never makes the whole
 * document scroll sideways.
 */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('-mx-1 overflow-x-auto px-1', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  numeric,
  className,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'sticky top-0 z-[1] border-b border-border bg-panel py-2 pr-3 text-left text-xs font-semibold uppercase tracking-wider text-text-muted',
        numeric && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

/**
 * `numeric` right-aligns *and* switches to tabular figures.
 *
 * Half this app is money — fares, penalties, nightly rates, exposure — and a
 * money column that is left-aligned in a proportional face cannot be scanned for
 * magnitude, which is the only reason to put numbers in a column.
 */
export function Td({
  children,
  numeric,
  className,
}: {
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-border py-2 pr-3 align-top',
        numeric && 'tabular text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ---------------------------------- tones ---------------------------------- */

/**
 * The four tones the domain speaks in, plus neutral — on the tokens, so light
 * and dark are one definition rather than a `dark:` twin per line that somebody
 * eventually forgets.
 */
const TONES = {
  neutral: 'bg-muted text-text-muted',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-block rounded-md px-1.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
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
  return <p className="py-2 text-sm text-text-muted">{children}</p>;
}

/* --------------------------------- buttons --------------------------------- */

/**
 * Three variants and no `danger`.
 *
 * Every destructive action in this app is either reversible in the app or
 * *irreversible outside* it — un-staffing does not cancel the ticket, cancelling
 * a request does not tell the airline. A red button implies the app can undo
 * what it is about to do, so the weight belongs in the sentence the store makes
 * you acknowledge, which is where it already is. `QuietSubmit` in `form-ui.tsx`
 * is the destructive affordance.
 */
const BUTTON = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-hover shadow-sm',
  secondary: 'border border-border-strong bg-panel text-text hover:bg-muted',
  ghost: 'text-text-muted hover:bg-muted hover:text-text',
} as const;

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function Button({
  children,
  variant = 'primary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON }) {
  return (
    <button {...props} className={cn(BUTTON_BASE, BUTTON[variant], className)}>
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  children,
  variant = 'secondary',
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof BUTTON;
  className?: string;
}) {
  return (
    <Link href={href} className={cn(BUTTON_BASE, BUTTON[variant], className)}>
      {children}
    </Link>
  );
}

/* ---------------------------------- pages ---------------------------------- */

/** One page heading, so every screen's title, blurb and action line up. */
export function PageHeader({
  title,
  blurb,
  action,
}: {
  title: string;
  blurb?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {blurb && <p className="mt-1 max-w-2xl text-sm text-text-muted">{blurb}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A number worth leading with, and the sentence that stops it being read wrong.
 *
 * `note` is not optional decoration on most of this app's figures: "40% ready"
 * means nothing without "eight months out", and the readiness portfolio exists
 * because of exactly that.
 */
export function Stat({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: Tone;
}) {
  const colour =
    tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : '';
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</div>
      <div className={cn('tabular mt-0.5 text-2xl font-semibold tracking-tight', colour)}>
        {value}
      </div>
      {note && <div className="mt-0.5 text-xs text-text-muted">{note}</div>}
    </div>
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
