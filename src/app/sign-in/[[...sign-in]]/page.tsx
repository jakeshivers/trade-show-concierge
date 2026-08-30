import { SignIn } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { authMode } from '@/lib/auth/actor';

/**
 * Clerk's hosted sign-in, mounted in-app. With no Clerk configured there is
 * nothing to sign in to — the dev seam is already the session — so the route
 * sends you to the app rather than rendering a form that cannot work.
 */
export default function SignInPage() {
  if (authMode() !== 'clerk') redirect('/');
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignIn />
    </div>
  );
}
