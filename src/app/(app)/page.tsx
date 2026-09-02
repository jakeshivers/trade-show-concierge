import Link from 'next/link';
import { getActor, authMode, isAdmin, canApprove } from '@/lib/auth/actor';
import { readLoginPolicy } from '@/lib/auth/login-policy-store';
import { formatStrategies } from '@/lib/auth/login-methods';
import { purchasingStatus } from '@/lib/travel/kill-switch';
import { getItinerary, listShows } from '@/lib/shows/store';
import { getAlertFeed } from '@/lib/alerts/store';
import { ENGINE_COUNT } from '@/lib/alerts/feed';
import { getDb } from '@/db';
import {
  Badge,
  Card,
  PageHeader,
  Row,
  dateRange,
  daysUntil,
  place,
  readinessLabel,
  readinessTone,
} from './_components/ui';
import { plural } from './_components/text';

/**
 * The overview.
 *
 * As of step 8 there is real work to point at, so it leads with it: what needs
 * deciding, what is coming up, and where you personally are going. It still ends
 * with the state of the seam and the spine, because the spine remains headless
 * until step 9 and a person needs to be told that rather than left to infer it
 * from an absence.
 */

export default async function OverviewPage() {
  const actor = await getActor();
  const db = getDb();
  const [policy, purchasing, shows, trips, feed] = await Promise.all([
    readLoginPolicy(actor.orgId, db),
    purchasingStatus(actor.orgId, db),
    listShows(actor),
    getItinerary(actor),
    getAlertFeed(actor),
  ]);

  const prospects = shows.filter((s) => s.status === 'prospect');
  const upcoming = shows
    .filter((s) => ['committed', 'planning', 'ready', 'live'].includes(s.status))
    .filter((s) => daysUntil(s.endsOn) >= 0)
    .slice(0, 4);
  const myNext = trips.filter((t) => daysUntil(t.show.endsOn) >= 0).slice(0, 3);

  const capabilities = [
    'See your shows, flights, lodging, and itinerary',
    'Submit a travel request',
    ...(canApprove(actor)
      ? ["See everyone's travel and shipments", 'Approve a request that exceeds policy', 'View the agent decision log']
      : []),
    ...(isAdmin(actor)
      ? ['Set travel policy and spend thresholds', 'Manage shows, budgets, and members', 'Restrict permitted login methods']
      : []),
  ];

  return (
    <div className="space-y-10">
      <PageHeader
        title={`Welcome, ${actor.fullName.split(' ')[0]}`}
        blurb={
          authMode() === 'clerk'
            ? 'What needs deciding, what is coming up, and where you are going.'
            : 'What needs deciding, what is coming up, and where you are going. This session is a development sign-in.'
        }
      />

      {/* Above everything, including what needs deciding: a missed receiving
          window is this week and a prospect is next quarter. It is a count and a
          link rather than the alerts themselves — the feed orders and groups
          them, and a second, shorter opinion here would be the one people read. */}
      {feed.summary.outstanding > 0 && (
        <Card title="Owed to you">
          <p>
            <Link href="/alerts" className="font-medium underline hover:no-underline">
              {plural(feed.summary.outstanding, 'outstanding alert', 'outstanding alerts')}
            </Link>{' '}
            <span className="text-text-muted">
              {feed.summary.critical > 0 && `${feed.summary.critical} critical · `}
              {feed.summary.unchecked > 0 &&
                `${feed.summary.unchecked} not re-checked recently · `}
              from the {ENGINE_COUNT} engines that watch this workspace.
            </span>
          </p>
        </Card>
      )}

      {prospects.length > 0 && (
        <Card title="Awaiting a decision">
          <ul className="space-y-1">
            {prospects.map((s) => (
              <li key={s.id}>
                <Link href={`/shows/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>{' '}
                <span className="text-text-muted">
                  {dateRange(s.startsOn, s.endsOn, s.timezone)} · {place(s)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted">
            {isAdmin(actor)
              ? 'You can commit or decline these, with a written reason.'
              : 'An admin commits or declines these.'}
          </p>
        </Card>
      )}

      <Card title="Next up">
        {upcoming.length === 0 ? (
          <p className="text-text-muted">Nothing on the calendar. </p>
        ) : (
          <ul className="space-y-1.5">
            {upcoming.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3">
                <Link href={`/shows/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <span className="text-text-muted">
                  {dateRange(s.startsOn, s.endsOn, s.timezone)} · {place(s)}
                </span>
                <Badge tone={readinessTone(s.readiness.score)}>
                  {readinessLabel(s.readiness.score)}
                </Badge>
                <span className="ml-auto text-xs text-text-muted">
                  in {plural(daysUntil(s.startsOn), 'day', 'days')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs">
          <Link className="underline" href="/shows">
            All shows
          </Link>
        </p>
      </Card>

      <Card title="Where you're going">
        {myNext.length === 0 ? (
          <p className="text-text-muted">
            You are not staffed on an upcoming show.{' '}
            <Link className="underline" href="/itinerary">
              My itinerary
            </Link>
          </p>
        ) : (
          <ul className="space-y-1.5">
            {myNext.map((t) => (
              <li key={t.show.id} className="flex flex-wrap items-baseline gap-x-3">
                <Link href={`/shows/${t.show.id}`} className="font-medium hover:underline">
                  {t.show.name}
                </Link>
                <span className="text-text-muted">
                  {t.flights.length
                    ? `${t.flights.length} flights booked`
                    : 'no flights booked yet'}
                  {t.lodging.length ? ` · ${t.lodging[0].hotelName}` : ' · no room yet'}
                </span>
                <span className="ml-auto text-xs">
                  <Link className="underline" href="/itinerary">
                    details
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="What you can do here">
        <ul className="list-disc space-y-1 pl-5">
          {capabilities.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>

      <Card title="Organization">
        <Row label="Sign-in methods">
          {policy && policy.policy.mode === 'allowlist' ? (
            <>
              Restricted to {formatStrategies(policy.policy.allowedStrategies)}
              {isAdmin(actor) && (
                <>
                  {' · '}
                  <Link className="underline" href="/settings/security">
                    change
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              Unrestricted
              {isAdmin(actor) && (
                <>
                  {' · '}
                  <Link className="underline" href="/settings/security">
                    restrict
                  </Link>
                </>
              )}
            </>
          )}
        </Row>
        <Row label="Automated purchasing">
          {purchasing.halted
            ? `Halted — ${purchasing.reason ?? 'no reason recorded'}`
            : 'Active'}
        </Row>
      </Card>

      <Card title="The booking spine runs headless">
        <p>
          Steps 1&ndash;6 built the part that spends money, and it still has no screens: the
          travel request form and the approvals queue land at step 9. Until then the whole
          loop is legible from the command line, and the Travel tab on a show shows what it
          has recorded.
        </p>
        <ul className="mt-3 space-y-1 font-mono text-xs">
          <li>pnpm booking:dry-run</li>
          <li>pnpm booking:audit &lt;id&gt;</li>
          <li>pnpm credits</li>
        </ul>
      </Card>
    </div>
  );
}


