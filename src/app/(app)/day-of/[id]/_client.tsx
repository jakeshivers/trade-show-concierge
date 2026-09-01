'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Card, Empty, type Tone } from '../../_components/ui';
import { Input, Select, Textarea } from '../../_components/form-ui';
import { cn } from '../../_components/cn';
import { useOnline } from '../../_components/pref';
import {
  degradeVerdicts,
  freshnessOf,
  shiftStanding,
  type DaySnapshot,
  type SnapshotShift,
} from '@/lib/dayof/snapshot';
import {
  describeOutbox,
  mintRef,
  reconcile,
  sendable,
  type QueuedItem,
  type SyncOutcome,
} from '@/lib/dayof/outbox';
import { matchTarget, summarizeTargets, targetStandings, type TargetAccount } from '@/lib/dayof/targets';
import {
  enqueue,
  purgeDevice,
  randomRef,
  readOutbox,
  readSnapshot,
  removeQueued,
  replaceOutbox,
  requestPersistence,
  storageAvailable,
  writeSnapshot,
} from '../_device';

/**
 * The day-of screen, and the only screen in this product that is not a Server
 * Component.
 *
 * That is the architecture decision §2 has been carrying since the first table
 * in this document, made concrete. Every other page here queries on the server
 * and sends HTML, which is the right shape for all of them and useless for this
 * one: the rendering is on the far side of the connection that has gone. So this
 * page holds its own data, and the server page above it passes **nothing but an
 * id** — deliberately. A server-rendered day-of page would put a second copy of
 * the show's facts into the cached HTML document, with no instant attached to
 * it, and the screen would then have two sources that disagree and one of them
 * would be invisible. There is exactly one copy of the data on this device, in
 * IndexedDB, and it carries the moment it was true.
 *
 * The order of what happens on mount is the product:
 *
 * 1. Read the cached snapshot and **render it immediately**, with its age at the
 *    top. Not a spinner. A spinner on a floor with no signal is a blank screen
 *    that never resolves, and the person needs the booth number now.
 * 2. Fetch a fresh one. On success, replace and re-stamp. On failure, keep what
 *    is on screen and say the refresh failed — never blank it, and never let it
 *    keep claiming to be current.
 * 3. Drain the outbox, if there is a network and anything in it.
 *
 * And the rule underneath all three: **a queued capture is not a recorded lead.**
 * The counts are kept apart everywhere they appear, because §8c's whole
 * mitigation is that a thin number is visibly thin, and a count that quietly
 * includes rows sitting on a phone is that failure with a new cause.
 */

type Props = { showId: string; actorId: string; actorName: string };

type Draft = {
  fullName: string;
  company: string;
  email: string;
  title: string;
  notes: string;
  basis: string;
};

const EMPTY: Draft = { fullName: '', company: '', email: '', title: '', notes: '', basis: 'unknown' };

export function DayOf({ showId, actorId, actorName }: Props) {
  const online = useOnline();
  const [snapshot, setSnapshot] = useState<DaySnapshot | null>(null);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loaded, setLoaded] = useState(false);
  const [storing, setStoring] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncing = useRef(false);

  /* The clock the whole screen reads. A day-of screen left open on a counter
   * must not sit there claiming a two-hour-old snapshot is current, so the age
   * is recomputed on a timer rather than at render time only. */
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/day-of/snapshot?show=${encodeURIComponent(showId)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(String(response.status));
      const fresh = (await response.json()) as DaySnapshot;
      // The device changed hands, or somebody signed in as somebody else. Every
      // cached copy goes before anything is rendered — the screen does not
      // filter, it forgets.
      if (fresh.actorId !== actorId) {
        await purgeDevice();
      }
      await writeSnapshot(fresh);
      setSnapshot(fresh);
      setRefreshFailed(false);
      return fresh;
    } catch {
      setRefreshFailed(true);
      return null;
    }
  }, [showId, actorId]);

  const drain = useCallback(async () => {
    if (syncing.current) return;
    const pending = sendable(await readOutbox());
    if (pending.length === 0) return;
    syncing.current = true;
    try {
      const response = await fetch('/api/day-of/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showId, items: pending }),
      });
      if (!response.ok) return;
      const { outcomes } = (await response.json()) as { outcomes: SyncOutcome[] };
      const result = reconcile(pending, outcomes);
      // Only the items that were sent are replaced; anything queued while the
      // request was in flight is still in IndexedDB and is merged back by the
      // read below rather than clobbered by a blind write.
      const sentRefs = new Set(pending.map((i) => i.clientRef));
      const untouched = (await readOutbox()).filter((i) => !sentRefs.has(i.clientRef));
      await replaceOutbox([...untouched, ...result.remaining]);
      setQueue(await readOutbox());
      const said: string[] = [];
      if (result.accepted.length) said.push(`${result.accepted.length} recorded`);
      if (result.already.length) said.push(`${result.already.length} already recorded`);
      if (result.duplicates.length) said.push(`${result.duplicates.length} already captured by somebody else`);
      if (result.rejected.length) said.push(`${result.rejected.length} refused`);
      setSyncNote(said.join(' · ') || null);
      await refresh();
    } catch {
      /* The queue is untouched, which is the whole point of the queue. */
    } finally {
      syncing.current = false;
    }
  }, [showId, refresh]);

  useEffect(() => {
    let live = true;
    (async () => {
      const ok = await storageAvailable();
      if (!live) return;
      setStoring(ok);
      if (ok) void requestPersistence();
      const cached = await readSnapshot(showId);
      if (!live) return;
      // A cached snapshot belonging to somebody else is never rendered, not even
      // for the instant before the fetch returns.
      if (cached && cached.actorId === actorId) setSnapshot(cached);
      else if (cached) await purgeDevice();
      setQueue(await readOutbox());
      setLoaded(true);
      await refresh();
      await drain();
    })();
    return () => {
      live = false;
    };
  }, [showId, actorId, refresh, drain]);

  /* Coming back online is the moment the queue matters. Scheduled rather than
   * called straight out of the effect: draining sets state when it finishes, and
   * kicking off async work is what an effect is for — synchronously setting
   * state from one is not. */
  useEffect(() => {
    if (!online) return;
    const id = setTimeout(() => void drain(), 0);
    return () => clearTimeout(id);
  }, [online, drain]);

  const enqueueItem = useCallback(
    async (kind: 'lead' | 'meeting', body: Record<string, unknown>) => {
      const item: QueuedItem = {
        clientRef: mintRef(randomRef),
        showId,
        kind,
        body,
        queuedAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
        blocked: false,
      };
      const stored = await enqueue(item);
      setQueue((q) => [...q, item]);
      if (!stored) setSyncNote('This device is not storing anything — do not close this tab.');
      if (navigator.onLine) void drain();
    },
    [showId, drain],
  );

  const view = useMemo(
    () => (snapshot ? degradeVerdicts(snapshot, now) : null),
    [snapshot, now],
  );

  if (!loaded) return <p className="text-sm text-text-muted">Opening this device&rsquo;s copy…</p>;

  if (!view) {
    return (
      <Card title="Nothing on this device yet">
        <Empty>
          This screen works with no signal, but only once it has been opened with one. Open it on
          wifi before the doors open and it will keep working after they close.
          {refreshFailed && ' The refresh just now did not reach the server.'}
        </Empty>
      </Card>
    );
  }

  const fresh = freshnessOf(view.capturedAt, now);
  const outbox = describeOutbox(queue, online);
  const standing = shiftStanding(view.shifts, now);
  const targets: TargetAccount[] = view.targets;
  const queuedLeads = queue.filter((q) => q.kind === 'lead');
  const standings = targetStandings(
    targets,
    view.leads.map((l) => ({
      id: l.id,
      fullName: l.fullName,
      company: l.company,
      capturedAt: new Date(l.capturedAt),
      duplicateOfId: l.duplicateOfId,
    })),
  );
  const summary = summarizeTargets(standings);

  return (
    <div className="space-y-4">
      <StatusLine
        fresh={fresh}
        online={online}
        outbox={outbox}
        storing={storing}
        refreshFailed={refreshFailed}
        syncNote={syncNote}
      />

      <Card
        title={view.show.name}
        subtitle={[view.show.venueName, view.show.city].filter(Boolean).join(' · ') || undefined}
      >
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="text-xs uppercase tracking-wider text-text-muted">Booth</div>
            <div className="text-3xl font-semibold tabular">{view.show.boothNumber ?? '—'}</div>
          </div>
          <ShiftLine standing={standing} zone={view.show.timezone} />
        </div>
      </Card>

      <CaptureCard
        targets={targets}
        consentNotice={view.consentNotice}
        onCapture={(draft) =>
          enqueueItem('lead', {
            fullName: draft.fullName,
            company: draft.company || null,
            email: draft.email || null,
            title: draft.title || null,
            notes: draft.notes || null,
            basis: draft.basis,
            consentNotice: draft.basis === 'consent' ? view.consentNotice : null,
          })
        }
        onMeeting={(subject, company, noShow) =>
          enqueueItem('meeting', { subject, company: company || null, noShow })
        }
        capturedBy={actorName}
      />

      <QueueCard
        queue={queue}
        onDrop={async (ref) => {
          await removeQueued(ref);
          setQueue(await readOutbox());
        }}
      />

      <TargetCard standings={standings} summary={summary} queued={queuedLeads} />

      <CrateCard crates={view.crates} fresh={fresh.standing} />

      <LeadCard leads={view.leads} queued={queuedLeads.length} />
    </div>
  );
}

/* --------------------------------- the top line ----------------------------- */

function StatusLine({
  fresh,
  online,
  outbox,
  storing,
  refreshFailed,
  syncNote,
}: {
  fresh: ReturnType<typeof freshnessOf>;
  online: boolean;
  outbox: ReturnType<typeof describeOutbox>;
  storing: boolean;
  refreshFailed: boolean;
  syncNote: string | null;
}) {
  const tone: Tone =
    fresh.standing === 'old' ? 'bad' : fresh.standing === 'stale' ? 'warn' : online ? 'good' : 'info';
  return (
    <div
      className={cn(
        'rounded-lg border border-border px-4 py-3 text-sm',
        tone === 'bad' && 'bg-bad-soft',
        tone === 'warn' && 'bg-warn-soft',
        tone === 'info' && 'bg-info-soft',
        tone === 'good' && 'bg-panel',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={online ? 'good' : 'info'}>{online ? 'Online' : 'No connection'}</Badge>
        <span className="text-text-muted">{fresh.sentence}</span>
      </div>
      <p className={cn('mt-1', outbox.tone === 'warn' ? 'text-bad' : 'text-text-muted')}>
        {outbox.sentence}
      </p>
      {!storing && (
        <p className="mt-1 text-bad">
          This browser is not storing anything on this device — a capture lives only in this tab.
          Do not close it.
        </p>
      )}
      {refreshFailed && online && (
        <p className="mt-1 text-warn">
          The last refresh did not reach the server, so everything above is as old as it says it is.
        </p>
      )}
      {syncNote && <p className="mt-1 text-text-muted">{syncNote}</p>}
    </div>
  );
}

function ShiftLine({
  standing,
  zone,
}: {
  standing: ReturnType<typeof shiftStanding>;
  zone: string;
}) {
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
    });

  if (standing.kind === 'not_rostered') {
    return (
      <div className="text-sm text-text-muted">
        You are not on a booth shift here. That is not the same as having nothing to do — anybody
        can capture a lead.
      </div>
    );
  }
  if (standing.kind === 'none_today') {
    return <div className="text-sm text-text-muted">No more shifts for you on this show.</div>;
  }
  const s: SnapshotShift = standing.shift;
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-text-muted">
        {standing.kind === 'on_now' ? 'On the booth now' : 'Your next shift'}
      </div>
      <div className="text-xl font-semibold">
        {time(s.startsAt)} – {time(s.endsAt)}
      </div>
      <div className="mt-0.5 text-xs text-text-muted">
        {standing.kind === 'on_now'
          ? `${Math.max(0, standing.endsInMinutes)} min left`
          : `starts in ${Math.max(0, Math.round(standing.startsInMinutes / 60))}h`}
        {s.staff.length > 0 && ` · with ${s.staff.join(', ')}`}
        {/* `effectiveCount` rather than the roster count, always: a shift that
            reads full and is not is the one thing nobody looks at again. */}
        {s.effectiveCount < s.targetStaff && (
          <span className="text-warn">
            {' '}
            · {s.effectiveCount} of {s.targetStaff} covered
          </span>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- capture ---------------------------------- */

/**
 * The ten-second form. §8c mitigation 2, and everything about it is that number.
 *
 * One required field. The company field is second because it is what fires the
 * target alert, and the alert has to arrive while the conversation is happening —
 * which is why `matchTarget` runs here, on every keystroke, against the cached
 * list, and not in a server action that would need a network the hall does not
 * have.
 *
 * The consent control is the one thing that is not optimised for speed, and
 * deliberately: a default of "consented" would manufacture a lawful basis from
 * somebody tabbing past a control at hour six of day two, which is `consent.ts`'s
 * first rule and the one place where four saved seconds is a regulatory finding.
 */
function CaptureCard({
  targets,
  consentNotice,
  onCapture,
  onMeeting,
  capturedBy,
}: {
  targets: TargetAccount[];
  consentNotice: string | null;
  onCapture: (draft: Draft) => Promise<void>;
  onMeeting: (subject: string, company: string, noShow: boolean) => Promise<void>;
  capturedBy: string;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const hit = matchTarget(draft.company, targets);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.fullName.trim()) {
      setError('A lead needs a name. Without a person there is no lead.');
      return;
    }
    setError(null);
    await onCapture(draft);
    setFlash(`${draft.fullName.trim()} captured on this device.`);
    setDraft(EMPTY);
    setMore(false);
    nameRef.current?.focus();
  }

  return (
    <Card title="Capture" subtitle={`Recorded as ${capturedBy}. Works with no signal.`}>
      <form onSubmit={submit} className="space-y-3">
        <Input
          ref={nameRef}
          density="comfortable"
          autoFocus
          placeholder="Name"
          value={draft.fullName}
          onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
          aria-label="Name"
        />
        <Input
          density="comfortable"
          placeholder="Company"
          value={draft.company}
          onChange={(e) => setDraft({ ...draft, company: e.target.value })}
          aria-label="Company"
        />

        {hit && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-sm',
              hit.priority === 'must_meet' ? 'bg-bad-soft text-bad' : 'bg-info-soft text-info',
            )}
          >
            <strong>
              {hit.priority === 'must_meet' ? 'Must-meet account' : 'Target account'} —{' '}
              {hit.companyName}
            </strong>
            {hit.reason && <span className="block text-text-muted">{hit.reason}</span>}
            <span className="block text-text-muted">
              {hit.ownerName ? `${hit.ownerName} owns this relationship.` : 'Nobody owns this one.'}
            </span>
          </div>
        )}

        {more && (
          <>
            <Input
              density="comfortable"
              placeholder="Email"
              inputMode="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              aria-label="Email"
            />
            <Input
              density="comfortable"
              placeholder="Title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              aria-label="Title"
            />
            <Textarea
              density="comfortable"
              rows={2}
              placeholder="What they wanted"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              aria-label="Notes"
            />
          </>
        )}

        <Select
          density="comfortable"
          value={draft.basis}
          onChange={(e) => setDraft({ ...draft, basis: e.target.value })}
          aria-label="Lawful basis"
        >
          <option value="unknown">No basis recorded</option>
          <option value="legitimate_interest">They gave me a card / badge</option>
          <option value="consent" disabled={!consentNotice}>
            {consentNotice ? 'They agreed to follow-up (notice read)' : 'Consent — no notice on file'}
          </option>
        </Select>

        {error && <p className="text-sm text-bad">{error}</p>}
        {flash && <p className="text-sm text-good">{flash}</p>}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="rounded-lg bg-brand px-5 py-3 text-base font-semibold text-brand-fg shadow-sm hover:bg-brand-hover"
          >
            Capture
          </button>
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            className="rounded-lg border border-border-strong px-4 py-3 text-sm text-text hover:bg-muted"
          >
            {more ? 'Fewer fields' : 'More fields'}
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!draft.fullName.trim()) {
                setError('A meeting needs a subject — who, or what it was about.');
                return;
              }
              await onMeeting(draft.fullName.trim(), draft.company.trim(), false);
              setFlash(`Meeting with ${draft.fullName.trim()} recorded on this device.`);
              setDraft(EMPTY);
            }}
            className="rounded-lg border border-border-strong px-4 py-3 text-sm text-text hover:bg-muted"
          >
            Record as a meeting
          </button>
        </div>
      </form>
    </Card>
  );
}

/* ---------------------------------- queue ----------------------------------- */

function QueueCard({
  queue,
  onDrop,
}: {
  queue: QueuedItem[];
  onDrop: (clientRef: string) => Promise<void>;
}) {
  if (queue.length === 0) return null;
  return (
    <Card
      title="On this device"
      subtitle="Not recorded yet, and not counted anywhere else in the app until they are."
    >
      <ul className="divide-y divide-border text-sm">
        {queue.map((item) => (
          <li key={item.clientRef} className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <span className="font-medium">
                {String(item.body.fullName ?? item.body.subject ?? 'Untitled')}
              </span>
              {item.body.company ? (
                <span className="text-text-muted"> · {String(item.body.company)}</span>
              ) : null}
              {item.blocked && (
                <p className="text-bad">
                  Refused: {item.lastError} — this one will not be recorded until it is fixed.
                </p>
              )}
            </div>
            {item.blocked && (
              <button
                type="button"
                onClick={() => onDrop(item.clientRef)}
                className="shrink-0 text-xs text-text-muted underline hover:text-text"
              >
                Discard
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* --------------------------------- targets ---------------------------------- */

function TargetCard({
  standings,
  summary,
  queued,
}: {
  standings: ReturnType<typeof targetStandings>;
  summary: ReturnType<typeof summarizeTargets>;
  queued: QueuedItem[];
}) {
  if (summary.total === 0) return null;
  return (
    <Card title="Who we came for" subtitle={summary.sentence}>
      <ul className="divide-y divide-border text-sm">
        {standings.map((s) => {
          // A target met by something still sitting on this phone is *not* met
          // as far as the show is concerned, and saying so is the difference
          // between a queue and a lie. It is named separately rather than
          // counted, exactly as the lead count is.
          const onDevice = queued.some(
            (q) =>
              typeof q.body.company === 'string' &&
              matchTarget(q.body.company, [s.target])?.id === s.target.id,
          );
          return (
            <li key={s.target.id} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{s.target.companyName}</span>
                {s.target.priority === 'must_meet' && !s.met && (
                  <Badge tone="bad" className="ml-2">
                    must meet
                  </Badge>
                )}
                {s.target.reason && !s.met && (
                  <p className="text-text-muted">{s.target.reason}</p>
                )}
                {s.met && (
                  <p className="text-text-muted">
                    {s.leads[0].fullName}
                    {s.leads.length > 1 && ` and ${s.leads.length - 1} more`}
                  </p>
                )}
                {!s.met && onDevice && (
                  <p className="text-info">Captured on this device, not recorded yet.</p>
                )}
                {s.unowned && <p className="text-warn">Nobody owns this account.</p>}
              </div>
              <Badge tone={s.met ? 'good' : 'neutral'}>{s.met ? 'met' : 'not yet'}</Badge>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---------------------------------- crates ---------------------------------- */

function CrateCard({
  crates,
  fresh,
}: {
  crates: DaySnapshot['crates'];
  fresh: ReturnType<typeof freshnessOf>['standing'];
}) {
  if (crates.length === 0) return null;
  const TONE: Record<string, Tone> = { ok: 'good', warn: 'warn', bad: 'bad', unknown: 'neutral' };
  return (
    <Card
      title="Freight"
      subtitle={
        fresh === 'stale' || fresh === 'old'
          ? 'Standings are withheld: nothing has re-checked the carrier since this snapshot was taken.'
          : undefined
      }
    >
      <ul className="divide-y divide-border text-sm">
        {crates.map((c) => (
          <li key={c.id} className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <span className="font-medium">{c.description}</span>
              <p className="text-text-muted">
                {c.standing ?? 'standing unknown from this device'}
                {c.trackingNumber && ` · ${c.trackingNumber}`}
              </p>
            </div>
            {/* The show's direction, not ours. `outbound` in the schema means
                out of our warehouse, which from a booth is freight *arriving* —
                and "outbound" on a screen read while standing in that booth is
                the exact opposite of what it means to the person reading it. */}
            <Badge tone={TONE[c.standingTone] ?? 'neutral'}>
              {c.receivedAt ? 'received' : c.direction === 'return' ? 'going home' : 'to the booth'}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------------------------------- leads ----------------------------------- */

function LeadCard({ leads, queued }: { leads: DaySnapshot['leads']; queued: number }) {
  const counted = leads.filter((l) => !l.duplicateOfId);
  return (
    <Card
      title="Captured here"
      subtitle={
        queued > 0
          ? `${counted.length} recorded, plus ${queued} on this device that are not.`
          : `${counted.length} recorded.`
      }
    >
      {counted.length === 0 ? (
        <Empty>Nothing recorded on this show yet.</Empty>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {counted.slice(0, 12).map((l) => (
            <li key={l.id} className="py-1.5">
              <span className="font-medium">{l.fullName}</span>
              {l.company && <span className="text-text-muted"> · {l.company}</span>}
              {l.capturedByName && (
                <span className="text-text-muted"> · {l.capturedByName.split(/\s+/)[0]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
