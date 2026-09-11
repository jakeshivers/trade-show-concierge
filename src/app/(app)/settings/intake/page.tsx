import { getActor } from '@/lib/auth/actor';
import { canManageIntakeKeys } from '@/lib/leads/access';
import { listIntakeKeys } from '@/lib/leads/store';
import { listShows } from '@/lib/shows/store';
import { Badge, Card, Empty, PageHeader, Table, Td, Th } from '../../_components/ui';
import { IssueForm, RevokeButton } from './forms';

/**
 * Lead intake keys — the credential a badge scanner posts with.
 *
 * Admin only, one bar higher than managing the leads themselves, because this is
 * authentication rather than data: §3 puts login-method control with Admin for
 * the same reason. A key resolves to an `IntakePrincipal`, which is deliberately
 * not an `Actor` — see `src/lib/leads/intake.ts` for why the boundary is a type
 * rather than a role check.
 *
 * The page nudges hard toward a show-scoped key and says what an org-wide one
 * costs, because the narrowest credential that does the job is the one to issue
 * and nobody re-narrows a key that already works.
 */
export default async function IntakeKeysPage() {
  const actor = await getActor();
  if (!canManageIntakeKeys(actor)) {
    return (
      <div className="space-y-4">
        <PageHeader title="Lead intake" />
        <Empty>
          Intake keys are managed by an admin. A key writes leads into this workspace from outside
          every permission in the app, so issuing one is an authentication decision rather than a
          lead one.
        </Empty>
      </div>
    );
  }

  const [keys, shows] = await Promise.all([listIntakeKeys(actor), listShows(actor)]);
  const openShows = shows.filter((s) => s.status !== 'cancelled');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lead intake"
        blurb="Keys for POST /api/intake/leads — the endpoint a badge scanner or a vendor’s webhook posts to."
      />

      <Card title="Issue a key">
        <p className="text-sm text-text-muted">
          Scope it to one show wherever you can. A scanner rented for three days has no business
          writing leads to next year’s show, and a key issued for everything is one nobody ever goes
          back and narrows. The plaintext is shown once and never stored.
        </p>
        <IssueForm shows={openShows.map((s) => ({ id: s.id, name: s.name }))} />
      </Card>

      <Card title="Keys">
        {keys.length === 0 ? (
          <Empty>No keys issued. Leads can still be typed at the booth or imported from a CSV.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>Key</Th>
                <Th>Scope</Th>
                <Th>Last used</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-t border-border">
                  <Td>
                    {key.label}
                    {key.revokedAt && (
                      <Badge tone="bad" className="ml-2">
                        revoked
                      </Badge>
                    )}
                    <div className="text-xs text-text-muted">
                      {key.createdByName ? `issued by ${key.createdByName}` : 'issued'} ·{' '}
                      {key.createdAt.toISOString().slice(0, 10)}
                    </div>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">{key.tokenPrefix}…</span>
                  </Td>
                  <Td>
                    {key.showName ?? (
                      <span className="text-warn">every show</span>
                    )}
                  </Td>
                  <Td>
                    {key.lastUsedAt ? (
                      key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ')
                    ) : (
                      <span className="text-text-muted">never</span>
                    )}
                  </Td>
                  <Td>{!key.revokedAt && <RevokeButton keyId={key.id} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="How a scanner posts a lead">
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
{`POST /api/intake/leads
Authorization: Bearer tsc_lead_…
Content-Type: application/json

{
  "showId": "…",              // optional on a show-scoped key
  "fullName": "Dana Whitfield",
  "email": "dana@example.com",
  "company": "Lakeside Manufacturing",
  "externalRef": "DMW-88214", // the scanner's own id — this is what makes a retry safe
  "consentBasis": "consent",  // omit it and none is recorded. Nothing is assumed.
  "consentNotice": "What the person was told at the booth"
}`}
        </pre>
        <ul className="mt-3 space-y-1 text-sm text-text-muted">
          <li>
            <span className="font-medium">201</span> — created.{' '}
            <span className="font-medium">200 with <code>status: duplicate</code></span> — the same
            scan is already here, and the retry that produced it was correct to happen. Answering
            409 would teach an integration to treat a recorded lead as a failure.
          </li>
          <li>
            <span className="font-medium">422</span> — the lead was refused, with the sentence a
            person would have been shown by the same validation the booth form goes through.
          </li>
          <li>
            <span className="font-medium">Omitting <code>consentBasis</code> records none.</span> It
            is never guessed. A lead marked as having consented because the scanner sent no field
            is a consent record invented out of a missing one, and the lead stays out of anything
            outbound until somebody records what the person was actually told.
          </li>
        </ul>
      </Card>
    </div>
  );
}
