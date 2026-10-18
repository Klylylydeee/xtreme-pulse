import {
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  Contact,
  Handshake,
  HardHat,
  Headset,
  House,
  Landmark,
  LayoutGrid,
  ListChecks,
  Network,
  Package,
  SquareUserRound,
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
  /** The admin sub-group the entry belongs to ({@link ADMIN_GROUPS}); none for the Overview. */
  adminGroup?: AdminGroupKey;
  /**
   * A count shown after the label, computed on the server for the signed-in user
   * ({@link NavBadges}). Hidden when zero or unknown.
   */
  badge?: NavBadgeKey;
  /**
   * Listed only for users with an employee, so never for the bootstrap system account: My record
   * (step 2.1, `/talent/me`). The page itself is open to every signed-in user.
   */
  employeeOnly?: boolean;
  /**
   * Current only on its own path, not on the pages under it: the admin Overview, so a page under
   * `/admin` the user can't open doesn't light it up. Home is always exact.
   */
  exact?: boolean;
  /**
   * Paths under `href` that belong to another entry and never make this one current: Talent's
   * `/talent/me`, which is My record in Pulse Core (step 2.1).
   */
  exclude?: readonly string[];
};

/** The sidebar counts, by what they count. */
export type NavBadgeKey = 'usersNeedingAccess' | 'approvalsWaiting';

/**
 * The sidebar counts for the signed-in user, computed on the server; null or 0 hides the badge.
 * `usersNeedingAccess` is User access's count, given to HR and System Administrators only
 * (docs/modules/core.md#user-access-page). `approvalsWaiting` is Approvals' count of the requests
 * waiting for the user, given to everyone (docs/modules/core.md#approvals-list, step 1.9).
 */
export type NavBadges = Record<NavBadgeKey, number | null>;

/** No counts: every badge hidden. */
export const NO_NAV_BADGES: NavBadges = { usersNeedingAccess: null, approvalsWaiting: null };

/**
 * What a badge's count means, read after the label by screen readers: "User access, 3 need
 * access", "Approvals, 3 waiting" (docs/DESIGN_SYSTEM.md#layout--components).
 */
export function navBadgeLabel(key: NavBadgeKey, count: number): string {
  switch (key) {
    case 'usersNeedingAccess':
      return count === 1 ? 'needs access' : 'need access';
    case 'approvalsWaiting':
      return 'waiting';
  }
}

export type NavGroup = {
  label: string;
  entries: NavEntry[];
};

/** The Administration sub-groups, by key. */
export type AdminGroupKey = 'people' | 'masterData' | 'system';

/**
 * The Administration sub-groups, in order: the sidebar's collapsible groups and the `/admin`
 * overview's card groups both come from here, so they can't drift
 * (docs/modules/core.md#administration-area). The Overview belongs to none.
 */
export const ADMIN_GROUPS: readonly { key: AdminGroupKey; label: string }[] = [
  { key: 'people', label: 'People and organization' },
  { key: 'masterData', label: 'Master data' },
  { key: 'system', label: 'System' },
];

/** One Administration sub-group with the entries in it. */
export type AdminNavGroup = { key: AdminGroupKey; label: string; entries: NavEntry[] };

/**
 * Splits admin entries into those outside any group (the Overview) and the sub-groups in
 * {@link ADMIN_GROUPS} order, each with its entries in their own order. Built from the entries
 * given, which are already filtered for the user, so a group with none is left out.
 */
export function groupAdminEntries(entries: readonly NavEntry[]): {
  ungrouped: NavEntry[];
  groups: AdminNavGroup[];
} {
  return {
    ungrouped: entries.filter((entry) => !entry.adminGroup),
    groups: ADMIN_GROUPS.map(({ key, label }) => ({
      key,
      label,
      entries: entries.filter((entry) => entry.adminGroup === key),
    })).filter((group) => group.entries.length > 0),
  };
}

/** The employee's own record (step 2.1): in Pulse Core, though it lives under `/talent`. */
export const MY_RECORD_HREF = '/talent/me';

/** The employee's own timesheet (step 2.4): in Pulse Core, though it lives under `/talent`. */
export const OWN_TIMESHEET_HREF = '/talent/timesheet';

/**
 * The employee's own onboarding checklist (step 2.6,
 * docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26): self-service,
 * reached from the toolbar progress, the Home card and My record, never from the sidebar.
 */
export const ONBOARDING_HREF = '/talent/onboarding';

/** Change request pages (step 2.6), opened from Approvals and from My record. */
export const CHANGE_REQUESTS_HREF = '/talent/change-requests';

/**
 * The timesheets list (step 2.7, decision 294), for Talent Read: reached from the "Timesheets"
 * button on `/talent` and from `talent.timesheetsMissing`, never from the sidebar. Another
 * employee's timesheet sits under it, at `/talent/timesheets/<employeeId>`.
 */
export const TIMESHEETS_LIST_HREF = '/talent/timesheets';

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
  {
    // Step 1.9 (docs/modules/core.md#approvals-list): every signed-in user, no module access
    // needed; the approvals services check the person. The badge counts what waits for them.
    href: '/approvals',
    label: 'Approvals',
    title: 'Approvals',
    description: 'Requests waiting for your decision, and the ones you decided',
    Icon: ListChecks,
    badge: 'approvalsWaiting',
  },
  {
    // Step 1.10 (docs/modules/core.md#holiday-calendar): every signed-in user, no module access
    // needed. Everyone sees confirmed holidays; HR and System Administrators also see drafts and
    // manage holidays, checked by role on the server.
    href: '/holidays',
    label: 'Holidays',
    title: 'Holidays',
    description: 'Regular holidays and special days, by year',
    Icon: CalendarDays,
  },
  {
    // Step 1.11 (docs/modules/core.md#company-directory): every signed-in user, no module access
    // needed. Directory fields only; the directory services decide who is listed.
    href: '/directory',
    label: 'Directory',
    title: 'Directory',
    description: 'Names, numbers, departments, positions, emails and reporting lines',
    Icon: Contact,
  },
  {
    // Step 1.11 (docs/modules/core.md#org-chart): every signed-in user, built from reporting lines.
    href: '/org-chart',
    label: 'Org chart',
    title: 'Org chart',
    description: 'Who reports to whom, built from reporting lines',
    Icon: Network,
  },
  {
    // Step 2.1 (docs/modules/talent.md#the-employee-record-build-step-21, decision 170): the
    // employee's own record, self-service outside module access
    // (SECURITY.md#exceptions-to-module-access). Listed for every user with an employee, never
    // for the bootstrap system account.
    href: MY_RECORD_HREF,
    label: 'My record',
    title: 'My record',
    description: 'Your own employee record: personal and employment details, pay, IDs and bank',
    Icon: SquareUserRound,
    employeeOnly: true,
  },
  {
    // Step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24,
    // decision 231): the employee's own timesheet, self-service outside module access
    // (SECURITY.md#exceptions-to-module-access). Listed after My record for every user with an
    // employee, never for the bootstrap system account.
    href: OWN_TIMESHEET_HREF,
    label: 'Timesheet',
    title: 'Timesheet',
    description: 'Your time in and out, daily entries, and overtime or offset hours by cut-off',
    Icon: CalendarClock,
    employeeOnly: true,
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
    // My record and the own timesheet are Pulse Core's, so Talent isn't current there (decisions
    // 170 and 231).
    exclude: [MY_RECORD_HREF, OWN_TIMESHEET_HREF],
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
 * Every entry but the Overview has an `adminGroup`, and each group's entries sit together in
 * {@link ADMIN_GROUPS} order: the sidebar folds consecutive entries of one group together.
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
    adminGroup: 'people',
  },
  {
    href: '/admin/access',
    label: 'User access',
    title: 'User access',
    description: 'Each user’s module access, and who still needs it',
    // The reference design's icon (docs/DESIGN_SYSTEM.md#reference-designs).
    Icon: ShieldCheck,
    adminArea: 'hrOrSystemAdministrator',
    adminGroup: 'people',
    badge: 'usersNeedingAccess',
  },
  {
    href: '/admin/departments',
    label: 'Departments',
    title: 'Departments',
    description: 'Department codes, names and heads',
    Icon: Building2,
    adminArea: 'hrOrSystemAdministrator',
    adminGroup: 'people',
  },
  {
    href: '/admin/positions',
    label: 'Positions',
    title: 'Positions',
    description: 'Positions in each department and their timesheet type',
    Icon: BriefcaseBusiness,
    adminArea: 'hrOrSystemAdministrator',
    adminGroup: 'people',
  },
  {
    href: '/admin/clients',
    label: 'Clients',
    title: 'Clients',
    description: 'Client companies, with their sites and contacts',
    Icon: Contact,
    adminArea: 'systemAdministrator',
    adminGroup: 'masterData',
  },
  {
    href: '/admin/products',
    label: 'Products',
    title: 'Products',
    description: 'The brands the company sells',
    Icon: Tag,
    adminArea: 'systemAdministrator',
    adminGroup: 'masterData',
  },
  {
    href: '/admin/catalog-items',
    label: 'Catalog items',
    title: 'Catalog items',
    description: 'Part numbers under each product, with their unit, kind and default warranty',
    Icon: Boxes,
    adminArea: 'systemAdministrator',
    adminGroup: 'masterData',
  },
  {
    href: '/admin/suppliers',
    label: 'Suppliers',
    title: 'Suppliers',
    description: 'Suppliers, their contacts and the products they supply',
    Icon: Truck,
    adminArea: 'systemAdministrator',
    adminGroup: 'masterData',
  },
  {
    href: '/admin/settings',
    label: 'Company settings',
    title: 'Company settings',
    description: 'Company details, logo, allowed email domains and upload limits',
    Icon: Settings,
    adminArea: 'systemAdministrator',
    adminGroup: 'system',
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    title: 'Audit log',
    description: 'Every change, reveal and password change, newest first',
    Icon: ScrollText,
    adminArea: 'systemAdministrator',
    adminGroup: 'system',
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
 * Pages under a sidebar entry that name themselves in the breadcrumb after the section's title,
 * such as "Pulse Talent › Payroll settings" (step 2.3,
 * docs/modules/talent.md#payroll-settings-and-allowances-build-step-23). The section's entry stays
 * current, and a user who can't see the section reads "No access", as on the section itself.
 */
export const SECTION_PAGES: {
  href: string;
  section: string;
  title: string;
  /**
   * The page decides who may open it, beyond the section's readers: another employee's timesheet
   * (step 2.4), which their `reportingTo` supervisors open whatever their module access. The
   * breadcrumb names it even when the user doesn't see the section; a refusal shows "No access"
   * through the forbidden page's own title.
   */
  openToOthers?: boolean;
  /** Only `href` itself, not the pages under it: the timesheets list (step 2.7). */
  exact?: boolean;
  /**
   * Only the pages under `href`, not `href` itself: another employee's timesheet
   * (`/talent/timesheets/<employeeId>`), whose parent path is the timesheets list (step 2.7).
   */
  under?: boolean;
}[] = [
  { href: '/talent/payroll-settings', section: '/talent', title: 'Payroll settings' },
  // Step 2.7 (decision 294): the timesheets list, "Pulse Talent › Timesheets", Talent Read only.
  { href: TIMESHEETS_LIST_HREF, section: '/talent', title: 'Timesheets', exact: true },
  // Step 2.4 (decision 231): "Pulse Talent › Timesheet", read-only.
  {
    href: TIMESHEETS_LIST_HREF,
    section: '/talent',
    title: 'Timesheet',
    openToOthers: true,
    under: true,
  },
  // Step 2.6 (decision 275): the own checklist, open to every signed-in user (self-service), and
  // a change request, which its requester, its approvers (a supervisor with no module access
  // included) and Talent readers open. The pages decide who may open them.
  { href: ONBOARDING_HREF, section: '/talent', title: 'Onboarding', openToOthers: true },
  { href: CHANGE_REQUESTS_HREF, section: '/talent', title: 'Change request', openToOthers: true },
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
  /** Whether the user has an employee (false only for the bootstrap system account). */
  hasEmployee: boolean;
}

/**
 * Whether `viewer` sees `entry`: Pulse Core's (Home, Approvals, Holidays, Directory, Org chart)
 * always, My record with an employee, a module at Read or higher, an admin page by role.
 */
export function isEntryVisible(entry: NavEntry, viewer: NavigationViewer): boolean {
  if (entry.employeeOnly) return viewer.hasEmployee;
  if (entry.module) return atLeast(viewer.moduleAccess[entry.module], 'read');
  if (entry.adminArea) return viewer.canOpenAdminArea(entry.adminArea);
  return true;
}

/**
 * The Administration entries `viewer` sees, split into the Overview and the sub-groups
 * ({@link groupAdminEntries}): the `/admin` overview's card groups and the navigation tests.
 */
export function visibleAdminGroups(viewer: NavigationViewer): ReturnType<typeof groupAdminEntries> {
  return groupAdminEntries(ADMIN_ENTRIES.filter((entry) => isEntryVisible(entry, viewer)));
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

/** Whether `pathname` is `href` or a page under it. */
function isAtOrUnder(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Whether `pathname` is a section page's, as its `exact` or `under` says. */
function isSectionPageAt(
  page: { href: string; exact?: boolean; under?: boolean },
  pathname: string,
): boolean {
  if (page.exact) return pathname === page.href;
  if (page.under) return pathname.startsWith(`${page.href}/`);
  return isAtOrUnder(page.href, pathname);
}

/**
 * Whether `pathname` is the entry's page or one of the pages under it. Home and `exact` entries
 * (the admin Overview) match their own path only, and an entry's `exclude` paths never match it.
 */
export function isEntryActive(
  entry: { href: string; exact?: boolean; exclude?: readonly string[] },
  pathname: string,
): boolean {
  if (entry.href === '/' || entry.exact) return pathname === entry.href;
  if (entry.exclude?.some((path) => isAtOrUnder(path, pathname))) return false;
  return isAtOrUnder(entry.href, pathname);
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
  // The section the path belongs to among all of them. If the user doesn't see it, they can't open
  // the page: HR on /admin/audit, a new user on /talent. My record and the own timesheet are the
  // exceptions: every signed-in user may open them, and the system account, which isn't given the
  // entries, sees their empty state there. So is another employee's timesheet
  // (`openToOthers`), which a supervisor without Talent Read opens.
  const section = activeEntry(NAV_GROUPS, pathname);
  const openPage = section
    ? SECTION_PAGES.find(
        (candidate) =>
          candidate.openToOthers &&
          candidate.section === section.entry.href &&
          isSectionPageAt(candidate, pathname),
      )
    : undefined;
  if (section && openPage) return { parent: section.entry.title, current: openPage.title };
  const match = activeEntry(groups, pathname) ?? (section?.entry.employeeOnly ? section : null);
  if (section && section.entry.href !== match?.entry.href) return { current: NO_ACCESS_PAGE_TITLE };
  if (!match) return { current: APP_NAME };
  const { group, entry } = match;
  const sectionPage = SECTION_PAGES.find(
    (candidate) => candidate.section === entry.href && isSectionPageAt(candidate, pathname),
  );
  if (sectionPage) return { parent: entry.title, current: sectionPage.title };
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
