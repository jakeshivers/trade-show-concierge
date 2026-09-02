import { getActor } from '@/lib/auth/actor';
import { canStartRollCall } from '@/lib/safety/access';
import { BASIS_LABEL, type Presence } from '@/lib/safety/presence';
import { getRollCall } from '@/lib/safety/store';
import { Badge, Card, Empty } from '../../../_components/ui';
import { AnswerFor, CloseRollCall, StartRollCall } from './forms';

/**
 * Duty of care — the tenth tab, and the only screen in this product that is read
 * while something is going wrong.
 *
 * Two things shape it. It leads with **who has not answered**, in the order to
 * phone them, because that is the entire output and a page that opened with a
 * reassuring count would bury it. And every standing carries **what it rests
 * on** — "badged into a booth shift, 12m ago" beside "travel window covers now"
 * — because `RESEARCH.md` sells this feature as *"we know where everyone is"*
 * and we do not: we know what a badge scanner recorded this morning and what
 * somebody typed into a window in June, and a person deciding who to look for
 * needs to see which of those they are reading.
 */

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<Presence['kind'], string> = {
  at_venue: 'At the venue',
  in_town: 'In town',
  in_transit: 'In transit',
  not_travelling: 'Not there',
  unknown: 'Unknown',
};

const KIND_TONE: Record<Presence['kind'], 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  at_venue: 'info',
  in_town: 'neutral',
  in_transit: 'info',
  not_travelling: 'neutral',
  unknown: 'warn',
};

function age(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export default async function SafetyTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  const call = await getRollCall(actor, id);
  const mayStart = canStartRollCall(actor);
  const open = call.request;

  return (
    <div className="space-y-6">
      <Card
        title={open ? 'Roll call in progress' : 'Duty of care'}
        subtitle={
          open
            ? 'Nobody is accounted for until they say so. A badge scan is not an answer — the person who badged in twelve minutes ago is who you most need to hear from.'
            : 'Who is expected at this show, what says so, and who a roll call could not reach. The useful time to read this is now, while the gaps can still be fixed.'
        }
      >
        {open?.note && <p className="mb-2 text-sm font-medium">{open.note}</p>}
        <p className="text-sm">{call.summary}</p>

        {open && call.needsHelp > 0 && (
          <p className="mt-2 rounded-md border border-bad px-3 py-2 text-sm font-medium text-bad">
            {call.needsHelp} {call.needsHelp === 1 ? 'person needs' : 'people need'} help.
          </p>
        )}

        {mayStart && (
          <div className="mt-4 border-t border-border pt-4">
            {open ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <CloseRollCall showId={id} checkId={open.id} />
                <span>
                  Closing records that you consider it finished. It marks nobody — anybody who
                  has not answered stays unanswered in the record.
                </span>
              </div>
            ) : (
              <StartRollCall showId={id} />
            )}
          </div>
        )}
      </Card>

      <Card
        title={open ? 'Who to call, in the order to call them' : 'Who is expected here'}
        subtitle="Ordered by what their silence would cost, not by how sure we are they are here. Somebody nothing can locate and who has not answered is the worst thing on this page."
      >
        {call.people.length === 0 ? (
          <Empty>Nobody is on this show’s roster.</Empty>
        ) : (
          <ul className="space-y-3">
            {call.people.map((p) => (
              <li key={p.presence.userId} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{p.presence.fullName}</span>
                  <Badge tone={KIND_TONE[p.presence.kind]}>{KIND_LABEL[p.presence.kind]}</Badge>
                  {p.response ? (
                    p.response.standing === 'needs_help' ? (
                      <Badge tone="bad">Needs help</Badge>
                    ) : (
                      <Badge tone="good">{p.relayed ? 'OK — relayed' : 'OK'}</Badge>
                    )
                  ) : open ? (
                    <Badge tone="warn">Not answered</Badge>
                  ) : null}
                  {p.unreachable && (
                    <Badge tone="bad">No phone number — a roll call cannot reach them</Badge>
                  )}
                  <span className="ml-auto text-xs text-text-muted">
                    {p.phone ?? p.email}
                  </span>
                </div>

                <p className="mt-1 text-xs text-text-muted">
                  {BASIS_LABEL[p.presence.basis]}
                  {age(p.presence.ageMinutes) && ` · ${age(p.presence.ageMinutes)}`}
                  {p.presence.stale && ' · this has stopped being a claim about now'}
                  {p.response?.note && ` · “${p.response.note}”`}
                </p>

                {open && !p.response && p.presence.kind !== 'not_travelling' && (
                  <div className="mt-2">
                    <AnswerFor
                      showId={id}
                      checkId={open.id}
                      userId={p.presence.userId}
                      isSelf={p.presence.userId === actor.userId}
                      name={p.presence.fullName}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
          Nothing on this page reads a device. Every standing is inferred from records this
          app already keeps for other reasons — a badge scan, a landed flight, a hotel stay, a
          travel window somebody typed months ago. That is a deliberate ceiling on what this
          feature is, not a gap in it.
        </p>
      </Card>
    </div>
  );
}
