import {
  ChartColumn,
  Handshake,
  HardHat,
  Headset,
  House,
  Landmark,
  Package,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type NavEntry = {
  href: string;
  /** Short name in the sidebar. */
  label: string;
  /** Full name: the page title, breadcrumb and command bar entry. */
  title: string;
  /** What the section covers (the module's domain). */
  description: string;
  Icon: LucideIcon;
};

export type NavGroup = {
  label: string;
  entries: NavEntry[];
};

/*
 * Every section of the app, in sidebar order. Spec: docs/ARCHITECTURE.md#modules-and-packages.
 * The modules follow the build order (docs/ROADMAP.md#build-order).
 *
 * For now the sidebar lists every module. Step 1.6 filters it by the user's module access; the
 * list is never access control on its own (SECURITY.md#module-access-rwo).
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
  },
  {
    href: '/engage',
    label: 'Engage',
    title: 'Pulse Engage',
    description: 'Sales & Growth',
    Icon: Handshake,
  },
  {
    href: '/ops',
    label: 'Ops',
    title: 'Pulse Ops',
    description: 'Project Delivery',
    Icon: HardHat,
  },
  {
    href: '/supply',
    label: 'Supply',
    title: 'Pulse Supply',
    description: 'Inventory & Procurement',
    Icon: Package,
  },
  {
    href: '/fiscal',
    label: 'Fiscal',
    title: 'Pulse Fiscal',
    description: 'Finance & Accounting',
    Icon: Landmark,
  },
  {
    href: '/desk',
    label: 'Desk',
    title: 'Pulse Desk',
    description: 'Customer Success',
    Icon: Headset,
  },
  {
    href: '/insight',
    label: 'Insight',
    title: 'Pulse Insight',
    description: 'Business Intelligence',
    Icon: ChartColumn,
  },
];

/**
 * Pulse Core administration (HR and the System Administrator). Later steps add their pages here,
 * such as User access and Company settings.
 */
export const ADMIN_ENTRIES: NavEntry[] = [
  {
    href: '/admin',
    label: 'Overview',
    title: 'Administration',
    description: 'System administration for HR and the System Administrator',
    Icon: ShieldCheck,
  },
];

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Pulse Core', entries: CORE_ENTRIES },
  { label: 'Modules', entries: MODULE_ENTRIES },
  { label: 'Administration', entries: ADMIN_ENTRIES },
];

/**
 * Pages that aren't in the sidebar, for the breadcrumb. Checked before the sidebar entries. Only
 * pages everyone may open: the breadcrumb comes from the URL, so a restricted page listed here
 * would name itself on the "not found" page shown to people who can't open it (the audit log stays
 * under "Administration").
 */
export const OTHER_PAGES: { href: string; parent: string; title: string }[] = [
  { href: '/notifications', parent: 'Pulse Core', title: 'Notifications' },
];

/** Whether `pathname` is the entry's page or one of the pages under it. */
export function isEntryActive(entry: NavEntry, pathname: string): boolean {
  if (entry.href === '/') return pathname === '/';
  return pathname === entry.href || pathname.startsWith(`${entry.href}/`);
}

/** The navigation entry for a route, such as `/talent`. Throws for an unknown route. */
export function getNavEntry(href: string): NavEntry {
  for (const group of NAV_GROUPS) {
    const entry = group.entries.find((candidate) => candidate.href === href);
    if (entry) return entry;
  }
  throw new Error(`No navigation entry for ${href}`);
}
