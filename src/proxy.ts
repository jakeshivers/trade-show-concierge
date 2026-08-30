import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { authMode } from '@/lib/auth/mode';

/**
 * Next 16 renamed Middleware to Proxy; same function, same file position, and it
 * now defaults to the Node runtime (`runtime` may not be set here at all).
 *
 * Two things happen in this file and nothing else:
 *
 * 1. With Clerk configured, `clerkMiddleware` establishes the request context
 *    that `auth()` needs, and unauthenticated traffic is bounced to `/sign-in`.
 * 2. With Clerk absent, every request passes through untouched, so a clean clone
 *    still runs `next dev` with zero accounts. SCOPE.md §9.
 *
 * The redirect here is a convenience, not the access control: proxy runs before
 * the app and cannot see the database, so it knows nothing about provisioning,
 * roles, or the org's login policy. Authorization is decided at the seam, in
 * `getActor()`, on the server, per request.
 */

const isPublic = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);

const withClerk = clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) await auth.protect();
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (authMode() !== 'clerk') return NextResponse.next();
  return withClerk(request, event);
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets, plus all API routes.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
