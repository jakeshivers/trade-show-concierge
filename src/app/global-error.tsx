'use client';

/**
 * The last boundary: the root layout itself threw.
 *
 * `(app)/error.tsx` cannot catch this, because an error thrown *in* a layout
 * escapes the boundary that layout renders. The case that matters here is
 * `AuthConfigError` — exactly one Clerk key set, which step 7 deliberately made
 * loud after discovering that the quiet version served one seeded user's session
 * to everybody. That refusal is worth reading, and until now it arrived as
 * Next's unstyled default error page.
 *
 * It replaces the whole document, so it ships its own `<html>` and `<body>` and
 * cannot use anything from the app shell — including the theme class, which is
 * applied by a script in the layout that did not run. Hence the inline styles
 * and `color-scheme`: the page has to be legible in both themes with no CSS of
 * ours loaded at all.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          colorScheme: 'light dark',
          fontFamily: 'system-ui, sans-serif',
          lineHeight: 1.5,
          margin: 0,
          padding: '3rem 1.5rem',
        }}
      >
        <main style={{ margin: '0 auto', maxWidth: '36rem' }}>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 1rem' }}>
            The application could not start
          </h1>
          <p style={{ margin: '0 0 1rem' }}>{error.message || 'No reason was given.'}</p>
          <p style={{ margin: '0 0 1rem', opacity: 0.7 }}>
            This is a configuration problem rather than something you did. Whoever runs this
            deployment sets it; the app refuses to guess a value it was not given.
          </p>
          {error.digest && (
            <p style={{ fontFamily: 'monospace', fontSize: '0.75rem', opacity: 0.7 }}>
              Reference: {error.digest}
            </p>
          )}
          <button type="button" onClick={reset} style={{ font: 'inherit', padding: '0.4rem 0.9rem' }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
