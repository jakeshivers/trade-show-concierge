import type { MetadataRoute } from 'next';

/**
 * The web app manifest — what makes this installable to a home screen.
 *
 * `start_url` is `/day-of` rather than `/`, and that is the whole point of
 * installing it. The icon on a phone at a trade show is not a shortcut to the
 * planning app; it is a shortcut to the two days the planning app was for. A
 * person tapping it at 7am on move-in morning wants the booth number, their
 * shift and a capture form, and every tap between them and that is §8c's ten
 * seconds getting longer.
 *
 * `display: standalone` removes the browser chrome, which also removes the
 * reload button — so the app has to say for itself how old its data is. That is
 * `freshnessOf` at the top of the screen, and it is why it is a line rather than
 * a footnote.
 *
 * The icon is an inline SVG data URI. Real products ship PNGs at six sizes; this
 * workspace ships no binaries it did not generate from something readable, and a
 * scalable mark is the honest version of an icon set nobody has designed yet.
 */

const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
      <rect width="512" height="512" rx="96" fill="#1d4ed8"/>
      <path d="M128 320h256v48H128zM128 176l128-64 128 64v112H128z" fill="#fff" opacity="0.95"/>
    </svg>`.replace(/\s+/g, ' '),
  );

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Trade Show Concierge — Day of',
    short_name: 'Day of',
    description: 'Your shift, the booth, the crates, and lead capture that works with no signal.',
    start_url: '/day-of',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1d4ed8',
    orientation: 'portrait',
    icons: [
      { src: ICON, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: ICON, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
