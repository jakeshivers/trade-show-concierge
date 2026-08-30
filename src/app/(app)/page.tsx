import Link from 'next/link';
import { getActor, authMode, isAdmin, canApprove } from '@/lib/auth/actor';
import { readLoginPolicy } from '@/lib/auth/login-policy-store';
import { formatStrategies } from '@/lib/auth/login-methods';
import { purchasingStatus } from '@/lib/travel/kill-switch';
import { getDb } from '@/db';

/**
 * The overview. It reports the state of the seam and the spine, and it does not
 * pretend the planning screens exist yet — those are steps 8–12. A page that
 * showed empty "Shows" and "Itinerary" cards would read as a broken product
 * rather than an unbuilt one.
 */

export default async function OverviewPage() {
  const actor = await getActor();
  const db = getDb();
  const [policy, purchasing] = await Promise.all([
    readLoginPolicy(actor.orgId, db),
    purchasingStatus(actor.orgId, db),
  ]);

  const capabilities = [
    'See your shows, flights, lodging, and itinerary',
    'Submit a travel request',
    ...(canApprove(actor)
      ? ["See everyone's travel and shipments", 'Approve a request that exceeds policy', 'View the agent decision log']
      : []),
    ...(isAdmin(actor)
      ? ['Set travel policy and spend thresholds', 'Manage shows, budgets, and members', 'Restrict permitted login methods']
      : []),
  ];

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {actor.fullName.split(' ')[0]}
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in through{' '}
          {authMode() === 'clerk' ? 'a Clerk session' : (
            <>
              the dev seam (<code>DEV_ACTOR_EMAIL</code>)
            </>
          )}
          . Your role and cost center come from this workspace&rsquo;s records, never from
          the identity provider.
        </p>
      </section>

      <Card title="What you can do here">
        <ul className="list-disc space-y-1 pl-5">
          {capabilities.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>

      <Card title="Organization">
        <Row label="Sign-in methods">
          {policy && policy.policy.mode === 'allowlist' ? (
            <>
              Restricted to {formatStrategies(policy.policy.allowedStrategies)}
              {isAdmin(actor) && (
                <>
                  {' · '}
                  <Link className="underline" href="/settings/security">
                    change
                  </Link>
                </>
              )}
            </>
          ) : (
            <>
              Unrestricted
              {isAdmin(actor) && (
                <>
                  {' · '}
                  <Link className="underline" href="/settings/security">
                    restrict
                  </Link>
                </>
              )}
            </>
          )}
        </Row>
        <Row label="Automated purchasing">
          {purchasing.halted
            ? `Halted — ${purchasing.reason ?? 'no reason recorded'}`
            : 'Active'}
        </Row>
      </Card>

      <Card title="The booking spine runs headless">
        <p>
          Steps 1&ndash;6 built the part that spends money, and it has no screens yet: the
          travel request UI and the approvals queue land at step 9. Until then the whole
          loop is legible from the command line.
        </p>
        <ul className="mt-3 space-y-1 font-mono text-xs">
          <li>pnpm booking:dry-run</li>
          <li>pnpm booking:audit &lt;id&gt;</li>
          <li>pnpm credits</li>
        </ul>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      <div className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 border-b border-zinc-100 py-1.5 last:border-0 dark:border-zinc-800">
      <span className="w-48 shrink-0 text-zinc-500">{label}</span>
      <span>{children}</span>
    </div>
  );
}
