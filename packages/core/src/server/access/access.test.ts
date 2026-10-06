import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { businessToday } from '../../dates';
import { emptyModuleAccess, fullModuleAccess, type ModuleAccess } from '../../module-access';
import { ACCESS_CHANGED_ELSEWHERE, type UserAccessUpdateInput } from '../../user-access';
import type { UserCreateInput } from '../../user-accounts';
import { AllowedEmailDomainModel } from '../allowed-email-domains/model';
import { AuditLogModel } from '../audit/model';
import type { DepartmentRole } from '../auth/roles';
import { loadSessionUser } from '../auth/session-user';
import { DepartmentModel } from '../departments/model';
import type { OrgStructureActor } from '../departments/service';
import { EmployeeNumberCounterModel } from '../employee-number-counters/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import { changeEmploymentStatus, createUser } from '../users/service';
import {
  countUsersNeedingAccess,
  countUsersNeedingAccessFor,
  getUserAccess,
  listUserAccess,
  saveUserAccess,
} from './service';

// Setting module access on the User access page (docs/modules/core.md#user-access-page,
// SECURITY.md#resolving-and-enforcing-build-step-16, docs/TESTING.md#user-access-tests). Made-up
// data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

async function failAuditWrites(): Promise<void> {
  await database().command({
    collMod: 'auditLogs',
    validator: { $jsonSchema: { required: ['aFieldNoEntryHas'] } },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

let codeCounter = 0;
async function addDepartment(code = `A${String(++codeCounter).padStart(3, '0')}`) {
  const department = await DepartmentModel.create({ name: `Department ${code}`, code });
  const position = await PositionModel.create({
    name: `Position ${code}`,
    departmentId: department._id,
    timesheetType: 'standard',
  });
  return { departmentId: department._id.toHexString(), positionId: position._id.toHexString() };
}

type Assignment = Awaited<ReturnType<typeof addDepartment>>;
let NET: Assignment;
let HR_DEPARTMENT: Assignment;
let BOARD: Assignment;

/** The system account, acting: a real, active System Administrator. */
let SYSTEM: OrgStructureActor;

let sequence = 0;
function hire(assignment: Assignment, overrides: Partial<UserCreateInput> = {}): UserCreateInput {
  sequence += 1;
  return {
    email: `access.${sequence}@xtreme-works.com`,
    firstName: 'Ana',
    middleName: null,
    lastName: `Reyes ${String(sequence).padStart(3, '0')}`,
    employeeNumberMode: 'generate',
    employeeNumber: null,
    dateHired: `${2010 + (sequence % 12)}-03-01`,
    departmentId: assignment.departmentId,
    positionId: assignment.positionId,
    employmentStatus: 'Regular',
    reportingTo: [],
    ...overrides,
  };
}

/** A real user, returned as an actor whose roles follow their department. */
async function person(
  assignment: Assignment,
  { admin = false, roles = [] as DepartmentRole[], overrides = {} } = {},
): Promise<OrgStructureActor & { employeeNumber: string }> {
  const created = await createUser(SYSTEM, hire(assignment, overrides));
  if (admin)
    await UserModel.updateOne({ _id: created.id }, { $set: { isSystemAdministrator: true } });
  const user = await UserModel.findById(created.id).lean().orFail();
  return {
    id: created.id,
    email: user.email,
    isSystemAdministrator: admin,
    roles,
    employeeNumber: created.employeeNumber,
  };
}

const hrPerson = (overrides: Partial<UserCreateInput> = {}) =>
  person(HR_DEPARTMENT, { roles: ['hr'], overrides });
const adminPerson = () => person(NET, { admin: true });

/** The sheet's save for `id` as it is now, with `changes` on top. */
async function sheet(
  id: string,
  changes: Partial<ModuleAccess> = {},
  extra: Partial<UserAccessUpdateInput> = {},
): Promise<UserAccessUpdateInput> {
  const detail = await getUserAccess(SYSTEM, id);
  if (!detail) throw new Error('No such active user.');
  return {
    id,
    moduleAccess: { ...detail.storedAccess, ...changes },
    expectedChangedAt: detail.changedAt,
    ...extra,
  };
}

async function accessEntries(id: string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(id), action: 'accessChange' })
    .sort({ _id: 1 })
    .lean();
}

async function stored(id: string) {
  return UserModel.findById(id).lean().orFail();
}

const signedInNow = () => Math.floor(Date.now() / 1000) - 5;

let systemAccountId: string;

beforeAll(async () => {
  await connectDb();
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
    NotificationModel.init(),
    EmployeeNumberCounterModel.init(),
    AllowedEmailDomainModel.init(),
  ]);
  await AllowedEmailDomainModel.create({ domain: 'xtreme-works.com' });
  NET = await addDepartment('NET');
  HR_DEPARTMENT = await addDepartment('HR');
  BOARD = await addDepartment('BOD');
  const system = await UserModel.create({
    email: 'sysadmin@xtreme-works.com',
    passwordHash: 'made-up-not-a-hash',
    mustChangePassword: false,
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  systemAccountId = system._id.toHexString();
  SYSTEM = { id: systemAccountId, email: system.email, isSystemAdministrator: true, roles: [] };
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
  await UserModel.updateOne({ _id: systemAccountId }, { $set: { systemAccountDisabled: false } });
});

// --- Who ----------------------------------------------------------------------------------------

describe('who can set access', () => {
  it('refuses anyone but HR and the System Administrator, and changes nothing', async () => {
    const target = await person(NET);
    const outsiders = [await person(NET), await person(BOARD, { roles: ['board'] })];
    const before = await stored(target.id);
    for (const outsider of outsiders) {
      await expect(listUserAccess(outsider)).rejects.toThrow(AccessDeniedError);
      await expect(getUserAccess(outsider, target.id)).rejects.toThrow(AccessDeniedError);
      await expect(
        saveUserAccess(outsider, await sheet(target.id, { talent: 'write' })),
      ).rejects.toThrow(AccessDeniedError);
      expect(await countUsersNeedingAccessFor(outsider)).toBeNull();
    }
    expect(await stored(target.id)).toEqual(before);
    expect(await accessEntries(target.id)).toHaveLength(0);
  });

  it('refuses a role the session still claims but the database no longer gives', async () => {
    const target = await person(NET);
    // Claims HR, but works in NET.
    const pretender = { ...(await person(NET)), roles: ['hr'] as DepartmentRole[] };
    await expect(
      saveUserAccess(pretender, await sheet(target.id, { talent: 'write' })),
    ).rejects.toThrow(AccessDeniedError);
    expect((await stored(target.id)).moduleAccess?.talent).toBe('none');
  });
});

// --- Saving -------------------------------------------------------------------------------------

describe('saveUserAccess', () => {
  it('sets Talent Write: one entry with both levels, Last changed, and the effective access', async () => {
    const hr = await hrPerson();
    const target = await person(NET);
    expect((await getUserAccess(hr, target.id))?.changedAt).toBeNull();

    const result = await saveUserAccess(hr, await sheet(target.id, { talent: 'write' }));
    expect(result.changedModules).toEqual(['talent']);
    expect(result.systemAdministratorChanged).toBe(false);

    const user = await stored(target.id);
    expect(user.moduleAccess?.talent).toBe('write');
    expect(user.moduleAccessChangedBy?.toHexString()).toBe(hr.id);
    expect(user.moduleAccessChangedAt?.toISOString()).toBe(result.changedAt);

    const entries = await accessEntries(target.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      module: 'core',
      action: 'accessChange',
      actorEmail: hr.email,
      record: { type: 'core.user', label: target.email },
      before: { moduleAccess: { talent: 'none' } },
      after: { moduleAccess: { talent: 'write' } },
    });

    const session = await loadSessionUser(target.id, signedInNow());
    expect(session?.moduleAccess).toEqual({ ...emptyModuleAccess(), talent: 'write' });

    const detail = await getUserAccess(hr, target.id);
    expect(detail?.changedAt).toBe(result.changedAt);
    expect(detail?.changedByName).toMatch(/^Ana Reyes/);
    expect(detail?.summary).toEqual(['Talent W']);
  });

  it('writes one entry per changed module, and nothing for a save that changes nothing', async () => {
    const target = await person(NET);
    await saveUserAccess(SYSTEM, await sheet(target.id, { fiscal: 'owner', insight: 'read' }));
    const entries = await accessEntries(target.id);
    expect(entries.map((entry) => entry.after)).toEqual([
      { moduleAccess: { fiscal: 'owner' } },
      { moduleAccess: { insight: 'read' } },
    ]);

    const before = await stored(target.id);
    const result = await saveUserAccess(SYSTEM, await sheet(target.id));
    expect(result.changedModules).toEqual([]);
    expect(await stored(target.id)).toEqual(before);
    expect(await accessEntries(target.id)).toHaveLength(2);
  });

  it('refuses Write on Insight', async () => {
    const target = await person(NET);
    const input = await sheet(target.id);
    await expect(
      saveUserAccess(SYSTEM, {
        ...input,
        moduleAccess: { ...input.moduleAccess, insight: 'write' } as unknown as ModuleAccess,
      }),
    ).rejects.toThrow(ActionError);
    expect((await stored(target.id)).moduleAccess?.insight).toBe('none');
  });

  it('leaves the access unchanged when the audit entry fails', async () => {
    const target = await person(NET);
    const input = await sheet(target.id, { talent: 'read' });
    await failAuditWrites();
    await expect(saveUserAccess(SYSTEM, input)).rejects.toThrow();
    const user = await stored(target.id);
    expect(user.moduleAccess?.talent).toBe('none');
    expect(user.moduleAccessChangedAt).toBeNull();
  });

  it('refuses a stale sheet', async () => {
    const hr = await hrPerson();
    const target = await person(NET);
    const opened = await sheet(target.id, { ops: 'read' });
    await saveUserAccess(SYSTEM, await sheet(target.id, { talent: 'read' }));

    await expect(saveUserAccess(hr, opened)).rejects.toThrow(ACCESS_CHANGED_ELSEWHERE);
    const user = await stored(target.id);
    expect(user.moduleAccess?.ops).toBe('none');
    expect(user.moduleAccess?.talent).toBe('read');
  });

  it('refuses one’s own row, HR on a System Administrator, and the system account', async () => {
    const hr = await hrPerson();
    const admin = await adminPerson();
    await expect(saveUserAccess(hr, await sheet(hr.id, { talent: 'owner' }))).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(saveUserAccess(admin, await sheet(admin.id, { talent: 'owner' }))).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(saveUserAccess(hr, await sheet(admin.id, { talent: 'read' }))).rejects.toThrow(
      AccessDeniedError,
    );
    const systemSheet = {
      id: systemAccountId,
      moduleAccess: { ...emptyModuleAccess(), talent: 'read' as const },
      expectedChangedAt: null,
    };
    // A System Administrator sees it read-only; HR as if it didn't exist.
    await expect(saveUserAccess(admin, systemSheet)).rejects.toThrow(AccessDeniedError);
    await expect(saveUserAccess(hr, systemSheet)).rejects.toThrow(ActionError);
    for (const id of [hr.id, admin.id, systemAccountId]) {
      expect(await accessEntries(id), id).toHaveLength(0);
    }
  });

  it('refuses an inactive user', async () => {
    const target = await person(NET);
    const input = await sheet(target.id, { talent: 'read' });
    await changeEmploymentStatus(SYSTEM, target.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });
    await expect(saveUserAccess(SYSTEM, input)).rejects.toThrow(ActionError);
    expect(await getUserAccess(SYSTEM, target.id)).toBeNull();
    expect((await stored(target.id)).moduleAccess?.talent).toBe('none');
  });

  it('refuses an actor deactivated before the save runs', async () => {
    const hr = await hrPerson();
    const target = await person(NET);
    const input = await sheet(target.id, { talent: 'read' });
    await changeEmploymentStatus(SYSTEM, hr.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });
    await expect(saveUserAccess(hr, input)).rejects.toThrow(ActionError);
    expect((await stored(target.id)).moduleAccess?.talent).toBe('none');
  });
});

// --- The System Administrator switch ----------------------------------------------------------

describe('the System Administrator switch', () => {
  it('is for System Administrators only', async () => {
    const hr = await hrPerson();
    const target = await person(NET);
    await expect(
      saveUserAccess(hr, await sheet(target.id, {}, { isSystemAdministrator: true })),
    ).rejects.toThrow(AccessDeniedError);
    expect((await stored(target.id)).isSystemAdministrator).toBe(false);
    // HR sending the switch unchanged is fine.
    await saveUserAccess(
      hr,
      await sheet(target.id, { talent: 'read' }, { isSystemAdministrator: false }),
    );
    expect((await stored(target.id)).moduleAccess?.talent).toBe('read');
  });

  it('keeps the stored levels while on, and brings them back when off', async () => {
    const admin = await adminPerson();
    const target = await person(NET);
    await saveUserAccess(admin, await sheet(target.id, { talent: 'write' }));

    const on = await saveUserAccess(
      admin,
      await sheet(target.id, { fiscal: 'owner' }, { isSystemAdministrator: true }),
    );
    // The rows lock: the sent Fiscal level is ignored.
    expect(on).toMatchObject({ changedModules: [], systemAdministratorChanged: true });
    let user = await stored(target.id);
    expect(user.isSystemAdministrator).toBe(true);
    expect(user.moduleAccess).toMatchObject({ talent: 'write', fiscal: 'none' });
    expect(user.moduleAccessChangedAt?.toISOString()).toBe(on.changedAt);
    expect((await loadSessionUser(target.id, signedInNow()))?.moduleAccess).toEqual(
      fullModuleAccess(),
    );
    const listed = await getUserAccess(admin, target.id);
    expect(listed?.summary).toEqual(['All modules O']);
    expect(listed?.needsAccess).toBe(false);

    await saveUserAccess(admin, await sheet(target.id, {}, { isSystemAdministrator: false }));
    user = await stored(target.id);
    expect(user.isSystemAdministrator).toBe(false);
    expect((await loadSessionUser(target.id, signedInNow()))?.moduleAccess).toEqual({
      ...emptyModuleAccess(),
      talent: 'write',
    });

    const entries = await accessEntries(target.id);
    expect(entries.map((entry) => [entry.before, entry.after])).toEqual([
      [{ moduleAccess: { talent: 'none' } }, { moduleAccess: { talent: 'write' } }],
      [{ isSystemAdministrator: false }, { isSystemAdministrator: true }],
      [{ isSystemAdministrator: true }, { isSystemAdministrator: false }],
    ]);
  });

  it('can’t be used on one’s own row or the system account', async () => {
    const admin = await adminPerson();
    await expect(
      saveUserAccess(admin, await sheet(admin.id, {}, { isSystemAdministrator: false })),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      saveUserAccess(admin, {
        id: systemAccountId,
        moduleAccess: emptyModuleAccess(),
        isSystemAdministrator: false,
        expectedChangedAt: null,
      }),
    ).rejects.toThrow(AccessDeniedError);
    expect((await stored(admin.id)).isSystemAdministrator).toBe(true);
    expect((await stored(systemAccountId)).isSystemAdministrator).toBe(true);
  });

  it('lets only one of two System Administrators switching each other off at once through', async () => {
    for (let round = 0; round < 3; round += 1) {
      await UserModel.updateMany(
        { isSystemAccount: false },
        { $set: { isSystemAdministrator: false } },
      );
      await UserModel.updateOne(
        { _id: systemAccountId },
        { $set: { systemAccountDisabled: true } },
      );
      const first = await adminPerson();
      const second = await adminPerson();
      const results = await Promise.allSettled([
        saveUserAccess(first, await sheet(second.id, {}, { isSystemAdministrator: false })),
        saveUserAccess(second, await sheet(first.id, {}, { isSystemAdministrator: false })),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(
        await UserModel.countDocuments({
          _id: { $in: [first.id, second.id] },
          isSystemAdministrator: true,
        }),
      ).toBe(1);
    }
  });
});

// --- The list -----------------------------------------------------------------------------------

describe('listUserAccess', () => {
  it('pins Needs access newest first, filters, searches, and counts like the badge', async () => {
    const team = await addDepartment();
    const older = await person(team, { overrides: { firstName: 'Older', lastName: 'Zamora' } });
    const newer = await person(team, { overrides: { firstName: 'Newer', lastName: 'Zamora' } });
    const withAccess = await person(team, { overrides: { firstName: 'Bea', lastName: 'Abad' } });
    await saveUserAccess(SYSTEM, await sheet(withAccess.id, { desk: 'read' }));
    const admin = await person(team, { admin: true, overrides: { lastName: 'Bautista' } });
    const gone = await person(team);
    await changeEmploymentStatus(SYSTEM, gone.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });

    const list = await listUserAccess(SYSTEM, { departmentId: team.departmentId });
    expect(list.needsAccess.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(list.others.map((row) => row.id)).toEqual([withAccess.id, admin.id]);
    expect(list.others[0]?.summary).toEqual(['Desk R']);
    expect(list.others[1]?.needsAccess).toBe(false);

    // Search: name and employee number, not the email.
    const byName = await listUserAccess(SYSTEM, { search: 'older zamora' });
    expect([...byName.needsAccess, ...byName.others].map((row) => row.id)).toEqual([older.id]);
    const byNumber = await listUserAccess(SYSTEM, { search: withAccess.employeeNumber });
    expect(byNumber.others.map((row) => row.id)).toEqual([withAccess.id]);
    const byEmail = await listUserAccess(SYSTEM, { search: older.email });
    expect([...byEmail.needsAccess, ...byEmail.others]).toHaveLength(0);
    const byPosition = await listUserAccess(SYSTEM, { positionId: team.positionId });
    expect(byPosition.needsAccess.length + byPosition.others.length).toBe(4);

    // The count ignores the filters, and matches the badge and the job.
    const all = await listUserAccess(SYSTEM);
    expect(list.needsAccessCount).toBe(all.needsAccess.length);
    expect(await countUsersNeedingAccess()).toBe(all.needsAccess.length);
    expect(await countUsersNeedingAccessFor(SYSTEM)).toBe(all.needsAccess.length);
    expect(all.stats.activeUsers).toBe(all.needsAccess.length + all.others.length - 1);
    expect(all.stats.withAccess).toBe(all.stats.activeUsers - all.needsAccess.length);
  });

  it('shows the system account to System Administrators only, read-only with no chips', async () => {
    const hr = await hrPerson();
    const admin = await adminPerson();
    const forAdmin = await listUserAccess(admin);
    const systemRow = forAdmin.others[0];
    expect(systemRow).toMatchObject({
      id: systemAccountId,
      isSystemAccount: true,
      isSystemAdministrator: true,
      summary: [],
      readOnlyReason: 'systemAccount',
      canToggleSystemAdministrator: false,
    });

    const forHr = await listUserAccess(hr);
    expect([...forHr.needsAccess, ...forHr.others].some((row) => row.isSystemAccount)).toBe(false);
    expect(await getUserAccess(hr, systemAccountId)).toBeNull();
    expect(forHr.needsAccessCount).toBe(forAdmin.needsAccessCount);

    const own = [...forHr.needsAccess, ...forHr.others].find((row) => row.id === hr.id);
    expect(own).toMatchObject({ isSelf: true, readOnlyReason: 'self' });
    const adminRow = forHr.others.find((row) => row.id === admin.id);
    expect(adminRow).toMatchObject({
      readOnlyReason: 'systemAdministrator',
      canToggleSystemAdministrator: false,
    });
  });

  it('marks Board members for the Insight hint', async () => {
    const member = await person(BOARD, { roles: ['board'] });
    expect((await getUserAccess(SYSTEM, member.id))?.isBoardMember).toBe(true);
    expect((await getUserAccess(SYSTEM, (await person(NET)).id))?.isBoardMember).toBe(false);
  });
});
