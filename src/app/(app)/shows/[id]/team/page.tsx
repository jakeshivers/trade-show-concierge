import Link from 'next/link';
import { getTeamBoard } from '@/lib/team/store';
import { Badge, Card, Empty, money, showDateTime, type Tone } from '../../../_components/ui';
import { loadShow } from '../detail';
import { AttendeeControls, InviteForm } from './roster-forms';
import { AddShiftForm, EditShiftForm, ShiftControls, UnassignButton } from './shift-forms';
import { AddSideEventForm, RsvpControl, SideEventControls } from './side-event-forms';

/**
 * Team — who is going, who is on the booth, and who is in two places at once.
 *
 * Writable as of step 12. The page leads with what is *wrong* rather than with a
 * headline count, for the reason the readiness portfolio does: "12 of 12 slots
 * assigned" is the number somebody looks at and stops, and it is the number most
 * likely to be a lie. So the coverage line names the shifts a roster count would
 * have called full, and each shift lists, by name, the people it cannot count and
 * why.
 *
 * The roster itself is org-wide (step 8's correction: §3 scopes *travel*, not the
 * calendar). Fares and hotel rows stay on the Travel and Lodging tabs, where
 * `travelerScope` narrows them.
 */
export default async function TeamTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, detail } = await loadShow(id);
  const board = await getTeamBoard(actor, id);
  const { show } = detail;
  const { roster, shifts, coverage, clashes, sideEvents, people, costCenters, may } = board;

  return (
    <div className="space-y-6">
      <Card title="Attendees">
        {roster.length === 0 ? (
          <Empty>
            Nobody is staffed on this show yet.{' '}
            {may.staff
              ? 'Invite a colleague below — they confirm for themselves, and only an answer they gave counts toward booth coverage.'
              : 'A travel manager or an admin staffs a show. Once you are invited you answer for yourself here.'}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {roster.map((entry) => {
              const a = entry.attendee;
              return (
                <li
                  key={a.id}
                  className="border-b border-border pb-3 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{entry.user.fullName}</span>
                    <Badge tone={ATTENDEE_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                    {/* Answered-by-them versus pencilled-in is the distinction
                        booth coverage is counting; it belongs on the row. */}
                    {a.status === 'confirmed' && !a.respondedAt && (
                      <Badge tone="warn">not answered by them</Badge>
                    )}
                    <span className="text-text-muted">{a.role}</span>
                    <span className="ml-auto text-xs text-text-muted">
                      {a.arrivesOn
                        ? `${showDateTime(a.arrivesOn, show.timezone)} → ${showDateTime(a.departsOn, show.timezone)}`
                        : 'Travel window not set'}
                    </span>
                  </div>

                  {entry.conflicts.map((c) => (
                    <p
                      key={`${c.a.attendeeId}-${c.b.attendeeId}`}
                      className={
                        c.severity === 'critical'
                          ? 'mt-1 text-xs text-bad'
                          : 'mt-1 text-xs text-warn'
                      }
                    >
                      <span className="font-medium">
                        {c.certainty === 'certain' ? 'Double-booked:':'Possibly double-booked:'}
                      </span>{' '}
                      {c.summary}
                    </p>
                  ))}

                  <AttendeeControls
                    showId={id}
                    timezone={show.timezone}
                    entry={entry}
                    mayStaff={may.staff}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {may.staff ? (
          <div className="mt-4 border-t border-border pt-4">
            <InviteForm showId={id} timezone={show.timezone} people={people} />
          </div>
        ) : (
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
            Whoever runs the show staffs it. Answering your own invitation and setting your own
            travel window is yours — coverage counts confirmations, and one somebody else typed for
            you is a number standing in for a conversation nobody had.
          </p>
        )}
      </Card>

      <Card title="Booth coverage">
        {shifts.length === 0 ? (
          <Empty>
            No shifts rostered. A shift is a slot with a staffing target; the gap between who is
            assigned to it and who can actually work it is what this card exists to show.
          </Empty>
        ) : (
          <>
            <p className="mb-3 text-sm">
              {coverage.short === 0 ? (
                <span className="text-good">
                  Every shift is covered by people who have confirmed and are in town.
                </span>
              ) : (
                <>
                  <span className="font-medium">
                    {coverage.short} of {coverage.shifts} shifts short
                  </span>
                  , {coverage.missingSlots} slot{coverage.missingSlots === 1 ? '' : 's'} to fill.
                  {coverage.overstated > 0 && (
                    <span className="text-bad">
                      {' '}
                      {coverage.overstated} of those {coverage.overstated === 1 ? 'is' : 'are'}{' '}
                      fully assigned and still short — the roster says covered and the people on it
                      cannot all be there.
                    </span>
                  )}
                </>
              )}
            </p>
            {coverage.rosteredVersusPresent && (
              <p className="mb-3 text-xs text-text-muted">
                On shifts that have already run: {coverage.rosteredVersusPresent.rostered} rostered,{' '}
                {coverage.rosteredVersusPresent.present} actually checked in. Rostered is not
                present, and the gap is the staffing insight.
              </p>
            )}

            <ul className="space-y-3">
              {shifts.map((entry) => (
                <li
                  key={entry.shiftId}
                  className="border-b border-border pb-3 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">
                      {showDateTime(entry.startsAt, show.timezone)} →{' '}
                      {showDateTime(entry.endsAt, show.timezone)}
                    </span>
                    <Badge
                      tone={entry.overstated ? 'bad' : entry.shortBy > 0 ? 'warn' : 'good'}
                    >
                      {entry.effectiveCount} of {entry.targetStaff}
                    </Badge>
                    {entry.assignedCount !== entry.effectiveCount && (
                      <span className="text-xs text-text-muted">
                        {entry.assignedCount} assigned
                      </span>
                    )}
                    {entry.notes && <span className="text-xs text-text-muted">{entry.notes}</span>}
                  </div>

                  <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {entry.standings.map((st) => (
                      <li
                        key={st.userId}
                        className={
                          st.counts ? 'text-text-muted' : 'text-warn'
                        }
                      >
                        {st.fullName}
                        {!st.counts && (
                          <>
                            {' '}
                            — {st.note}
                            {st.at && <> ({showDateTime(st.at, show.timezone)})</>}
                          </>
                        )}
                        {entry.presence && (
                          <>
                            {' '}
                            {entry.presence.noShows.some((n) => n.userId === st.userId) ? (
                              <Badge tone="bad">no-show</Badge>
                            ) : st.counts ? (
                              <Badge tone="good">present</Badge>
                            ) : null}
                          </>
                        )}{' '}
                        {may.staff && (
                          <UnassignButton showId={id} shiftId={entry.shiftId} userId={st.userId} />
                        )}
                      </li>
                    ))}
                    {entry.standings.length === 0 && (
                      <li className="text-warn">Nobody assigned.</li>
                    )}
                  </ul>

                  <ShiftControls
                    showId={id}
                    entry={entry}
                    mayStaff={may.staff}
                    actorId={board.actorId}
                  />
                  {may.staff && (
                    <EditShiftForm showId={id} timezone={show.timezone} entry={entry} />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {clashes.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs font-medium text-warn">
              One person, two places, same hour
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-warn">
              {clashes.map((c) => (
                <li key={`${c.a.id}-${c.b.id}-${c.userId}`}>{c.summary}</li>
              ))}
            </ul>
          </div>
        )}

        {may.staff && (
          <div className="mt-4 border-t border-border pt-4">
            <AddShiftForm showId={id} timezone={show.timezone} />
          </div>
        )}
      </Card>

      <Card title="Side events">
        {sideEvents.length === 0 ? (
          <Empty>
            No dinners, demos, or seminars recorded. Often where the pipeline actually gets made.
          </Empty>
        ) : (
          <ul className="space-y-4">
            {sideEvents.map((entry) => {
              const e = entry.event;
              return (
                <li
                  key={e.id}
                  className="border-b border-border pb-4 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{e.name}</span>
                    <Badge>{e.kind}</Badge>
                    <span className="text-text-muted">
                      {showDateTime(e.startsAt, show.timezone)}
                    </span>
                    {e.location && <span className="text-xs text-text-muted">{e.location}</span>}
                    {e.budgetCents != null && (
                      <span className="text-xs text-text-muted">{money(e.budgetCents)} budget</span>
                    )}
                    <span className="ml-auto text-xs text-text-muted">
                      {entry.host ? `Host: ${entry.host.fullName}` : 'No host'}
                      {' · '}
                      {entry.accepted} accepted
                      {entry.seatsLeft !== null && `, ${entry.seatsLeft} seat${entry.seatsLeft === 1 ? '' : 's'} left`}
                    </span>
                  </div>

                  {entry.rsvps.length > 0 && (
                    <ul className="mt-1 space-y-1 text-xs">
                      {entry.rsvps.map(({ rsvp, user }) => (
                        <li key={rsvp.id} className="flex flex-wrap items-center gap-2">
                          <span>
                            {user ? user.fullName : rsvp.guestName}
                            {!user && rsvp.guestCompany && (
                              <span className="text-text-muted"> · {rsvp.guestCompany}</span>
                            )}
                          </span>
                          <Badge tone={RSVP_TONE[rsvp.status] ?? 'neutral'}>{rsvp.status}</Badge>
                          <RsvpControl
                            showId={id}
                            rsvpId={rsvp.id}
                            status={rsvp.status}
                            mayAnswer={entry.mayManage || user?.id === board.actorId}
                            mayRemove={entry.mayManage}
                          />
                        </li>
                      ))}
                    </ul>
                  )}

                  <SideEventControls
                    showId={id}
                    timezone={show.timezone}
                    entry={entry}
                    people={people}
                    costCenters={costCenters}
                    actorId={board.actorId}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {may.staff && (
          <div className="mt-4 border-t border-border pt-4">
            <AddSideEventForm
              showId={id}
              timezone={show.timezone}
              people={people}
              costCenters={costCenters}
            />
          </div>
        )}
      </Card>

      <p className="text-xs text-text-muted">
        Hotels, room assignments and the room block cutoff are on the{' '}
        <Link href={`/shows/${id}/lodging`} className="underline">
          Lodging tab
        </Link>
        .
      </p>
    </div>
  );
}

const ATTENDEE_TONE: Record<string, Tone> = {
  confirmed: 'good',
  invited: 'info',
  declined: 'bad',
  waitlist: 'neutral',
};

const RSVP_TONE: Record<string, Tone> = {
  accepted: 'good',
  invited: 'info',
  tentative: 'warn',
  declined: 'neutral',
};
