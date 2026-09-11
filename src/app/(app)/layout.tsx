import { UserButton } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { Sidebar } from './_components/sidebar';
import {
  authMode,
  canApprove,
  isAdmin,
  LoginMethodNotPermittedError,
  NotProvisionedError,
  type Actor,
} from '@/lib/auth/actor';
import { currentActorOrNull, currentFeed } from './_request';

/**
 * The app shell.
 *
 * Navigation moved into `_components/sidebar.tsx` — it is stateful (collapsed,
 * active route) and therefore a client component, while this layout must stay a
 * server component because it is where `getActor()` runs.
 *
 * What the shell owns is the thing step 7 is for — showing, on every page, *who
 * the server thinks you are and how it decided that*. An auth seam you cannot
 * see is an auth seam you debug by print statement. The dev-auth banner sits
 * above the header rather than below it: it qualifies everything on the page,
 * including the identity in the header, so it has to be read first.
 */

/**
 * Every page under this shell is resolved per actor, so none of them may be
 * prerendered. Without this the dev seam — which reads an env var and the
 * database, and touches no dynamic request API — renders happily at build time
 * and ships one person's session to everyone as static HTML. The segment config
 * says so once, here, rather than being re-remembered on every new page.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let actor: Actor | null;
  try {
    actor = await currentActorOrNull();
  } catch (err) {
    if (err instanceof NotProvisionedError || err instanceof LoginMethodNotPermittedError) {
      return <NoAccess title={titleFor(err)} detail={err.message} />;
    }
    throw err;
  }

  if (!actor) {
    // In Clerk mode the proxy has already bounced anonymous traffic; landing here
    // means the session vanished between the two, so send them round again.
    if (authMode() === 'clerk') redirect('/sign-in');
    return <NoDevActor />;
  }

  // Bound once: `actor` is a `let`, and TypeScript will not carry its narrowing
  // into the closures below.
  const me = actor;

  // The count the sidebar badges. It is the same `getAlertFeed` the overview
  // reads, memoized per request in `_request.ts`, so rendering `/` is one query
  // rather than two and the two surfaces cannot report different numbers.
  const feed = await currentFeed();

  return (
    <div className="flex min-h-screen">
      <Sidebar
        isAdmin={isAdmin(me)}
        isApprover={canApprove(me)}
        outstandingAlerts={feed.summary.outstanding}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {authMode() === 'dev' && (
          <div className="bg-warn-soft px-6 py-1.5 text-center text-xs text-text">
            Dev auth — this session is <code>DEV_ACTOR_EMAIL</code>, not a sign-in. Set Clerk
            keys to use real sessions.
          </div>
        )}
        <header className="sticky top-0 z-10 border-b border-border bg-panel/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
            <div className="ml-auto text-right text-sm">
              <div className="font-medium">{me.fullName}</div>
              <div className="text-xs text-text-muted">
                {me.email} · {roleLabel(me)}
              </div>
            </div>
            {authMode() === 'clerk' && <UserButton />}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}

function roleLabel(actor: Actor): string {
  if (isAdmin(actor)) return 'Admin';
  return canApprove(actor) ? 'Travel manager' : 'Member';
}

function titleFor(err: Error): string {
  return err instanceof LoginMethodNotPermittedError
    ? 'Sign-in method not permitted'
    : 'No access in this workspace';
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="mt-3 space-y-3 text-sm text-text-muted">{children}</div>
    </div>
  );
}

function NoAccess({ title, detail }: { title: string; detail: string }) {
  return (
    <Panel title={title}>
      <p>{detail}</p>
    </Panel>
  );
}

/** Dev mode with no actor selected — a configuration message, never a blank page. */
function NoDevActor() {
  return (
    <Panel title="No dev actor selected">
      <p>
        Clerk is not configured, so the seam is reading <code>DEV_ACTOR_EMAIL</code> from{' '}
        <code>.env.local</code> — and it is unset, or names nobody in the database.
      </p>
      <p>
        Seeded accounts: <code>shelley@northwindrobotics.test</code> (admin),{' '}
        <code>marcus@northwindrobotics.test</code> (travel manager),{' '}
        <code>priya@northwindrobotics.test</code> (member). Run <code>pnpm db:reset</code> if
        the database is empty.
      </p>
    </Panel>
  );
}
