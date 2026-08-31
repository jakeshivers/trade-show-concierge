import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import {
  authMode,
  getActorOrNull,
  canApprove,
  isAdmin,
  LoginMethodNotPermittedError,
  NotProvisionedError,
  type Actor,
} from '@/lib/auth/actor';

/**
 * The app shell.
 *
 * The nav grows one entry per screen that actually exists — step 8 added Shows
 * and My itinerary; steps 9–12 add the rest. A nav that advertises unbuilt pages
 * reads as a broken product rather than an unfinished one.
 *
 * What the shell owns beyond that is the thing step 7 is for — showing, on every
 * page, *who the server thinks you are and how it decided that*. An auth seam you
 * cannot see is an auth seam you debug by print statement.
 */

type NavItem = { href: string; label: string; see: (actor: Actor) => boolean };

/**
 * Every page under this shell is resolved per actor, so none of them may be
 * prerendered. Without this the dev seam — which reads an env var and the
 * database, and touches no dynamic request API — renders happily at build time
 * and ships one person's session to everyone as static HTML. The segment config
 * says so once, here, rather than being re-remembered on every new page.
 */
export const dynamic = 'force-dynamic';

const NAV: NavItem[] = [
  { href: '/', label: 'Overview', see: () => true },
  { href: '/shows', label: 'Shows', see: () => true },
  { href: '/readiness', label: 'Readiness', see: () => true },
  { href: '/itinerary', label: 'My itinerary', see: () => true },
  { href: '/travel', label: 'Travel', see: () => true },
  // Everyone has an approvals page; for a Member it is their own requests
  // waiting on somebody else, which is worth a nav entry — "where has my
  // request got to" is the question the queue exists to answer.
  { href: '/travel/approvals', label: 'Approvals', see: () => true },
  { href: '/settings/security', label: 'Security', see: isAdmin },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let actor: Actor | null;
  try {
    actor = await getActorOrNull();
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="font-semibold tracking-tight">Trade Show Concierge</span>
          <nav className="flex gap-4 text-sm">
            {NAV.filter((item) => item.see(me)).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-50"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto text-right text-sm">
            <div className="font-medium">{me.fullName}</div>
            <div className="text-xs text-zinc-500">
              {me.email} · {roleLabel(me)}
            </div>
          </div>
          {authMode() === 'clerk' && <UserButton />}
        </div>
        {authMode() === 'dev' && (
          <div className="bg-amber-100 px-6 py-1.5 text-center text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Dev auth — this session is <code>DEV_ACTOR_EMAIL</code>, not a sign-in. Set
            Clerk keys to use real sessions.
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
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
      <div className="mt-3 space-y-3 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
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
