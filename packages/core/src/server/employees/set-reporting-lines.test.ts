import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { OWN_REPORTING_LINES, reportingLinesChangedMessage } from '../../directory';
import { AuditLogModel } from '../audit/model';
import { canEditReportingLines, type DepartmentRole } from '../auth/roles';
import { NotificationModel } from '../notifications/model';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';
import { type ReportingLineActor, setReportingLines } from './reporting-lines';

// Reporting line edits in the directory and org chart inspector (docs/modules/core.md#reporting-lines,
// decisions 137–141 in docs/BUILD_PLAN.md, docs/TESTING.md#directory-org-chart-and-command-bar-tests).
// Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

interface Person {
  employeeId: Types.ObjectId;
  userId: Types.ObjectId;
  id: string;
  name: string;
  employeeNumber: string;
}

let counter = 0;

async function person(
  firstName: string,
  {
    status = 'Regular',
    reportingTo = [],
    account = true,
  }: { status?: EmploymentStatus; reportingTo?: Person[]; account?: boolean } = {},
): Promise<Person> {
  counter += 1;
  const lastName = `Lines${counter}`;
  const employee = await EmployeeModel.create({
    employeeNumber: `${2000 + Math.floor(counter / 90)}-${String((counter % 90) + 1).padStart(2, '0')}`,
    firstName,
    lastName,
    departmentId: new Types.ObjectId(),
    positionId: new Types.ObjectId(),
    reportingTo: reportingTo.map((supervisor) => supervisor.employeeId),
    employmentStatus: status,
    dateHired: new Date('2025-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2025-06-01T00:00:00+08:00'),
  });
  const userId = new Types.ObjectId();
  if (account) {
    await UserModel.create({
      _id: userId,
      email: `lines${counter}@xtreme-works.com`,
      passwordHash: 'not-a-real-hash',
      employeeId: employee._id,
    });
  }
  return {
    employeeId: employee._id,
    userId,
    id: employee._id.toHexString(),
    name: `${firstName} ${lastName}`,
    employeeNumber: employee.employeeNumber,
  };
}

/** An actor with `roles`; with `as`, signed in as that person's account. */
function actor(
  roles: DepartmentRole[],
  { admin = false, as }: { admin?: boolean; as?: Person } = {},
): ReportingLineActor {
  return {
    id: (as?.userId ?? new Types.ObjectId()).toHexString(),
    email: 'editor@xtreme-works.com',
    isSystemAdministrator: admin,
    roles,
  };
}

const HR = actor(['hr']);
const BOARD = actor(['board']);
const ADMIN = actor([], { admin: true });

async function linesOf(p: Person): Promise<string[]> {
  const employee = await EmployeeModel.findById(p.employeeId).lean().orFail();
  return employee.reportingTo.map((id) => id.toHexString());
}

const ids = (...people: Person[]) => people.map((p) => p.id);

function save(
  editor: ReportingLineActor,
  subject: Person,
  supervisors: Person[],
  expected?: string[],
) {
  return (async () =>
    setReportingLines(editor, subject.id, {
      supervisorIds: ids(...supervisors),
      expected: expected ?? (await linesOf(subject)),
    }))();
}

async function entriesFor(p: Person) {
  return AuditLogModel.find({ 'record.id': p.employeeId }).sort({ _id: 1 }).lean();
}

let systemAccountId: Types.ObjectId;

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
    NotificationModel.init(),
  ]);
  const system = await UserModel.create({
    email: 'system@xtreme-works.com',
    passwordHash: 'not-a-real-hash',
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  systemAccountId = system._id;
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('canEditReportingLines', () => {
  it('is HR, the Board and System Administrators only', () => {
    expect(canEditReportingLines(HR)).toBe(true);
    expect(canEditReportingLines(BOARD)).toBe(true);
    expect(canEditReportingLines(ADMIN)).toBe(true);
    expect(canEditReportingLines(actor([]))).toBe(false);
    expect(canEditReportingLines(actor(['accounting']))).toBe(false);
  });
});

describe('who may save', () => {
  it.each([
    ['HR', HR],
    ['a Board member', BOARD],
    ['a System Administrator', ADMIN],
  ])(
    '%s can save, with one update entry on core.employee and no notification',
    async (_, editor) => {
      const boss = await person('Boss');
      const ana = await person('Ana');
      const notificationsBefore = await NotificationModel.countDocuments();

      expect(await save(editor, ana, [boss])).toEqual({ changed: true });

      expect(await linesOf(ana)).toEqual(ids(boss));
      const entries = await entriesFor(ana);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        module: 'core',
        action: 'update',
        actorEmail: editor.email,
        record: { type: 'core.employee', label: `${ana.employeeNumber} · ${ana.name}` },
      });
      expect(entries[0]?.before).toMatchObject({ reportingTo: [] });
      expect(entries[0]?.after).toMatchObject({ reportingTo: ids(boss) });
      expect(await NotificationModel.countDocuments()).toBe(notificationsBefore);
    },
  );

  it.each([
    ['an employee with no role', actor([])],
    ['Accounting', actor(['accounting'])],
  ])('%s is refused and nothing changes', async (_, editor) => {
    const boss = await person('Boss');
    const ana = await person('Ana');
    await expect(save(editor, ana, [boss])).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await linesOf(ana)).toEqual([]);
    expect(await entriesFor(ana)).toHaveLength(0);
  });

  it('a Board member may edit HR staff’s and System Administrators’ lines', async () => {
    const boss = await person('Boss');
    const hrStaff = await person('Hana');
    await UserModel.updateOne({ _id: hrStaff.userId }, { $set: { isSystemAdministrator: true } });
    expect(await save(BOARD, hrStaff, [boss])).toEqual({ changed: true });
    expect(await linesOf(hrStaff)).toEqual(ids(boss));
  });
});

describe('what can’t be edited', () => {
  it('refuses the actor’s own lines, for every editor', async () => {
    const boss = await person('Boss');
    const self = await person('Self');
    for (const roles of [['hr'], ['board']] as DepartmentRole[][]) {
      await expect(save(actor(roles, { as: self }), self, [boss])).rejects.toMatchObject({
        name: 'AccessDeniedError',
        message: OWN_REPORTING_LINES,
      });
    }
    await expect(save(actor([], { admin: true, as: self }), self, [boss])).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    expect(await linesOf(self)).toEqual([]);
  });

  it('refuses the system account', async () => {
    const boss = await person('Boss');
    await expect(
      setReportingLines(ADMIN, systemAccountId.toHexString(), {
        supervisorIds: ids(boss),
        expected: [],
      }),
    ).rejects.toMatchObject({
      name: 'ActionError',
      message: 'The system account has no reporting lines.',
    });
  });

  it('refuses a separated employee, and one with no account', async () => {
    const boss = await person('Boss');
    const gone = await person('Gone', { status: 'Resigned' });
    await expect(save(HR, gone, [boss])).rejects.toMatchObject({
      name: 'ActionError',
      message: expect.stringContaining('no longer active'),
    });
    const noAccount = await person('Nobody', { account: false });
    await expect(save(HR, noAccount, [boss])).rejects.toBeInstanceOf(ActionError);
    expect(await linesOf(gone)).toEqual([]);
  });

  it('refuses someone who doesn’t exist', async () => {
    await expect(
      setReportingLines(HR, new Types.ObjectId().toHexString(), {
        supervisorIds: [],
        expected: [],
      }),
    ).rejects.toThrow('This person no longer exists.');
    await expect(
      setReportingLines(HR, 'not-an-id', { supervisorIds: [], expected: [] }),
    ).rejects.toThrow('This person no longer exists.');
  });
});

describe('the stale form', () => {
  it('is refused when the stored lines differ from the ones the inspector opened with', async () => {
    const first = await person('First');
    const second = await person('Second');
    const ana = await person('Ana', { reportingTo: [first] });
    const opened = await linesOf(ana);
    // Someone else saves in between.
    await save(HR, ana, [second]);
    await expect(save(BOARD, ana, [first, second], opened)).rejects.toMatchObject({
      name: 'ActionError',
      message: reportingLinesChangedMessage(ana.name),
    });
    expect(await linesOf(ana)).toEqual(ids(second));
  });

  it('counts the order', async () => {
    const first = await person('First');
    const second = await person('Second');
    const ana = await person('Ana', { reportingTo: [first, second] });
    await expect(save(HR, ana, [first], ids(second, first))).rejects.toThrow(
      'Someone else changed',
    );
  });
});

describe('the checks of step 1.5', () => {
  it('refuses a cycle', async () => {
    const top = await person('Top');
    const middle = await person('Middle', { reportingTo: [top] });
    const bottom = await person('Bottom', { reportingTo: [middle] });
    await expect(save(HR, top, [bottom])).rejects.toMatchObject({
      field: 'reportingTo',
      message: expect.stringContaining('loop'),
    });
    expect(await linesOf(top)).toEqual([]);
  });

  it('refuses an inactive new supervisor, themselves and a repeat', async () => {
    const gone = await person('Gone', { status: 'Resigned' });
    const boss = await person('Boss');
    const ana = await person('Ana');
    await expect(save(HR, ana, [gone])).rejects.toMatchObject({
      field: 'reportingTo',
      message: expect.stringContaining('isn’t an active employee'),
    });
    await expect(save(HR, ana, [ana])).rejects.toMatchObject({ field: 'reportingTo' });
    await expect(save(HR, ana, [boss, boss])).rejects.toMatchObject({ field: 'reportingTo' });
    expect(await linesOf(ana)).toEqual([]);
  });

  it('keeps an inactive line when the edit only removes or reorders', async () => {
    const boss = await person('Boss');
    const later = await person('Later');
    const ana = await person('Ana', { reportingTo: [later, boss] });
    await EmployeeModel.updateOne(
      { _id: later.employeeId },
      {
        $set: {
          employmentStatus: 'Resigned',
          separationDate: new Date('2025-06-01T00:00:00+08:00'),
        },
      },
    );
    expect(await save(HR, ana, [boss, later])).toEqual({ changed: true });
    expect(await linesOf(ana)).toEqual(ids(boss, later));
    expect(await save(HR, ana, [later])).toEqual({ changed: true });
    expect(await linesOf(ana)).toEqual(ids(later));
    // Adding someone runs the full check, which refuses the inactive line.
    await expect(save(HR, ana, [later, boss])).rejects.toMatchObject({ field: 'reportingTo' });
  });
});

describe('writing', () => {
  it('writes nothing for a save that changes nothing', async () => {
    const boss = await person('Boss');
    const ana = await person('Ana', { reportingTo: [boss] });
    const before = await EmployeeModel.findById(ana.employeeId).lean().orFail();
    expect(await save(HR, ana, [boss])).toEqual({ changed: false });
    const after = await EmployeeModel.findById(ana.employeeId).lean().orFail();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await entriesFor(ana)).toHaveLength(0);
  });

  it('rolls back the lines when the audit entry can’t be written', async () => {
    const boss = await person('Boss');
    const ana = await person('Ana');
    await database().command({
      collMod: 'auditLogs',
      validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await expect(save(HR, ana, [boss])).rejects.toThrow();
    await database().command({ collMod: 'auditLogs', validator: {} });
    expect(await linesOf(ana)).toEqual([]);
  });
});
