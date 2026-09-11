import type { ShipmentRow } from '@/lib/shipping/board';
import type { ShipmentPhase, WindowStanding } from '@/lib/shipping/status';
import { Badge, type Tone } from '../_components/ui';

/**
 * How a shipment reads, in one place, because two screens render it.
 *
 * The show's Logistics tab and the workspace board must not disagree about what
 * `too_early` looks like or whether `delivered` is a calm colour — a divergence
 * nothing would catch, since each screen agrees with itself. `flights/page.tsx`
 * got away with keeping its tones private because it is the only page rendering
 * a leg; the moment there are two, the vocabulary has to move.
 */

export const STATUS_TONE: Record<ShipmentPhase, Tone> = {
  draft: 'neutral',
  label_created: 'neutral',
  in_transit: 'info',
  out_for_delivery: 'info',
  // Deliberately *not* `good`. A delivered crate is on a dock, not at the booth,
  // and colouring it green is the screen telling somebody they are finished.
  delivered: 'info',
  exception: 'bad',
  returned: 'bad',
  cancelled: 'neutral',
  unknown: 'warn',
};

export const WINDOW_TONE: Record<WindowStanding, Tone> = {
  not_applicable: 'neutral',
  no_estimate: 'warn',
  clear: 'good',
  tight: 'warn',
  late: 'bad',
  too_early: 'bad',
  arrived: 'good',
  arrived_late: 'warn',
  arrived_early: 'warn',
  no_arrival: 'bad',
};

const WINDOW_LABEL: Record<WindowStanding, string> = {
  not_applicable: 'no deadline',
  no_estimate: 'no estimate',
  clear: 'on time',
  tight: 'tight',
  late: 'will miss',
  too_early: 'before dock opens',
  arrived: 'arrived',
  arrived_late: 'arrived late',
  arrived_early: 'arrived early',
  no_arrival: 'not arriving',
};

export const SEVERITY_TONE: Record<'info' | 'warning' | 'critical', Tone> = {
  info: 'info',
  warning: 'warn',
  critical: 'bad',
};

export const CONSIGNMENT_LABEL: Record<string, string> = {
  advance_warehouse: 'advance warehouse',
  show_site: 'show site',
  office: 'office',
  direct: 'direct — no show dock',
};

/**
 * The window as one cell.
 *
 * Hours near the edge, days further out — `flights/page.tsx`'s rule, for the
 * same reason: "614h before the cutoff" is a precision nobody asked for on a
 * crate that ships next month, and it makes the 18h row harder to find.
 */
export function gap(hours: number): string {
  const abs = Math.abs(hours);
  if (abs >= 48) return `${(hours / 24).toFixed(0)}d`;
  return `${hours.toFixed(1)}h`;
}

export function WindowCell({ row }: { row: ShipmentRow }) {
  const w = row.window;
  return (
    <>
      <Badge tone={WINDOW_TONE[w.standing]}>{WINDOW_LABEL[w.standing]}</Badge>
      {w.hoursSpare !== null && (
        <span className="mt-0.5 block text-xs text-text-muted">
          {w.hoursSpare >= 0 ? `${gap(w.hoursSpare)} spare` : `${gap(Math.abs(w.hoursSpare))} over`}
          {w.brokenSincePromise && ' · slipped'}
        </span>
      )}
    </>
  );
}

/** Silence, said out loud — the one column no carrier's payload would fill in. */
export function ScanCell({ row, asOf }: { row: ShipmentRow; asOf: Date }) {
  const { stall, shipment } = row;
  if (stall.kind === 'never_scanned') {
    return <span className="text-warn">never scanned · {(stall.sinceHours / 24).toFixed(1)}d</span>;
  }
  if (stall.kind === 'stalled') {
    return <span className="text-warn">silent {(stall.sinceHours / 24).toFixed(1)}d</span>;
  }
  if (!shipment.lastScanAt) return <span className="text-text-muted">—</span>;
  const hours = (asOf.getTime() - shipment.lastScanAt.getTime()) / 3_600_000;
  return (
    <span className="text-text-muted">
      {hours < 48 ? `${hours.toFixed(0)}h ago` : `${(hours / 24).toFixed(0)}d ago`}
    </span>
  );
}

export function local(d: Date | null, zone: string | null): string {
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    timeZone: zone ?? 'UTC',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
