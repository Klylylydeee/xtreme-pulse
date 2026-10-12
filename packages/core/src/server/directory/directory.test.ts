import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError } from '../../actions';
import type { DirectoryPersonLink } from '../../directory';
import type { DepartmentRole } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import { getOrgChart } from './org-chart';
import {
  type DirectoryViewer,
  getDirectoryPerson,
  getOwnTeam,
  listDirectory,
  listDirectoryDepartments,
  searchSupervisorCandidates,
} from './service';

// The directory, its cards, the Home team and the org chart (docs/modules/core.md#company-directory,
// #org-chart, #home; SECURITY.md#sensitive-data; docs/TESTING.md#directory-org-chart-and-command-bar-tests).
// Made-up data only.

const PASSWORD_HASH = 'made-up-hash-that-must-never-leave';

// The allowlist: exactly these keys, and never the date hired, employment status, separation
// date, module access or password hash.
const PERSON_KEYS = [
  'departmentCode',
  'departmentId',
  'departmentName',
  'directReports',
  'email',
  'employeeNumber',
  'id',
  'inactive',
  'initials',
  'name',
  'photoUrl',
  'positionName',
  'reportingTo',
];
const CARD_KEYS = [...PERSON_KEYS, 'canEditReportingLines'].sort();
const LINK_KEYS = [
  'departmentName',
  'employeeNumber',
  'id',
  'inactive',
  'initials',
  'name',
  'photoUrl',
  'positionName',
];
const NODE_KEYS = [
  'departmentId',
  'departmentName',
  'externalSupervisors',
  'id',
  'initials',
  'name',
  'photoUrl',
  'positionName',
  'supervisorIds',
];
const FORBIDDEN = [
  'dateHired',
  'employmentStatus',
  'separationDate',
  'moduleAccess',
  'passwordHash',
  PASSWORD_HASH,
  'Regular',
  'Resigned',
];

function expectKeys(value: object, keys: string[]) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function expectLinks(links: DirectoryPersonLink[]) {
  for (const link of links) expectKeys(link, LINK_KEYS);
}

function expectNothingForbidden(value: unknown) {
  const json = JSON.stringify(value);
  for (const word of FORBIDDEN) expect(json).not.toContain(word);
}

interface Person {
  id: string;
  employeeId: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  email: string;
  employeeNumber: string;
}

let counter = 0;

async function department(name: string, code: string) {
  const created = await DepartmentModel.create({ name, code });
  const position = await PositionModel.create({
    name: `${name} Engineer`,
    departmentId: created._id,
    timesheetType: 'standard',
  });
  return { id: created._id, idHex: created._id.toHexString(), positionId: position._id };
}

let NET: Awaited<ReturnType<typeof department>>;
let SALES: Awaited<ReturnType<typeof department>>;
let BOD: Awaited<ReturnType<typeof department>>;

async function person(
  firstName: string,
  lastName: string,
  {
    dept = NET,
    status = 'Regular',
    reportingTo = [],
    account = true,
  }: {
    dept?: Awaited<ReturnType<typeof department>>;
    status?: EmploymentStatus;
    reportingTo?: Person[];
    account?: boolean;
  } = {},
): Promise<Person> {
  counter += 1;
  const employeeNumber = `${2000 + Math.floor(counter / 90)}-${String((counter % 90) + 1).padStart(2, '0')}`;
  const employee = await EmployeeModel.create({
    employeeNumber,
    firstName,
    lastName,
    departmentId: dept.id,
    positionId: dept.positionId,
    reportingTo: reportingTo.map((supervisor) => supervisor.employeeId),
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  const email = `dir${counter}@xtreme-works.com`;
  const userId = new Types.ObjectId();
  if (account) {
    await UserModel.create({
      _id: userId,
      email,
      passwordHash: PASSWORD_HASH,
      employeeId: employee._id,
      moduleAccess: { talent: 'owner' },
    });
  }
  return {
    id: employee._id.toHexString(),
    employeeId: employee._id,
    userId,
    name: `${firstName} ${lastName}`,
    email,
    employeeNumber,
  };
}

function viewer(
  roles: DepartmentRole[],
  { admin = false, as }: { admin?: boolean; as?: Person } = {},
): DirectoryViewer {
  return {
    id: (as?.userId ?? new Types.ObjectId()).toHexString(),
    employee: as ? { id: as.id } : null,
    isSystemAdministrator: admin,
    roles,
  };
}

const EMPLOYEE = viewer([]);
const HR = viewer(['hr']);
const BOARD = viewer(['board']);
const ADMIN = viewer([], { admin: true });

async function separate(p: Person) {
  await EmployeeModel.updateOne(
    { _id: p.employeeId },
    {
      $set: { employmentStatus: 'Resigned', separationDate: new Date('2024-06-01T00:00:00+08:00') },
    },
  );
}

const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id);

let systemAccountId: string;

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
  ]);
  NET = await department('Network', 'NET');
  SALES = await department('Sales', 'SALES');
  BOD = await department('Board of Directors', 'BOD');
  const system = await UserModel.create({
    email: 'system@xtreme-works.com',
    passwordHash: PASSWORD_HASH,
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  systemAccountId = system._id.toHexString();
});

describe('the directory allowlist', () => {
  it('returns exactly the directory fields in the list, a card, the team and the org chart', async () => {
    const boss = await person('Boss', 'Allow');
    const ana = await person('Ana', 'Allow', { reportingTo: [boss] });
    const report = await person('Rey', 'Allow', { reportingTo: [ana] });

    for (const who of [EMPLOYEE, HR, BOARD, ADMIN]) {
      const rows = await listDirectory(who, { search: 'Allow', separated: true });
      expect(idsOf(rows).sort()).toEqual([boss.id, ana.id, report.id].sort());
      for (const row of rows) {
        expectKeys(row, PERSON_KEYS);
        expectLinks(row.reportingTo);
        expectLinks(row.directReports);
      }
      expectNothingForbidden(rows);

      const card = await getDirectoryPerson(who, ana.id);
      if (!card) throw new Error('No card.');
      expectKeys(card, CARD_KEYS);
      expectLinks(card.reportingTo);
      expectLinks(card.directReports);
      expectNothingForbidden(card);
    }

    const team = await getOwnTeam(viewer([], { as: ana }));
    expectKeys(team, ['directReports', 'supervisors']);
    expectLinks(team.supervisors);
    expectLinks(team.directReports);
    expectNothingForbidden(team);

    const nodes = await getOrgChart();
    for (const node of nodes) expectKeys(node, NODE_KEYS);
    expectNothingForbidden(nodes);
  });

  it('shows the name, initials, number, department, position, email and lines', async () => {
    const boss = await person('Bella', 'Shape');
    const ana = await person('ana', 'shape', { reportingTo: [boss] });
    const [row] = await listDirectory(EMPLOYEE, { search: ana.employeeNumber });
    expect(row).toEqual({
      id: ana.id,
      name: 'ana shape',
      initials: 'AS',
      photoUrl: null,
      employeeNumber: ana.employeeNumber,
      departmentId: NET.idHex,
      departmentName: 'Network',
      departmentCode: 'NET',
      positionName: 'Network Engineer',
      email: ana.email,
      reportingTo: [
        {
          id: boss.id,
          name: 'Bella Shape',
          initials: 'BS',
          photoUrl: null,
          employeeNumber: boss.employeeNumber,
          departmentName: 'Network',
          positionName: 'Network Engineer',
          inactive: false,
        },
      ],
      directReports: [],
      inactive: false,
    });
  });
});

describe('profile photos in the directory', () => {
  it('carries the current photo as its file route URL in rows, links, cards, the team and the org chart', async () => {
    const boss = await person('Pia', 'Pictured');
    const ana = await person('Ana', 'Pictured', { reportingTo: [boss] });
    const photoFileId = new Types.ObjectId();
    const url = `/files/${photoFileId.toHexString()}?inline=1`;
    await EmployeeModel.updateOne({ _id: boss.id }, { $set: { photoFileId } });

    const rows = await listDirectory(EMPLOYEE, { search: 'Pictured' });
    expect(rows.find((row) => row.id === boss.id)?.photoUrl).toBe(url);
    expect(rows.find((row) => row.id === ana.id)?.photoUrl).toBeNull();
    expect(rows.find((row) => row.id === ana.id)?.reportingTo[0]?.photoUrl).toBe(url);
    expect((await getDirectoryPerson(EMPLOYEE, boss.id))?.photoUrl).toBe(url);
    expect((await getOwnTeam(viewer([], { as: ana }))).supervisors[0]?.photoUrl).toBe(url);
    expect((await getOrgChart()).find((node) => node.id === boss.id)?.photoUrl).toBe(url);
  });
});

describe('directory visibility', () => {
  it('lists active people only; separated ones only for HR and System Administrators who ask', async () => {
    const active = await person('Ann', 'Visible');
    const gone = await person('Gil', 'Visible', { status: 'Resigned' });
    const noAccount = await person('Ned', 'Visible', { account: false });

    for (const who of [EMPLOYEE, HR, BOARD, ADMIN]) {
      expect(idsOf(await listDirectory(who, { search: 'Visible' }))).toEqual([active.id]);
    }
    // The flag is ignored for anyone else, Board members included.
    for (const who of [EMPLOYEE, BOARD]) {
      expect(idsOf(await listDirectory(who, { search: 'Visible', separated: true }))).toEqual([
        active.id,
      ]);
    }
    for (const who of [HR, ADMIN]) {
      const rows = await listDirectory(who, { search: 'Visible', separated: true });
      expect(idsOf(rows)).toEqual([active.id, gone.id, noAccount.id]);
      expect(rows.map((row) => row.inactive)).toEqual([false, true, true]);
    }
  });

  it('answers a separated person’s card like a missing one for anyone but HR and System Administrators', async () => {
    const gone = await person('Gia', 'Card', { status: 'Resigned' });
    for (const who of [EMPLOYEE, BOARD]) {
      expect(await getDirectoryPerson(who, gone.id)).toBeNull();
      expect(await getDirectoryPerson(who, new Types.ObjectId().toHexString())).toBeNull();
    }
    for (const who of [HR, ADMIN]) {
      const card = await getDirectoryPerson(who, gone.id);
      expect(card).toMatchObject({ id: gone.id, inactive: true, canEditReportingLines: false });
    }
    expect(await getDirectoryPerson(ADMIN, 'not-an-id')).toBeNull();
  });

  it('never shows the bootstrap system account', async () => {
    for (const who of [EMPLOYEE, HR, ADMIN]) {
      const rows = await listDirectory(who, { separated: true });
      expect(rows.some((row) => row.email === 'system@xtreme-works.com')).toBe(false);
      expect(idsOf(rows)).not.toContain(systemAccountId);
      expect(await getDirectoryPerson(who, systemAccountId)).toBeNull();
    }
    expect(idsOf(await getOrgChart())).not.toContain(systemAccountId);
  });

  it('searches on name, employee number and email, filters by department, and sorts by last name', async () => {
    const zed = await person('Zed', 'Alpha', { dept: SALES });
    const amy = await person('Amy', 'Bravo', { dept: SALES });
    const bob = await person('Bob', 'Alpha', { dept: SALES });
    const other = await person('Oli', 'Alpha');

    expect(idsOf(await listDirectory(EMPLOYEE, { departmentId: SALES.idHex }))).toEqual([
      bob.id,
      zed.id,
      amy.id,
    ]);
    expect(
      idsOf(await listDirectory(EMPLOYEE, { search: 'alpha', departmentId: SALES.idHex })),
    ).toEqual([bob.id, zed.id]);
    expect(idsOf(await listDirectory(EMPLOYEE, { search: 'zed alpha' }))).toEqual([zed.id]);
    expect(idsOf(await listDirectory(EMPLOYEE, { search: amy.employeeNumber }))).toEqual([amy.id]);
    expect(idsOf(await listDirectory(EMPLOYEE, { search: other.email.toUpperCase() }))).toEqual([
      other.id,
    ]);
    expect(await listDirectory(EMPLOYEE, { departmentId: 'not-an-id' })).toEqual([]);
  });

  it('shows an inactive supervisor on a card only to HR, Board members and System Administrators', async () => {
    const boss = await person('Boss', 'Lines');
    const later = await person('Later', 'Lines');
    const ana = await person('Ana', 'Lines', { reportingTo: [later, boss] });
    await separate(later);

    for (const who of [HR, BOARD, ADMIN]) {
      const card = await getDirectoryPerson(who, ana.id);
      expect(card?.reportingTo.map((s) => [s.id, s.inactive])).toEqual([
        [later.id, true],
        [boss.id, false],
      ]);
    }
    const card = await getDirectoryPerson(EMPLOYEE, ana.id);
    expect(card?.reportingTo.map((s) => s.id)).toEqual([boss.id]);
    // The list shows active supervisors only, for everyone.
    const [row] = await listDirectory(HR, { search: ana.employeeNumber });
    expect(row?.reportingTo.map((s) => s.id)).toEqual([boss.id]);
  });

  it('lists active direct reports on the card', async () => {
    const boss = await person('Boss', 'Reports');
    const one = await person('Una', 'Reports', { reportingTo: [boss] });
    const two = await person('Two', 'Reports', { reportingTo: [boss], status: 'Resigned' });
    const card = await getDirectoryPerson(EMPLOYEE, boss.id);
    expect(card?.directReports.map((r) => r.id)).toEqual([one.id]);
    expect(card?.directReports.map((r) => r.id)).not.toContain(two.id);
  });

  it('lets editors edit someone else’s lines, never their own or a separated person’s', async () => {
    const ana = await person('Ana', 'Editable');
    const hrSelf = await person('Hana', 'Editable');
    const gone = await person('Gus', 'Editable', { status: 'Resigned' });

    for (const who of [HR, BOARD, ADMIN]) {
      expect((await getDirectoryPerson(who, ana.id))?.canEditReportingLines).toBe(true);
    }
    expect((await getDirectoryPerson(EMPLOYEE, ana.id))?.canEditReportingLines).toBe(false);
    expect(
      (await getDirectoryPerson(viewer(['hr'], { as: hrSelf }), hrSelf.id))?.canEditReportingLines,
    ).toBe(false);
    expect((await getDirectoryPerson(HR, gone.id))?.canEditReportingLines).toBe(false);
  });

  it('offers the live departments for the filter', async () => {
    const names = (await listDirectoryDepartments()).map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Board of Directors', 'Network', 'Sales']));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('the Home team', () => {
  it('returns the user’s active supervisors and active direct reports only', async () => {
    const boss = await person('Boss', 'Team');
    const goneBoss = await person('Gone', 'Team');
    const me = await person('Me', 'Team', { reportingTo: [goneBoss, boss] });
    const report = await person('Rita', 'Team', { reportingTo: [me] });
    const goneReport = await person('Ron', 'Team', { reportingTo: [me], status: 'Resigned' });
    await separate(goneBoss);

    const team = await getOwnTeam(viewer([], { as: me }));
    expect(idsOf(team.supervisors)).toEqual([boss.id]);
    expect(idsOf(team.directReports)).toEqual([report.id]);
    expect(idsOf(team.directReports)).not.toContain(goneReport.id);
  });

  it('is empty for the bootstrap system account', async () => {
    expect(await getOwnTeam({ ...ADMIN, id: systemAccountId, employee: null })).toEqual({
      supervisors: [],
      directReports: [],
    });
  });
});

describe('the org chart', () => {
  it('shows an employee with two supervisors as one node with two lines (the step’s "Done when")', async () => {
    const first = await person('First', 'Chart');
    const second = await person('Second', 'Chart');
    const ana = await person('Ana', 'Chart', { reportingTo: [first, second] });
    const nodes = (await getOrgChart()).filter((node) => node.id === ana.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.supervisorIds).toEqual([first.id, second.id]);
    expect(nodes[0]).toMatchObject({
      name: 'Ana Chart',
      initials: 'AC',
      positionName: 'Network Engineer',
      departmentName: 'Network',
      externalSupervisors: [],
    });
  });

  it('leaves out separated people and lines to them; a person with none left sits at the top', async () => {
    const gone = await person('Gone', 'Top');
    const ana = await person('Ana', 'Top', { reportingTo: [gone] });
    const separated = await person('Sep', 'Top', { status: 'Resigned' });
    await separate(gone);

    const nodes = await getOrgChart();
    expect(idsOf(nodes)).not.toContain(gone.id);
    expect(idsOf(nodes)).not.toContain(separated.id);
    expect(nodes.find((node) => node.id === ana.id)?.supervisorIds).toEqual([]);
    // Every line points to a shown node.
    const shown = new Set(idsOf(nodes));
    for (const node of nodes) for (const id of node.supervisorIds) expect(shown.has(id)).toBe(true);
  });

  it('filters by department: its members, the lines among them, and the names of supervisors outside it', async () => {
    const director = await person('Dora', 'Filter', { dept: BOD });
    const lead = await person('Lea', 'Filter', { dept: SALES, reportingTo: [director] });
    const rep = await person('Rex', 'Filter', { dept: SALES, reportingTo: [lead, director] });
    const outsider = await person('Oto', 'Filter', { reportingTo: [lead] });

    const nodes = await getOrgChart({ departmentId: SALES.idHex });
    expect(nodes.every((node) => node.departmentId === SALES.idHex)).toBe(true);
    expect(idsOf(nodes)).not.toContain(outsider.id);
    expect(idsOf(nodes)).not.toContain(director.id);
    const leadNode = nodes.find((node) => node.id === lead.id);
    expect(leadNode).toMatchObject({
      supervisorIds: [],
      externalSupervisors: [{ id: director.id, name: 'Dora Filter' }],
    });
    const repNode = nodes.find((node) => node.id === rep.id);
    expect(repNode).toMatchObject({
      supervisorIds: [lead.id],
      externalSupervisors: [{ id: director.id, name: 'Dora Filter' }],
    });
    expect(await getOrgChart({ departmentId: 'not-an-id' })).toEqual([]);
  });
});

describe('the inspector’s supervisor search', () => {
  it('is for the editors only, finds active people, and leaves out the person being edited', async () => {
    const ana = await person('Ana', 'Picker');
    const ben = await person('Ben', 'Picker');
    await person('Gone', 'Picker', { status: 'Resigned' });

    await expect(searchSupervisorCandidates(EMPLOYEE, { search: 'Picker' })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    for (const who of [HR, BOARD, ADMIN]) {
      const found = await searchSupervisorCandidates(who, {
        search: 'Picker',
        excludeEmployeeId: ana.id,
      });
      expect(found).toEqual([
        {
          id: ben.id,
          name: 'Ben Picker',
          employeeNumber: ben.employeeNumber,
          departmentName: 'Network',
        },
      ]);
    }
  });
});
