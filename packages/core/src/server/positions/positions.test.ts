import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { type ClientSession, type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { EmploymentStatus } from '../../account';
import { AccessDeniedError, ActionError } from '../../actions';
import { AuditLogModel } from '../audit/model';
import type { DepartmentRole } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { createDepartment, type OrgStructureActor, retireDepartment } from '../departments/service';
import { EmployeeModel } from '../employees/model';
import { coreSeedLoaders } from '../seed/loaders';
import { PositionModel } from './model';
import {
  createPosition,
  listPositions,
  restorePosition,
  retirePosition,
  updatePosition,
} from './service';

// Positions (docs/modules/core.md#managing-departments-and-positions,
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
async function addDepartment(): Promise<string> {
  codeCounter += 1;
  const code = `P${String(codeCounter).padStart(3, '0')}`;
  return (await createDepartment(ADMIN, { name: `Department ${code}`, code })).id;
}

let positionCounter = 0;
async function addPosition(departmentId: string, by = HR) {
  positionCounter += 1;
  const name = `Position ${positionCounter}`;
  const { id } = await createPosition(by, { departmentId, name, timesheetType: 'standard' });
  return { id, name };
}

let employeeCounter = 0;
async function addEmployee(
  departmentId: string,
  positionId: string,
  status: EmploymentStatus = 'Regular',
) {
  employeeCounter += 1;
  return EmployeeModel.create({
    employeeNumber: `2021-${String(employeeCounter).padStart(2, '0')}`,
    firstName: 'Made',
    lastName: 'Up',
    departmentId,
    positionId,
    employmentStatus: status,
    dateHired: new Date('2021-01-01T00:00:00+08:00'),
  });
}

async function entriesFor(id: string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(id) })
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

/**
 * Runs `work` in a transaction that stays open until `commit` is called, standing in for a
 * concurrent request that has passed its checks but not committed yet.
 */
async function openTransaction(work: (session: ClientSession) => Promise<unknown>) {
  const session = await mongoose.startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  await work(session);
  return {
    async commit() {
      await session.commitTransaction();
      await session.endSession();
    },
  };
}

/** Retires the department in an open transaction, the way `retireDepartment` writes it. */
function retireInOpenTransaction(departmentId: string) {
  return openTransaction((session) =>
    DepartmentModel.updateOne(
      { _id: departmentId },
      { $set: { deletedAt: new Date() } },
      { session },
    ),
  );
}

// Long enough for the call under test to read its snapshot and hit the open transaction's write.
const OVERLAP_MS = 500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    AuditLogModel.init(),
  ]);
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

describe('access', () => {
  it.each(OUTSIDERS)('refuses %s and changes nothing', async (_label, outsider) => {
    const departmentId = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    await expect(
      createPosition(outsider, { departmentId, name: 'Nope', timesheetType: 'standard' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      updatePosition(outsider, id, { name: 'Renamed', timesheetType: 'overtime' }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(retirePosition(outsider, id)).rejects.toThrow(AccessDeniedError);
    await expect(listPositions(outsider)).rejects.toThrow(AccessDeniedError);
    await retirePosition(HR, id);
    await expect(restorePosition(outsider, id)).rejects.toThrow(AccessDeniedError);

    const stored = await PositionModel.findById(id, null, { withDeleted: true }).lean().orFail();
    expect(stored).toMatchObject({ name, timesheetType: 'standard' });
    expect(stored.deletedAt).not.toBeNull();
    expect(await PositionModel.countDocuments({ departmentId, name: 'Nope' })).toBe(0);
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('lets HR and the System Administrator manage positions', async () => {
    const departmentId = await addDepartment();
    for (const by of [HR, ADMIN]) {
      const { id } = await addPosition(departmentId, by);
      await updatePosition(by, id, { name: `Renamed ${id}`, timesheetType: 'overtime' });
      await retirePosition(by, id);
      await restorePosition(by, id);
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

describe('createPosition', () => {
  it('writes exactly one core.position create entry, with the timesheet type', async () => {
    const departmentId = await addDepartment();
    const { id } = await createPosition(HR, {
      departmentId,
      name: ' Field Technician ',
      timesheetType: 'overtime',
    });

    const stored = await PositionModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({ name: 'Field Technician', timesheetType: 'overtime' });
    expect(stored.departmentId.toHexString()).toBe(departmentId);

    const entries = await entriesFor(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'create',
      record: { type: 'core.position', label: expect.stringMatching(/^P\d+ · Field Technician$/) },
      before: null,
      after: { name: 'Field Technician', timesheetType: 'overtime', departmentId },
    });
  });

  it('refuses a name the department already has, retired positions and case included', async () => {
    const departmentId = await addDepartment();
    const { name } = await addPosition(departmentId);
    await expect(
      createPosition(HR, { departmentId, name: name.toUpperCase(), timesheetType: 'standard' }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'name' });

    const retired = await addPosition(departmentId);
    await retirePosition(HR, retired.id);
    await expect(
      createPosition(HR, { departmentId, name: retired.name, timesheetType: 'overtime' }),
    ).rejects.toMatchObject({ field: 'name' });

    // The same name in another department is fine.
    const other = await addDepartment();
    await createPosition(HR, { departmentId: other, name, timesheetType: 'standard' });
    expect(await PositionModel.countDocuments({ departmentId, name })).toBe(1);
  });

  it('refuses a retired or unknown department', async () => {
    const departmentId = await addDepartment();
    await retireDepartment(HR, departmentId);
    for (const id of [departmentId, new Types.ObjectId().toHexString()]) {
      await expect(
        createPosition(HR, { departmentId: id, name: 'Orphan', timesheetType: 'standard' }),
      ).rejects.toMatchObject({ name: 'ActionError', field: 'departmentId' });
    }
    expect(await PositionModel.countDocuments({ name: 'Orphan' })).toBe(0);
  });

  it('writes nothing when the audit entry can’t be written', async () => {
    const departmentId = await addDepartment();
    await failAuditWrites();
    await expect(
      createPosition(HR, { departmentId, name: 'Rolled back', timesheetType: 'standard' }),
    ).rejects.toThrow();
    expect(
      await PositionModel.exists({ departmentId, name: 'Rolled back' }).setOptions({
        withDeleted: true,
      }),
    ).toBeNull();
  });
});

describe('updatePosition', () => {
  it('snapshots a timesheet type change', async () => {
    const departmentId = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    await updatePosition(HR, id, { name, timesheetType: 'overtime' });

    expect((await PositionModel.findById(id).lean().orFail()).timesheetType).toBe('overtime');
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'update']);
    expect(entries[1]).toMatchObject({
      record: { type: 'core.position' },
      before: { name, timesheetType: 'standard' },
      after: { name, timesheetType: 'overtime' },
    });
  });

  it('can’t change the department', async () => {
    const departmentId = await addDepartment();
    const other = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    const moved = { name, timesheetType: 'standard', departmentId: other } as unknown as {
      name: string;
      timesheetType: 'standard';
    };
    await expect(updatePosition(HR, id, moved)).rejects.toMatchObject({
      name: 'ActionError',
      field: 'departmentId',
    });
    const stored = await PositionModel.findById(id).lean().orFail();
    expect(stored.departmentId.toHexString()).toBe(departmentId);
    expect(await entriesFor(id)).toHaveLength(1);
  });

  it('refuses a name another position in the department has', async () => {
    const departmentId = await addDepartment();
    const first = await addPosition(departmentId);
    const second = await addPosition(departmentId);
    await expect(
      updatePosition(HR, second.id, { name: first.name, timesheetType: 'standard' }),
    ).rejects.toMatchObject({ field: 'name' });

    // Changing only the case of its own name is fine.
    await updatePosition(HR, second.id, {
      name: second.name.toUpperCase(),
      timesheetType: 'standard',
    });
  });

  it('leaves the position unchanged when the audit entry can’t be written', async () => {
    const departmentId = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    await failAuditWrites();
    await expect(updatePosition(HR, id, { name, timesheetType: 'overtime' })).rejects.toThrow();
    expect((await PositionModel.findById(id).lean().orFail()).timesheetType).toBe('standard');
    expect(await entriesFor(id)).toHaveLength(1);
  });
});

describe('retirePosition', () => {
  it('is blocked while an active employee holds it, then retires with after null', async () => {
    const departmentId = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    const employee = await addEmployee(departmentId, id, 'Probationary');

    await expect(retirePosition(HR, id)).rejects.toBeInstanceOf(ActionError);
    const listed = (await listPositions(HR, { departmentId })).find((p) => p.id === id);
    expect(listed).toMatchObject({ activeEmployeeCount: 1, timesheetType: 'standard' });

    await EmployeeModel.updateOne({ _id: employee._id }, { $set: { employmentStatus: 'Retired' } });
    await retirePosition(HR, id);
    expect(await PositionModel.findById(id).lean()).toBeNull();

    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete']);
    expect(entries[1]).toMatchObject({ before: { name, deletedAt: null }, after: null });

    expect((await listPositions(HR, { departmentId })).some((p) => p.id === id)).toBe(false);
    const withRetired = await listPositions(HR, { departmentId, includeRetired: true });
    expect(withRetired.find((p) => p.id === id)?.retiredAt).toBeInstanceOf(Date);
  });

  it('leaves the position live when the audit entry can’t be written', async () => {
    const departmentId = await addDepartment();
    const { id } = await addPosition(departmentId);
    await failAuditWrites();
    await expect(retirePosition(HR, id)).rejects.toThrow();
    expect(await PositionModel.findById(id).lean()).not.toBeNull();
  });
});

describe('restorePosition', () => {
  it('brings a retired position back unchanged, with a restore entry', async () => {
    const departmentId = await addDepartment();
    const { id, name } = await addPosition(departmentId);
    await retirePosition(HR, id);
    await restorePosition(HR, id);

    const stored = await PositionModel.findById(id).lean().orFail();
    expect(stored).toMatchObject({ name, timesheetType: 'standard', deletedAt: null });
    const entries = await entriesFor(id);
    expect(entries.map((entry) => entry.action)).toEqual(['create', 'delete', 'restore']);
    expect(entries[2]?.after).toMatchObject({ name, deletedAt: null });
  });

  it('refuses while the department is retired, and rolls back on a failed audit write', async () => {
    const departmentId = await addDepartment();
    const { id } = await addPosition(departmentId);
    await retirePosition(HR, id);
    await retireDepartment(HR, departmentId);
    await expect(restorePosition(HR, id)).rejects.toBeInstanceOf(ActionError);

    await DepartmentModel.updateOne(
      { _id: departmentId, deletedAt: { $ne: null } },
      { $set: { deletedAt: null } },
    );
    await failAuditWrites();
    await expect(restorePosition(HR, id)).rejects.toThrow();
    expect(await PositionModel.findById(id).lean()).toBeNull();
  });
});

describe('case-insensitive names', () => {
  it('lets the unique index itself refuse `driver` next to `Driver`', async () => {
    const departmentId = await addDepartment();
    await createPosition(HR, { departmentId, name: 'Driver', timesheetType: 'overtime' });
    await expect(
      createPosition(HR, { departmentId, name: 'driver', timesheetType: 'overtime' }),
    ).rejects.toMatchObject({ name: 'ActionError', field: 'name' });
    // Straight to the model, past the service's own check.
    await expect(
      PositionModel.create({ departmentId, name: 'driver', timesheetType: 'overtime' }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await PositionModel.countDocuments({ departmentId })).toBe(1);

    const index = (await PositionModel.collection.indexes()).find(
      (candidate) => candidate.name === 'departmentId_1_name_1_ci',
    );
    expect(index).toMatchObject({ unique: true, collation: { locale: 'en', strength: 2 } });
  });

  it('keeps the department fixed even on a direct model update', async () => {
    const departmentId = await addDepartment();
    const other = await addDepartment();
    const { id } = await addPosition(departmentId);
    await PositionModel.updateOne({ _id: id }, { $set: { departmentId: other } });
    const stored = await PositionModel.findById(id).lean().orFail();
    expect(stored.departmentId.toHexString()).toBe(departmentId);
  });
});

describe('audit labels', () => {
  it('label each entry `<DEPT CODE> · <name>`', async () => {
    const departmentId = await addDepartment();
    const { code } = await DepartmentModel.findById(departmentId).lean().orFail();
    const { id, name } = await addPosition(departmentId);
    await updatePosition(HR, id, { name: `${name} II`, timesheetType: 'standard' });
    await retirePosition(HR, id);
    await restorePosition(HR, id);
    expect((await entriesFor(id)).map((entry) => entry.record.label)).toEqual([
      `${code} · ${name}`,
      `${code} · ${name} II`,
      `${code} · ${name} II`,
      `${code} · ${name} II`,
    ]);
  });
});

// A department retired while a position is added or restored in it: without a write to the
// department, both transactions commit (write skew) and leave a live position in a retired
// department. docs/modules/core.md#managing-departments-and-positions
describe('a department retired at the same time', () => {
  it('makes a position add that overlaps the retirement fail once it commits', async () => {
    const departmentId = await addDepartment();
    const retiring = await retireInOpenTransaction(departmentId);
    const adding = createPosition(HR, {
      departmentId,
      name: 'Overlapping',
      timesheetType: 'standard',
    }).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await adding).toMatchObject({ name: 'ActionError', field: 'departmentId' });
    expect(await PositionModel.countDocuments({ departmentId }, { withDeleted: true })).toBe(0);
  });

  it('makes a position restore that overlaps the retirement fail once it commits', async () => {
    const departmentId = await addDepartment();
    const { id } = await addPosition(departmentId);
    await retirePosition(HR, id);
    const retiring = await retireInOpenTransaction(departmentId);
    const restoring = restorePosition(HR, id).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await restoring).toBeInstanceOf(ActionError);
    expect(await PositionModel.findById(id).lean()).toBeNull();
    expect((await entriesFor(id)).map((entry) => entry.action)).toEqual(['create', 'delete']);
  });

  it('never leaves a live position in a retired department when both run at once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const departmentId = await addDepartment();
      const [added, retired] = await Promise.allSettled([
        createPosition(HR, { departmentId, name: `Race ${round}`, timesheetType: 'standard' }),
        retireDepartment(HR, departmentId),
      ]);
      expect([added.status, retired.status]).not.toEqual(['fulfilled', 'fulfilled']);

      const department = await DepartmentModel.findById(departmentId, null, {
        withDeleted: true,
      })
        .lean()
        .orFail();
      const live = await PositionModel.countDocuments({ departmentId });
      expect(department.deletedAt === null || live === 0).toBe(true);
    }
  });
});

describe('the old case-sensitive name index', () => {
  it('is dropped by the seed, leaving the case-insensitive one', async () => {
    // What a database built before the change still has.
    await PositionModel.collection.createIndex(
      { departmentId: 1, name: 1 },
      { unique: true, name: 'departmentId_1_name_1' },
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const loader of coreSeedLoaders.filter((l) =>
        ['departments', 'positions'].includes(l.name),
      ))
        await loader.run();
    } finally {
      log.mockRestore();
    }

    const names = (await PositionModel.collection.indexes()).map((index) => index.name);
    expect(names).not.toContain('departmentId_1_name_1');
    expect(names).toContain('departmentId_1_name_1_ci');
  });

  it('is kept, with a warning, while the case-insensitive one is missing', async () => {
    // What a database has when the new index couldn't be built.
    await PositionModel.collection.createIndex(
      { departmentId: 1, name: 1 },
      { unique: true, name: 'departmentId_1_name_1' },
    );
    await PositionModel.collection.dropIndex('departmentId_1_name_1_ci');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const loader of coreSeedLoaders.filter((l) =>
        ['departments', 'positions'].includes(l.name),
      ))
        await loader.run();

      const names = (await PositionModel.collection.indexes()).map((index) => index.name);
      expect(names).toContain('departmentId_1_name_1');
      expect(names).not.toContain('departmentId_1_name_1_ci');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept the old case-sensitive'));
    } finally {
      warn.mockRestore();
      // Put the indexes back the way the other tests expect them.
      await PositionModel.createIndexes();
      await PositionModel.collection.dropIndex('departmentId_1_name_1');
    }
  });
});
