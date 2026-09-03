import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { getRollCallPortfolio } from '@/lib/safety/store';
import { canStartRollCall } from '@/lib/safety/access';
import { rollCallShowOrder } from '@/lib/safety/rollcall';
import { Badge, Card, Empty, PageHeader } from '../_components/ui';
import { GoToShow } from '../_components/go-to-show';
import { BASIS_LABEL } from '@/lib/safety/presence';
import type { PersonStanding, RollCall } from '@/lib/safety/rollcall';
import { BoardAnswer } from './forms';

/**
 * Who is still to be heard from, in the order `rollcall.ts` already sorted them
 * into — the people this page exists for. Derived rather than stored, and read
 * off `people` rather than recomputed, so the list under a badge can never
 * disagree with the count on it.
 */
function outstanding(c: RollCall & { showId: string }): PersonStanding[] {
  return c.people.filter(
    (p) => p.response === null && p.presence.kind !== 'not_travelling',
  );
}

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
  const asOf = new Date();
  const calls = await getRollCallPortfolio(actor, asOf);
  const travelling = calls.filter((c) =>
    c.people.some((p) => p.presence.kind !== 'not_travelling'),
  );

  // The comparator lives in `rollcall.ts`, not here, so this page and
  // `pnpm rollcall` cannot put a different show at the top of the same incident.
  const ranked = [...travelling].sort((a, b) => rollCallShowOrder(a, b, asOf));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Duty of care"
        blurb="Where your people are expected to be, why we think so, and who we would not be able to phone. Shows nearest to today come first, except that anyone who has said they need help comes above everything. This does not track phones or locations — it works from records the app already keeps."
        action={
          canStartRollCall(actor) ? (
            <GoToShow
              actor={actor}
              tab="safety"
              label="Start a roll call"
              hint={
                <>
                  A response is a response to a request, so a roll call is opened on the show it
                  is about — and nobody is ever marked safe by the system.
                </>
              }
            />
          ) : undefined
        }
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

                {/*
                  The list to work down, on the board rather than one click away.
                  This screen is read while something is going wrong, and until now
                  it was a summary that linked out: to record that somebody is safe
                  you opened the show, found the Safety tab, then found the name.
                  Three navigations, during an evacuation, on a phone.
                  `/shows/[id]/safety` is still where a roll call is started and
                  closed — those belong to the show, and starting one from a list of
                  shows is exactly the guess `GoToShow` refuses to make. What moves
                  here is the only act that is time-critical and unambiguous: this
                  person, this roll call, heard from.

                  It shows the **outstanding** people only. The accounted-for are
                  not work, and a board that redrew the whole roster would bury the
                  four names that matter under the twenty that do not — the same
                  reason the show tab leads with who has not answered.
                */}
                {c.request && outstanding(c).length > 0 && (
                  <ul className="mt-3 space-y-2 border-t border-border pt-3">
                    {outstanding(c).map((p) => (
                      <li key={p.presence.userId} className="space-y-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-medium">{p.presence.fullName}</span>
                          <span className="text-xs text-text-muted">
                            {BASIS_LABEL[p.presence.basis]}
                            {p.presence.stale && ' (stale)'}
                          </span>
                          {/*
                            A phone number is the actual next action, so it is a
                            tel: link rather than text to copy. Somebody with none
                            is called out rather than left looking merely quiet:
                            their silence means nothing, and that is refusal 3.
                          */}
                          {p.phone ? (
                            <a href={`tel:${p.phone}`} className="text-xs underline">
                              {p.phone}
                            </a>
                          ) : (
                            <span className="text-xs text-bad">no phone number</span>
                          )}
                        </div>
                        <BoardAnswer
                          showId={c.showId}
                          checkId={c.request!.id}
                          userId={p.presence.userId}
                          isSelf={p.presence.userId === actor.userId}
                          name={p.presence.fullName}
                          standing={p.response?.standing ?? null}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
