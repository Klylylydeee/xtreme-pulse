'use client';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AppShell } from '@pulse/ui/components/app-shell';
import type { ShellBreadcrumb } from '@pulse/ui/components/top-toolbar';
import type { ShellNavSection } from '@pulse/ui/components/sidebar';
import { COMMAND_BAR_SHORTCUT } from '@pulse/ui/components/command-bar';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';
import { Button } from '@pulse/ui/components/button';
import { APP_NAME } from '@/lib/app';
import { NAV_GROUPS, OTHER_PAGES, isEntryActive } from '@/lib/navigation';
import { signOutAction } from '@/lib/sign-out';
import { LogoPlaceholder } from './logo-placeholder';
import { NotificationRouteWatcher, useNotificationBell } from './notification-bell';

function sectionsFor(pathname: string): ShellNavSection[] {
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.entries.map((entry) => ({
      href: entry.href,
      label: entry.label,
      title: entry.title,
      keywords: [entry.description],
      icon: <entry.Icon strokeWidth={1.75} />,
      current: isEntryActive(entry, pathname),
    })),
  }));
}

function breadcrumbFor(pathname: string): ShellBreadcrumb {
  const page = OTHER_PAGES.find(
    (candidate) => pathname === candidate.href || pathname.startsWith(`${candidate.href}/`),
  );
  if (page) return { parent: page.parent, current: page.title };
  for (const group of NAV_GROUPS) {
    const entry = group.entries.find((candidate) => isEntryActive(candidate, pathname));
    // "Administration › Administration" would repeat itself, so a page named after its group stands alone.
    if (entry) {
      return {
        parent: group.label === entry.title ? undefined : group.label,
        current: entry.title,
      };
    }
  }
  return { current: APP_NAME };
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
 * notification count. It lists every section for now; step 1.6 passes in the user's modules instead.
 */
export function PulseShell({
  email,
  unreadNotifications,
  children,
}: {
  email: string;
  unreadNotifications: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const sections = sectionsFor(pathname);
  const bell = useNotificationBell(unreadNotifications);

  return (
    <AppShell
      appName={APP_NAME}
      logo={<LogoPlaceholder />}
      sections={sections}
      breadcrumb={breadcrumbFor(pathname)}
      linkComponent={Link}
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
  );
}
