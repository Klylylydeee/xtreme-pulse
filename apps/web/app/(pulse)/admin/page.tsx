import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, ScrollText } from 'lucide-react';
import { isSystemAdministrator } from '@pulse/core/server';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { ModulePlaceholder } from '@/components/module-placeholder';
import { requireCurrentUser } from '@/lib/auth';
import { getNavEntry } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Administration' };

// Spec: docs/modules/core.md. HR and the System Administrator only, checked on the server from step
// 1.6. The audit log link shows for the System Administrator only, checked here on the server (the
// audit log page checks again: hiding a link is never access control).
export default async function AdminPage() {
  const user = await requireCurrentUser();
  if (!isSystemAdministrator(user)) return <ModulePlaceholder href="/admin" />;

  const { title, description } = getNavEntry('/admin');
  return (
    <>
      <PageHeader title={title} description={description} />
      <nav aria-label="Administration pages">
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          <li>
            <Link
              href="/admin/audit"
              className="flex min-h-18 items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent-subtle/50 focus-visible:-outline-offset-2 md:px-5"
            >
              <IconTile className="size-11 rounded-xl [&_svg]:size-5">
                <ScrollText strokeWidth={1.75} />
              </IconTile>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-headline">Audit log</span>
                <span className="text-footnote text-text-secondary">
                  Every change, reveal and password change, newest first.
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4.5 shrink-0 text-text-secondary" />
            </Link>
          </li>
        </ul>
      </nav>
    </>
  );
}
