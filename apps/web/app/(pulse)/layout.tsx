import type { ReactNode } from 'react';
import { countUnread } from '@pulse/core/server';
import { PulseShell } from '@/components/pulse-shell';
import { requireCurrentUser } from '@/lib/auth';
import { getCompanyLogoUrl } from '@/lib/company-logo';

/**
 * The signed-in shell. The proxy checks the session and account status on every request; this
 * checks again where the page renders (SECURITY.md#account-status), sending a signed-out user to
 * the login page and a temporary password to the change-password page. Step 1.6 lists only the
 * modules the user can open.
 *
 * The bell's first unread count is read here; the bell refreshes it itself after that
 * (docs/modules/core.md#notifications).
 */
export default async function PulseLayout({ children }: { children: ReactNode }) {
  const user = await requireCurrentUser();
  let unread = 0;
  try {
    unread = await countUnread(user.id);
  } catch {
    // The badge is a convenience: the page still opens, and the bell retries on the next
    // navigation, focus or open.
  }
  const logoUrl = await getCompanyLogoUrl();
  return (
    <PulseShell email={user.email} unreadNotifications={unread} logoUrl={logoUrl}>
      {children}
    </PulseShell>
  );
}
