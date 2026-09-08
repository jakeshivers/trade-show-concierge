import { LinkButton } from './_components/ui';

/**
 * A row that is not there, inside the shell.
 *
 * Five places already call `notFound()` — a show id that does not resolve, a
 * travel request in another org, a conversation that is not yours — and each of
 * them landed on Next's default 404 page: no navigation, no theme, no way back
 * except the browser's own button. A dead end is a bad answer to a stale
 * bookmark, which is most of how somebody gets here.
 *
 * It says the same thing for a missing row and a forbidden one on purpose.
 * `assistant/[id]` calls `notFound()` for a `ForbiddenError` precisely so that a
 * conversation belonging to a colleague is indistinguishable from one that does
 * not exist — telling the difference is telling somebody what is in another
 * person's transcript.
 */
export default function NotFound() {
  return (
    <div className="max-w-xl space-y-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Not here</h1>
      <p className="text-text-muted">
        Whatever this address pointed at is gone, or was never something this workspace could
        show you. A link that used to work usually means the row was deleted or belongs to a
        colleague.
      </p>
      <div className="flex gap-2">
        <LinkButton href="/" variant="primary">
          Back to the overview
        </LinkButton>
        <LinkButton href="/shows">All shows</LinkButton>
      </div>
    </div>
  );
}
