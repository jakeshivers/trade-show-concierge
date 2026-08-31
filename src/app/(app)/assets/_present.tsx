import type { AssetRow } from '@/lib/assets/board';
import type { Availability, CustodyStanding, Serviceability } from '@/lib/assets/custody';
import type { StockStanding } from '@/lib/assets/inventory';
import { Badge, type Tone } from '../_components/ui';

/**
 * How an asset reads, in one place, because two screens render it.
 *
 * The show's Logistics tab and the workspace register must not disagree about
 * whether `never_collected` is a calm colour or what `secondhand`'s equivalent
 * looks like here — a divergence nothing catches, since each screen agrees with
 * itself. Same reasoning as `shipping/_present.tsx`, which is where this became
 * a rule rather than a preference.
 *
 * One tone choice is deliberate and worth stating. **`out` is neutral, not
 * good.** An asset that is signed out is doing exactly what it is for, and
 * colouring that green would say the loop is closed when the only thing that
 * closes it is a check-in. `returned` is the green one.
 */

export const CUSTODY_TONE: Record<CustodyStanding, Tone> = {
  planned: 'neutral',
  due_out: 'info',
  out: 'neutral',
  overdue: 'warn',
  missing: 'bad',
  never_collected: 'warn',
  returned: 'good',
};

export const CUSTODY_LABEL: Record<CustodyStanding, string> = {
  planned: 'reserved',
  due_out: 'due out',
  out: 'signed out',
  overdue: 'overdue back',
  missing: 'unaccounted for',
  never_collected: 'never taken',
  returned: 'back',
};

export const SEVERITY_TONE: Record<'info' | 'warning' | 'critical', Tone> = {
  info: 'info',
  warning: 'warn',
  critical: 'bad',
};

export function CustodyBadge({ row }: { row: AssetRow }) {
  if (!row.custody) return <Badge>not reserved</Badge>;
  const { standing, hoursPastDue } = row.custody;
  const late = standing === 'overdue' || standing === 'missing';
  return (
    <Badge tone={CUSTODY_TONE[standing]}>
      {CUSTODY_LABEL[standing]}
      {late && ` · ${(hoursPastDue / 24).toFixed(0)}d`}
    </Badge>
  );
}

/** A condition badge that says what it *means* for the next show, not just what it is. */
export function ConditionBadge({ serviceability, condition }: {
  serviceability: Serviceability;
  condition: string;
}) {
  if (serviceability.kind === 'serviceable') return <Badge tone="good">good</Badge>;
  return (
    <Badge tone={condition === 'retired' ? 'neutral' : 'warn'}>
      {condition.replace('_', ' ')} — not fit to go
    </Badge>
  );
}

/**
 * The picker's refusals, each with its reason attached — the same rule
 * `availableActions` follows in `travel/review.ts`. An option greyed out with no
 * sentence beside it is a screen refusing to explain itself.
 */
export function AvailabilityNote({ availability }: { availability: Availability }) {
  switch (availability.kind) {
    case 'available':
      return null;
    case 'unserviceable':
      return <span className="text-warn">{availability.why}</span>;
    case 'committed':
      return <span className="text-bad">already promised elsewhere for these dates</span>;
    case 'tight_turnaround':
      return (
        <span className="text-warn">
          only {availability.gapHours.toFixed(0)}h between this and another show
        </span>
      );
  }
}

export const STOCK_TONE: Record<StockStanding['level'], Tone> = {
  ok: 'good',
  low: 'warn',
  short: 'bad',
};

/**
 * On hand beside available, always, and never on hand alone.
 *
 * The whole §5h correction about collateral is that the first number reads fine
 * while the second is the one that decides whether the crate can be packed. A
 * component that could render one without the other would be the way that
 * correction gets undone by the next screen somebody adds.
 */
export function StockCell({ standing }: { standing: StockStanding }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 text-xs">
      <span className="tabular font-medium">{standing.available} free</span>
      <span className="tabular text-text-muted">
        of {standing.onHand} on hand
        {standing.committed > 0 && ` · ${standing.committed} promised`}
        {standing.issued > 0 && ` · ${standing.issued} in crates`}
      </span>
      {standing.level !== 'ok' && (
        <Badge tone={STOCK_TONE[standing.level]}>
          {standing.level === 'short' ? 'oversubscribed' : 'low'}
        </Badge>
      )}
    </span>
  );
}

export function local(d: Date | null | undefined, zone: string | null): string {
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    timeZone: zone ?? 'UTC',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
