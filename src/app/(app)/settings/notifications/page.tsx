import { getActor } from '@/lib/auth/actor';
import { getDeliveryLog, getMyChannel, getTransportStanding } from '@/lib/notify/store';
import { canReadOrgDeliveries } from '@/lib/notify/access';
import { describeRunStanding, getRunStanding, RUN_OVERDUE_HOURS } from '@/lib/schedule/nightly';
import { Badge, Card, Empty, PageHeader, Stat, Table, Td, Th } from '../../_components/ui';
import { ConnectForm, DisconnectForm, RunNowForm } from './forms';

/**
 * Notifications — where alerts go when they leave this app, and what runs them.
 *
 * The page leads with the sentence most workspaces will see, which is that
 * **nothing has ever left this workspace.** That is not an error state and the
 * page does not dress it as one: for twenty steps seven engines have written
 * alerts and `/alerts` has been where they are read. What would be a failure is
 * the same state looking like a working one, which is why the console transport
 * records `rendered` rather than `sent` and why the figure here counts real
 * deliveries rather than log rows.
 *
 * Connecting is the actor's own act, always — see `notify/access.ts`. An admin
 * cannot point a colleague's alerts anywhere, because every engine addresses its
 * rows to a person specifically so that a Member's personal flight home is not
 * on somebody else's screen.
 */
export default async function NotificationsPage() {
  const actor = await getActor();
  const [standing, channel, runStanding, mine] = await Promise.all([
    getTransportStanding(actor),
    getMyChannel(actor).catch(() => null),
    getRunStanding(actor.orgId),
    getDeliveryLog(actor, { scope: 'mine', limit: 20 }),
  ]);
  const org = canReadOrgDeliveries(actor)
    ? await getDeliveryLog(actor, { scope: 'org', limit: 40 })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        blurb="Every engine writes an alert. This is what carries one out of the app, and what runs the engines."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Transport" value={standing.name} />
        <Stat label="Connected" value={`${standing.connected} of ${standing.people}`} />
        <Stat label="Delivered, ever" value={String(standing.everSent)} />
      </div>

      {standing.misconfigured && (
        <Card title="The transport is misconfigured">
          <p className="text-sm text-bad">{standing.misconfigured}</p>
        </Card>
      )}

      {!standing.live && !standing.misconfigured && (
        <Card title="Nothing has left this workspace">
          <p className="text-sm text-text-muted">
            No transport is configured, so messages are composed from the real alerts and delivered
            to nobody. That is a working state and has been this product’s state throughout: every
            alert is still recorded, still counted, and still on{' '}
            <span className="font-medium">/alerts</span>. What it is not is a delivery — the log
            below says <span className="font-mono text-xs">rendered</span> rather than{' '}
            <span className="font-mono text-xs">sent</span>, because a workspace that had told
            nobody anything must never be able to read as one that had.
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Set <span className="font-mono text-xs">SLACK_BOT_TOKEN</span> with the{' '}
            <span className="font-mono text-xs">users:read.email</span>,{' '}
            <span className="font-mono text-xs">chat:write</span> and{' '}
            <span className="font-mono text-xs">im:write</span> scopes. The app reads no
            conversations and asks for no history scope: it is write-only.
          </p>
        </Card>
      )}

      <Card title="Where your alerts go">
        {channel && !channel.disabledAt ? (
          <>
            <p className="text-sm">
              Connected as{' '}
              <span className="font-medium">{channel.label ?? channel.address}</span>{' '}
              <Badge tone="good">verified</Badge>
              <span className="block text-xs text-text-muted">
                {channel.kind === 'dm' ? 'a direct message' : 'a shared channel'} on {channel.transport}
              </span>
            </p>
            <DisconnectForm />
          </>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              Your address is resolved from your email by the transport itself and never typed. A
              member id pasted into a box is a claim: a message sent to a wrong one is accepted,
              logged as sent, and never seen by anybody.
            </p>
            {channel?.disabledAt && (
              <p className="mt-2 text-sm text-warn">
                Turned off {channel.disabledAt.toISOString().slice(0, 10)} — {channel.disabledReason}
              </p>
            )}
            <ConnectForm email={actor.email} />
          </>
        )}
        <p className="mt-3 text-xs text-text-muted">
          This is yours to set, and nobody else’s — not an admin’s. Every alert here is addressed to
          one person, and an alert that could be pointed somewhere on your behalf is an alert
          somebody else can read.
        </p>
      </Card>

      <Card title="What runs the engines">
        <p className="text-sm">
          <Badge
            tone={
              runStanding.standing === 'current'
                ? 'good'
                : runStanding.standing === 'failing'
                  ? 'bad'
                  : 'warn'
            }
          >
            {runStanding.standing.replace('_', ' ')}
          </Badge>{' '}
          <span className="text-text-muted">{describeRunStanding(runStanding)}</span>
        </p>
        <p className="mt-2 text-sm text-text-muted">
          A scheduler calls <span className="font-mono text-xs">POST /api/cron/nightly</span> with{' '}
          <span className="font-mono text-xs">CRON_SECRET</span> as a bearer token. It sweeps every
          engine, erases every lead past its retention date, and carries what is owed — in that
          order, and it stops rather than delivering last night’s answers as though they were
          tonight’s. With no secret set the endpoint refuses: a job that erases personal data must
          not be open because nobody configured a variable.
        </p>
        <p className="mt-2 text-xs text-text-muted">
          Nothing is called overdue for {RUN_OVERDUE_HOURS} hours, which is deliberately longer than
          the {36}-hour window an individual alert goes <span className="font-mono">unchecked</span>{' '}
          in — the row admits doubt before the page declares the job broken.
        </p>
        <div className="mt-3">
          <RunNowForm />
        </div>
      </Card>

      <Card title="What you were told">
        {mine.length === 0 ? (
          <Empty>
            Nothing has been carried to you. Every alert addressed to you is on /alerts, which is
            where they have always been read.
          </Empty>
        ) : (
          <DeliveryTable rows={mine} showRecipient={false} />
        )}
      </Card>

      {org && (
        <Card title="Everything this workspace carried">
          <p className="text-sm text-text-muted">
            The org-wide log is an admin’s, because it names who was told what. It records the
            refusals as well as the sends: an alert below the interruption floor, one raised before
            a destination existed, and a person with something worth carrying and nowhere to carry
            it are three different reasons somebody heard nothing, and only the last is fixable.
          </p>
          <div className="mt-3">
            {org.length === 0 ? (
              <Empty>Nothing yet. Run the job, or wait for a scheduler to.</Empty>
            ) : (
              <DeliveryTable rows={org} showRecipient />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

const OUTCOME_TONE = {
  sent: 'good',
  rendered: 'warn',
  undeliverable: 'bad',
  suppressed: 'neutral',
  failed: 'bad',
} as const;

function DeliveryTable({
  rows,
  showRecipient,
}: {
  rows: Awaited<ReturnType<typeof getDeliveryLog>>;
  showRecipient: boolean;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          {showRecipient && <Th>To</Th>}
          <Th>Alert</Th>
          <Th>Outcome</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-border">
            <Td>{r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</Td>
            {showRecipient && <Td>{r.recipientName ?? 'the workspace'}</Td>}
            <Td>
              {r.phase === 'resolved' && <span className="text-text-muted">resolved · </span>}
              {r.alertTitle}
              {r.detail && <div className="text-xs text-text-muted">{r.detail}</div>}
            </Td>
            <Td>
              <Badge tone={OUTCOME_TONE[r.outcome] ?? 'neutral'}>{r.outcome}</Badge>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
