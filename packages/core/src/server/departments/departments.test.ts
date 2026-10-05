import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { AuditLogModel } from '../audit/model';
import type { DepartmentRole } from '../auth/roles';
import { EmployeeModel } from '../employees/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import { DepartmentModel } from './model';
import {
  createDepartment,
  listDepartments,
  listEligibleDepartmentHeads,
  type OrgStructureActor,
  restoreDepartment,
  retireDepartment,
  updateDepartment,
} from './service';

// Departments (docs/modules/core.md#managing-departments-and-positions,
// docs/TESTING.md#core-administration-tests). Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

function actor(roles: DepartmentRole[], { admin = false } = {}): OrgStructureActor {
  return {
    id: new Types.ObjectId().toHexString(),
    email: 'actor@xtreme-works.com',
    isSystemAdministrator: admin,
    roles,
  };
}

const HR = actor(['hr']);
const ADMIN = actor([], { admin: true });
const OUTSIDERS: [string, OrgStructureActor][] = [
  ['an employee with no role', actor([])],
  ['Accounting', actor(['accounting'])],
  ['the Board', actor(['board'])],
];

let codeCounter = 0;
/** A fresh, unused department code. */
function nextCode(): string {
  codeCounter += 1;
  return `T${String(codeCounter).padStart(3, '0')}`;
}

let employeeCounter = 0;
async function addEmployee(
  departmentId: Types.ObjectId,
  {
    status = 'Regular',
    withAccount = true,
    firstName = 'Made',
    lastName = 'Up',
    positionId = new Types.ObjectId(),
  }: {
    status?: EmploymentStatus;
    withAccount?: boolean;
    firstName?: string;
    lastName?: string;
    positionId?: Types.ObjectId;
  } = {},
) {
  employeeCounter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: `2020-${String(employeeCounter).padStart(2, '0')}`,
    firstName,
    lastName,
    departmentId,
    positionId,
    employmentStatus: status,
    dateHired: new Date('2020-01-01T00:00:00+08:00'),
    // A separated status needs a separation date (SECURITY.md#account-status).
    separationDate:
      EMPLOYMENT_STATUS[status] === 'deactivated' ? new Date('2026-06-01T00:00:00+08:00') : null,
  });
  if (withAccount) {
    await UserModel.create({
      email: `employee.${employeeCounter}@xtreme-works.com`,
      passwordHash: 'not-a-real-hash',
      employeeId: employee._id,
    });
  }
  return employee;
}

async function entriesFor(id: Types.ObjectId | string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(String(id)) })
    .sort({ _id: 1 })
    .lean();
}

async function failAuditWrites(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

async function addDepartment(by = HR, code = nextCode()) {
  const { id } = await createDepartment(by, { name: `Department ${code}`, code });
  return { id, code };
}

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
  ]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  it.each(OUTSIDERS)('refuses %s and changes nothing', async (_label, outsider) => {
    const { id } = await addDepartment();
    await expect(createDepartment(outsider, { name: 'Nope', code: nextCode() })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(updateDepartment(outsider, id, { name: 'Renamed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(retireDepartment(outsider, id)).rejects.toThrow(AccessDeniedError);
    await expect(listDepartments(outsider)).rejects.toThrow(AccessDeniedError);
    await expect(listEligibleDepartmentHeads(outsider)).rejects.toThrow(AccessDeniedError);

    await retireDepartment(HR, id);
    await expect(restoreDepartment(outsider, id)).rejects.toThrow(AccessDeniedError);

    const stored = await DepartmentModel.findById(id, null, { withDeleted: true }).lean();
    expect(stored?.name).not.toBe('Renamed');
    expect(stored?.deletedAt).not.toBeNull();
    // Create (by HR) and retire (by HR) only.
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets HR and the System Administrator manage departments', async () => {
    for (const by of [HR, ADMIN]) {
      const { id } = await addDepartment(by);
      await updateDepartment(by, id, { name: 'Renamed by an allowed user' });
      await retireDepartment(by, id);
      await restoreDepartment(by, id);
      const entries = await entriesFor(id);
      expect(entries.map((entry) => entry.action)).toEqual([
        'create',
        'update',
        'delete',
        'restore',
      ]);
      expect(entries.every((entry) => entry.actorId?.toHexString() === by.id)).toBe(true);
    }
  });
});

describe('createDepartment', () => {
  it('writes exactly one create entry with the new record', async () => {
    const code = nextCode();
    const { id } = await createDepartment(HR, {
      name: '  Field Services ',
      code: code.toLowerCase(),
    });

    const stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({ name: 'Field Services', code, headEmployeeId: null });
    expect(stored.createdBy?.toHexString()).toBe(HR.id);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      actorEmail: HR.email,
      record: { type: 'core.department' },
      before: null,
      after: { name: 'Field Services', code, headEmployeeId: null },
    });
  });

  it('refuses a code already used, including by a retired department', async () => {
    const live = await addDepartment();
    await expect(
      createDepartment(HR, { name: 'Copy', code: live.code.toLowerCase() }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'code' });

    const retired = await addDepartment();
    await retireDepartment(HR, retired.id);
    await expect(createDepartment(HR, { name: 'Reuse', code: retired.code })).rejects.toMatchObject(
      {
        field: 'code',
      },
    );
    expect(await DepartmentModel.countDocuments({ name: { $in: ['Copy', 'Reuse'] } })).toBe(0);
  });

  it('refuses a code that breaks the rule', async () => {
    for (const code of ['A', '1AB', 'AB-C', 'ABCDEFGHIJK']) {
      await expect(createDepartment(HR, { name: 'Bad code', code })).rejects.toMatchObject({
        field: 'code',
      });
    }
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const code = nextCode();
    await failAuditWrites();
    await expect(createDepartment(HR, { name: 'Rolled back', code })).rejects.toThrow();
    expect(await DepartmentModel.exists({ code }).setOptions({ withDeleted: true })).toBeNull();
  });
});

describe('updateDepartment', () => {
  it('changes the name with one update entry holding before and after', async () => {
    const { id, code } = await addDepartment();
    await updateDepartment(HR, id, { name: 'New name' });

    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update']);
    expect(entries[1]).toMatchObject({
      record: { type: 'core.department', label: `${code} · New name` },
      before: { name: `Department ${code}`, code },
      after: { name: 'New name', code },
    });
  });

  it('can’t change the code', async () => {
    const { id, code } = await addDepartment();
    const changed = { name: 'Other', code: 'ZZZ9' } as unknown as { name: string };
    await expect(updateDepartment(HR, id, changed)).rejects.toMatchObject({
      name: 'ActionError',
      field: 'code',
    });

    // Sending the same code is fine; the stored code never changes.
    await updateDepartment(HR, id, { name: 'Same code', code } as unknown as { name: string });
    await DepartmentModel.updateOne({ _id: id }, { $set: { code: 'ZZZ8' } });
    const stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({ code, name: 'Same code' });
  });

  it('accepts a head whose account is active, from any department, and can clear it', async () => {
    const { id } = await addDepartment();
    const other = await addDepartment();
    const head = await addEmployee(new Types.ObjectId(other.id), { status: 'Probationary' });

    await updateDepartment(HR, id, { name: 'With head', headEmployeeId: head._id.toHexString() });
    let stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored.headEmployeeId?.toHexString()).toBe(head._id.toHexString());

    const listed = (await listDepartments(HR)).find((department) => department.id === id);
    expect(listed?.headName).toBe('Made Up');

    await updateDepartment(HR, id, { name: 'With head', headEmployeeId: '' as unknown as null });
    stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored.headEmployeeId).toBeNull();
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual([
      'create',
      'update',
      'update',
    ]);
  });

  it('refuses a head whose account isn’t active', async () => {
    const { id } = await addDepartment();
    const resigned = await addEmployee(new Types.ObjectId(id), { status: 'Resigned' });
    const noAccount = await addEmployee(new Types.ObjectId(id), { withAccount: false });

    for (const headEmployeeId of [
      resigned._id.toHexString(),
      noAccount._id.toHexString(),
      new Types.ObjectId().toHexString(),
    ]) {
      await expect(updateDepartment(HR, id, { name: 'X', headEmployeeId })).rejects.toMatchObject({
        field: 'headEmployeeId',
      });
      await expect(
        createDepartment(HR, { name: 'Y', code: nextCode(), headEmployeeId }),
      ).rejects.toMatchObject({ field: 'headEmployeeId' });
    }
    expect(await entriesFor(id)).toHaveLength(1);
  });

  it('leaves the department unchanged when the audit entry can’t be written', async () => {
    const { id, code } = await addDepartment();
    await failAuditWrites();
    await expect(updateDepartment(HR, id, { name: 'Rolled back' })).rejects.toThrow();
    const stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored.name).toBe(`Department ${code}`);
    expect(await entriesFor(id)).toHaveLength(1);
  });
});

describe('retireDepartment', () => {
  it('retires an empty department with a delete entry whose after is null', async () => {
    const { id, code } = await addDepartment();
    await retireDepartment(HR, id);

    expect(await DepartmentModel.findById(id).lean()).toBeNull();
    const stored = await DepartmentModel.findById(id, null, { withDeleted: true }).lean().orFail();
    expect(stored.deletedAt).toBeInstanceOf(Date);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      action: 'delete',
      record: { type: 'core.department' },
      before: { code, deletedAt: null },
      after: null,
    });

    expect((await listDepartments(HR)).some((department) => department.id === id)).toBe(false);
    const withRetired = await listDepartments(HR, { includeRetired: true });
    expect(withRetired.find((department) => department.id === id)?.retiredAt).toBeInstanceOf(Date);
  });

  it('is blocked while the department has a live position', async () => {
    const { id } = await addDepartment();
    const position = await PositionModel.create({
      name: 'Blocking position',
      departmentId: id,
      timesheetType: 'standard',
    });
    await expect(retireDepartment(HR, id)).rejects.toBeInstanceOf(ActionError);
    expect(await DepartmentModel.findById(id).lean()).not.toBeNull();

    // A retired position no longer blocks it.
    await PositionModel.updateOne({ _id: position._id }, { $set: { deletedAt: new Date() } });
    await retireDepartment(HR, id);
    expect(await DepartmentModel.findById(id).lean()).toBeNull();
  });

  it('is blocked while the department has an active employee', async () => {
    const { id } = await addDepartment();
    const employee = await addEmployee(new Types.ObjectId(id), { status: 'Contractual' });
    await expect(retireDepartment(HR, id)).rejects.toBeInstanceOf(ActionError);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create']);

    const listed = (await listDepartments(HR)).find((department) => department.id === id);
    expect(listed).toMatchObject({ activeEmployeeCount: 1, positionCount: 0 });

    // A separated employee doesn't block it.
    await EmployeeModel.updateOne(
      { _id: employee._id },
      { $set: { employmentStatus: 'Resigned' } },
    );
    await retireDepartment(HR, id);
    expect(await DepartmentModel.findById(id).lean()).toBeNull();
  });

  it.each(['HR', 'ACCT', 'BOD'])(
    'doesn’t protect %s: an empty one can be retired',
    async (code) => {
      const { id } = await createDepartment(ADMIN, { name: `Role department ${code}`, code });
      await retireDepartment(ADMIN, id);
      expect(await DepartmentModel.findById(id).lean()).toBeNull();
      expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
    },
  );

  it('leaves the department live when the audit entry can’t be written', async () => {
    const { id } = await addDepartment();
    await failAuditWrites();
    await expect(retireDepartment(HR, id)).rejects.toThrow();
    expect(await DepartmentModel.findById(id).lean()).not.toBeNull();
  });
});

describe('restoreDepartment', () => {
  it('brings a retired department back unchanged, with a restore entry', async () => {
    const { id, code } = await addDepartment();
    await retireDepartment(HR, id);
    await restoreDepartment(HR, id);

    const stored = await DepartmentModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({ code, name: `Department ${code}`, deletedAt: null });
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[2]?.before).toMatchObject({ code });
    expect((entries[2]?.before as { deletedAt: unknown }).deletedAt).not.toBeNull();
    expect(entries[2]?.after).toMatchObject({ code, deletedAt: null });
  });

  it('refuses a live department, and rolls back when the audit entry can’t be written', async () => {
    const { id } = await addDepartment();
    await expect(restoreDepartment(HR, id)).rejects.toBeInstanceOf(ActionError);

    await retireDepartment(HR, id);
    await failAuditWrites();
    await expect(restoreDepartment(HR, id)).rejects.toThrow();
    expect(await DepartmentModel.findById(id).lean()).toBeNull();
  });
});

describe('listEligibleDepartmentHeads', () => {
  it('lists only employees whose account resolves to active, matching the search', async () => {
    const { id } = await addDepartment();
    const departmentId = new Types.ObjectId(id);
    const active = await addEmployee(departmentId, { firstName: 'Zenaida', lastName: 'Quimpo' });
    await addEmployee(departmentId, {
      firstName: 'Zenaida',
      lastName: 'Resigned',
      status: 'Terminated',
    });
    await addEmployee(departmentId, {
      firstName: 'Zenaida',
      lastName: 'Noaccount',
      withAccount: false,
    });

    const found = await listEligibleDepartmentHeads(HR, 'zenaida');
    expect(found.map((option) => option.id)).toEqual([active._id.toHexString()]);
    expect(found[0]).toMatchObject({
      name: 'Zenaida Quimpo',
      employeeNumber: active.employeeNumber,
      departmentName: `Department ${(await DepartmentModel.findById(id).lean())?.code}`,
    });
    expect(await listEligibleDepartmentHeads(HR, 'zenaida quim')).toHaveLength(1);
    expect(await listEligibleDepartmentHeads(HR, 'nobody-by-this-name')).toEqual([]);
  });
});
