import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { canManageCrm, canSyncCrm } from '@/lib/roi/access';
import { selectCrmProviderOrNull } from '@/lib/roi/provider';
import { listSyncRuns } from '@/lib/roi/store';
import { DEFAULT_SETTINGS, MODEL_LABEL } from '@/lib/roi/attribution';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '../../_components/ui';
import { SyncForm } from './forms';

/**
 * The CRM connection. §8b, §11.6.
 *
 * Two things this page has to say plainly, because both are decisions somebody
 * will otherwise read as bugs.
 *
 * **The integration is deliberately narrow.** Read opportunities linked to leads
 * we captured; write one attribution field back; never sync contacts, own the
 * pipeline, or duplicate CRM objects. That is not a v1 limitation to be lifted
 * later — the way not to become a second CRM is to be structurally unable to,
 * which is why the provider interface has exactly one write method on it.
 *
 * **Salesforce is built and HubSpot is declared.** §11.6 said to build one well
 * rather than two adequately. The seam is written and its header lists what
 * finishing it takes, and asking for it gets that answer rather than a spelling
 * complaint.
 */

export const metadata = { title: 'CRM' };
export const dynamic = 'force-dynamic';

export default async function CrmSettingsPage() {
  const actor = await getActor();
  if (!canSyncCrm(actor)) {
    return (
      <div className="space-y-6">
        <PageHeader title="CRM" />
        <Empty>
          Connecting a CRM and running a sync sit with Travel Manager and Admin — a sync reads a
          customer’s pipeline and writes back into it, which is the one place this product touches
          a database it does not own.
        </Empty>
      </div>
    );
  }

  const choice = selectCrmProviderOrNull();
  const runs = await listSyncRuns(actor, 10);

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM"
        blurb={
          <>
            Leads and meetings we capture. Pipeline and revenue we cannot invent — they live in
            Salesforce. The integration reads opportunities linked to leads we captured and writes
            one attribution field back, and does nothing else on purpose.
          </>
        }
      />

      <Card title="Connection">
        {'unavailable' in choice ? (
          <>
            <p className="text-sm">
              <Badge tone="warn">not connected</Badge>
            </p>
            <p className="mt-2 text-sm text-text-muted">{choice.unavailable}</p>
            <p className="mt-2 text-xs text-text-muted">
              Until then every show has a cost and no return side, and{' '}
              <Link href="/roi" className="underline">
                ROI
              </Link>{' '}
              says exactly that rather than showing a pipeline of $0. Nothing stands in for a
              real CRM in the meantime — a screen quietly showing made-up opportunities would look
              identical to a connected one, and this is the number budgets get set from.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm">
              <Badge tone={choice.choice.replayed ? 'bad' : 'good'}>
                {choice.choice.source}
                {choice.choice.replayed && ' — replayed'}
              </Badge>
            </p>
            {choice.choice.replayed && (
              <p className="mt-2 text-sm text-text-muted">
                <code>CRM_PROVIDER=recorded</code> is set, so opportunities come from a recorded
                pattern rather than from a CRM. It describes how booth conversations convert in
                general and says nothing about this company — so on the ROI screens every ratio
                built on it is left blank rather than shown with a warning. It also writes nothing
                back, rather than reporting a write it never made.
              </p>
            )}
            <SyncForm canWrite={!choice.choice.replayed} />
          </>
        )}
      </Card>

      <Card title="Attribution">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium">
              {MODEL_LABEL[DEFAULT_SETTINGS.model]}, {DEFAULT_SETTINGS.windowDays}-day window
            </dt>
            <dd className="text-text-muted">
              <strong>Sourced</strong> means the show is where we first met the buyer. It is the
              conservative reading and the one a finance team will not argue with.
              <strong> Influenced</strong> means the show touched the deal at some point; it is
              the generous reading, and it is the fairer one for a show that moves deals along
              rather than starting them. Both are shown, and this setting picks which one leads.
            </dd>
          </div>
          <div>
            <dt className="font-medium">First touch is decided across the whole calendar</dt>
            <dd className="text-text-muted">
              Not within a show. The same buyer walks the same booth every year, and a model that
              only asked “did this show meet them before the deal opened” would hand every
              recurring customer’s opportunity to the most recent show, silently, forever. One
              opportunity is sourced to at most one show — otherwise the portfolio’s sourced
              pipeline exceeds the pipeline, which a finance reader spots in four seconds and
              never trusts again.
            </dd>
          </div>
          <div>
            <dt className="font-medium">A lead with no consent record is never sent</dt>
            <dd className="text-text-muted">
              Matching by email sends a stranger’s address to a third party, so it only happens
              where somebody recorded what that person was told at the booth. Matching on an id the
              CRM already gave us is not restricted, because it sends nothing about the person.
              Badge-scanner exports carry no consent column, so those leads are kept and counted
              here and never appear in a pipeline figure — which is this app holding them back
              rather than the CRM not knowing them. The two are counted separately.
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        title="Sync history"
        subtitle="Every run, including what it refused. Matched, not found and not sent always add up to the leads considered."
      >
        {runs.length === 0 ? (
          <p className="text-sm text-text-muted">
            Nothing has run yet, so no lead in this workspace has ever been offered to a CRM.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Provider</Th>
                <Th numeric>Considered</Th>
                <Th numeric>Matched</Th>
                <Th numeric>Not found</Th>
                <Th numeric>Not sent</Th>
                <Th numeric>Opps</Th>
                <Th numeric>Written</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <Td>
                    {run.startedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    {run.failedReason && (
                      <span className="block text-xs text-bad">failed: {run.failedReason}</span>
                    )}
                  </Td>
                  <Td>
                    {run.provider}
                    {run.replayed && <span className="text-text-muted"> (replayed)</span>}
                  </Td>
                  <Td numeric>{run.leadsConsidered}</Td>
                  <Td numeric>{run.matched}</Td>
                  <Td numeric>{run.unmatched}</Td>
                  <Td numeric>{run.withheld}</Td>
                  <Td numeric>{run.opportunitiesRead}</Td>
                  <Td numeric>{run.attributionsWritten}</Td>
                  <Td>{run.startedByName ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {!canManageCrm(actor) && (
          <p className="mt-3 text-xs text-text-muted">
            Changing the connection itself is Admin — one bar higher than running a sync, because
            an access token is a credential rather than data.
          </p>
        )}
      </Card>
    </div>
  );
}
