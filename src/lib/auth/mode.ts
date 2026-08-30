export type AuthMode = 'clerk' | 'dev';

/**
 * Which side of the `getActor()` seam is live. The app shell says so on screen.
 *
 * Its own module, and deliberately dependency-free: `proxy.ts` needs this answer
 * and must not drag the database client — PGlite ships WASM — into the proxy
 * bundle to get it.
 */
export function authMode(): AuthMode {
  return process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    ? 'clerk'
    : 'dev';
}
