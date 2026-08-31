import Link from 'next/link';
import { Badge, money, type Tone } from '../_components/ui';
import { STATUS, standingMatters } from '@/lib/travel/review';
import type { OfferStanding } from '@/lib/travel/review';
import type { TravelRequestSummary } from '@/lib/travel/queue';

/**
 * The pieces both the list and the queue render.
 *
 * The one rule they share: **a fare is never shown as a bare number.** What
 * `$612` means depends entirely on whether the offer behind it is still for
 * sale, and the whole point of `offerStanding` is that the answer is computed
 * once. So every price on these screens is rendered by `Fare`, which will not
 * print a figure without saying what kind of figure it is.
 */

export function StatusBadge({ status }: { status: keyof typeof STATUS }) {
  const s = STATUS[status];
  return <Badge tone={s.tone as Tone}>{s.label}</Badge>;
}

const STANDING_TONE: Record<OfferStanding['kind'], Tone> = {
  live: 'good',
  held_guaranteed: 'good',
  held_unguaranteed: 'warn',
  expired: 'warn',
};

/**
 * A price, with what it actually is.
 *
 * "$612 · offer expired — will re-price" is longer than "$612" and is the
 * difference between an approver authorizing a fare and an approver authorizing
 * a ceiling they were never told about.
 */
export function Fare({
  cents,
  standing,
}: {
  cents: number | null;
  standing: OfferStanding | null;
}) {
  if (cents === null) {
    return <span className="text-text-muted">not priced yet</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span className={standing?.bookableAtShownPrice ? 'font-medium' : 'font-medium text-text-muted'}>
        {money(cents)}
      </span>
      {standing && (
        <Badge tone={STANDING_TONE[standing.kind]}>{standingShort(standing.kind)}</Badge>
      )}
    </span>
  );
}

function standingShort(kind: OfferStanding['kind']): string {
  switch (kind) {
    case 'live':
      return 'fare live';
    case 'held_guaranteed':
      return 'held · fare guaranteed';
    case 'held_unguaranteed':
      return 'held · fare NOT guaranteed';
    case 'expired':
      return 'expired · will re-price';
  }
}

export function RequestRow({
  r,
  showTraveler,
}: {
  r: TravelRequestSummary;
  showTraveler: boolean;
}) {
  return (
    <li className="border-b border-border py-2.5 last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <StatusBadge status={r.status} />
        <Link href={`/travel/${r.id}`} className="font-medium hover:underline">
          {r.originAirport} → {r.destinationAirport}
        </Link>
        {r.show && (
          <Link href={`/shows/${r.show.id}`} className="text-xs text-text-muted hover:underline">
            {r.show.name}
          </Link>
        )}
        <span className="ml-auto">
          <Fare cents={r.quotedCents} standing={standingMatters(r.status) ? r.standing : null} />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-text-muted">
        <span>
          out {r.earliestDeparture.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
        {showTraveler && <span>{r.traveler.fullName}</span>}
        {r.requester.fullName !== r.traveler.fullName && (
          <span>opened by {r.requester.fullName}</span>
        )}
        {r.awaitingConstraintConfirmation && (
          <span className="text-warn">
            parsed constraints unconfirmed
          </span>
        )}
      </div>
    </li>
  );
}
