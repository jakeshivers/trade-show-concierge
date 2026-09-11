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

function answeredAgo(at: Date, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
  return mins < 1 ? 'just now' : (age(mins) ?? 'earlier');
}

export default async function SafetyTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  const call = await getRollCall(actor, id);
  const mayStart = canStartRollCall(actor);
  const open = call.request;
  const now = new Date();
  const nameOf = new Map(call.people.map((p) => [p.presence.userId, p.presence.fullName] as const));

  return (
    <div className="space-y-6">
      <Card
        title={open ? 'Roll call in progress' : 'Duty of care'}
        subtitle={
          open
            ? 'Work down the list and mark each person once you have actually heard from them. Nobody counts as safe until somebody says so — badging into the booth this morning is not an answer.'
            : 'Everyone expected at this show, why we think they are there, and who we would not be able to phone in an emergency. Worth checking now, while the gaps are still fixable.'
        }
      >
        {open?.note && <p className="mb-2 text-sm font-medium">{open.note}</p>}
        <p className="text-sm">{call.summary}</p>

        {open && call.needsHelp > 0 && (
          <div className="mt-2 rounded-md border border-bad px-3 py-2 text-sm text-bad">
            <p className="font-medium">
              {call.needsHelp} {call.needsHelp === 1 ? 'person has' : 'people have'} said they
              need help.
            </p>
            {/*
              What the standing means, in front of the person reading it. The
              word is alarming and the app's part in it is small: it changes an
              order and holds a name open. Nothing here calls anybody, and a
              screen that does not say so invites somebody to assume it did.
            */}
            <p className="mt-1 text-xs">
              That is somebody saying they are not all right. It sorts them to the top of the
              list below and keeps the roll call open. It does not call anyone, alert anyone
              or contact emergency services — that is a phone call somebody makes. When they
              have been reached, record what they say now with <strong>“is OK now”</strong> on
              their row; the earlier answer stays in the record.
            </p>
          </div>
        )}

        {mayStart && (
          <div className="mt-4 border-t border-border pt-4">
            {open ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <CloseRollCall showId={id} checkId={open.id} />
                <span>
                  Closing just records that you are done. It does not mark anybody safe —
                  anyone who never answered stays unanswered in the record.
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
        subtitle={
          open
            ? 'Start at the top. Anyone who said they need help comes first, then people we have not heard from — and among those, the ones we have no idea where they are.'
            : 'Everyone travelling to this show, with the most recent sign of where they are. Anyone we could not reach by phone is flagged.'
        }
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
                  Why we think so: {BASIS_LABEL[p.presence.basis]}
                  {age(p.presence.ageMinutes) && ` · ${age(p.presence.ageMinutes)}`}
                  {p.presence.stale && ' · too old to say where they are now'}
                  {p.response?.note && ` · “${p.response.note}”`}
                </p>

                {p.response && (
                  <p className="mt-1 text-xs text-text-muted">
                    {p.response.standing === 'needs_help'
                      ? `Said they need help ${answeredAgo(p.response.respondedAt, now)}`
                      : `Answered ${answeredAgo(p.response.respondedAt, now)}`}
                    {p.relayed &&
                      ` · recorded by ${nameOf.get(p.response.recordedById) ?? 'a colleague'}, not by ${p.presence.fullName.split(' ')[0]}`}
                    {p.response.standing === 'needs_help' &&
                      ' · they stay on this list until somebody records what they say next'}
                  </p>
                )}

                {open && p.presence.kind !== 'not_travelling' && (
                  <div className="mt-2">
                    {/*
                      Rendered whether or not they have answered. The store has
                      always been append-only and the roll call reads the latest
                      answer, so a correction is a new answer rather than an edit
                      — but for three steps this control disappeared the moment
                      anybody pressed a button, which made "needs help" a state
                      with no way out on the one screen somebody reads under
                      pressure.
                    */}
                    <AnswerFor
                      showId={id}
                      checkId={open.id}
                      userId={p.presence.userId}
                      isSelf={p.presence.userId === actor.userId}
                      name={p.presence.fullName}
                      standing={p.response?.standing ?? null}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
          This page does not track anybody’s phone or location. Everything here is worked out
          from records the app already keeps for other reasons — a badge scan at the booth, a
          flight that landed, a hotel booking, a travel window somebody typed in months ago. So
          treat it as a good guess about where to start looking, never as proof somebody is
          there. That is on purpose.
        </p>
      </Card>
    </div>
  );
}
