/**
 * What a navigation looks like while the server is working.
 *
 * Every page under this shell is `force-dynamic` and reads the database, so
 * until now clicking a nav entry left the *previous* page on screen with no
 * indication anything had happened — for as long as the next page's queries
 * took. A board that takes a moment and a board that is broken looked identical,
 * and the honest reading of that from a first-time user is that the app is
 * broken.
 *
 * It fills the `main` slot only. The sidebar and the header live in the layout
 * and survive the navigation, so redrawing them here would make a working
 * app flicker.
 *
 * Deliberately a shape rather than a spinner: the page that arrives is a heading
 * and rows, so the placeholder is a heading and rows. `animate-pulse` is
 * Tailwind's own, and every colour is a semantic token — this file is rendered
 * in both themes and has no `dark:` variant, like everything else in `src/app`.
 */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="space-y-2">
        <div className="h-7 w-64 rounded-lg bg-muted" />
        <div className="h-4 w-96 max-w-full rounded bg-muted" />
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-panel p-4">
        <div className="h-4 w-40 rounded bg-muted" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-4 rounded bg-muted" style={{ width: `${92 - i * 11}%` }} />
        ))}
      </div>
    </div>
  );
}
