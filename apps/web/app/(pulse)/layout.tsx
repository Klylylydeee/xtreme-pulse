import type { ReactNode } from 'react';
import { PulseShell } from '@/components/pulse-shell';
import { requireCurrentUser } from '@/lib/auth';

/**
 * The signed-in shell. The proxy checks the session and account status on every request; this
 * checks again where the page renders (SECURITY.md#account-status), sending a signed-out user to
 * the login page and a temporary password to the change-password page. Step 1.6 lists only the
 * modules the user can open.
 */
export default async function PulseLayout({ children }: { children: ReactNode }) {
  const user = await requireCurrentUser();
  return <PulseShell email={user.email}>{children}</PulseShell>;
}
