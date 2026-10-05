'use client';

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AppShell } from '@pulse/ui/components/app-shell';
import type { ShellNavSection } from '@pulse/ui/components/sidebar';
import { COMMAND_BAR_SHORTCUT } from '@pulse/ui/components/command-bar';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';
import { Button } from '@pulse/ui/components/button';
import { APP_NAME } from '@/lib/app';
import { visibleNavigationAction } from '@/lib/actions/navigation';
import {
  activeEntry,
  breadcrumbFor,
  documentTitleFor,
  isStatusBreadcrumb,
  navigationFor,
  type Breadcrumb,
  type NavGroup,
} from '@/lib/navigation';
import { signOutAction } from '@/lib/sign-out';
import { CompanyLogo } from './company-logo';
import { NotificationRouteWatcher, useNotificationBell } from './notification-bell';
import { useShellPageTitleState } from './shell-page-title';

function sameHrefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((href, index) => href === b[index]);
}

/**
 * The hrefs of the sections the user can open, kept current. `initial` comes from the (pulse)
 * layout, which doesn't re-run on client navigation, so on every pathname change after the first
 * render the server is asked again (`visibleNavigationAction`, the same server-side rule): a module
 * granted or taken away shows in the sidebar and command bar at the next click, without a reload.
 * A failed request keeps the last good list; only the latest request's answer is used.
 */
function useVisibleHrefs(initial: readonly string[], pathname: string): readonly string[] {
  const [hrefs, setHrefs] = useState(initial);
  // A new list from the server render (a full load or router.refresh()) replaces the state.
  const [lastInitial, setLastInitial] = useState(initial);
  if (!sameHrefs(lastInitial, initial)) {
    setLastInitial(initial);
    setHrefs(initial);
  }

  const request = useRef(0);
  const previousPathname = useRef(pathname);
  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const current = ++request.current;
    visibleNavigationAction(null, {})
      .then((result) => {
        if (!result.ok || current !== request.current) return;
        setHrefs((previous) => (sameHrefs(previous, result.data) ? previous : result.data));
      })
      .catch(() => {
        // Navigation is a convenience: keep the last good list and try again on the next one.
      });
  }, [pathname]);

  return hrefs;
}

/**
 * The sidebar link's pending hint (docs/DESIGN_SYSTEM.md#feedback--motion): a small accent dot
 * that fades in at the end of the clicked link while its page loads, and pulses unless the user
 * prefers reduced motion. Fixed size and always rendered, so the row never shifts; the short delay
 * keeps it from flashing on a fast navigation.
 */
function NavLinkPendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-pending={pending ? '' : undefined}
      className="size-1.5 shrink-0 rounded-full bg-accent opacity-0 transition-opacity duration-fast data-pending:opacity-100 data-pending:delay-100 motion-safe:data-pending:animate-pulse"
    />
  );
}

/**
 * Shows a status page's title ("No access", "Page not found") in the browser tab too. The page's
 * own metadata (such as "Pulse Talent") still applies when its guard refuses, and can stream in
 * after this runs, so the tab is kept on the status title while it shows; then whatever the page
 * last set comes back.
 */
function useStatusDocumentTitle(breadcrumb: Breadcrumb) {
  const status = isStatusBreadcrumb(breadcrumb) ? breadcrumb.current : null;
  useEffect(() => {
    if (!status) return;
    const title = documentTitleFor(status);
    let pageTitle = document.title;
    document.title = title;
    const observer = new MutationObserver(() => {
      if (document.title === title) return;
      pageTitle = document.title;
      document.title = title;
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (document.title === title) document.title = pageTitle;
    };
  }, [status]);
}

function sectionsFor(groups: readonly NavGroup[], pathname: string): ShellNavSection[] {
  // Only the longest matching entry is current, so /admin/users highlights Users, not Overview.
  const current = activeEntry(groups, pathname)?.entry.href;
  return groups.map((group) => ({
    label: group.label,
    items: group.entries.map((entry) => ({
      href: entry.href,
      label: entry.label,
      title: entry.title,
      keywords: [entry.description],
      icon: <entry.Icon strokeWidth={1.75} />,
      current: entry.href === current,
    })),
  }));
}

function HelpContent() {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-headline">Help</h2>
      <dl className="flex items-center justify-between gap-4 text-subheadline">
        <dt className="text-text-secondary">Search or jump to</dt>
        <dd>
          <ShortcutHint keys={COMMAND_BAR_SHORTCUT} announce />
        </dd>
      </dl>
    </div>
  );
}

function AccountContent({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-headline">Account</h2>
        <p className="truncate text-subheadline text-text-secondary">{email}</p>
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="secondary" className="w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}

/**
 * The Xtreme Pulse shell for signed-in pages: the shared AppShell wired to Next.js routing. The
 * (pulse) layout has already checked the signed-in user and passes their email and unread
 * notification count, the company logo URL (null shows the placeholder mark), and the hrefs of the
 * sections the user can open (`visibleHrefsFor` in lib/visible-navigation.ts), which the shell
 * asks the server for again on every navigation. The sidebar, and the command bar built from it,
 * list only those; hiding them is never access control, since every page checks for itself
 * (SECURITY.md#resolving-and-enforcing-build-step-16). Status pages set their toolbar and tab
 * title with `ShellPageTitle`.
 */
export function PulseShell({
  email,
  unreadNotifications,
  logoUrl,
  visibleHrefs,
  children,
}: {
  email: string;
  unreadNotifications: number;
  /** The public company logo URL, or null while none is uploaded. */
  logoUrl: string | null;
  /** The hrefs of the sections the user can open, computed on the server: the first render's. */
  visibleHrefs: readonly string[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const hrefs = useVisibleHrefs(visibleHrefs, pathname);
  const groups = useMemo(() => navigationFor(hrefs), [hrefs]);
  const sections = useMemo(() => sectionsFor(groups, pathname), [groups, pathname]);
  const bell = useNotificationBell(unreadNotifications);
  const statusTitle = useShellPageTitleState();
  // A status page's own title wins; otherwise the path's. Either way a page the user can't open
  // never names itself.
  const breadcrumb: Breadcrumb = statusTitle.title
    ? { current: statusTitle.title }
    : breadcrumbFor(groups, pathname);
  useStatusDocumentTitle(breadcrumb);

  return (
    <statusTitle.Provider value={statusTitle.value}>
      <AppShell
        appName={APP_NAME}
        logo={<CompanyLogo logoUrl={logoUrl} />}
        sections={sections}
        breadcrumb={breadcrumb}
        linkComponent={Link}
        linkHint={<NavLinkPendingHint />}
        routeKey={pathname}
        onNavigate={(href) => router.push(href)}
        notifications={bell.panel}
        notificationsUnread={bell.unread}
        notificationsOpen={bell.open}
        onNotificationsOpenChange={bell.onOpenChange}
        help={<HelpContent />}
        account={<AccountContent email={email} />}
      >
        <Suspense fallback={null}>
          <NotificationRouteWatcher onChange={bell.refreshCount} />
        </Suspense>
        {children}
      </AppShell>
    </statusTitle.Provider>
  );
}
