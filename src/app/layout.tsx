import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { authMode } from '@/lib/auth/mode';
import { InlineScript } from './_inline-script';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Trade Show Concierge',
  description: 'Shows, travel, logistics, and a booking agent that stays inside policy.',
};

/**
 * Apply the stored theme before first paint.
 *
 * `globals.css` reads dark mode off a `.dark` class rather than
 * `prefers-color-scheme` alone, because a media query cannot be overridden by a
 * person — it can only be obeyed. This runs synchronously in <head>, so the
 * class is on <html> before the first paint and there is no flash of the wrong
 * theme. It falls back to the system preference, which is what the app did
 * before, so doing nothing keeps the old behaviour exactly.
 *
 * Wrapped in try/catch: localStorage throws outright in some privacy modes, and
 * a theme preference is not worth a blank page.
 *
 * It goes through `InlineScript` rather than a bare `<script>`: React warns in
 * development that a script rendered by a component never executes, which is
 * true of one inserted by a DOM update and not of one in the server-rendered
 * HTML. The helper is Next's own answer — `text/javascript` on the server,
 * inert `text/plain` on the client — and `<html>` carries
 * `suppressHydrationWarning` because this script changes it before React ever
 * looks.
 */
const THEME_SCRIPT = `
try {
  var stored = localStorage.getItem('theme');
  var dark = stored ? stored === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
`;

/**
 * `<ClerkProvider>` is mounted only when Clerk is configured. Rendering it
 * without keys throws at request time, and "runs with zero API keys" is a
 * non-negotiable, not a nicety — so the unconfigured tree is Clerk-free rather
 * than Clerk-with-a-try/catch.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const shell = (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body className="min-h-full bg-surface font-sans text-text">
        {children}
      </body>
    </html>
  );

  return authMode() === 'clerk' ? <ClerkProvider>{shell}</ClerkProvider> : shell;
}
