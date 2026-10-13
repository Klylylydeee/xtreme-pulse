import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '../../module-access';
import { reloadActorAccess } from '../auth/administrators';
import { DepartmentModel } from '../departments/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import {
  employeeAuditLabel,
  getEmployeeIdentity,
  getSensitiveSubject,
  type IdentityActor,
  listDirectReportIdentities,
  listEmployeeIdentities,
  toDirectoryIdentity,
} from './identity';
import { EmployeeModel } from './model';

// The identity service (docs/modules/core.md#people-data-ownership,
// docs/TESTING.md#employee-record-tests). Made-up data only.

const PASSWORD_HASH = 'made-up-hash-that-must-never-leave';

const IDENTITY_KEYS = [
  'active',
  'dateHired',
  'department',
  'email',
  'employeeId',
  'employeeNumber',
  'employmentStatus',
  'firstName',
  'lastName',
  'middleName',
  'photoUrl',
  'position',
  'reportingTo',
  'separated',
  'separationDate',
  'userId',
].sort();

interface Person {
  id: string;
  employeeId: Types.ObjectId;
  userId: Types.ObjectId;
  employeeNumber: string;
}

let counter = 0;
let NET: { id: Types.ObjectId; positionId: Types.ObjectId };
let HRD: { id: Types.ObjectId; positionId: Types.ObjectId };

async function department(name: string, code: string) {
  const created = await DepartmentModel.create({ name, code });
  const position = await PositionModel.create({
    name: `${name} Specialist`,
    departmentId: created._id,
    timesheetType: 'overtime',
  });
  return { id: created._id, positionId: position._id };
}

async function person(
  firstName: string,
  lastName: string,
  {
    dept = NET,
    status = 'Regular',
    reportingTo = [],
    moduleAccess = {},
  }: {
    dept?: typeof NET;
    status?: EmploymentStatus;
    reportingTo?: Person[];
    moduleAccess?: Partial<ModuleAccess>;
  } = {},
): Promise<Person> {
  counter += 1;
  const employeeNumber = `2025-${String(counter).padStart(2, '0')}`;
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
  const userId = new Types.ObjectId();
  await UserModel.create({
    _id: userId,
    email: `identity${counter}@xtreme-works.com`,
    passwordHash: PASSWORD_HASH,
    employeeId: employee._id,
    moduleAccess,
  });
  return { id: employee._id.toHexString(), employeeId: employee._id, userId, employeeNumber };
}

function actor(moduleAccess: ModuleAccess, as: Person | null = null): IdentityActor {
  return { moduleAccess, employee: as ? { id: as.id } : null };
}

function withTalent(level: 'read' | 'write' | 'owner', as: Person | null = null): IdentityActor {
  return actor({ ...emptyModuleAccess(), talent: level }, as);
}

let boss: Person;
let worker: Person;
let leaver: Person;
let hrPerson: Person;
let systemAccountId: Types.ObjectId;

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
  ]);
  NET = await department('Network', 'NET');
  HRD = await department('Human Resource', 'HR');
  boss = await person('Bea', 'Alonzo');
  worker = await person('Carlo', 'Bautista', { reportingTo: [boss] });
  leaver = await person('Dina', 'Cruz', { status: 'Resigned' });
  hrPerson = await person('Elmer', 'Dizon', { dept: HRD });
  systemAccountId = new Types.ObjectId();
  await UserModel.create({
    _id: systemAccountId,
    email: 'sysadmin@xtreme-works.com',
    passwordHash: PASSWORD_HASH,
    isSystemAccount: true,
    isSystemAdministrator: true,
    employeeId: null,
  });
});

describe('listEmployeeIdentities', () => {
  it('gives Talent Read every active employee, with exactly the listed keys', async () => {
    const rows = await listEmployeeIdentities(withTalent('read'));
    expect(rows.map((row) => row.employeeId)).toEqual([boss.id, worker.id, hrPerson.id]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(IDENTITY_KEYS);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(PASSWORD_HASH);
    expect(json).not.toContain('moduleAccess');
    expect(json).not.toContain('sysadmin@');
    const carlo = rows.find((row) => row.employeeId === worker.id);
    expect(carlo).toMatchObject({
      userId: worker.userId.toHexString(),
      employeeNumber: worker.employeeNumber,
      firstName: 'Carlo',
      middleName: null,
      lastName: 'Bautista',
      department: { name: 'Network', code: 'NET' },
      position: { name: 'Network Specialist', timesheetType: 'overtime' },
      reportingTo: [{ id: boss.id, name: 'Bea Alonzo' }],
      employmentStatus: 'Regular',
      dateHired: '2024-01-01',
      separationDate: null,
      separated: false,
      active: true,
      photoUrl: null,
    });
  });

  it('carries the current profile photo as its file route URL', async () => {
    const photoFileId = new Types.ObjectId();
    await EmployeeModel.updateOne({ _id: boss.employeeId }, { $set: { photoFileId } });
    const rows = await listEmployeeIdentities(withTalent('read'));
    expect(rows.find((row) => row.employeeId === boss.id)?.photoUrl).toBe(
      `/files/${photoFileId.toHexString()}?inline=1`,
    );
    await EmployeeModel.updateOne({ _id: boss.employeeId }, { $set: { photoFileId: null } });
  });

  it('shows separated employees only when asked, and only with Talent Read', async () => {
    const asked = await listEmployeeIdentities(withTalent('read'), { separated: true });
    expect(asked.map((row) => row.employeeId)).toContain(leaver.id);
    const separated = asked.find((row) => row.employeeId === leaver.id);
    expect(separated).toMatchObject({
      separated: true,
      active: false,
      separationDate: '2024-06-01',
    });

    const notAsked = await listEmployeeIdentities(withTalent('read'));
    expect(notAsked.map((row) => row.employeeId)).not.toContain(leaver.id);

    const own = await listEmployeeIdentities(actor(emptyModuleAccess(), worker), {
      separated: true,
    });
    expect(own.map((row) => row.employeeId)).toEqual([worker.id]);
  });

  it('gives Talent None only the own identity, and refuses someone with neither', async () => {
    const own = await listEmployeeIdentities(actor(emptyModuleAccess(), worker));
    expect(own.map((row) => row.employeeId)).toEqual([worker.id]);
    await expect(listEmployeeIdentities(actor(emptyModuleAccess()))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('filters by search, department and status', async () => {
    const reader = withTalent('read');
    const byName = await listEmployeeIdentities(reader, { q: 'carlo baut' });
    expect(byName.map((row) => row.employeeId)).toEqual([worker.id]);
    const byNumber = await listEmployeeIdentities(reader, { q: hrPerson.employeeNumber });
    expect(byNumber.map((row) => row.employeeId)).toEqual([hrPerson.id]);
    const byDepartment = await listEmployeeIdentities(reader, {
      departmentId: HRD.id.toHexString(),
    });
    expect(byDepartment.map((row) => row.employeeId)).toEqual([hrPerson.id]);
    const resigned = await listEmployeeIdentities(reader, { status: 'Resigned' });
    expect(resigned).toEqual([]);
    const resignedAsked = await listEmployeeIdentities(reader, {
      status: 'Resigned',
      separated: true,
    });
    expect(resignedAsked.map((row) => row.employeeId)).toEqual([leaver.id]);
    expect(await listEmployeeIdentities(reader, { departmentId: 'not-an-id' })).toEqual([]);
  });

  it('never lists the system account, even for a System Administrator', async () => {
    const rows = await listEmployeeIdentities(actor(fullModuleAccess()), { separated: true });
    expect(rows.map((row) => row.userId)).not.toContain(systemAccountId.toHexString());
    expect(rows).toHaveLength(4);
  });
});

describe('getEmployeeIdentity', () => {
  it('needs Talent Read, or the own employee', async () => {
    const read = await getEmployeeIdentity(withTalent('read'), worker.id);
    expect(read?.employeeId).toBe(worker.id);
    expect(Object.keys(read ?? {}).sort()).toEqual(IDENTITY_KEYS);

    const own = await getEmployeeIdentity(actor(emptyModuleAccess(), worker), worker.id);
    expect(own?.employeeId).toBe(worker.id);

    await expect(
      getEmployeeIdentity(actor(emptyModuleAccess(), worker), boss.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getEmployeeIdentity(actor(emptyModuleAccess()), boss.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('returns a separated employee only when asked, with Talent Read', async () => {
    expect(await getEmployeeIdentity(withTalent('read'), leaver.id)).toBeNull();
    const asked = await getEmployeeIdentity(withTalent('read'), leaver.id, { separated: true });
    expect(asked?.employeeId).toBe(leaver.id);
  });

  it('answers null for an unknown or malformed id', async () => {
    expect(
      await getEmployeeIdentity(withTalent('read'), new Types.ObjectId().toHexString()),
    ).toBeNull();
    expect(await getEmployeeIdentity(withTalent('read'), 'nope')).toBeNull();
  });
});

describe('getSensitiveSubject and employeeAuditLabel', () => {
  it('returns only the employee id and current department code', async () => {
    const subject = await getSensitiveSubject(hrPerson.id);
    expect(subject).toEqual({ employeeId: hrPerson.id, departmentCode: 'HR' });
    expect(await getSensitiveSubject(new Types.ObjectId())).toBeNull();
    expect(await getSensitiveSubject('nope')).toBeNull();
  });

  it('follows a department change', async () => {
    const mover = await person('Fe', 'Estrada');
    expect((await getSensitiveSubject(mover.id))?.departmentCode).toBe('NET');
    await EmployeeModel.updateOne({ _id: mover.employeeId }, { $set: { departmentId: HRD.id } });
    expect((await getSensitiveSubject(mover.id))?.departmentCode).toBe('HR');
  });

  it('labels the employee by number and name', async () => {
    expect(await employeeAuditLabel(worker.id)).toEqual({
      employeeNumber: worker.employeeNumber,
      name: 'Carlo Bautista',
    });
    expect(await employeeAuditLabel(new Types.ObjectId())).toBeNull();
  });
});

describe('reloadActorAccess', () => {
  it('gives the actor as they are now, with their employee and effective access', async () => {
    const reader = await person('Gina', 'Flores', { moduleAccess: { talent: 'write' } });
    const reloaded = await withTransaction((session) =>
      reloadActorAccess({ id: reader.userId.toHexString() }, session),
    );
    expect(reloaded.employee).toEqual({ id: reader.id, departmentCode: 'NET' });
    expect(reloaded.moduleAccess.talent).toBe('write');
    expect(reloaded.roles).toEqual([]);

    await EmployeeModel.updateOne(
      { _id: reader.employeeId },
      {
        $set: {
          employmentStatus: 'Resigned',
          separationDate: new Date('2024-06-01T00:00:00+08:00'),
        },
      },
    );
    await expect(
      withTransaction((session) => reloadActorAccess({ id: reader.userId.toHexString() }, session)),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe('supervisors (build step 2.4)', () => {
  const DIRECTORY_KEYS = [
    'department',
    'email',
    'employeeId',
    'employeeNumber',
    'firstName',
    'lastName',
    'middleName',
    'photoUrl',
    'position',
    'reportingTo',
  ].sort();

  let lead: Person;
  let otherLead: Person;
  let report: Person;
  let sharedReport: Person;
  let separatedReport: Person;
  let movedReport: Person;
  let stranger: Person;

  beforeAll(async () => {
    lead = await person('Hilda', 'Garcia');
    otherLead = await person('Ivan', 'Herrera');
    report = await person('Jose', 'Ilagan', { reportingTo: [lead] });
    sharedReport = await person('Karen', 'Jimenez', { reportingTo: [otherLead, lead] });
    separatedReport = await person('Lito', 'Katigbak', { status: 'Resigned', reportingTo: [lead] });
    movedReport = await person('Mara', 'Lopez', { reportingTo: [lead] });
    await EmployeeModel.updateOne(
      { _id: movedReport.employeeId },
      { $set: { reportingTo: [otherLead.employeeId] } },
    );
    stranger = await person('Nilo', 'Mendoza');
  });

  it('lets a supervisor without module access read an active direct report', async () => {
    const supervisor = actor(emptyModuleAccess(), lead);
    const read = await getEmployeeIdentity(supervisor, report.id);
    expect(read?.employeeId).toBe(report.id);
    expect(read?.reportingTo).toEqual([{ id: lead.id, name: 'Hilda Garcia' }]);
    const shared = await getEmployeeIdentity(supervisor, sharedReport.id);
    expect(shared?.employeeId).toBe(sharedReport.id);
  });

  it('refuses a non-report, a separated report and a report whose line was removed', async () => {
    const supervisor = actor(emptyModuleAccess(), lead);
    for (const target of [stranger, separatedReport, movedReport, otherLead]) {
      await expect(getEmployeeIdentity(supervisor, target.id)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        getEmployeeIdentity(supervisor, target.id, { separated: true }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    }
    // A report doesn't read their supervisor, and a missing or malformed id is refused, not null.
    await expect(
      getEmployeeIdentity(actor(emptyModuleAccess(), report), lead.id),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      getEmployeeIdentity(supervisor, new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getEmployeeIdentity(supervisor, 'nope')).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('keeps the full identity on the server and cuts it to exactly the directory keys', async () => {
    const read = await getEmployeeIdentity(actor(emptyModuleAccess(), lead), report.id);
    expect(read).not.toBeNull();
    if (!read) return;
    expect(Object.keys(read).sort()).toEqual(IDENTITY_KEYS);
    const sent = toDirectoryIdentity(read);
    expect(Object.keys(sent).sort()).toEqual(DIRECTORY_KEYS);
    expect(Object.keys(sent.department ?? {}).sort()).toEqual(['code', 'id', 'name']);
    expect(Object.keys(sent.position ?? {}).sort()).toEqual(['id', 'name']);
    for (const row of sent.reportingTo) expect(Object.keys(row).sort()).toEqual(['id', 'name']);
    const json = JSON.stringify(sent);
    expect(json).not.toContain('2024-01-01');
    expect(json).not.toContain('Regular');
    expect(json).not.toContain(PASSWORD_HASH);
    expect(json).not.toContain(report.userId.toHexString());
    expect(sent).toMatchObject({
      employeeId: report.id,
      employeeNumber: report.employeeNumber,
      firstName: 'Jose',
      lastName: 'Ilagan',
      department: { name: 'Network', code: 'NET' },
      position: { name: 'Network Specialist' },
      reportingTo: [{ id: lead.id, name: 'Hilda Garcia' }],
    });
  });

  it('lists only the active direct reports, by last name', async () => {
    const rows = await listDirectReportIdentities(actor(emptyModuleAccess(), lead));
    expect(rows.map((row) => row.employeeId)).toEqual([report.id, sharedReport.id]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(IDENTITY_KEYS);
    const others = await listDirectReportIdentities(actor(emptyModuleAccess(), otherLead));
    expect(others.map((row) => row.employeeId)).toEqual([sharedReport.id, movedReport.id]);
    expect(await listDirectReportIdentities(actor(emptyModuleAccess(), stranger))).toEqual([]);
    // Talent Read doesn't widen the list, and an actor without an employee has none.
    const reader = await listDirectReportIdentities(withTalent('read', lead));
    expect(reader.map((row) => row.employeeId)).toEqual([report.id, sharedReport.id]);
    expect(await listDirectReportIdentities(actor(fullModuleAccess()))).toEqual([]);
  });

  it('leaves Talent Read as it was', async () => {
    const reader = withTalent('read', lead);
    expect((await getEmployeeIdentity(reader, stranger.id))?.employeeId).toBe(stranger.id);
    expect(await getEmployeeIdentity(reader, separatedReport.id)).toBeNull();
    const asked = await getEmployeeIdentity(reader, separatedReport.id, { separated: true });
    expect(asked?.employeeId).toBe(separatedReport.id);
    expect(Object.keys(asked ?? {}).sort()).toEqual(IDENTITY_KEYS);
    expect(
      await getEmployeeIdentity(withTalent('read'), new Types.ObjectId().toHexString()),
    ).toBeNull();
  });
});
