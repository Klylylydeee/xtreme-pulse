import type { ReactNode } from 'react';
import { countUnread } from '@pulse/core/server';
import { PulseShell } from '@/components/pulse-shell';
import { requireCurrentUser } from '@/lib/auth';
import { getCompanyLogoUrl } from '@/lib/company-logo';
import { navBadgesFor, visibleHrefsFor } from '@/lib/visible-navigation';

/** The unread count for the bell's first render. */
async function unreadCountFor(userId: string): Promise<number> {
  try {
    return await countUnread(userId);
  } catch {
    // The badge is a convenience: the page still opens, and the bell retries on the next
    // navigation, focus or open.
    return 0;
  }
}

/**
 * The signed-in shell. The proxy checks the session and account status on every request; this
 * checks again where the page renders (SECURITY.md#account-status), sending a signed-out user to
 * the login page and a temporary password to the change-password page.
 *
 * The sidebar and command bar list only the sections the user can open: modules at Read or higher,
 * and the admin pages their role opens (docs/ARCHITECTURE.md#one-application). This is the first
 * render's list: this layout doesn't re-run on client navigation, so the shell asks the server
 * again on every navigation (`visibleNavigationAction`) and an access change shows without a
 * reload. That is navigation, not access control: each page calls its own guard first
 * (`requireModulePage`, `requireAdminPage`), never this layout
 * (SECURITY.md#resolving-and-enforcing-build-step-16).
 *
 * No route-level loading.tsx sits here: it would start the response before a page's guard and
 * force HTTP 200 on the no-access state. So this layout keeps to the session user (read once per
 * request and shared with the page) and three small reads run together; pages stream their own
 * data behind in-page Suspense. The bell's first unread count is read here; the bell refreshes it
 * itself after that (docs/modules/core.md#notifications). So is the sidebar's first User access
 * count (HR and System Administrators only), which the shell asks for again on every navigation
 * with the hrefs (docs/modules/core.md#user-access-page).
 */
export default async function PulseLayout({ children }: { children: ReactNode }) {
  const user = await requireCurrentUser();
  const [unread, logoUrl, badges] = await Promise.all([
    unreadCountFor(user.id),
    getCompanyLogoUrl(),
    navBadgesFor(user),
  ]);
  const hrefs = visibleHrefsFor(user);
  return (
    <PulseShell
      email={user.email}
      unreadNotifications={unread}
      logoUrl={logoUrl}
      visibleHrefs={hrefs}
      navBadges={badges}
    >
      {children}
    </PulseShell>
  );
}
