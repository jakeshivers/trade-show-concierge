'use client';

/**
 * An inline script that runs while the browser parses the HTML.
 *
 * The two `type` values are the whole component, and they come from Next's own
 * *Preventing flash before hydration* guide
 * (`node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`).
 *
 * React warns in development whenever rendering produces a `<script>` tag,
 * because a script inserted by a DOM update never executes — which is true, and
 * is exactly why this one is in the server-rendered HTML rather than anywhere
 * else. On the server it is `text/javascript` and the browser runs it during
 * parsing, before the first paint; on the client it renders as `text/plain`,
 * which is inert and silences the warning by making the claim honest.
 * `suppressHydrationWarning` covers the resulting type mismatch.
 *
 * **`'use client'` is what makes any of that work, and leaving it off is a silent
 * no-op.** Next's guide shows this helper without the directive because every
 * example it gives calls it from inside a Client Component, which pulls it into
 * the client bundle. Rendered from a Server Component — the root layout, here —
 * the function only ever executes on the server, `typeof window` is always
 * `undefined`, the type is always `text/javascript`, and React still meets a
 * live script element in the RSC payload when it hydrates. The warning fires
 * exactly as before and the helper looks like it is doing something.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
