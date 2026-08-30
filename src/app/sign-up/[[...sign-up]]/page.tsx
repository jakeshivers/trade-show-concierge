import { SignUp } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { authMode } from '@/lib/auth/actor';

/**
 * Signing up creates a Clerk account; it does not create access. Until an admin
 * provisions a matching user in this workspace, the session lands on the
 * "no access" panel in the app shell. See `lib/auth/clerk.ts`, rule 2.
 */
export default function SignUpPage() {
  if (authMode() !== 'clerk') redirect('/');
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignUp />
    </div>
  );
}
