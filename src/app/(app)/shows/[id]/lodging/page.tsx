import Link from 'next/link';
import { getLodgingBoard } from '@/lib/lodging/store';
import { getActor } from '@/lib/auth/actor';
import { Badge, Card, Empty, money, showDate, showDateTime } from '../../../_components/ui';
import { loadShow } from '../detail';
import {
  AddLodgingForm,
  CutoffOwnerForm,
  DropGuestButton,
  EditLodgingForm,
  RoomGuests,
} from './forms';

/**
 * Lodging — hotels, room assignments, and the room block cutoff.
 *
 * The cutoff is the reason this tab exists at all, and the design decision worth
 * reading is that it does **not** get its own warning banner. §4 made
 * `room_block_cutoff` first-class because missing it is among the most expensive
 * routine mistakes in this business; §5a then built an engine whose entire job is
 * escalating exactly that kind of date. A second warning here would be a weaker
 * copy of the first, on a different schedule, and the two would disagree — so the
 * cutoff derives a row in the show's deadline register instead, and what this
 * page shows is what the engine already thinks about it.
 */
export default async function LodgingTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ detail }, actor] = await Promise.all([loadShow(id), getActor()]);
  const board = await getLodgingBoard(actor, id);
  const { show } = detail;
  const { entries, people, costCenters, cutoffExposure, may } = board;

  return (
    <div className="space-y-6">
      <Card title="Hotels">
        {entries.length === 0 ? (
          <Empty>
            No lodging recorded. Hotels are entered by hand — booking them is out of scope for v1
            (§5); tracking them is not.
          </Empty>
        ) : (
          <ul className="space-y-4">
            {entries.map((entry) => {
              const l = entry.lodging;
              const d = entry.deadline;
              const missed = d ? d.status === 'open' && d.dueAt < new Date() : false;
              return (
                <li
                  key={l.id}
                  className="border-b border-border pb-4 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{l.hotelName}</span>
                    {l.confirmationCode && (
                      <span className="font-mono text-xs">{l.confirmationCode}</span>
                    )}
                    <span className="text-text-muted">
                      {showDate(l.checkIn, show.timezone)} → {showDate(l.checkOut, show.timezone)}
                      {entry.nights !== null && ` · ${entry.nights} nights`}
                    </span>
                    {l.nightlyRateCents != null && (
                      <span className="text-xs text-text-muted">
                        {money(l.nightlyRateCents)}/night
                        {entry.estimatedCents !== null && ` · ${money(entry.estimatedCents)} per room`}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-text-muted">
                      {entry.costCenter
                        ? `${entry.costCenter.code} · ${entry.costCenter.name}`
                        : 'No cost center'}
                    </span>
                  </div>

                  {l.address && <p className="mt-0.5 text-xs text-text-muted">{l.address}</p>}
                  {l.notes && <p className="mt-0.5 text-xs text-text-muted">{l.notes}</p>}

                  {/* The cutoff, and what the register already says about it. */}
                  <div className="mt-2 rounded-md bg-muted p-2 text-xs">
                    {l.roomBlockCutoff ? (
                      <>
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="font-medium">Room block closes</span>
                          <span>{showDateTime(l.roomBlockCutoff, show.timezone)}</span>
                          {missed && <Badge tone="bad">missed</Badge>}
                          {d && !d.confirmedAt && !missed && <Badge tone="warn">unconfirmed</Badge>}
                          {d && !d.ownerId && <Badge tone="warn">unowned</Badge>}
                        </div>
                        <p className="mt-1 text-text-muted">
                          {d ? (
                            <>
                              This date has a row{' '}
                              <Link href={`/shows/${id}/readiness`} className="underline">
                                in the deadline register
                              </Link>
                              {missed
                                ? ', and it has passed — the register carries that in the past tense, to whoever runs the show, once. There is nothing left to hurry about; what is left is finding out what the rooms now cost.'
                                : ', so the escalation engine chases it — at 45 days if nobody has confirmed it, then 30, 14, 3 and day-of.'}{' '}
                              It is edited here and only here; moving it withdraws any confirmation,
                              because a confirmation is an assertion about one specific date.
                            </>
                          ) : (
                            'No register row — reload after saving.'
                          )}
                        </p>
                        {d && may.manage && (
                          <CutoffOwnerForm
                            showId={id}
                            deadlineId={d.id}
                            ownerId={d.ownerId}
                            penaltyEstimateCents={d.penaltyEstimateCents}
                            people={people}
                          />
                        )}
                      </>
                    ) : (
                      <span className="text-text-muted">
                        No room block cutoff recorded, so nothing is chasing one. If this hotel has
                        a block, the date is the single most valuable field on this page.
                      </span>
                    )}
                  </div>

                  <div className="mt-2">
                    <p className="text-xs text-text-muted">
                      In this block:{' '}
                      {entry.guests.length === 0
                        ? 'nobody yet'
                        : entry.guests.map((g) => g.fullName).join(', ')}
                      {entry.guestsNarrowed && ' (and colleagues you cannot see)'}
                    </p>
                    {may.manage && (
                      <>
                        {entry.guests.length > 0 && (
                          <ul className="mt-1 flex flex-wrap gap-x-3 text-xs">
                            {entry.guests.map((g) => (
                              <li key={g.id}>
                                {g.fullName}{' '}
                                <DropGuestButton
                                  showId={id}
                                  lodgingId={l.id}
                                  userId={g.userId}
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                        <RoomGuests showId={id} entry={entry} />
                      </>
                    )}
                  </div>

                  {may.manage && (
                    <EditLodgingForm
                      showId={id}
                      timezone={show.timezone}
                      costCenters={costCenters}
                      entry={entry}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {may.manage ? (
          <div className="mt-4 border-t border-border pt-4">
            <AddLodgingForm showId={id} timezone={show.timezone} costCenters={costCenters} />
          </div>
        ) : (
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
            Whoever runs the show books and records the hotels. You see the one you are in.
          </p>
        )}
      </Card>

      {(cutoffExposure.open > 0 || cutoffExposure.missed > 0) && (
        <Card title="Room block cutoffs, as the engine counts them">
          <p className="text-sm">
            {cutoffExposure.open} still ahead of us
            {cutoffExposure.unconfirmed > 0 &&
              `, ${cutoffExposure.unconfirmed} of them never checked against the contract`}
            {cutoffExposure.unowned > 0 && `, ${cutoffExposure.unowned} with nobody chasing`}
            {cutoffExposure.missed > 0 && `; ${cutoffExposure.missed} already gone`}.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Counted by the same model as every other deadline on this show — see the{' '}
            <Link href={`/shows/${id}/readiness`} className="underline">
              register
            </Link>
            . Blowing a room block does not bill a surcharge; it drops the whole party to walk-up
            rates in a city that is sold out that week, which is why these rows carry no penalty
            estimate until somebody prices the alternative.
          </p>
        </Card>
      )}
    </div>
  );
}
