import { getDb } from '@/db';
import { sweepDeadlineAlerts } from '@/lib/deadlines/store';
import { syncFlightStatuses } from '@/lib/flights/store';
import { selectStatusProviderOrNull } from '@/lib/flights/provider';
import { syncShipmentTracking } from '@/lib/shipping/store';
import { selectTrackingProviderOrNull } from '@/lib/shipping/provider';
import { sweepAssetAlerts } from '@/lib/assets/store';
import { runCreditMaintenance } from '@/lib/travel/credits';
import type { AlertSource } from './feed';

type Db = ReturnType<typeof getDb>;

/**
 * All five engines, in one call. The thing `pnpm alerts --sweep` runs and the
 * thing step 21's scheduler will run.
 *
 * It exists because the engines have to run **together and completely** for the
 * feed to mean anything. Each one resolves the conditions it no longer plans
 * (see `store.ts`), so running four of five leaves the fifth's rows standing
 * with no statement about whether they are still true — which is survivable and
 * is exactly what `standingOf`'s `unchecked` standing is for, but only if a
 * reader can tell. So a run reports every engine's outcome, including the two
 * that need a provider and did not get one: **an engine that could not run is
 * not an engine with nothing to say**, which is the same sentence
 * `flights/status.ts` writes about a flight nobody could check.
 *
 * It deliberately does not swallow errors into a summary line. A sweep that
 * half-failed and reported success is how a board goes quiet.
 */

export type EngineOutcome = {
  source: AlertSource;
  raised: number;
  resolved: number;
  /** Set when the engine could not run at all. Nothing was resolved either. */
  unavailable?: string;
  detail?: string;
};

export async function runAllSweeps(
  orgId: string,
  now: Date = new Date(),
  db: Db = getDb(),
): Promise<EngineOutcome[]> {
  const out: EngineOutcome[] = [];

  const deadlines = await sweepDeadlineAlerts(orgId, now, db);
  out.push({
    source: 'deadline',
    raised: deadlines.written,
    resolved: deadlines.resolved,
    detail: `${deadlines.planned.length} deadline condition(s) hold tonight`,
  });

  const status = selectStatusProviderOrNull();
  if ('choice' in status) {
    const flights = await syncFlightStatuses(orgId, status.choice.provider, now, db);
    out.push({
      source: 'flight',
      raised: flights.alertsWritten,
      resolved: flights.alertsResolved,
      detail: `${flights.checked} leg(s) checked, ${flights.changed} moved, ${flights.noRecord} not found`,
    });
  } else {
    out.push({ source: 'flight', raised: 0, resolved: 0, unavailable: status.unavailable });
  }

  const tracking = selectTrackingProviderOrNull();
  if ('choice' in tracking) {
    const crates = await syncShipmentTracking(orgId, tracking.choice.provider, now, db);
    out.push({
      source: 'shipping',
      raised: crates.alertsWritten,
      resolved: crates.alertsResolved,
      detail: `${crates.checked} crate(s) checked, ${crates.scansAdded} new scan(s)`,
    });
  } else {
    out.push({ source: 'shipping', raised: 0, resolved: 0, unavailable: tracking.unavailable });
  }

  const assets = await sweepAssetAlerts(orgId, now, db);
  out.push({
    source: 'asset',
    raised: assets.alertsWritten,
    resolved: assets.alertsResolved,
    detail: `${assets.reservations} reservation(s) examined`,
  });

  const credits = await runCreditMaintenance(db, orgId, now);
  out.push({
    source: 'credit',
    raised: credits.alertsSent,
    resolved: credits.alertsResolved,
    detail:
      `${credits.warned} credit(s) approaching expiry` +
      (credits.sweptCount > 0
        ? `, ${credits.sweptCount} written off for $${(credits.forfeitedCents / 100).toFixed(0)}`
        : ''),
  });

  return out;
}
