'use server';

import { signOut } from '@/auth';

/**
 * Signs out and goes to the login page. It needs no access check: signing out only ends the
 * caller's own session, and does nothing when there isn't one.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}
