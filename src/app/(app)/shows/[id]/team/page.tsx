import { Badge, Card, Empty, showDateTime, type Tone } from '../../../_components/ui';
import { loadShow } from '../detail';

/**
 * Team — who is staffed, and the side events around the show.
 *
 * Shift coverage, conflict detection, and RSVPs land at step 12. The roster is
 * org-wide information; what a given person's travel looks like is not, and lives
 * on the Travel tab under `travelerScope`.
 */
export default async function TeamTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { detail } = await loadShow(id);
  const { show, attendees, sideEvents } = detail;

  return (
    <div className="space-y-6">
      <Card title="Attendees">
        {attendees.length === 0 ? (
          <Empty>Nobody is staffed on this show yet.</Empty>
        ) : (
          <ul className="space-y-1.5">
            {attendees.map(({ attendee, user }) => (
              <li
                key={attendee.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800"
              >
                <span className="font-medium">{user.fullName}</span>
                <Badge tone={ATTENDEE_TONE[attendee.status]}>{attendee.status}</Badge>
                <span className="text-zinc-500">{attendee.role}</span>
                <span className="ml-auto text-xs text-zinc-500">
                  {attendee.arrivesOn
                    ? `${showDateTime(attendee.arrivesOn, show.timezone)} → ${showDateTime(attendee.departsOn, show.timezone)}`
                    : 'Travel window not set'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Side events">
        {sideEvents.length === 0 ? (
          <Empty>
            No dinners, demos, or seminars recorded. RSVPs and guest lists arrive at step 12.
          </Empty>
        ) : (
          <ul className="space-y-1.5">
            {sideEvents.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800"
              >
                <span className="font-medium">{event.name}</span>
                <Badge>{event.kind}</Badge>
                <span className="text-zinc-500">{showDateTime(event.startsAt, show.timezone)}</span>
                {event.location && <span className="text-xs text-zinc-500">{event.location}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const ATTENDEE_TONE: Record<string, Tone> = {
  confirmed: 'good',
  invited: 'info',
  declined: 'bad',
  cancelled: 'neutral',
};
