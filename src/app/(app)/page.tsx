import Link from 'next/link';
import { authMode, isAdmin, canApprove } from '@/lib/auth/actor';
import { readLoginPolicy } from '@/lib/auth/login-policy-store';
import { formatStrategies } from '@/lib/auth/login-methods';
import { purchasingStatus } from '@/lib/travel/kill-switch';
import { getItinerary, listShows } from '@/lib/shows/store';
import { ENGINE_COUNT } from '@/lib/alerts/feed';
import { getSetupSteps } from '@/lib/setup/store';
import { getDb } from '@/db';
import { currentActor, currentFeed } from './_request';
import { GROUPS, visibleItems } from './_components/nav';
import { SetupCard } from './setup-card';
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
 * It leads with real work: what this workspace still needs before it functions,
 * then what is owed to you, what needs deciding, what is coming up, and where
 * you personally are going.
 *
 * Two things it used to do and no longer does, both the same defect:
 *
 * 1. It ended with a card headed "The booking spine runs headless", saying the
 *    travel request form and approvals queue would "land at step 9" and listing
 *    three `pnpm` commands as the way to use the product. Step 9 shipped sixteen
 *    steps before anybody read that sentence again. It is deleted rather than
 *    reworded — what replaced it is `SetupCard`, which says what is *actually*
 *    unfinished about this particular workspace.
 * 2. "What you can do here" was a hand-written array of seven capabilities,
 *    frozen at step 8, beside a nav that had grown to twenty-three entries. It
 *    is derived from `_components/nav.ts` now, filtered through the same role
 *    gate the sidebar uses, so the two cannot disagree and a new screen cannot
 *    be added without a sentence describing it.
 */

export default async function OverviewPage() {
  const actor = await currentActor();
  const db = getDb();
  const [policy, purchasing, shows, trips, feed, setup] = await Promise.all([
    readLoginPolicy(actor.orgId, db),
    purchasingStatus(actor.orgId, db),
    listShows(actor),
    getItinerary(actor),
    // Memoized per request — the sidebar badges the same number from the layout.
    currentFeed(),
    getSetupSteps(actor, db),
  ]);

  const prospects = shows.filter((s) => s.status === 'prospect');
  const upcoming = shows
    .filter((s) => ['committed', 'planning', 'ready', 'live'].includes(s.status))
    .filter((s) => daysUntil(s.endsOn) >= 0)
    .slice(0, 4);
  const myNext = trips.filter((t) => daysUntil(t.show.endsOn) >= 0).slice(0, 3);

  // The same list the sidebar renders, through the same filter. `/` is dropped:
  // "See what is owed to you and what is coming up" is a description of the page
  // the reader is already on.
  const gates = { isAdmin: isAdmin(actor), isApprover: canApprove(actor) };
  const capabilities = GROUPS.map((g) => ({
    label: g.label,
    items: visibleItems(g.items, gates).filter((i) => i.href !== '/'),
  })).filter((g) => g.items.length > 0);

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

      {/* Above the alerts, and it is the only thing that outranks them: an alert
          is work inside a workspace that functions, and these are the reasons it
          does not yet. It renders nothing once they are all done. */}
      {setup.length > 0 && <SetupCard steps={setup} />}

      {/* Above everything else, including what needs deciding: a missed receiving
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
          <p className="text-text-muted">
            Nothing upcoming.{' '}
            <Link className="underline" href="/shows/new">
              Propose a show
            </Link>
            , or look at the ones that have already run.
          </p>
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
                    ? `${plural(t.flights.length, 'flight', 'flights')} booked`
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

      <Card
        title="What you can do here"
        subtitle="Everything your role reaches, and what each screen is for."
      >
        <div className="space-y-4">
          {capabilities.map((group) => (
            <div key={group.label}>
              <p className="pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {group.label}
              </p>
              <ul className="space-y-1">
                {group.items.map((i) => (
                  <li key={i.href} className="flex flex-wrap items-baseline gap-x-2">
                    <Link href={i.href} className="font-medium hover:underline">
                      {i.label}
                    </Link>
                    <span className="text-text-muted">{i.does}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
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

    </div>
  );
}


