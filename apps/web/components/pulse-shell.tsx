'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AppShell } from '@pulse/ui/components/app-shell';
import type { ShellBreadcrumb } from '@pulse/ui/components/top-toolbar';
import type { ShellNavSection } from '@pulse/ui/components/sidebar';
import { COMMAND_BAR_SHORTCUT } from '@pulse/ui/components/command-bar';
import { ShortcutHint } from '@pulse/ui/components/shortcut-hint';
import { APP_NAME } from '@/lib/app';
import { NAV_GROUPS, isEntryActive } from '@/lib/navigation';
import { LogoPlaceholder } from './logo-placeholder';

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

/**
 * The Xtreme Pulse shell for signed-in pages: the shared AppShell wired to Next.js routing.
 * It lists every section for now; step 1.6 passes in the user's modules instead.
 */
export function PulseShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const sections = sectionsFor(pathname);

  return (
    <AppShell
      appName={APP_NAME}
      logo={<LogoPlaceholder />}
      sections={sections}
      breadcrumb={breadcrumbFor(pathname)}
      linkComponent={Link}
      onNavigate={(href) => router.push(href)}
      notifications={
        <div className="flex flex-col gap-1">
          <h2 className="text-headline">Notifications</h2>
          <p className="text-subheadline text-text-secondary">Notifications aren’t set up yet.</p>
        </div>
      }
      help={<HelpContent />}
    >
      {children}
    </AppShell>
  );
}
