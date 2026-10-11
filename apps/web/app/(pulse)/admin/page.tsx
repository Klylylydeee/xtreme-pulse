import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { canOpenAdminArea, countUsersNeedingAccessFor } from '@pulse/core/server';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { CompanyDetailsReminder } from '@/components/company-details-reminder';
import { Badge } from '@/components/org-structure';
import { getCurrentUser, requireAdminPage } from '@/lib/auth';
import {
  type AdminNavGroup,
  getNavEntry,
  navBadgeLabel,
  visibleAdminGroups,
} from '@/lib/navigation';

export const metadata: Metadata = { title: 'Administration' };

/**
 * User access's count on its card: the users who still need access, the same count as the sidebar
 * badge (docs/modules/core.md#user-access-page). Only HR and System Administrators get it, checked
 * by the service; hidden at zero, and when it can't be read (the card still opens the page).
 */
async function UsersNeedingAccess() {
  const user = await getCurrentUser();
  if (!user) return null;
  let count: number | null;
  try {
    count = await countUsersNeedingAccessFor(user);
  } catch {
    return null;
  }
  if (!count) return null;
  return (
    <Badge tone="accent" className="numeric">
      {count} {navBadgeLabel('usersNeedingAccess', count)}
    </Badge>
  );
}

// Spec: docs/modules/core.md#administration-area — HR and the System Administrator only, checked by
// role (SECURITY.md#resolving-and-enforcing-build-step-16). The cards are the Administration
// entries the user's role opens, in the sidebar's sub-groups and order (`visibleAdminGroups`, from
// `ADMIN_GROUPS` in lib/navigation.ts, so the two can't drift): HR sees People and organization
// (users, user access with the count of users who still need access, departments and positions);
// the System Administrator also sees Master data (clients, products, catalog items and suppliers,
// from step 1.8) and System (company settings and the audit log). Anyone else gets the no-access
// state (HTTP 403). Checked here on the server, and each page checks again: hiding a link is never
// access control. The guard comes first, before anything that can suspend; the reminder and the
// user access count, the page's only reads, stream in their own boundaries.
export default async function AdminPage() {
  const user = await requireAdminPage('hrOrSystemAdministrator');

  const { groups } = visibleAdminGroups({
    moduleAccess: user.moduleAccess,
    canOpenAdminArea: (kind) => canOpenAdminArea(user, kind),
    hasEmployee: user.employee !== null,
  });
  const { title, description } = getNavEntry('/admin');
  return (
    <>
      <PageHeader title={title} description={description} />
      <Suspense fallback={null}>
        <CompanyDetailsReminder />
      </Suspense>
      <nav aria-label="Administration pages" className="flex flex-col gap-6">
        {groups.map((group) => (
          <AdminLinkSection key={group.key} group={group} />
        ))}
      </nav>
    </>
  );
}

/** One group of admin page links: a short header over a rounded card of rows. */
function AdminLinkSection({ group }: { group: AdminNavGroup }) {
  const headingId = `admin-group-${group.key}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="px-4 text-footnote font-semibold text-text-secondary">
        {group.label}
      </h2>
      <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        {group.entries.map((entry) => {
          return (
            <li key={entry.href}>
              <Link
                href={entry.href}
                className="flex min-h-18 items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent-subtle/50 focus-visible:-outline-offset-2 md:px-5"
              >
                <IconTile className="size-11 rounded-xl [&_svg]:size-5">
                  <entry.Icon strokeWidth={1.75} />
                </IconTile>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-headline">{entry.title}</span>
                    {entry.badge === 'usersNeedingAccess' ? (
                      <Suspense fallback={null}>
                        <UsersNeedingAccess />
                      </Suspense>
                    ) : null}
                  </span>
                  <span className="text-footnote text-text-secondary">{entry.description}.</span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4.5 shrink-0 text-text-secondary"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
