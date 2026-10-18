import { describe, expect, it } from 'vitest';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '@pulse/core';
import { canOpenAdminArea, type DepartmentRole } from '@pulse/core/server';
import {
  activeEntry,
  ADMIN_ENTRIES,
  ADMIN_GROUPS,
  breadcrumbFor,
  CHANGE_REQUESTS_HREF,
  CORE_ENTRIES,
  documentTitleFor,
  getNavEntry,
  groupAdminEntries,
  isEntryActive,
  isStatusBreadcrumb,
  MODULE_ENTRIES,
  NAV_GROUPS,
  navBadgeLabel,
  navigationFor,
  NO_ACCESS_PAGE_TITLE,
  NO_NAV_BADGES,
  noAccessTitle,
  NOT_FOUND_PAGE_TITLE,
  ONBOARDING_HREF,
  TIMESHEETS_LIST_HREF,
  type NavigationViewer,
  visibleAdminGroups,
  visibleHrefs,
  visibleNavigation,
} from './navigation';

// Spec: docs/TESTING.md#module-access-tests (navigation), docs/TESTING.md#user-access-tests
// (navigation, step 1.7), docs/TESTING.md#master-data-tests (navigation, step 1.8, and the
// Administration sub-groups), docs/TESTING.md#approvals-tests (navigation, step 1.9),
// docs/TESTING.md#holiday-calendar-tests (navigation, step 1.10),
// docs/TESTING.md#directory-org-chart-and-command-bar-tests (navigation, step 1.11),
// docs/TESTING.md#employee-record-tests (My record, step 2.1), the Payroll settings breadcrumb
// (step 2.3), docs/TESTING.md#timesheet-and-work-schedule-tests (Timesheet, step 2.4),
// docs/TESTING.md#onboarding-and-change-request-tests (Onboarding and Change request, step 2.6),
// docs/TESTING.md#timesheet-approval-dtr-and-offset-tests (Timesheets, step 2.7) and
// docs/modules/core.md#administration-area — the sidebar, and the
// command bar built from it, list only what the user can open; breadcrumbs use the longest matching
// entry. Pure: no database.

function viewer({
  moduleAccess = emptyModuleAccess(),
  roles = [],
  isSystemAdministrator = false,
  hasEmployee = true,
}: {
  moduleAccess?: ModuleAccess;
  roles?: DepartmentRole[];
  isSystemAdministrator?: boolean;
  hasEmployee?: boolean;
} = {}): NavigationViewer {
  const holder = { roles, isSystemAdministrator };
  return {
    moduleAccess,
    canOpenAdminArea: (kind) => canOpenAdminArea(holder, kind),
    hasEmployee,
  };
}

const newUser = viewer();
const hr = viewer({ roles: ['hr'] });
// What the session load resolves for a System Administrator: Owner everywhere, Read on Insight.
const systemAdministrator = viewer({
  isSystemAdministrator: true,
  moduleAccess: fullModuleAccess(),
});
// The bootstrap system account: a System Administrator with no employee.
const systemAccount = viewer({
  isSystemAdministrator: true,
  moduleAccess: fullModuleAccess(),
  hasEmployee: false,
});

// Pulse Core, for every signed-in user with an employee: Home, then Approvals (step 1.9), then
// Holidays (step 1.10), then Directory and Org chart (step 1.11), then My record (step 2.1), then
// Timesheet (step 2.4).
const CORE_HREFS = [
  '/',
  '/approvals',
  '/holidays',
  '/directory',
  '/org-chart',
  '/talent/me',
  '/talent/timesheet',
];

const HR_ADMIN_HREFS = [
  '/admin',
  '/admin/users',
  '/admin/access',
  '/admin/departments',
  '/admin/positions',
];
// Step 1.8: the master data pages, for the System Administrator only, before Company settings.
const MASTER_DATA_HREFS = [
  '/admin/clients',
  '/admin/products',
  '/admin/catalog-items',
  '/admin/suppliers',
];
const ALL_ADMIN_HREFS = [
  ...HR_ADMIN_HREFS,
  ...MASTER_DATA_HREFS,
  '/admin/settings',
  '/admin/audit',
];

describe('visibleNavigation', () => {
  it('shows a new user only Pulse Core (Home, Approvals, Holidays, Directory, Org chart), with the empty groups hidden', () => {
    const groups = visibleNavigation(newUser);
    expect(groups.map((group) => group.label)).toEqual(['Pulse Core']);
    expect(visibleHrefs(newUser)).toEqual(CORE_HREFS);
  });

  it('adds Talent for Read on Talent, and nothing else', () => {
    const talentReader = viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } });
    expect(visibleHrefs(talentReader)).toEqual([...CORE_HREFS, '/talent']);
    expect(visibleNavigation(talentReader).map((group) => group.label)).toEqual([
      'Pulse Core',
      'Modules',
    ]);
  });

  it('lists a module for Write and Owner too', () => {
    const access = { ...emptyModuleAccess(), ops: 'write', fiscal: 'owner' } as const;
    expect(visibleHrefs(viewer({ moduleAccess: access }))).toEqual([
      ...CORE_HREFS,
      '/ops',
      '/fiscal',
    ]);
  });

  it('shows HR the five HR admin entries, User access included, and no modules of its own', () => {
    expect(visibleHrefs(hr)).toEqual([...CORE_HREFS, ...HR_ADMIN_HREFS]);
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
    expect(visibleHrefs(viewer({ roles: ['board'] }))).toEqual(CORE_HREFS);
    expect(visibleHrefs(viewer({ roles: ['accounting'] }))).toEqual(CORE_HREFS);
  });

  it('shows the System Administrator all 7 modules and all 11 admin entries', () => {
    const groups = visibleNavigation(systemAdministrator);
    expect(groups.map((group) => group.label)).toEqual(['Pulse Core', 'Modules', 'Administration']);
    expect(groups[1]?.entries).toHaveLength(7);
    expect(groups[1]?.entries.map((entry) => entry.href)).toEqual(
      MODULE_ENTRIES.map((entry) => entry.href),
    );
    expect(groups[2]?.entries.map((entry) => entry.href)).toEqual(ALL_ADMIN_HREFS);
    expect(ADMIN_ENTRIES).toHaveLength(11);
  });

  it('shows the four master data entries to the System Administrator only, not HR', () => {
    const adminLabels = visibleNavigation(systemAdministrator)
      .find((group) => group.label === 'Administration')
      ?.entries.map((entry) => entry.label);
    expect(adminLabels).toEqual([
      'Overview',
      'Users',
      'User access',
      'Departments',
      'Positions',
      'Clients',
      'Products',
      'Catalog items',
      'Suppliers',
      'Company settings',
      'Audit log',
    ]);
    for (const href of MASTER_DATA_HREFS) {
      expect(visibleHrefs(systemAdministrator)).toContain(href);
      expect(visibleHrefs(hr)).not.toContain(href);
      expect(visibleHrefs(viewer({ roles: ['board'] }))).not.toContain(href);
      // Module access alone never opens an admin page: Engage and Supply Owner see none of them.
      const owner = viewer({
        moduleAccess: { ...emptyModuleAccess(), engage: 'owner', supply: 'owner' },
      });
      expect(visibleHrefs(owner)).not.toContain(href);
    }
  });

  it('rebuilds the same sections in the client shell from the visible hrefs', () => {
    for (const someone of [newUser, hr, systemAdministrator]) {
      expect(navigationFor(visibleHrefs(someone))).toEqual(visibleNavigation(someone));
    }
  });
});

describe('Approvals (step 1.9)', () => {
  const everyone = [
    newUser,
    hr,
    systemAdministrator,
    viewer({ roles: ['board'] }),
    viewer({ roles: ['accounting'] }),
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  ];

  it('sits in Pulse Core right after Home for every signed-in user', () => {
    for (const someone of everyone) {
      const core = visibleNavigation(someone)[0];
      expect(core?.label).toBe('Pulse Core');
      expect(core?.entries.map((entry) => entry.href)).toEqual(CORE_HREFS);
      expect(visibleHrefs(someone).slice(0, CORE_HREFS.length)).toEqual(CORE_HREFS);
    }
  });

  it('needs no module access or role, and is not an Administration entry', () => {
    const entry = getNavEntry('/approvals');
    expect(entry).toMatchObject({ label: 'Approvals', title: 'Approvals' });
    expect(entry.module).toBeUndefined();
    expect(entry.adminArea).toBeUndefined();
    expect(entry.adminGroup).toBeUndefined();
    expect(CORE_ENTRIES.map((candidate) => candidate.href)).toEqual(CORE_HREFS);
    expect(ADMIN_ENTRIES.map((candidate) => candidate.href)).not.toContain('/approvals');
  });

  it('reads "Pulse Core › Approvals" in the breadcrumb', () => {
    for (const someone of [newUser, hr, systemAdministrator]) {
      expect(breadcrumbFor(visibleNavigation(someone), '/approvals')).toEqual({
        parent: 'Pulse Core',
        current: 'Approvals',
      });
    }
  });

  it('is current on /approvals, not Home', () => {
    expect(activeEntry(visibleNavigation(newUser), '/approvals')?.entry.label).toBe('Approvals');
  });

  it('carries the waiting count as its badge, read as "N waiting"', () => {
    expect(getNavEntry('/approvals').badge).toBe('approvalsWaiting');
    const counted = NAV_GROUPS.flatMap((group) => group.entries).filter((entry) => entry.badge);
    expect(counted.map((entry) => [entry.href, entry.badge])).toEqual([
      ['/approvals', 'approvalsWaiting'],
      ['/admin/access', 'usersNeedingAccess'],
    ]);
    expect(navBadgeLabel('approvalsWaiting', 3)).toBe('waiting');
    expect(navBadgeLabel('approvalsWaiting', 1)).toBe('waiting');
    expect(NO_NAV_BADGES).toEqual({ usersNeedingAccess: null, approvalsWaiting: null });
  });
});

describe('Holidays (step 1.10)', () => {
  const everyone = [
    newUser,
    hr,
    systemAdministrator,
    viewer({ roles: ['board'] }),
    viewer({ roles: ['accounting'] }),
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  ];

  it('sits in Pulse Core right after Approvals for every signed-in user', () => {
    for (const someone of everyone) {
      const core = visibleNavigation(someone)[0];
      expect(core?.label).toBe('Pulse Core');
      const hrefs = core?.entries.map((entry) => entry.href) ?? [];
      expect(hrefs.indexOf('/holidays')).toBe(hrefs.indexOf('/approvals') + 1);
      expect(visibleHrefs(someone)).toContain('/holidays');
    }
  });

  it('needs no module access or role, has no badge, and is not an Administration entry', () => {
    const entry = getNavEntry('/holidays');
    expect(entry).toMatchObject({ label: 'Holidays', title: 'Holidays' });
    expect(entry.module).toBeUndefined();
    expect(entry.adminArea).toBeUndefined();
    expect(entry.adminGroup).toBeUndefined();
    expect(entry.badge).toBeUndefined();
    expect(ADMIN_ENTRIES.map((candidate) => candidate.href)).not.toContain('/holidays');
  });

  it('reads "Pulse Core › Holidays" in the breadcrumb', () => {
    for (const someone of everyone) {
      expect(breadcrumbFor(visibleNavigation(someone), '/holidays')).toEqual({
        parent: 'Pulse Core',
        current: 'Holidays',
      });
    }
  });

  it('is current on /holidays, not Home or Approvals', () => {
    expect(activeEntry(visibleNavigation(newUser), '/holidays')?.entry.label).toBe('Holidays');
  });
});

describe('Directory and Org chart (step 1.11)', () => {
  const everyone = [
    newUser,
    hr,
    systemAdministrator,
    viewer({ roles: ['board'] }),
    viewer({ roles: ['accounting'] }),
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  ];

  it('sit in Pulse Core after Holidays, Directory then Org chart, for every signed-in user', () => {
    for (const someone of everyone) {
      const core = visibleNavigation(someone)[0];
      expect(core?.label).toBe('Pulse Core');
      const hrefs = core?.entries.map((entry) => entry.href) ?? [];
      expect(hrefs.indexOf('/directory')).toBe(hrefs.indexOf('/holidays') + 1);
      expect(hrefs.indexOf('/org-chart')).toBe(hrefs.indexOf('/directory') + 1);
      expect(visibleHrefs(someone)).toEqual(expect.arrayContaining(['/directory', '/org-chart']));
    }
  });

  it('need no module access or role, have no badge, and are not Administration entries', () => {
    for (const [href, label] of [
      ['/directory', 'Directory'],
      ['/org-chart', 'Org chart'],
    ] as const) {
      const entry = getNavEntry(href);
      expect(entry).toMatchObject({ label, title: label });
      expect(entry.module).toBeUndefined();
      expect(entry.adminArea).toBeUndefined();
      expect(entry.adminGroup).toBeUndefined();
      expect(entry.badge).toBeUndefined();
      expect(ADMIN_ENTRIES.map((candidate) => candidate.href)).not.toContain(href);
    }
  });

  it('read "Pulse Core › Directory" and "Pulse Core › Org chart" in the breadcrumb', () => {
    for (const someone of everyone) {
      const groups = visibleNavigation(someone);
      expect(breadcrumbFor(groups, '/directory')).toEqual({
        parent: 'Pulse Core',
        current: 'Directory',
      });
      expect(breadcrumbFor(groups, '/org-chart')).toEqual({
        parent: 'Pulse Core',
        current: 'Org chart',
      });
    }
  });

  it('are current on their own paths, not Home or Holidays', () => {
    const groups = visibleNavigation(newUser);
    expect(activeEntry(groups, '/directory')?.entry.label).toBe('Directory');
    expect(activeEntry(groups, '/org-chart')?.entry.label).toBe('Org chart');
  });
});

describe('My record (step 2.1)', () => {
  const withEmployee = [
    newUser,
    hr,
    systemAdministrator,
    viewer({ roles: ['board'] }),
    viewer({ roles: ['accounting'] }),
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'write' } }),
  ];

  it('sits in Pulse Core right after Org chart for every user with an employee', () => {
    for (const someone of withEmployee) {
      const core = visibleNavigation(someone)[0];
      expect(core?.label).toBe('Pulse Core');
      const hrefs = core?.entries.map((entry) => entry.href) ?? [];
      expect(hrefs.indexOf('/talent/me')).toBe(hrefs.indexOf('/org-chart') + 1);
    }
  });

  it('is never shown to the bootstrap system account', () => {
    expect(visibleHrefs(systemAccount)).not.toContain('/talent/me');
    expect(visibleHrefs(systemAccount)).toContain('/talent');
    expect(navigationFor(visibleHrefs(systemAccount))).toEqual(visibleNavigation(systemAccount));
  });

  it('needs no module access or role, and is a Pulse Core entry', () => {
    const entry = getNavEntry('/talent/me');
    expect(entry).toMatchObject({ label: 'My record', title: 'My record', employeeOnly: true });
    expect(entry.module).toBeUndefined();
    expect(entry.adminArea).toBeUndefined();
    expect(entry.badge).toBeUndefined();
    expect(CORE_ENTRIES.map((candidate) => candidate.href)).toContain('/talent/me');
    expect(MODULE_ENTRIES.map((candidate) => candidate.href)).not.toContain('/talent/me');
    expect(visibleHrefs(newUser)).toContain('/talent/me');
    expect(visibleHrefs(newUser)).not.toContain('/talent');
  });

  it('reads "Pulse Core › My record" in the breadcrumb, Talent access or not', () => {
    for (const someone of [...withEmployee, systemAccount]) {
      expect(breadcrumbFor(visibleNavigation(someone), '/talent/me')).toEqual({
        parent: 'Pulse Core',
        current: 'My record',
      });
    }
  });

  it('is current on /talent/me, and the Talent item is not', () => {
    const talentWriter = visibleNavigation(
      viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'write' } }),
    );
    expect(activeEntry(talentWriter, '/talent/me')?.entry.label).toBe('My record');
    expect(isEntryActive(getNavEntry('/talent'), '/talent/me')).toBe(false);
    expect(isEntryActive(getNavEntry('/talent'), '/talent/me/anything')).toBe(false);
    // The system account sees Talent but not My record: nothing is current there.
    expect(activeEntry(visibleNavigation(systemAccount), '/talent/me')).toBeNull();
    // Talent stays current on its own pages, /talent/members included.
    expect(activeEntry(talentWriter, '/talent')?.entry.label).toBe('Talent');
    expect(isEntryActive(getNavEntry('/talent'), '/talent/members')).toBe(true);
  });
});

describe('Timesheet (step 2.4)', () => {
  const withEmployee = [
    newUser,
    hr,
    systemAdministrator,
    viewer({ roles: ['board'] }),
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  ];
  const talentReader = visibleNavigation(
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  );

  it('sits in Pulse Core right after My record for every user with an employee', () => {
    for (const someone of withEmployee) {
      const core = visibleNavigation(someone)[0];
      expect(core?.label).toBe('Pulse Core');
      const hrefs = core?.entries.map((entry) => entry.href) ?? [];
      expect(hrefs.indexOf('/talent/timesheet')).toBe(hrefs.indexOf('/talent/me') + 1);
    }
  });

  it('is never shown to the bootstrap system account', () => {
    expect(visibleHrefs(systemAccount)).not.toContain('/talent/timesheet');
    expect(navigationFor(visibleHrefs(systemAccount))).toEqual(visibleNavigation(systemAccount));
  });

  it('needs no module access or role, and is a Pulse Core entry', () => {
    const entry = getNavEntry('/talent/timesheet');
    expect(entry).toMatchObject({ label: 'Timesheet', title: 'Timesheet', employeeOnly: true });
    expect(entry.module).toBeUndefined();
    expect(entry.adminArea).toBeUndefined();
    expect(entry.badge).toBeUndefined();
    expect(MODULE_ENTRIES.map((candidate) => candidate.href)).not.toContain('/talent/timesheet');
    expect(visibleHrefs(newUser)).toContain('/talent/timesheet');
  });

  it('reads "Pulse Core › Timesheet" in the breadcrumb, Talent access or not', () => {
    for (const someone of [...withEmployee, systemAccount]) {
      expect(breadcrumbFor(visibleNavigation(someone), '/talent/timesheet')).toEqual({
        parent: 'Pulse Core',
        current: 'Timesheet',
      });
    }
  });

  it('is current on /talent/timesheet, and the Talent item is not', () => {
    expect(activeEntry(talentReader, '/talent/timesheet')?.entry.label).toBe('Timesheet');
    expect(isEntryActive(getNavEntry('/talent'), '/talent/timesheet')).toBe(false);
    expect(activeEntry(visibleNavigation(systemAccount), '/talent/timesheet')).toBeNull();
  });

  it('names another employee’s timesheet "Pulse Talent › Timesheet", supervisors included', () => {
    const path = '/talent/timesheets/64b7f0c2a1b2c3d4e5f60718';
    // Talent Read, and a supervisor with no module access (the page decides who may open it).
    for (const groups of [talentReader, visibleNavigation(newUser), visibleNavigation(hr)]) {
      expect(breadcrumbFor(groups, path)).toEqual({ parent: 'Pulse Talent', current: 'Timesheet' });
    }
    // Talent stays current there for Talent readers; the own timesheet entry isn't.
    expect(activeEntry(talentReader, path)?.entry.label).toBe('Talent');
    expect(isEntryActive(getNavEntry('/talent/timesheet'), path)).toBe(false);
    expect(visibleHrefs(systemAdministrator)).not.toContain('/talent/timesheets');
  });
});

describe('Onboarding and change requests (step 2.6)', () => {
  const talentReader = visibleNavigation(
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  );
  const changeRequest = '/talent/change-requests/64b7f0c2a1b2c3d4e5f60718';

  it('names the checklist "Pulse Talent › Onboarding" for everyone, Talent access or not', () => {
    for (const someone of [newUser, hr, systemAdministrator, systemAccount]) {
      expect(breadcrumbFor(visibleNavigation(someone), ONBOARDING_HREF)).toEqual({
        parent: 'Pulse Talent',
        current: 'Onboarding',
      });
    }
    expect(ONBOARDING_HREF).toBe('/talent/onboarding');
  });

  it('names a change request "Pulse Talent › Change request", approvers without Talent included', () => {
    for (const groups of [talentReader, visibleNavigation(newUser), visibleNavigation(hr)]) {
      expect(breadcrumbFor(groups, changeRequest)).toEqual({
        parent: 'Pulse Talent',
        current: 'Change request',
      });
    }
    expect(changeRequest.startsWith(`${CHANGE_REQUESTS_HREF}/`)).toBe(true);
  });

  it('adds no sidebar entry, and leaves My record and the own timesheet not current', () => {
    for (const someone of [newUser, systemAdministrator]) {
      const hrefs = visibleHrefs(someone);
      expect(hrefs).not.toContain(ONBOARDING_HREF);
      expect(hrefs).not.toContain(CHANGE_REQUESTS_HREF);
    }
    for (const path of [ONBOARDING_HREF, changeRequest]) {
      expect(isEntryActive(getNavEntry('/talent/me'), path)).toBe(false);
      expect(isEntryActive(getNavEntry('/talent/timesheet'), path)).toBe(false);
      // Talent stays current there for Talent readers, as on the other Talent pages.
      expect(activeEntry(talentReader, path)?.entry.label).toBe('Talent');
    }
  });
});

describe('The timesheets list (step 2.7)', () => {
  const talentReader = visibleNavigation(
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  );
  const employeeTimesheet = `${TIMESHEETS_LIST_HREF}/64b7f0c2a1b2c3d4e5f60718`;

  it('reads "Pulse Talent › Timesheets", with Talent current', () => {
    expect(TIMESHEETS_LIST_HREF).toBe('/talent/timesheets');
    for (const groups of [talentReader, visibleNavigation(systemAdministrator)]) {
      expect(breadcrumbFor(groups, TIMESHEETS_LIST_HREF)).toEqual({
        parent: 'Pulse Talent',
        current: 'Timesheets',
      });
      expect(activeEntry(groups, TIMESHEETS_LIST_HREF)?.entry.label).toBe('Talent');
    }
    expect(isEntryActive(getNavEntry('/talent/timesheet'), TIMESHEETS_LIST_HREF)).toBe(false);
  });

  it('keeps "Pulse Talent › Timesheet" for one employee’s timesheet, supervisors included', () => {
    for (const groups of [talentReader, visibleNavigation(newUser), visibleNavigation(hr)]) {
      expect(breadcrumbFor(groups, employeeTimesheet)).toEqual({
        parent: 'Pulse Talent',
        current: 'Timesheet',
      });
    }
  });

  it('isn’t a sidebar entry, and reads "No access" without Talent Read', () => {
    expect(visibleHrefs(systemAdministrator)).not.toContain(TIMESHEETS_LIST_HREF);
    // A supervisor with no module access opens a team member's timesheet, never the list.
    for (const someone of [newUser, hr]) {
      expect(breadcrumbFor(visibleNavigation(someone), TIMESHEETS_LIST_HREF)).toEqual({
        current: NO_ACCESS_PAGE_TITLE,
      });
    }
  });
});

describe('Payroll settings (step 2.3)', () => {
  const talentReader = visibleNavigation(
    viewer({ moduleAccess: { ...emptyModuleAccess(), talent: 'read' } }),
  );

  it('reads "Pulse Talent › Payroll settings" in the breadcrumb, with Talent current', () => {
    for (const groups of [talentReader, visibleNavigation(systemAdministrator)]) {
      expect(breadcrumbFor(groups, '/talent/payroll-settings')).toEqual({
        parent: 'Pulse Talent',
        current: 'Payroll settings',
      });
      expect(activeEntry(groups, '/talent/payroll-settings')?.entry.label).toBe('Talent');
    }
    expect(breadcrumbFor(talentReader, '/talent')).toEqual({
      parent: 'Modules',
      current: 'Pulse Talent',
    });
  });

  it('isn’t a sidebar entry, and reads "No access" without Talent Read', () => {
    expect(visibleHrefs(systemAdministrator)).not.toContain('/talent/payroll-settings');
    expect(breadcrumbFor(visibleNavigation(newUser), '/talent/payroll-settings')).toEqual({
      current: NO_ACCESS_PAGE_TITLE,
    });
    expect(breadcrumbFor(visibleNavigation(hr), '/talent/payroll-settings')).toEqual({
      current: NO_ACCESS_PAGE_TITLE,
    });
  });
});

describe('Administration sub-groups', () => {
  it('has three groups in order, from one list', () => {
    expect(ADMIN_GROUPS.map((group) => group.label)).toEqual([
      'People and organization',
      'Master data',
      'System',
    ]);
  });

  it('puts every admin entry but the Overview in a group, each group’s entries together', () => {
    expect(ADMIN_ENTRIES.filter((entry) => !entry.adminGroup).map((entry) => entry.href)).toEqual([
      '/admin',
    ]);
    // The sidebar folds consecutive entries of one group: the groups must not interleave, and they
    // follow ADMIN_GROUPS order.
    const order = ADMIN_ENTRIES.flatMap((entry) => (entry.adminGroup ? [entry.adminGroup] : []));
    const runs = order.filter((key, index) => key !== order[index - 1]);
    expect(runs).toEqual(ADMIN_GROUPS.map((group) => group.key));
  });

  it('gives the System Administrator all three groups with their entries, Overview outside', () => {
    const { ungrouped, groups } = visibleAdminGroups(systemAdministrator);
    expect(ungrouped.map((entry) => entry.label)).toEqual(['Overview']);
    expect(groups.map((group) => [group.label, group.entries.map((entry) => entry.label)])).toEqual(
      [
        ['People and organization', ['Users', 'User access', 'Departments', 'Positions']],
        ['Master data', ['Clients', 'Products', 'Catalog items', 'Suppliers']],
        ['System', ['Company settings', 'Audit log']],
      ],
    );
  });

  it('gives HR only People and organization', () => {
    const { ungrouped, groups } = visibleAdminGroups(hr);
    expect(ungrouped.map((entry) => entry.href)).toEqual(['/admin']);
    expect(groups.map((group) => group.key)).toEqual(['people']);
    expect(groups[0]?.entries.map((entry) => entry.href)).toEqual(HR_ADMIN_HREFS.slice(1));
  });

  it('gives a viewer with no admin entries no groups', () => {
    for (const someone of [
      newUser,
      viewer({ roles: ['board'] }),
      viewer({ roles: ['accounting'] }),
    ]) {
      expect(visibleAdminGroups(someone)).toEqual({ ungrouped: [], groups: [] });
    }
  });

  it('groups only the entries it is given, dropping empty groups', () => {
    const picked = ADMIN_ENTRIES.filter((entry) =>
      ['/admin/clients', '/admin/audit'].includes(entry.href),
    );
    const { ungrouped, groups } = groupAdminEntries(picked);
    expect(ungrouped).toEqual([]);
    expect(groups.map((group) => [group.key, group.entries.map((entry) => entry.href)])).toEqual([
      ['masterData', ['/admin/clients']],
      ['system', ['/admin/audit']],
    ]);
  });

  it('matches the sidebar’s Administration entries for each viewer', () => {
    for (const someone of [hr, systemAdministrator]) {
      const sidebar = visibleNavigation(someone).find((group) => group.label === 'Administration');
      const { ungrouped, groups } = visibleAdminGroups(someone);
      expect([...ungrouped, ...groups.flatMap((group) => group.entries)]).toEqual(sidebar?.entries);
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

  it('names the master data pages under Administration', () => {
    expect(breadcrumbFor(adminGroups, '/admin/clients')).toEqual({
      parent: 'Administration',
      current: 'Clients',
    });
    expect(breadcrumbFor(adminGroups, '/admin/products')).toEqual({
      parent: 'Administration',
      current: 'Products',
    });
    expect(breadcrumbFor(adminGroups, '/admin/catalog-items')).toEqual({
      parent: 'Administration',
      current: 'Catalog items',
    });
    expect(breadcrumbFor(adminGroups, '/admin/suppliers')).toEqual({
      parent: 'Administration',
      current: 'Suppliers',
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
    expect(breadcrumbFor(hrGroups, '/admin/clients')).toEqual({ current: 'No access' });
    expect(breadcrumbFor(hrGroups, '/admin/catalog-items')).toEqual({ current: 'No access' });
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
