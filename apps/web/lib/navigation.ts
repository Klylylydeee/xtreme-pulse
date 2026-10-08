import {
  Boxes,
  BriefcaseBusiness,
  Building2,
  ChartColumn,
  Contact,
  Handshake,
  HardHat,
  Headset,
  House,
  Landmark,
  LayoutGrid,
  Package,
  ScrollText,
  Settings,
  ShieldCheck,
  Tag,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { atLeast, isModuleKey, type ModuleAccess, type ModuleKey } from '@pulse/core';
// A type only, erased at build time: this file stays pure and safe in the browser.
import type { AdminAreaKind } from '@pulse/core/server';
import { APP_NAME } from './app';

export type NavEntry = {
  href: string;
  /** Short name in the sidebar. */
  label: string;
  /** Full name: the page title, breadcrumb and command bar entry. */
  title: string;
  /** What the section covers (the module's domain). */
  description: string;
  Icon: LucideIcon;
  /** A module's section: listed only for users with at least Read on it. */
  module?: ModuleKey;
  /** An admin page: listed only for users whose role opens this part of the admin area. */
  adminArea?: AdminAreaKind;
  /**
   * A count shown after the label, computed on the server for the signed-in user
   * ({@link NavBadges}). Hidden when zero or unknown.
   */
  badge?: NavBadgeKey;
  /**
   * Current only on its own path, not on the pages under it: the admin Overview, so a page under
   * `/admin` the user can't open doesn't light it up. Home is always exact.
   */
  exact?: boolean;
};

/** The sidebar counts, by what they count. */
export type NavBadgeKey = 'usersNeedingAccess';

/**
 * The sidebar counts for the signed-in user, computed on the server; null or 0 hides the badge.
 * `usersNeedingAccess` is User access's count, given to HR and System Administrators only
 * (docs/modules/core.md#user-access-page).
 */
export type NavBadges = Record<NavBadgeKey, number | null>;

/** No counts: every badge hidden. */
export const NO_NAV_BADGES: NavBadges = { usersNeedingAccess: null };

/**
 * What a badge's count means, read after the label by screen readers: "User access, 3 need
 * access" (docs/DESIGN_SYSTEM.md#layout--components).
 */
export function navBadgeLabel(key: NavBadgeKey, count: number): string {
  switch (key) {
    case 'usersNeedingAccess':
      return count === 1 ? 'needs access' : 'need access';
  }
}

export type NavGroup = {
  label: string;
  entries: NavEntry[];
};

/*
 * Every section of the app, in sidebar order. Spec: docs/ARCHITECTURE.md#one-application and
 * docs/modules/core.md#administration-area. The modules follow the build order
 * (docs/ROADMAP.md#build-order).
 *
 * The sidebar and the command bar list only what the user can open (`visibleNavigation`). The list
 * is never access control on its own: every page checks for itself (SECURITY.md#module-access-rwo).
 */
export const CORE_ENTRIES: NavEntry[] = [
  {
    href: '/',
    label: 'Home',
    title: 'Home',
    description: 'Your day at a glance',
    Icon: House,
  },
];

/** The ERP modules, in build order. */
export const MODULE_ENTRIES: NavEntry[] = [
  {
    href: '/talent',
    label: 'Talent',
    title: 'Pulse Talent',
    description: 'People & Culture',
    Icon: Users,
    module: 'talent',
  },
  {
    href: '/engage',
    label: 'Engage',
    title: 'Pulse Engage',
    description: 'Sales & Growth',
    Icon: Handshake,
    module: 'engage',
  },
  {
    href: '/ops',
    label: 'Ops',
    title: 'Pulse Ops',
    description: 'Project Delivery',
    Icon: HardHat,
    module: 'ops',
  },
  {
    href: '/supply',
    label: 'Supply',
    title: 'Pulse Supply',
    description: 'Inventory & Procurement',
    Icon: Package,
    module: 'supply',
  },
  {
    href: '/fiscal',
    label: 'Fiscal',
    title: 'Pulse Fiscal',
    description: 'Finance & Accounting',
    Icon: Landmark,
    module: 'fiscal',
  },
  {
    href: '/desk',
    label: 'Desk',
    title: 'Pulse Desk',
    description: 'Customer Success',
    Icon: Headset,
    module: 'desk',
  },
  {
    href: '/insight',
    label: 'Insight',
    title: 'Pulse Insight',
    description: 'Business Intelligence',
    Icon: ChartColumn,
    module: 'insight',
  },
];

/**
 * Pulse Core administration, checked by role (docs/modules/core.md#administration-area): HR and
 * the System Administrator open the first five; only the System Administrator opens the four master
 * data pages (step 1.8, docs/modules/core.md#managing-master-data), Company settings and the Audit
 * log. User access (step 1.7) sits after Users, with the count of users who still need access.
 */
export const ADMIN_ENTRIES: NavEntry[] = [
  {
    href: '/admin',
    label: 'Overview',
    title: 'Administration',
    description: 'System administration for HR and the System Administrator',
    Icon: LayoutGrid,
    adminArea: 'hrOrSystemAdministrator',
    exact: true,
  },
  {
    href: '/admin/users',
    label: 'Users',
    title: 'Users',
    description: 'Logins, employee numbers, employment status and password resets',
    Icon: Users,
    adminArea: 'hrOrSystemAdministrator',
  },
  {
    href: '/admin/access',
    label: 'User access',
    title: 'User access',
    description: 'Each user’s module access, and who still needs it',
    // The reference design's icon (docs/DESIGN_SYSTEM.md#reference-designs).
    Icon: ShieldCheck,
    adminArea: 'hrOrSystemAdministrator',
    badge: 'usersNeedingAccess',
  },
  {
    href: '/admin/departments',
    label: 'Departments',
    title: 'Departments',
    description: 'Department codes, names and heads',
    Icon: Building2,
    adminArea: 'hrOrSystemAdministrator',
  },
  {
    href: '/admin/positions',
    label: 'Positions',
    title: 'Positions',
    description: 'Positions in each department and their timesheet type',
    Icon: BriefcaseBusiness,
    adminArea: 'hrOrSystemAdministrator',
  },
  {
    href: '/admin/clients',
    label: 'Clients',
    title: 'Clients',
    description: 'Client companies, with their sites and contacts',
    Icon: Contact,
    adminArea: 'systemAdministrator',
  },
  {
    href: '/admin/products',
    label: 'Products',
    title: 'Products',
    description: 'The brands the company sells',
    Icon: Tag,
    adminArea: 'systemAdministrator',
  },
  {
    href: '/admin/catalog-items',
    label: 'Catalog items',
    title: 'Catalog items',
    description: 'Part numbers under each product, with their unit, kind and default warranty',
    Icon: Boxes,
    adminArea: 'systemAdministrator',
  },
  {
    href: '/admin/suppliers',
    label: 'Suppliers',
    title: 'Suppliers',
    description: 'Suppliers, their contacts and the products they supply',
    Icon: Truck,
    adminArea: 'systemAdministrator',
  },
  {
    href: '/admin/settings',
    label: 'Company settings',
    title: 'Company settings',
    description: 'Company details, logo, allowed email domains and upload limits',
    Icon: Settings,
    adminArea: 'systemAdministrator',
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    title: 'Audit log',
    description: 'Every change, reveal and password change, newest first',
    Icon: ScrollText,
    adminArea: 'systemAdministrator',
  },
];

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Pulse Core', entries: CORE_ENTRIES },
  { label: 'Modules', entries: MODULE_ENTRIES },
  { label: 'Administration', entries: ADMIN_ENTRIES },
];

/**
 * Pages that aren't in the sidebar, for the breadcrumb. Checked before the sidebar entries. Only
 * pages every signed-in user may open.
 */
export const OTHER_PAGES: { href: string; parent: string; title: string }[] = [
  { href: '/notifications', parent: 'Pulse Core', title: 'Notifications' },
];

/**
 * What the navigation needs to know about the signed-in user. The layout builds it on the server
 * from the `CurrentUser`: the effective module access, and `canOpenAdminArea` from
 * `@pulse/core/server`, so the role rule lives in one place.
 */
export interface NavigationViewer {
  /** The effective map (`CurrentUser.moduleAccess`). */
  moduleAccess: ModuleAccess;
  /** Whether the user's role opens the admin pages of `kind`. */
  canOpenAdminArea: (kind: AdminAreaKind) => boolean;
}

/** Whether `viewer` sees `entry`: Home always, a module at Read or higher, an admin page by role. */
export function isEntryVisible(entry: NavEntry, viewer: NavigationViewer): boolean {
  if (entry.module) return atLeast(viewer.moduleAccess[entry.module], 'read');
  if (entry.adminArea) return viewer.canOpenAdminArea(entry.adminArea);
  return true;
}

/** Keeps the entries `keep` accepts, and drops any group left empty. */
function filterGroups(keep: (entry: NavEntry) => boolean): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    entries: group.entries.filter(keep),
  })).filter((group) => group.entries.length > 0);
}

/** The sidebar sections `viewer` sees, in order, with empty groups hidden. */
export function visibleNavigation(viewer: NavigationViewer): NavGroup[] {
  return filterGroups((entry) => isEntryVisible(entry, viewer));
}

/**
 * The hrefs `viewer` sees: what the server layout hands the client shell (icons can't cross the
 * server/client boundary), which rebuilds the sections with {@link navigationFor}.
 */
export function visibleHrefs(viewer: NavigationViewer): string[] {
  return visibleNavigation(viewer).flatMap((group) => group.entries.map((entry) => entry.href));
}

/** The sidebar sections holding only `hrefs`, in order, with empty groups hidden. */
export function navigationFor(hrefs: readonly string[]): NavGroup[] {
  const allowed = new Set(hrefs);
  return filterGroups((entry) => allowed.has(entry.href));
}

/**
 * Whether `pathname` is the entry's page or one of the pages under it. Home and `exact` entries
 * (the admin Overview) match their own path only.
 */
export function isEntryActive(entry: { href: string; exact?: boolean }, pathname: string): boolean {
  if (entry.href === '/' || entry.exact) return pathname === entry.href;
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/**
 * The entry `pathname` belongs to among `groups`, with its group: the longest matching href, so
 * `/admin/users` is Users, not Overview. Null when none matches.
 */
export function activeEntry(
  groups: readonly NavGroup[],
  pathname: string,
): { group: NavGroup; entry: NavEntry } | null {
  let best: { group: NavGroup; entry: NavEntry } | null = null;
  for (const group of groups) {
    for (const entry of group.entries) {
      if (!isEntryActive(entry, pathname)) continue;
      if (!best || entry.href.length > best.entry.href.length) best = { group, entry };
    }
  }
  return best;
}

export type Breadcrumb = { parent?: string; current: string };

/** The toolbar and tab title of a page the user can't open (HTTP 403, the no-access state). */
export const NO_ACCESS_PAGE_TITLE = 'No access';
/** The toolbar and tab title of a page that called `notFound()` inside the shell (HTTP 404). */
export const NOT_FOUND_PAGE_TITLE = 'Page not found';

/**
 * The toolbar breadcrumb for `pathname`, from the sections the user sees (so a page they can't
 * open never names itself): "Administration › Users". A page named after its group stands alone
 * ("Administration", not "Administration › Administration"). A path whose section the user can't
 * see reads "No access", since the page shows the no-access state there. No match at all falls
 * back to the app name.
 */
export function breadcrumbFor(groups: readonly NavGroup[], pathname: string): Breadcrumb {
  const page = OTHER_PAGES.find((candidate) => isEntryActive(candidate, pathname));
  if (page) return { parent: page.parent, current: page.title };
  const match = activeEntry(groups, pathname);
  // The section the path belongs to among all of them. If the user doesn't see it, they can't open
  // the page: HR on /admin/audit, a new user on /talent.
  const section = activeEntry(NAV_GROUPS, pathname);
  if (section && section.entry.href !== match?.entry.href) return { current: NO_ACCESS_PAGE_TITLE };
  if (!match) return { current: APP_NAME };
  const { group, entry } = match;
  return { parent: group.label === entry.title ? undefined : group.label, current: entry.title };
}

/** Whether `breadcrumb` is a status page's ("No access", "Page not found"), not a section's. */
export function isStatusBreadcrumb(breadcrumb: Breadcrumb): boolean {
  return breadcrumb.current === NO_ACCESS_PAGE_TITLE || breadcrumb.current === NOT_FOUND_PAGE_TITLE;
}

/** The browser tab title for a page title, as the root layout's `%s · Xtreme Pulse` template. */
export function documentTitleFor(title: string): string {
  return title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`;
}

/**
 * The no-access title for `pathname` (docs/DESIGN_SYSTEM.md#feedback--motion): "You don’t have
 * access to Pulse Talent" under a module's route, "You don’t have access to this page" anywhere
 * else (the admin pages).
 */
export function noAccessTitle(pathname: string): string {
  const segment = pathname.split('/')[1];
  const entry = isModuleKey(segment)
    ? MODULE_ENTRIES.find((candidate) => candidate.module === segment)
    : undefined;
  return `You don’t have access to ${entry ? entry.title : 'this page'}`;
}

/** The navigation entry for a route, such as `/talent`. Throws for an unknown route. */
export function getNavEntry(href: string): NavEntry {
  for (const group of NAV_GROUPS) {
    const entry = group.entries.find((candidate) => candidate.href === href);
    if (entry) return entry;
  }
  throw new Error(`No navigation entry for ${href}`);
}
