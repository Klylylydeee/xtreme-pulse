import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Info } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { safeCallbackUrl } from '@/lib/callback-url';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * The Pulse Core login page, the only public route (SECURITY.md#sign-in-and-passwords). The hero
 * is in the (auth) layout.
 */
export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(params.callbackUrl);

  // Already signed in: go on. The proxy sends a temporary password to change-password from there.
  if (await getCurrentUser()) redirect(callbackUrl);

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-display">Sign in</h1>
        <p className="text-body text-text-secondary">Sign in with your work email.</p>
      </div>
      {params.reason === 'signed-out' ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-card bg-bg-grouped px-4 py-3.5"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-accent" />
          <p className="text-footnote text-text-secondary">You were signed out.</p>
        </div>
      ) : null}
      <SignInForm callbackUrl={callbackUrl} />
    </>
  );
}
