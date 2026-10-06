import { describe, expect, it } from 'vitest';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '@pulse/core';
import { canOpenAdminArea, type DepartmentRole } from '@pulse/core/server';
import {
  activeEntry,
  ADMIN_ENTRIES,
  breadcrumbFor,
  documentTitleFor,
  isStatusBreadcrumb,
  MODULE_ENTRIES,
  navBadgeLabel,
  navigationFor,
  NO_ACCESS_PAGE_TITLE,
  noAccessTitle,
  NOT_FOUND_PAGE_TITLE,
  type NavigationViewer,
  visibleHrefs,
  visibleNavigation,
} from './navigation';

// Spec: docs/TESTING.md#module-access-tests (navigation), docs/TESTING.md#user-access-tests
// (navigation, step 1.7) and docs/modules/core.md#administration-area — the sidebar, and the command bar built from it,
// list only what the user can open; breadcrumbs use the longest matching entry. Pure: no database.

function viewer({
  moduleAccess = emptyModuleAccess(),
  roles = [],
  isSystemAdministrator = false,
}: {
  moduleAccess?: ModuleAccess;
  roles?: DepartmentRole[];
  isSystemAdministrator?: boolean;
} = {}): NavigationViewer {
  const holder = { roles, isSystemAdministrator };
  return { moduleAccess, canOpenAdminArea: (kind) => canOpenAdminArea(holder, kind) };
}

const newUser = viewer();
const hr = viewer({ roles: ['hr'] });
// What the session load resolves for a System Administrator: Owner everywhere, Read on Insight.
const systemAdministrator = viewer({
  isSystemAdministrator: true,
  moduleAccess: fullModuleAccess(),
});

const HR_ADMIN_HREFS = [
  '/admin',
  '/admin/users',
  '/admin/access',
  '/admin/departments',
  '/admin/positions',
];
const ALL_ADMIN_HREFS = [...HR_ADMIN_HREFS, '/admin/settings', '/admin/audit'];

describe('visibleNavigation', () => {
  it('shows a new user only Home, with the empty groups hidden', () => {
    const groups = visibleNavigation(newUser);
    expect(groups.map((group) => group.label)).toEqual(['Pulse Core']);
    expect(visibleHrefs(newUser)).toEqual(['/']);
  });

  it('adds Talent for Read on Talent, and nothing else', () => {
    const talentReader = viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } });
    expect(visibleHrefs(talentReader)).toEqual(['/', '/talent']);
    expect(visibleNavigation(talentReader).map((group) => group.label)).toEqual([
      'Pulse Core',
      'Modules',
    ]);
  });

  it('lists a module for Write and Owner too', () => {
    const access = { ...emptyModuleAccess(), ops: 'write', fiscal: 'owner' } as const;
    expect(visibleHrefs(viewer({ moduleAccess: access }))).toEqual(['/', '/ops', '/fiscal']);
  });

  it('shows HR the five HR admin entries, User access included, and no modules of its own', () => {
    expect(visibleHrefs(hr)).toEqual(['/', ...HR_ADMIN_HREFS]);
    const admin = visibleNavigation(hr).find((group) => group.label === 'Administration');
    expect(admin?.entries.map((entry) => entry.label)).toEqual([
      'Overview',
      'Users',
      'User access',
      'Departments',
      'Positions',
    ]);
  });

  it('puts the "need access" count on User access only', () => {
    const counted = ADMIN_ENTRIES.filter((entry) => entry.badge);
    expect(counted.map((entry) => [entry.href, entry.badge])).toEqual([
      ['/admin/access', 'usersNeedingAccess'],
    ]);
    expect(navBadgeLabel('usersNeedingAccess', 3)).toBe('need access');
    expect(navBadgeLabel('usersNeedingAccess', 1)).toBe('needs access');
  });

  it('shows a Board member or Accounting no admin group', () => {
    // Board members and Accounting never see User access (nor its count) in the sidebar.
    expect(visibleHrefs(viewer({ roles: ['board'] }))).toEqual(['/']);
    expect(visibleHrefs(viewer({ roles: ['accounting'] }))).toEqual(['/']);
  });

  it('shows the System Administrator all 7 modules and all 7 admin entries', () => {
    const groups = visibleNavigation(systemAdministrator);
    expect(groups.map((group) => group.label)).toEqual(['Pulse Core', 'Modules', 'Administration']);
    expect(groups[1]?.entries).toHaveLength(7);
    expect(groups[1]?.entries.map((entry) => entry.href)).toEqual(
      MODULE_ENTRIES.map((entry) => entry.href),
    );
    expect(groups[2]?.entries.map((entry) => entry.href)).toEqual(ALL_ADMIN_HREFS);
    expect(ADMIN_ENTRIES).toHaveLength(7);
  });

  it('rebuilds the same sections in the client shell from the visible hrefs', () => {
    for (const someone of [newUser, hr, systemAdministrator]) {
      expect(navigationFor(visibleHrefs(someone))).toEqual(visibleNavigation(someone));
    }
  });
});

describe('breadcrumbFor', () => {
  const adminGroups = visibleNavigation(systemAdministrator);

  it('uses the longest matching entry', () => {
    expect(breadcrumbFor(adminGroups, '/admin/users')).toEqual({
      parent: 'Administration',
      current: 'Users',
    });
    expect(breadcrumbFor(adminGroups, '/admin/access')).toEqual({
      parent: 'Administration',
      current: 'User access',
    });
    expect(breadcrumbFor(visibleNavigation(hr), '/admin/access')).toEqual({
      parent: 'Administration',
      current: 'User access',
    });
    expect(breadcrumbFor(adminGroups, '/admin/audit')).toEqual({
      parent: 'Administration',
      current: 'Audit log',
    });
    expect(breadcrumbFor(adminGroups, '/admin/settings/anything')).toEqual({
      parent: 'Administration',
      current: 'Company settings',
    });
  });

  it('lets a page named after its group stand alone', () => {
    expect(breadcrumbFor(adminGroups, '/admin')).toEqual({ current: 'Administration' });
  });

  it('names modules and Home under their groups', () => {
    expect(breadcrumbFor(adminGroups, '/talent')).toEqual({
      parent: 'Modules',
      current: 'Pulse Talent',
    });
    expect(breadcrumbFor(adminGroups, '/')).toEqual({ parent: 'Pulse Core', current: 'Home' });
  });

  it('names pages outside the sidebar, such as Notifications', () => {
    expect(breadcrumbFor(visibleNavigation(newUser), '/notifications')).toEqual({
      parent: 'Pulse Core',
      current: 'Notifications',
    });
  });

  it('never names a page the user can’t open: it reads "No access"', () => {
    const hrGroups = visibleNavigation(hr);
    expect(breadcrumbFor(hrGroups, '/admin/audit')).toEqual({ current: NO_ACCESS_PAGE_TITLE });
    expect(breadcrumbFor(hrGroups, '/admin/settings')).toEqual({ current: 'No access' });
    expect(breadcrumbFor(visibleNavigation(newUser), '/talent')).toEqual({
      current: 'No access',
    });
    expect(breadcrumbFor(hrGroups, '/talent/anything')).toEqual({ current: 'No access' });
    expect(breadcrumbFor(visibleNavigation(newUser), '/admin')).toEqual({ current: 'No access' });
    expect(breadcrumbFor(visibleNavigation(viewer({ roles: ['board'] })), '/admin/access')).toEqual(
      { current: 'No access' },
    );
  });

  it('falls back to the app name for a path in no section', () => {
    expect(breadcrumbFor(visibleNavigation(systemAdministrator), '/admin/unknown')).toEqual({
      current: 'Xtreme Pulse',
    });
  });
});

describe('the admin Overview', () => {
  const hrGroups = visibleNavigation(hr);

  it('is current on /admin only', () => {
    expect(activeEntry(hrGroups, '/admin')?.entry.label).toBe('Overview');
  });

  it('is not current on an admin page HR can’t open', () => {
    expect(activeEntry(hrGroups, '/admin/audit')).toBeNull();
    expect(activeEntry(hrGroups, '/admin/settings')).toBeNull();
  });

  it('is not current under another admin page', () => {
    expect(activeEntry(hrGroups, '/admin/users')?.entry.label).toBe('Users');
    expect(activeEntry(hrGroups, '/admin/users/anything')?.entry.label).toBe('Users');
    expect(activeEntry(hrGroups, '/admin/access')?.entry.label).toBe('User access');
  });
});

describe('status page titles', () => {
  it('tells the status titles from section titles', () => {
    expect(isStatusBreadcrumb({ current: NO_ACCESS_PAGE_TITLE })).toBe(true);
    expect(isStatusBreadcrumb({ current: NOT_FOUND_PAGE_TITLE })).toBe(true);
    expect(isStatusBreadcrumb({ parent: 'Modules', current: 'Pulse Talent' })).toBe(false);
  });

  it('follows the root layout’s tab title template', () => {
    expect(documentTitleFor('No access')).toBe('No access · Xtreme Pulse');
    expect(documentTitleFor('Page not found')).toBe('Page not found · Xtreme Pulse');
    expect(documentTitleFor('Xtreme Pulse')).toBe('Xtreme Pulse');
  });
});

describe('noAccessTitle', () => {
  it('names the module under a module route', () => {
    expect(noAccessTitle('/talent')).toBe('You don’t have access to Pulse Talent');
    expect(noAccessTitle('/insight/reports')).toBe('You don’t have access to Pulse Insight');
  });

  it('says "this page" anywhere else', () => {
    expect(noAccessTitle('/admin/audit')).toBe('You don’t have access to this page');
    expect(noAccessTitle('/admin')).toBe('You don’t have access to this page');
  });
});
