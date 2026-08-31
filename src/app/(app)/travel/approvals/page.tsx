import Link from 'next/link';
import { getActor, canApprove, canApproveRequestFor } from '@/lib/auth/actor';
import { approvalsQueue } from '@/lib/travel/queue';
import { purchasingStatus } from '@/lib/travel/kill-switch';
import { getDb } from '@/db';
import { Card, Empty } from '../../_components/ui';
import { Fare, StatusBadge } from '../_components';
import { standingMatters } from '@/lib/travel/review';

/**
 * The approvals queue.
 *
 * Written around one sentence from SCOPE.md §6b: **an approval authorizes an
 * amount, not an offer.** Offers die in about thirty minutes; a queue lives
 * overnight. So a row here does not say "$612 — approve?", because roughly half
 * the time approving does not buy that fare at all: it authorizes $612 as a
 * ceiling, re-searches, and books whatever comes back at or under it.
 *
 * The standing of each offer is therefore on the row itself, not hidden behind
 * the detail page, and it is computed by the same `offerStanding` the agent uses
 * to decide. An approver who has to click through to find out whether the number
 * is real will stop clicking through.
 *
 * Oldest first: this is a work queue, and the thing that has waited longest is
 * the thing whose offer is deadest.
 */
export default async function ApprovalsPage() {
  const actor = await getActor();
  const [queue, halt] = await Promise.all([
    approvalsQueue(actor),
    purchasingStatus(actor.orgId, getDb()),
  ]);

  // Oldest first — the store returns newest-first for the personal list, which
  // is the right default there and the wrong one here.
  const rows = [...queue].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Requests the policy engine would not auto-book. Approving authorizes{' '}
          <strong>an amount, not an offer</strong> — where the fare has already expired, the agent
          re-searches and holds the result to what you signed off.
        </p>
      </header>

      {!canApprove(actor) && (
        <p className="rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          You are not an approver, so this shows only your own requests waiting on someone else.
        </p>
      )}

      {halt.halted && (
        <p className="rounded-md bg-rose-100 px-3 py-2 text-xs text-rose-900 dark:bg-rose-950 dark:text-rose-200">
          <strong>Automated purchasing is halted org-wide.</strong>{' '}
          {halt.reason ?? 'No reason recorded.'} Approvals are refused while it is off — the agent
          keeps searching and judging, so this queue is a backlog rather than a hole. An admin
          resumes it under Security.
        </p>
      )}

      <Card title={`Waiting (${rows.length})`}>
        {rows.length === 0 ? (
          <Empty>
            Nothing is waiting on a human. Requests within policy are booked by the agent without
            appearing here.
          </Empty>
        ) : (
          <ul className="space-y-4">
            {rows.map((r) => {
              const mayDecide = canApproveRequestFor(actor, r.requester.id);
              const waitedHours = Math.floor(r.ageMs / 3_600_000);

              return (
                <li
                  key={r.id}
                  className="border-b border-zinc-100 pb-4 last:border-0 dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <StatusBadge status={r.status} />
                    <Link href={`/travel/${r.id}`} className="font-medium hover:underline">
                      {r.originAirport} &rarr; {r.destinationAirport}
                    </Link>
                    <span className="text-sm text-zinc-500">{r.traveler.fullName}</span>
                    {r.show && (
                      <Link
                        href={`/shows/${r.show.id}`}
                        className="text-xs text-zinc-500 hover:underline"
                      >
                        {r.show.name}
                      </Link>
                    )}
                    <span className="ml-auto">
                      <Fare
                        cents={r.quotedCents}
                        standing={standingMatters(r.status) ? r.standing : null}
                      />
                    </span>
                  </div>

                  {/* The sentence that makes the number above mean something. */}
                  {r.standing && (
                    <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                      {r.standing.meaning}
                    </p>
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-zinc-500">
                    <span>waiting {waitedHours < 1 ? 'under an hour' : `${waitedHours}h`}</span>
                    {mayDecide ? (
                      <Link href={`/travel/${r.id}`} className="font-medium underline">
                        Review and decide &rarr;
                      </Link>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">
                        {r.requester.id === actor.userId
                          ? 'Yours — it needs another approver.'
                          : 'Not yours to approve.'}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
