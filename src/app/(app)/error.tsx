'use client';

import { Button, LinkButton } from './_components/ui';

/**
 * A page that threw, inside the shell.
 *
 * **It shows `error.message`, which is unusual and is the point.** Most of what
 * can be thrown here is written to be read by whoever hits it: `NoPolicyError`
 * says the booking agent has no rules to buy within, every provider selector
 * throws naming the environment variable it wants, and
 * `MissingTravelerDetailsError` lists the fields an airline needs. Swallowing
 * those behind "Something went wrong" would discard the most useful sentence in
 * the codebase and leave a person with a blank screen and a configuration
 * problem nothing names.
 *
 * Next replaces the message with a generic string in production for errors it
 * did not expect, handing back a `digest` instead — so an unexpected error still
 * cannot leak a stack or a query, and the digest is rendered because it is the
 * only thing that ties this screen to a server log.
 *
 * `reset()` re-renders the segment. It is offered first because a good share of
 * what reaches here is a provider timing out rather than a rule being broken,
 * and the second attempt works.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-xl space-y-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">This screen could not be built</h1>
      <p className="rounded-lg border border-border bg-bad-soft px-3 py-2 text-sm text-text">
        {error.message || 'The server did not say what went wrong.'}
      </p>
      <p className="text-sm text-text-muted">
        If that names a setting, it can be changed under Settings. If it names an environment
        variable, whoever runs this deployment sets it — the app refuses to invent a value
        rather than showing you a figure nothing stands behind.
      </p>
      {error.digest && (
        <p className="font-mono text-xs text-text-muted">Reference: {error.digest}</p>
      )}
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <LinkButton href="/">Back to the overview</LinkButton>
      </div>
    </div>
  );
}
