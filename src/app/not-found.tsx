import Link from 'next/link';

/**
 * A URL that matches no route at all.
 *
 * Distinct from `(app)/not-found.tsx`, which catches the five `notFound()` calls
 * inside the shell and can therefore render the sidebar, the theme and a signed-in
 * person's way back. This one is reached before any of that exists — a mistyped
 * address, or a link to a page this deployment does not have — so it renders
 * under the root layout only, with no navigation to offer beyond the front door.
 *
 * It exists because the alternative is Next's built-in page, which is unstyled,
 * ignores the theme, and says "This page could not be found" in a typeface that
 * belongs to no product.
 */
export default function RootNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">No such page</h1>
      <p className="mt-3 text-sm text-text-muted">
        Nothing here answers to that address. If you followed a link from inside the app, it
        points at a screen this deployment does not have.
      </p>
      <p className="mt-4 text-sm">
        <Link href="/" className="underline hover:no-underline">
          Go to the overview
        </Link>
      </p>
    </main>
  );
}
