import { getActor, isAdmin, authMode } from '@/lib/auth/actor';
import { UNRESTRICTED, formatStrategies } from '@/lib/auth/login-methods';
import { readLoginPolicy, loginPolicyHistory } from '@/lib/auth/login-policy-store';
import { getDb } from '@/db';
import { PageHeader } from '../../_components/ui';
import { LoginPolicyForm } from './form';

/**
 * Login-method control — SCOPE.md §3, the enterprise security-review blocker.
 *
 * The page is candid about the split it sits on: Clerk enforces at sign-in, this
 * workspace enforces at session-read, and the two check different things. Saying
 * so on screen is not documentation-in-the-UI for its own sake — an admin who
 * believes this page turns passwords off in Clerk has a false sense of security,
 * which is worse than no page at all.
 */

export default async function SecurityPage() {
  const actor = await getActor();
  if (!isAdmin(actor)) {
    return (
      <p className="text-sm text-text-muted">
        Only an admin can view or change login-method restrictions.
      </p>
    );
  }

  const db = getDb();
  const [live, history] = await Promise.all([
    readLoginPolicy(actor.orgId, db),
    loginPolicyHistory(actor.orgId, db),
  ]);
  const current = live?.policy ?? UNRESTRICTED;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Sign-in methods"
        blurb={
          <>
            In force:{' '}
            <strong>
              {current.mode === 'allowlist'
                ? formatStrategies(current.allowedStrategies)
                : 'no restriction'}
            </strong>
            {live && (
              <>
                {' '}
                &mdash; version {live.version}, set {live.since.toLocaleDateString()}. &ldquo;
                {live.reason}&rdquo;
              </>
            )}
          </>
        }
      />

      <section className="rounded-lg border border-border bg-panel p-5">
        <LoginPolicyForm current={current} />
      </section>

      <section className="rounded-lg border border-warn bg-warn-soft p-5 text-sm">
        <h2 className="font-semibold">What this setting does, exactly</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5 text-text">
          <li>
            It does <strong>not</strong> disable a sign-in method in Clerk. Turning
            passwords off for the whole instance is a Clerk setting, and that is the gate
            that actually stops a password sign-in from happening.
          </li>
          <li>
            What it does is refuse a session whose account <em>holds</em> a credential this
            org forbids &mdash; a password on an SSO-only account, for instance. Clerk&rsquo;s
            session carries no record of which method was used, so this workspace checks
            the credentials a person could use rather than the one they did.
          </li>
          <li>
            It fails closed: under an allowlist, an account whose identities cannot be read
            is refused rather than admitted.
          </li>
          {authMode() === 'dev' && (
            <li>
              <strong>Clerk is not configured in this environment</strong>, so the policy is
              recorded but nothing is enforced &mdash; the dev seam has no credentials to
              inspect.
            </li>
          )}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
          History
        </h2>
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            No restriction has ever been set for this organization.
          </p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm">
            {history.map((row) => (
              <li
                key={row.id}
                className="rounded border border-border bg-panel p-3"
              >
                <div className="font-medium">
                  v{row.version} &mdash;{' '}
                  {row.mode === 'allowlist'
                    ? formatStrategies(row.allowedStrategies)
                    : 'no restriction'}
                  {row.supersededAt === null && (
                    <span className="ml-2 rounded bg-good-soft px-1.5 py-0.5 text-xs text-good">
                      live
                    </span>
                  )}
                </div>
                <div className="text-text-muted">
                  {row.createdAt.toLocaleString()} &middot; &ldquo;{row.reason}&rdquo;
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
