import type { Metadata } from 'next';
import { type ReactNode, Suspense } from 'react';
import Link from 'next/link';
import {
  BriefcaseBusiness,
  Building2,
  ChevronRight,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { countUsersNeedingAccessFor, isSystemAdministrator } from '@pulse/core/server';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { CompanyDetailsReminder } from '@/components/company-details-reminder';
import { Badge } from '@/components/org-structure';
import { getCurrentUser, requireAdminPage } from '@/lib/auth';
import { getNavEntry, navBadgeLabel } from '@/lib/navigation';

export const metadata: Metadata = { title: 'Administration' };

interface AdminPageLink {
  href: string;
  title: string;
  description: string;
  icon: ReactNode;
  /** Streams a count after the title (User access's "need access"). */
  count?: ReactNode;
}

const ORG_STRUCTURE_LINKS: AdminPageLink[] = [
  {
    href: '/admin/users',
    title: 'Users',
    description: 'Logins, employee numbers, employment status and password resets.',
    icon: <Users strokeWidth={1.75} />,
  },
  {
    href: '/admin/access',
    title: 'User access',
    description: 'Each user’s module access, and who still needs it.',
    icon: <ShieldCheck strokeWidth={1.75} />,
    count: <UsersNeedingAccess />,
  },
  {
    href: '/admin/departments',
    title: 'Departments',
    description: 'Department codes, names and heads.',
    icon: <Building2 strokeWidth={1.75} />,
  },
  {
    href: '/admin/positions',
    title: 'Positions',
    description: 'Positions in each department and their timesheet type.',
    icon: <BriefcaseBusiness strokeWidth={1.75} />,
  },
];

const SYSTEM_ADMINISTRATOR_LINKS: AdminPageLink[] = [
  {
    href: '/admin/settings',
    title: 'Company settings',
    description: 'Company details, logo, allowed email domains and upload limits.',
    icon: <Settings strokeWidth={1.75} />,
  },
  {
    href: '/admin/audit',
    title: 'Audit log',
    description: 'Every change, reveal and password change, newest first.',
    icon: <ScrollText strokeWidth={1.75} />,
  },
];

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
// role (SECURITY.md#resolving-and-enforcing-build-step-16). HR sees users, user access (with the
// count of users who still need access, from step 1.7), departments and positions; the System
// Administrator also sees company settings and the audit log. Anyone else
// gets the no-access state (HTTP 403). Checked here on the server, and each page checks again:
// hiding a link is never access control. The guard comes first, before anything that can suspend;
// the reminder and the user access count, the page's only reads, stream in their own boundaries.
export default async function AdminPage() {
  const user = await requireAdminPage('hrOrSystemAdministrator');

  const links = isSystemAdministrator(user)
    ? [...ORG_STRUCTURE_LINKS, ...SYSTEM_ADMINISTRATOR_LINKS]
    : ORG_STRUCTURE_LINKS;
  const { title, description } = getNavEntry('/admin');
  return (
    <>
      <PageHeader title={title} description={description} />
      <Suspense fallback={null}>
        <CompanyDetailsReminder />
      </Suspense>
      <nav aria-label="Administration pages">
        <ul className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="flex min-h-18 items-center gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent-subtle/50 focus-visible:-outline-offset-2 md:px-5"
              >
                <IconTile className="size-11 rounded-xl [&_svg]:size-5">{link.icon}</IconTile>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-headline">{link.title}</span>
                    {link.count ? <Suspense fallback={null}>{link.count}</Suspense> : null}
                  </span>
                  <span className="text-footnote text-text-secondary">{link.description}</span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4.5 shrink-0 text-text-secondary"
                />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
