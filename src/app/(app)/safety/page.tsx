import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getRollCallPortfolio } from '@/lib/safety/store';
import { Badge, Card, Empty, PageHeader } from '../_components/ui';

/**
 * Duty of care across the calendar.
 *
 * `RESEARCH.md`'s pitch is *"who is on the ground in Chicago right now"*, and
 * this is that question — with the honest answer, which is a list of shows and
 * what each one's records can and cannot say.
 *
 * It is ordered by **what is wrong** rather than by date: a roll call with people
 * still unanswered first, then shows with somebody a roll call could not reach at
 * all, then the quiet ones. The second of those is the reason to open this page
 * on an ordinary Tuesday — a missing phone number is free to fix today and
 * impossible to fix during an evacuation.
 */

export const dynamic = 'force-dynamic';

export default async function SafetyPortfolio() {
  const actor = await getActor();
  const calls = await getRollCallPortfolio(actor);
  const travelling = calls.filter((c) =>
    c.people.some((p) => p.presence.kind !== 'not_travelling'),
  );

  const ranked = [...travelling].sort((a, b) => {
    const rank = (c: (typeof travelling)[number]) =>
      c.needsHelp > 0 ? 0 : c.request && c.outstanding > 0 ? 1 : c.unreachable > 0 ? 2 : 3;
    return rank(a) - rank(b) || b.people.length - a.people.length;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Duty of care"
        blurb="Who is expected where, what says so, and who could not be reached. Nothing here reads a device — every standing is inferred from records this app already keeps."
      />

      <Card title="Shows with people travelling">
        {ranked.length === 0 ? (
          <Empty>Nobody is travelling to any show on the calendar.</Empty>
        ) : (
          <ul className="space-y-3">
            {ranked.map((c) => (
              <li key={c.showId} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/shows/${c.showId}/safety`}
                    className="font-medium underline hover:no-underline"
                  >
                    {c.showName}
                  </Link>
                  {c.needsHelp > 0 && <Badge tone="bad">{c.needsHelp} need help</Badge>}
                  {c.request && c.outstanding > 0 && (
                    <Badge tone="warn">Roll call running · {c.outstanding} unanswered</Badge>
                  )}
                  {!c.request && c.unreachable > 0 && (
                    <Badge tone="bad">
                      {c.unreachable} with no phone number
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-muted">{c.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
