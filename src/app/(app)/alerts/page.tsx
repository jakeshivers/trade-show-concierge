import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getAlertFeed } from '@/lib/alerts/store';
import {
  SOURCE_LABEL,
  groupFeed,
  linkFor,
  standingDays,
  standingOf,
  type AlertStanding,
  type FeedGroup,
} from '@/lib/alerts/feed';
import { Badge, Card, Empty, PageHeader, Stat, type Tone } from '../_components/ui';
import { RefreshButton, SeenButton } from './forms';

/**
 * The feed — everything five engines have to say to this person, worst first.
 *
 * For twelve steps the `alerts` table was written by the deadline engine, the
 * flight engine, the shipping engine, the asset engine and the credit sweep, and
 * read by nothing. Every one of those steps ended by noting that `pnpm
 * deadlines` / `pnpm flights` / `pnpm shipping` / `pnpm assets` was how a person
 * heard any of it. This is the screen those notes were owed.
 *
 * What it deliberately does not do:
 *
 * - **It does not let anybody resolve an alert.** Acknowledging says "I have
 *   seen this" and changes nothing about the crate. Only a sweep closes a
 *   condition, by no longer finding it — see `alerts/store.ts`. A dismiss button
 *   that cleared the board would be the exact failure this product keeps naming:
 *   a screen that goes green while the world does not.
 * - **It does not re-derive anything.** Every sentence here was written by the
 *   engine that owns the judgment, in the tense that engine argued about — "at
 *   risk" before a date and "incurred" after it, "delivered" as the carrier's
 *   word and "received" as a person's. A feed that re-worded them would be a
 *   sixth opinion, and the one a reader sees.
 * - **It does not show anybody else's alerts**, including for an admin. The
 *   audience was decided when each alert was planned, by code that knew what it
 *   was about. `alerts/access.ts` has the argument.
 *
 * The one thing it *does* add is grouping. Eleven people on one re-timed flight
 * is eleven correct rows and one piece of news, and an engine cannot see that
 * because it only ever looks at one leg.
 */

export const metadata = { title: 'Alerts' };
export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'bad',
  warning: 'warn',
  info: 'info',
};

const STANDING_NOTE: Record<AlertStanding, string> = {
  new: 'First time this has been said.',
  repeating: 'Said again by every sweep since.',
  unchecked: 'True when it was last checked, and nothing has checked since.',
  acknowledged: 'Seen by you. Still true.',
  resolved: 'The condition ended. Nobody had to clear it.',
};

export default async function AlertsPage() {
  const actor = await getActor();
  const asOf = new Date();
  const { alerts, summary } = await getAlertFeed(actor, { asOf });
  const groups = groupFeed(alerts, asOf);

  const live = groups.filter((g) => {
    const s = standingOf(g.lead, asOf);
    return s !== 'resolved' && s !== 'acknowledged';
  });
  const seen = groups.filter((g) => standingOf(g.lead, asOf) === 'acknowledged');
  const over = groups.filter((g) => standingOf(g.lead, asOf) === 'resolved');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        blurb={
          <>
            Everything five engines have to say to you, worst first — deadlines, flights,
            freight, assets and ticket credits. Each sentence is written by the engine that
            owns the judgment, in the tense that engine chose: a penalty is “at risk” before
            its date and “incurred” after it, and a crate is “delivered” only in the
            carrier’s words until somebody says it reached the booth.
          </>
        }
        action={<RefreshButton />}
      />

      <Card title="Addressed to you">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Outstanding"
            value={summary.outstanding}
            tone={summary.critical > 0 ? 'bad' : summary.outstanding > 0 ? 'warn' : 'good'}
            note={summary.oldestDays > 0 ? `Oldest, ${summary.oldestDays} days.` : undefined}
          />
          <Stat
            label="Critical"
            value={summary.critical}
            tone={summary.critical > 0 ? 'bad' : 'neutral'}
          />
          {/* The figure that is a statement about us rather than about the
              crates: nothing has re-checked these, so their claims are as old as
              the last sweep. */}
          <Stat
            label="Unchecked"
            value={summary.unchecked}
            tone={summary.unchecked > 0 ? 'warn' : 'neutral'}
            note="True when last looked at. Nothing has looked since."
          />
          <Stat
            label="Seen, still true"
            value={summary.acknowledged}
            note="Acknowledging is not fixing."
          />
          <Stat
            label="Ended by themselves"
            value={summary.resolved}
            tone={summary.resolved > 0 ? 'good' : 'neutral'}
            note="Resolved because a sweep stopped finding them."
          />
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Nothing here runs on a schedule yet — a scheduler is step 21 — so an alert is
          exactly as fresh as the last time somebody pressed <em>Re-check everything</em>.
          That is why “unchecked” is a number on this page rather than a footnote.
        </p>
      </Card>

      {alerts.length === 0 ? (
        <Empty>
          Nothing is addressed to you. That is the ordinary result: all five engines are
          written to say nothing on most rows on most nights, which is the only way the ones
          that do speak stay worth reading.
        </Empty>
      ) : (
        <>
          {live.length > 0 && (
            <Card title="Outstanding">
              <ul className="space-y-4">
                {live.map((g) => (
                  <AlertRow key={g.lead.id} group={g} asOf={asOf} />
                ))}
              </ul>
            </Card>
          )}

          {seen.length > 0 && (
            <Card
              title="Seen, and still true"
              subtitle="Acknowledged by you. The condition has not changed — only a sweep can end it."
            >
              <ul className="space-y-4">
                {seen.map((g) => (
                  <AlertRow key={g.lead.id} group={g} asOf={asOf} />
                ))}
              </ul>
            </Card>
          )}

          {over.length > 0 && (
            <Card
              title="Ended"
              subtitle="The engine stopped finding these. Kept for a month, because “when did that clear” is a real question."
            >
              <ul className="space-y-4">
                {over.map((g) => (
                  <AlertRow key={g.lead.id} group={g} asOf={asOf} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function AlertRow({ group, asOf }: { group: FeedGroup; asOf: Date }) {
  const a = group.lead;
  const standing = standingOf(a, asOf);
  const days = standingDays(a, asOf);
  const href = linkFor(a);

  return (
    <li className="border-b border-border pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone={SEVERITY_TONE[a.severity] ?? 'neutral'}>{a.severity}</Badge>
        <Badge>{SOURCE_LABEL[a.source]}</Badge>
        {standing === 'unchecked' && <Badge tone="warn">unchecked</Badge>}
        {standing === 'resolved' && <Badge tone="good">ended</Badge>}
        <span className="font-medium">{a.title}</span>
        {group.rest.length > 0 && (
          <Badge tone="info">
            +{group.rest.length} more row{group.rest.length === 1 ? '' : 's'} saying this
          </Badge>
        )}
      </div>

      {a.body && <p className="mt-1 text-sm text-text-muted">{a.body}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span>
          {days === 0 ? 'First said today' : `First said ${days} day${days === 1 ? '' : 's'} ago`}
          {a.occurrences > 1 && ` · repeated by ${a.occurrences} sweeps`}
        </span>
        <span>{STANDING_NOTE[standing]}</span>
        {a.showName && (
          <Link href={`/shows/${a.showId}`} className="hover:underline">
            {a.showName}
          </Link>
        )}
        {group.showNames.length > 1 && <span>across {group.showNames.join(', ')}</span>}
        {href && (
          <Link href={href} className="underline hover:no-underline">
            Go to it
          </Link>
        )}
        {standing !== 'resolved' && <SeenButton alertId={a.id} seen={standing === 'acknowledged'} />}
      </div>

      {group.rest.length > 0 && (
        <details className="mt-1.5 text-xs text-text-muted">
          <summary className="cursor-pointer">
            The other {group.rest.length} row{group.rest.length === 1 ? '' : 's'}
          </summary>
          {/* Kept individually underneath rather than merged: each is somebody's
              actual leg or crate, and the person it belongs to sees exactly one. */}
          <ul className="mt-1 space-y-1 pl-4">
            {group.rest.map((other) => (
              <li key={other.id}>{other.body ?? other.title}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
