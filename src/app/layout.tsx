import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { authMode } from '@/lib/auth/mode';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Trade Show Concierge',
  description: 'Shows, travel, logistics, and a booking agent that stays inside policy.',
};

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
    >
      <body className="min-h-full bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        {children}
      </body>
    </html>
  );

  return authMode() === 'clerk' ? <ClerkProvider>{shell}</ClerkProvider> : shell;
}
