import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { AccessCheck } from '@pulse/core';
import {
  assertSignedIn,
  type CurrentUser,
  loadSessionUser,
  type SignedInOptions,
} from '@pulse/core/server';
import { auth } from '@/auth';

// Spec: SECURITY.md#account--access — the signed-in user for pages, layouts and Server Actions.
// The proxy (proxy.ts) checks every request first; these checks repeat it where the data is read,
// so a page never depends on the proxy alone.

/**
 * The signed-in user, reloaded from the database (once per request): null when signed out, when
 * the account is deactivated, or when the session is older than SESSION_MAX_AGE_HOURS.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  const signedInAt = session?.signedInAt;
  if (typeof userId !== 'string' || typeof signedInAt !== 'number') return null;
  return loadSessionUser(userId, signedInAt);
});

/**
 * The signed-in user for a page or layout. Redirects to the login page when signed out, and to the
 * change-password page while the password is temporary (unless `allowPasswordChange`).
 */
export async function requireCurrentUser(options: SignedInOptions = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword && !options.allowPasswordChange) redirect('/change-password');
  return user;
}

/**
 * The access check for a Server Action that needs a signed-in user (`defineAction({ access })`).
 * Step 1.6 adds `requireModuleAccess(module, level)` for module pages and actions.
 */
export function requireSignedIn(options: SignedInOptions = {}): AccessCheck {
  return async () => {
    assertSignedIn(await getCurrentUser(), options);
  };
}
