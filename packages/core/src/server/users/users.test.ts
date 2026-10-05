import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose, { type ClientSession, type mongo, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { AccessDeniedError, ActionError } from '../../actions';
import { addDays, businessToday, startOfBusinessDate } from '../../dates';
import {
  SEPARATION_BEFORE_HIRE,
  SEPARATION_IN_FUTURE,
  TERMINATED_UNAVAILABLE,
  type UserCreateInput,
} from '../../user-accounts';
import { AllowedEmailDomainModel } from '../allowed-email-domains/model';
import { AuditLogModel } from '../audit/model';
import { authenticate } from '../auth/authenticate';
import { verifyPassword } from '../auth/password';
import {
  type AccountTarget,
  canChangeProtectedFieldsOf,
  canEditAccountOf,
  canResetPasswordOf,
  type DepartmentRole,
} from '../auth/roles';
import { loadSessionUser } from '../auth/session-user';
import { TEMPORARY_PASSWORD_PATTERN } from '../auth/temporary-password';
import { DepartmentModel } from '../departments/model';
import { listDepartments, type OrgStructureActor } from '../departments/service';
import { EmployeeNumberCounterModel } from '../employee-number-counters/model';
import { EMPLOYEE_NUMBER_IN_USE_MESSAGE } from '../employee-numbers/service';
import { EmployeeModel } from '../employees/model';
import { PositionModel } from '../positions/model';
import { UserModel } from './model';
import {
  changeEmploymentStatus,
  createUser,
  getUser,
  listUsers,
  resetPassword,
  updateUser,
} from './service';

// User accounts (docs/modules/core.md#managing-user-accounts, SECURITY.md#account--access,
// docs/TESTING.md#user-account-tests). Made-up data only.

function database(): mongo.Db {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');
  return db;
}

function actor(
  roles: DepartmentRole[],
  { admin = false, id = new Types.ObjectId().toHexString() } = {},
): OrgStructureActor {
  return { id, email: 'actor@xtreme-works.com', isSystemAdministrator: admin, roles };
}

const HR = actor(['hr']);
const ADMIN = actor([], { admin: true });
const OUTSIDERS: [string, OrgStructureActor][] = [
  ['an employee with no role', actor([])],
  ['Accounting', actor(['accounting'])],
  ['the Board', actor(['board'])],
];

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

// Long enough for the call under test to read its snapshot and hit the open transaction's write.
const OVERLAP_MS = 500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let codeCounter = 0;
/** A live department with one live position in it. */
async function addDepartment(code = `U${String(++codeCounter).padStart(3, '0')}`) {
  const department = await DepartmentModel.create({ name: `Department ${code}`, code });
  const position = await PositionModel.create({
    name: `Position ${code}`,
    departmentId: department._id,
    timesheetType: 'standard',
  });
  return { departmentId: department._id.toHexString(), positionId: position._id.toHexString() };
}

let NET: Awaited<ReturnType<typeof addDepartment>>;
let HR_DEPARTMENT: Awaited<ReturnType<typeof addDepartment>>;
let BOARD: Awaited<ReturnType<typeof addDepartment>>;

let sequence = 0;
/**
 * A create input with a fresh email and last name. Hire years rotate, so no year runs out of
 * numbers; 2027 is kept for the "Done when" scenario.
 */
function hire(overrides: Partial<UserCreateInput> = {}): UserCreateInput {
  sequence += 1;
  return {
    email: `user.${sequence}@xtreme-works.com`,
    firstName: 'Ana',
    middleName: null,
    lastName: `Cruz ${String(sequence).padStart(3, '0')}`,
    employeeNumberMode: 'generate',
    employeeNumber: null,
    dateHired: `${2010 + (sequence % 12)}-03-01`,
    departmentId: NET.departmentId,
    positionId: NET.positionId,
    employmentStatus: 'Regular',
    reportingTo: [],
    ...overrides,
  };
}

/** The edit form's values for the user as they are now. */
async function editValues(userId: string) {
  const detail = await getUser(ADMIN, userId);
  if (!detail) throw new Error('No such user.');
  return {
    email: detail.email,
    firstName: detail.firstName ?? '',
    middleName: detail.middleName,
    lastName: detail.lastName ?? '',
    dateHired: detail.dateHired ?? '',
    departmentId: detail.departmentId ?? '',
    positionId: detail.positionId ?? '',
    reportingTo: detail.reportingTo.map((supervisor) => supervisor.id),
  };
}

/** Creates a user and makes them a System Administrator (the switch itself is step 1.7). */
async function addAdministrator(overrides: Partial<UserCreateInput> = {}) {
  const created = await createUser(ADMIN, hire(overrides));
  await UserModel.updateOne({ _id: created.id }, { $set: { isSystemAdministrator: true } });
  return created;
}

async function entriesFor(id: Types.ObjectId | string) {
  return AuditLogModel.find({ 'record.id': new Types.ObjectId(String(id)) })
    .sort({ _id: 1 })
    .lean();
}

async function counts() {
  const [users, employees, entries] = await Promise.all([
    UserModel.countDocuments(),
    EmployeeModel.countDocuments(),
    AuditLogModel.countDocuments(),
  ]);
  return { users, employees, entries };
}

/** `signedInAt` (whole seconds since the epoch) for a sign-in `secondsAgo` before now. */
function signedInAgo(secondsAgo: number): number {
  return Math.floor(Date.now() / 1000) - secondsAgo;
}

let systemAccountId: string;

beforeAll(async () => {
  await connectDb();
  // Collections must exist before a transaction writes to them.
  await Promise.all([
    DepartmentModel.init(),
    PositionModel.init(),
    EmployeeModel.init(),
    UserModel.init(),
    AuditLogModel.init(),
    EmployeeNumberCounterModel.init(),
    AllowedEmailDomainModel.init(),
  ]);
  await AllowedEmailDomainModel.create([
    { domain: 'xtreme-works.com' },
    { domain: 'gmail.com' },
    { domain: 'removed-domain.com', deletedAt: new Date() },
  ]);
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
});

afterEach(async () => {
  await database().command({ collMod: 'auditLogs', validator: {} });
});

// --- Who may do what ----------------------------------------------------------------------------

describe('the role helpers', () => {
  const self = actor(['hr']);
  const admin = actor([], { admin: true });
  const otherAdmin = actor([], { admin: true });
  const target = (id: string, { admin: isAdmin = false, system = false } = {}): AccountTarget => ({
    id,
    isSystemAdministrator: isAdmin,
    isSystemAccount: system,
  });
  const someone = target(new Types.ObjectId().toHexString());
  const anAdmin = target(otherAdmin.id, { admin: true });
  const theSystemAccount = target(new Types.ObjectId().toHexString(), {
    admin: true,
    system: true,
  });

  it('lets HR and the System Administrator edit, change and reset an ordinary user', () => {
    for (const who of [self, admin]) {
      expect(canEditAccountOf(who, someone)).toBe(true);
      expect(canChangeProtectedFieldsOf(who, someone)).toBe(true);
      expect(canResetPasswordOf(who, someone)).toBe(true);
    }
  });

  it('refuses everyone their own row', () => {
    for (const who of [self, admin]) {
      const own = target(who.id, { admin: who.isSystemAdministrator });
      expect(canEditAccountOf(who, own)).toBe(false);
      expect(canChangeProtectedFieldsOf(who, own)).toBe(false);
      expect(canResetPasswordOf(who, own)).toBe(false);
    }
  });

  it('lets HR edit a System Administrator’s identity but not the email, status or password', () => {
    expect(canEditAccountOf(self, anAdmin)).toBe(true);
    expect(canChangeProtectedFieldsOf(self, anAdmin)).toBe(false);
    expect(canResetPasswordOf(self, anAdmin)).toBe(false);
    expect(canChangeProtectedFieldsOf(admin, anAdmin)).toBe(true);
    expect(canResetPasswordOf(admin, anAdmin)).toBe(true);
  });

  it('keeps the system account read-only, reset only by another System Administrator', () => {
    for (const who of [self, admin]) {
      expect(canEditAccountOf(who, theSystemAccount)).toBe(false);
      expect(canChangeProtectedFieldsOf(who, theSystemAccount)).toBe(false);
    }
    expect(canResetPasswordOf(admin, theSystemAccount)).toBe(true);
    expect(canResetPasswordOf(self, theSystemAccount)).toBe(false);
    const systemActor = actor([], { admin: true, id: theSystemAccount.id });
    expect(canResetPasswordOf(systemActor, theSystemAccount)).toBe(false);
  });

  it.each(OUTSIDERS)('gives %s nothing', (_label, outsider) => {
    expect(canEditAccountOf(outsider, someone)).toBe(false);
    expect(canChangeProtectedFieldsOf(outsider, someone)).toBe(false);
    expect(canResetPasswordOf(outsider, someone)).toBe(false);
  });
});

describe('access', () => {
  it.each(OUTSIDERS)('refuses %s and changes nothing', async (_label, outsider) => {
    const { id } = await createUser(HR, hire());
    const before = await counts();
    const values = await editValues(id);

    await expect(listUsers(outsider)).rejects.toThrow(AccessDeniedError);
    await expect(getUser(outsider, id)).rejects.toThrow(AccessDeniedError);
    await expect(createUser(outsider, hire())).rejects.toThrow(AccessDeniedError);
    await expect(updateUser(outsider, id, { ...values, firstName: 'Changed' })).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(
      changeEmploymentStatus(outsider, id, {
        employmentStatus: 'Resigned',
        separationDate: businessToday(),
      }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(resetPassword(outsider, id)).rejects.toThrow(AccessDeniedError);

    expect(await counts()).toEqual(before);
    expect(await editValues(id)).toEqual(values);
  });
});

// --- Creating -----------------------------------------------------------------------------------

describe('createUser', () => {
  it('writes the employee, the user and two create entries', async () => {
    const input = hire({ firstName: 'Bea', middleName: 'Luna', dateHired: '2021-02-01' });
    const created = await createUser(HR, input);

    expect(created.temporaryPassword).toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(created.employeeNumber).toMatch(/^2021-\d{2}$/);
    const user = await UserModel.findById(created.id).select('+passwordHash').lean().orFail();
    expect(user).toMatchObject({
      email: input.email,
      mustChangePassword: true,
      isSystemAdministrator: false,
      isSystemAccount: false,
      sessionsValidFrom: null,
    });
    const employee = await EmployeeModel.findById(user.employeeId).lean().orFail();
    expect(employee).toMatchObject({
      employeeNumber: created.employeeNumber,
      firstName: 'Bea',
      middleName: 'Luna',
      employmentStatus: 'Regular',
      separationDate: null,
      reportingTo: [],
    });
    expect(employee.dateHired).toEqual(startOfBusinessDate('2021-02-01'));

    const employeeEntries = await entriesFor(employee._id);
    const userEntries = await entriesFor(user._id);
    expect(employeeEntries).toHaveLength(1);
    expect(employeeEntries[0]).toMatchObject({
      action: 'create',
      record: { type: 'core.employee', label: `${created.employeeNumber} · Bea ${input.lastName}` },
      before: null,
    });
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]).toMatchObject({
      action: 'create',
      record: { type: 'core.user', label: input.email },
    });
  });

  it('stores the temporary password only as an argon2id hash, and never in an entry', async () => {
    const created = await createUser(HR, hire());
    const user = await UserModel.findById(created.id).select('+passwordHash').lean().orFail();
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user.passwordHash, created.temporaryPassword)).toBe(true);

    const stored = JSON.stringify(
      await AuditLogModel.find({ 'record.id': { $in: [user._id, user.employeeId] } }).lean(),
    );
    expect(stored).not.toContain(created.temporaryPassword);
    expect(stored).not.toContain(user.passwordHash);
    expect(stored).not.toContain('$argon2');
    expect(stored).not.toContain('passwordHash');
  });

  it('writes nothing when the audit entry fails, and leaves no gap in the numbers', async () => {
    const year = 2019;
    const first = await createUser(HR, hire({ dateHired: `${year}-05-01` }));
    const before = await counts();
    const counter = await EmployeeNumberCounterModel.findOne({ year }).lean().orFail();

    await failAuditWrites();
    await expect(createUser(HR, hire({ dateHired: `${year}-05-02` }))).rejects.toThrow();
    await database().command({ collMod: 'auditLogs', validator: {} });

    expect(await counts()).toEqual(before);
    expect((await EmployeeNumberCounterModel.findOne({ year }).lean().orFail()).lastSequence).toBe(
      counter.lastSequence,
    );
    const next = await createUser(HR, hire({ dateHired: `${year}-05-03` }));
    const sequenceOf = (number: string) => Number(number.slice(5));
    expect(sequenceOf(next.employeeNumber)).toBe(sequenceOf(first.employeeNumber) + 1);
  });

  it('lowercases the email and refuses a domain that isn’t allowed, or was removed', async () => {
    const created = await createUser(HR, hire({ email: '  Mixed.Case@Gmail.com ' }));
    expect((await UserModel.findById(created.id).lean().orFail()).email).toBe(
      'mixed.case@gmail.com',
    );

    const before = await counts();
    for (const email of ['someone@other-company.com', 'someone@removed-domain.com']) {
      await expect(createUser(HR, hire({ email }))).rejects.toMatchObject({
        name: 'ActionError',
        field: 'email',
      });
    }
    expect(await counts()).toEqual(before);
  });

  it('refuses an email another user has', async () => {
    const first = hire();
    await createUser(HR, first);
    const before = await counts();
    await expect(createUser(HR, hire({ email: first.email.toUpperCase() }))).rejects.toMatchObject({
      name: 'ActionError',
      field: 'email',
    });
    expect(await counts()).toEqual(before);
  });

  it('refuses a date hired outside 1990-01-01 to a year ahead', async () => {
    for (const dateHired of ['1989-12-31', addDays(businessToday(), 366)]) {
      await expect(createUser(HR, hire({ dateHired }))).rejects.toMatchObject({
        field: 'dateHired',
      });
    }
  });

  it('needs a live department and a live position in it', async () => {
    const retired = await addDepartment();
    await DepartmentModel.updateOne({ _id: retired.departmentId }, { deletedAt: new Date() });
    const withRetiredPosition = await addDepartment();
    await PositionModel.updateOne(
      { _id: withRetiredPosition.positionId },
      { deletedAt: new Date() },
    );
    const before = await counts();

    await expect(createUser(HR, hire(retired))).rejects.toMatchObject({ field: 'departmentId' });
    await expect(createUser(HR, hire(withRetiredPosition))).rejects.toMatchObject({
      field: 'positionId',
    });
    await expect(
      createUser(HR, hire({ departmentId: NET.departmentId, positionId: BOARD.positionId })),
    ).rejects.toMatchObject({ field: 'positionId' });
    expect(await counts()).toEqual(before);
  });

  it('checks the reporting lines', async () => {
    const boss = await createUser(HR, hire());
    const bossEmployee = (await getUser(HR, boss.id))?.employeeId ?? '';
    const created = await createUser(HR, hire({ reportingTo: [bossEmployee] }));
    expect((await getUser(HR, created.id))?.reportingTo.map((s) => s.id)).toEqual([bossEmployee]);

    await changeEmploymentStatus(HR, boss.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });
    await expect(createUser(HR, hire({ reportingTo: [bossEmployee] }))).rejects.toMatchObject({
      field: 'reportingTo',
    });
    await expect(createUser(HR, hire({ reportingTo: [systemAccountId] }))).rejects.toMatchObject({
      field: 'reportingTo',
    });
  });

  it('accepts an entered number and refuses one in use', async () => {
    const created = await createUser(
      HR,
      hire({ employeeNumberMode: 'existing', employeeNumber: '2018-40', dateHired: '2018-07-01' }),
    );
    expect(created.employeeNumber).toBe('2018-40');
    await expect(
      createUser(
        HR,
        hire({
          employeeNumberMode: 'existing',
          employeeNumber: '2018-40',
          dateHired: '2018-08-01',
        }),
      ),
    ).rejects.toMatchObject({ field: 'employeeNumber', message: EMPLOYEE_NUMBER_IN_USE_MESSAGE });
    await expect(
      createUser(
        HR,
        hire({
          employeeNumberMode: 'existing',
          employeeNumber: '2017-41',
          dateHired: '2018-08-01',
        }),
      ),
    ).rejects.toMatchObject({ field: 'employeeNumber' });
  });

  it('gives one of two concurrent creates with the same entered number an in-use error', async () => {
    const same = { employeeNumberMode: 'existing', employeeNumber: '2016-77' } as const;
    const results = await Promise.allSettled([
      createUser(HR, hire({ ...same, dateHired: '2016-02-01' })),
      createUser(HR, hire({ ...same, dateHired: '2016-02-02' })),
    ]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.reason).toBeInstanceOf(ActionError);
    expect(failure?.reason).toMatchObject({
      field: 'employeeNumber',
      message: EMPLOYEE_NUMBER_IN_USE_MESSAGE,
    });
    expect(await EmployeeModel.countDocuments({ employeeNumber: '2016-77' })).toBe(1);
  });

  it('never makes a new user a System Administrator', async () => {
    const created = await createUser(ADMIN, {
      ...hire(),
      isSystemAdministrator: true,
    } as UserCreateInput);
    expect((await UserModel.findById(created.id).lean().orFail()).isSystemAdministrator).toBe(
      false,
    );
  });
});

// A department or position retired while a user is created in it: without the claims, both
// commit and leave an active employee in a retired department or position.
describe('a department or position retired at the same time', () => {
  it('makes a create that overlaps a department retire fail once it commits', async () => {
    const target = await addDepartment();
    const retiring = await openTransaction((session) =>
      DepartmentModel.updateOne(
        { _id: target.departmentId },
        { $set: { deletedAt: new Date() } },
        { session },
      ),
    );
    const before = await counts();
    const creating = createUser(HR, hire(target)).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await creating).toMatchObject({ name: 'ActionError', field: 'departmentId' });
    expect(await counts()).toEqual(before);
  });

  it('makes a create that overlaps a position retire fail once it commits', async () => {
    const target = await addDepartment();
    const retiring = await openTransaction((session) =>
      PositionModel.updateOne(
        { _id: target.positionId },
        { $set: { deletedAt: new Date() } },
        { session },
      ),
    );
    const before = await counts();
    const creating = createUser(HR, hire(target)).catch((error: unknown) => error);
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await creating).toMatchObject({ name: 'ActionError', field: 'positionId' });
    expect(await counts()).toEqual(before);
  });

  it('makes a department move that overlaps the retire fail once it commits', async () => {
    const { id } = await createUser(HR, hire());
    const target = await addDepartment();
    const retiring = await openTransaction((session) =>
      DepartmentModel.updateOne(
        { _id: target.departmentId },
        { $set: { deletedAt: new Date() } },
        { session },
      ),
    );
    const moving = updateUser(HR, id, { ...(await editValues(id)), ...target }).catch(
      (error: unknown) => error,
    );
    await pause(OVERLAP_MS);
    await retiring.commit();

    expect(await moving).toMatchObject({ name: 'ActionError', field: 'departmentId' });
    expect((await getUser(HR, id))?.departmentId).toBe(NET.departmentId);
  });
});

// An allowed email domain removed while a user is saved on it: the domain check before the
// transaction passes, and without the claim inside it both commit, leaving a new email on a
// removed domain.
describe('an email domain removed at the same time', () => {
  let domainCounter = 0;
  async function addDomain() {
    const domain = `racing-${++domainCounter}.example.com`;
    await AllowedEmailDomainModel.create({ domain });
    return domain;
  }
  function removing(domain: string) {
    return openTransaction((session) =>
      AllowedEmailDomainModel.updateOne(
        { domain, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { session },
      ),
    );
  }

  it('makes a create that overlaps the removal fail once it commits, and writes nothing', async () => {
    const domain = await addDomain();
    const removal = await removing(domain);
    const before = await counts();
    const creating = createUser(HR, hire({ email: `new.hire@${domain}` })).catch(
      (error: unknown) => error,
    );
    await pause(OVERLAP_MS);
    await removal.commit();

    expect(await creating).toMatchObject({ name: 'ActionError', field: 'email' });
    expect(await counts()).toEqual(before);
  });

  it('makes an email change that overlaps the removal fail once it commits', async () => {
    const { id } = await createUser(HR, hire());
    const values = await editValues(id);
    const domain = await addDomain();
    const removal = await removing(domain);
    const changing = updateUser(HR, id, { ...values, email: `moved@${domain}` }).catch(
      (error: unknown) => error,
    );
    await pause(OVERLAP_MS);
    await removal.commit();

    expect(await changing).toMatchObject({ name: 'ActionError', field: 'email' });
    expect((await getUser(HR, id))?.email).toBe(values.email);
  });
});

// --- Reading ------------------------------------------------------------------------------------

describe('listUsers and getUser', () => {
  it('shows the system account to a System Administrator only', async () => {
    expect((await listUsers(ADMIN)).some((row) => row.id === systemAccountId)).toBe(true);
    expect((await listUsers(HR)).some((row) => row.id === systemAccountId)).toBe(false);
    expect(await getUser(HR, systemAccountId)).toBeNull();
    const system = await getUser(ADMIN, systemAccountId);
    expect(system).toMatchObject({
      isSystemAccount: true,
      employeeNumber: null,
      actions: {
        edit: false,
        changeEmail: false,
        changeEmploymentStatus: false,
        resetPassword: true,
      },
    });
  });

  it('sorts by last name, searches, filters and hides separated users', async () => {
    const department = await addDepartment();
    const zed = await createUser(HR, hire({ ...department, lastName: 'Zamora', firstName: 'Zed' }));
    const amy = await createUser(HR, hire({ ...department, lastName: 'Abad', firstName: 'Amy' }));
    const gone = await createUser(HR, hire({ ...department, lastName: 'Mendoza' }));
    await changeEmploymentStatus(HR, gone.id, {
      employmentStatus: 'Retired',
      separationDate: businessToday(),
    });

    const rows = await listUsers(HR, { departmentId: department.departmentId });
    expect(rows.map((row) => row.id)).toEqual([amy.id, zed.id]);
    expect(rows[0]).toMatchObject({
      name: 'Amy Abad',
      employeeNumber: amy.employeeNumber,
      departmentId: department.departmentId,
      positionId: department.positionId,
      employmentStatus: 'Regular',
      accountStatus: 'active',
      mustChangePassword: true,
      isSelf: false,
      actions: { edit: true, changeEmail: true, changeEmploymentStatus: true, resetPassword: true },
    });

    const withSeparated = await listUsers(HR, {
      departmentId: department.departmentId,
      separated: true,
    });
    expect(withSeparated.map((row) => row.id)).toEqual([amy.id, gone.id, zed.id]);

    expect((await listUsers(HR, { search: amy.employeeNumber })).map((row) => row.id)).toEqual([
      amy.id,
    ]);
    expect((await listUsers(HR, { search: 'zed zamora' })).map((row) => row.id)).toEqual([zed.id]);
    const email = (await getUser(HR, zed.id))?.email ?? '';
    expect((await listUsers(HR, { search: email.toUpperCase() })).map((row) => row.id)).toEqual([
      zed.id,
    ]);
  });

  it('marks the actor’s own row and HR’s limits on a System Administrator’s row', async () => {
    const hrUser = await createUser(ADMIN, hire(HR_DEPARTMENT));
    const hrActor = actor(['hr'], { id: hrUser.id });
    const admin = await addAdministrator();

    const rows = await listUsers(hrActor, { separated: true });
    expect(rows.find((row) => row.id === hrUser.id)).toMatchObject({
      isSelf: true,
      actions: {
        edit: false,
        changeEmail: false,
        changeEmploymentStatus: false,
        resetPassword: false,
      },
    });
    expect(rows.find((row) => row.id === admin.id)).toMatchObject({
      isSystemAdministrator: true,
      actions: {
        edit: true,
        changeEmail: false,
        changeEmploymentStatus: false,
        resetPassword: false,
      },
    });
  });

  it('gives the edit sheet the dates and supervisors', async () => {
    const boss = await createUser(HR, hire({ firstName: 'Boss', lastName: 'Reyes' }));
    const bossEmployeeId = (await getUser(HR, boss.id))?.employeeId ?? '';
    const { id } = await createUser(
      HR,
      hire({ dateHired: '2020-04-15', reportingTo: [bossEmployeeId] }),
    );
    expect(await getUser(HR, id)).toMatchObject({
      dateHired: '2020-04-15',
      separationDate: null,
      reportingTo: [{ id: bossEmployeeId, name: 'Boss Reyes', active: true }],
    });
  });
});

// --- Editing ------------------------------------------------------------------------------------

describe('updateUser', () => {
  it('saves the identity and writes one update entry', async () => {
    const { id } = await createUser(HR, hire({ dateHired: '2015-01-10' }));
    const values = await editValues(id);
    const entriesBefore = await counts();

    await updateUser(HR, id, { ...values, firstName: 'Carla', dateHired: '2015-12-31' });

    const detail = await getUser(HR, id);
    expect(detail).toMatchObject({ firstName: 'Carla', dateHired: '2015-12-31' });
    expect((await counts()).entries).toBe(entriesBefore.entries + 1);
    const [entry] = (await entriesFor(detail?.employeeId ?? '')).slice(-1);
    expect(entry).toMatchObject({
      action: 'update',
      record: {
        type: 'core.employee',
        label: `${detail?.employeeNumber} · Carla ${values.lastName}`,
      },
      before: { firstName: 'Ana' },
      after: { firstName: 'Carla' },
    });
  });

  it('keeps the date hired within the employee number’s year and the number fixed', async () => {
    const { id } = await createUser(HR, hire({ dateHired: '2014-06-01' }));
    const values = await editValues(id);
    await expect(updateUser(HR, id, { ...values, dateHired: '2013-12-31' })).rejects.toMatchObject({
      field: 'dateHired',
    });
    await expect(
      updateUser(HR, id, { ...values, employeeNumber: '2014-98' } as typeof values),
    ).rejects.toMatchObject({ field: 'employeeNumber' });
    expect(await editValues(id)).toEqual(values);
  });

  it('changes the email with the same checks, and keeps the user’s sessions', async () => {
    const { id } = await createUser(HR, hire());
    const other = hire();
    await createUser(HR, other);
    const values = await editValues(id);
    const signedInAt = signedInAgo(60);
    expect(await loadSessionUser(id, signedInAt)).not.toBeNull();

    await expect(
      updateUser(HR, id, { ...values, email: 'moved@removed-domain.com' }),
    ).rejects.toMatchObject({ field: 'email' });
    await expect(updateUser(HR, id, { ...values, email: other.email })).rejects.toMatchObject({
      field: 'email',
    });

    await updateUser(HR, id, { ...values, email: 'New.Address@Gmail.com' });
    expect((await getUser(HR, id))?.email).toBe('new.address@gmail.com');
    expect(await loadSessionUser(id, signedInAt)).not.toBeNull();
    const [entry] = (await entriesFor(id)).slice(-1);
    expect(entry).toMatchObject({
      action: 'update',
      record: { type: 'core.user', label: 'new.address@gmail.com' },
      before: { email: values.email },
      after: { email: 'new.address@gmail.com' },
    });
  });

  it('audits a move into HR, which changes the role', async () => {
    const { id, employeeId } = await createUser(HR, hire());
    await updateUser(HR, id, { ...(await editValues(id)), ...HR_DEPARTMENT });
    const [entry] = (await entriesFor(employeeId)).slice(-1);
    expect(entry).toMatchObject({
      before: { departmentId: NET.departmentId },
      after: { departmentId: HR_DEPARTMENT.departmentId },
    });
    expect((await loadSessionUser(id, signedInAgo(5)))?.roles).toEqual(['hr']);
  });

  it('refuses the actor’s own row and the system account', async () => {
    const own = await createUser(HR, hire(HR_DEPARTMENT));
    const ownActor = actor(['hr'], { id: own.id });
    await expect(updateUser(ownActor, own.id, await editValues(own.id))).rejects.toThrow(
      AccessDeniedError,
    );
    const systemValues = {
      ...(await editValues(own.id)),
      email: 'sysadmin@xtreme-works.com',
    };
    await expect(updateUser(ADMIN, systemAccountId, systemValues)).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(updateUser(HR, systemAccountId, systemValues)).rejects.toThrow(ActionError);
  });

  it('lets HR edit a System Administrator’s name but not their email', async () => {
    const admin = await addAdministrator();
    const values = await editValues(admin.id);
    // HR's posted email is ignored: the stored one stays, and nothing is written.
    const entries = (await entriesFor(admin.id)).length;
    await updateUser(HR, admin.id, { ...values, email: 'changed.admin@xtreme-works.com' });
    expect(await editValues(admin.id)).toEqual(values);
    expect(await entriesFor(admin.id)).toHaveLength(entries);

    await updateUser(HR, admin.id, { ...values, firstName: 'Renamed' });
    expect((await getUser(HR, admin.id))?.firstName).toBe('Renamed');
    await updateUser(ADMIN, admin.id, { ...values, email: 'changed.admin@xtreme-works.com' });
    expect((await getUser(HR, admin.id))?.email).toBe('changed.admin@xtreme-works.com');
  });

  it('keeps a System Administrator’s new email when HR saves a form opened before it changed', async () => {
    const admin = await addAdministrator();
    const stale = await editValues(admin.id);
    await updateUser(ADMIN, admin.id, { ...stale, email: 'renamed.admin@xtreme-works.com' });

    await updateUser(HR, admin.id, { ...stale, firstName: 'Edited' });
    const detail = await getUser(HR, admin.id);
    expect(detail?.firstName).toBe('Edited');
    expect(detail?.email).toBe('renamed.admin@xtreme-works.com');
  });

  it('checks new supervisors, and keeps a line to someone who later separated', async () => {
    const first = await createUser(HR, hire());
    const second = await createUser(HR, hire());
    const firstId = (await getUser(HR, first.id))?.employeeId ?? '';
    const secondId = (await getUser(HR, second.id))?.employeeId ?? '';
    const { id, employeeId } = await createUser(HR, hire({ reportingTo: [firstId, secondId] }));
    await changeEmploymentStatus(HR, first.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });

    // A name change keeps both lines, the separated supervisor included.
    const values = await editValues(id);
    await updateUser(HR, id, { ...values, firstName: 'Kept' });
    expect((await editValues(id)).reportingTo).toEqual([firstId, secondId]);
    // Removing one is fine; a list that adds anyone is checked in full, so the separated one is
    // refused, and so is a loop.
    await updateUser(HR, id, { ...(await editValues(id)), reportingTo: [firstId] });
    expect((await editValues(id)).reportingTo).toEqual([firstId]);
    await expect(
      updateUser(HR, id, { ...(await editValues(id)), reportingTo: [firstId, secondId] }),
    ).rejects.toMatchObject({ field: 'reportingTo', message: expect.stringContaining('active') });
    await updateUser(HR, second.id, {
      ...(await editValues(second.id)),
      reportingTo: [employeeId],
    });
    await expect(
      updateUser(HR, id, { ...(await editValues(id)), reportingTo: [secondId] }),
    ).rejects.toMatchObject({ field: 'reportingTo', message: expect.stringContaining('loop') });
    expect((await editValues(id)).reportingTo).toEqual([firstId]);
  });
});

// --- Employment status --------------------------------------------------------------------------

describe('changeEmploymentStatus', () => {
  it('refuses Terminated and a separation date in the future or before the date hired', async () => {
    const { id } = await createUser(HR, hire({ dateHired: '2012-05-01' }));
    await expect(
      changeEmploymentStatus(HR, id, {
        employmentStatus: 'Terminated',
        separationDate: businessToday(),
      }),
    ).rejects.toMatchObject({ field: 'employmentStatus', message: TERMINATED_UNAVAILABLE });
    await expect(
      changeEmploymentStatus(HR, id, {
        employmentStatus: 'Resigned',
        separationDate: addDays(businessToday(), 1),
      }),
    ).rejects.toMatchObject({ field: 'separationDate', message: SEPARATION_IN_FUTURE });
    await expect(
      changeEmploymentStatus(HR, id, {
        employmentStatus: 'Resigned',
        separationDate: '2012-04-30',
      }),
    ).rejects.toMatchObject({ field: 'separationDate', message: SEPARATION_BEFORE_HIRE });
    expect((await getUser(HR, id))?.employmentStatus).toBe('Regular');
  });

  it('signs a user who resigned today out at once, and refuses their sign-in', async () => {
    const input = hire();
    const created = await createUser(HR, input);
    const signedInAt = signedInAgo(60);
    expect(await loadSessionUser(created.id, signedInAt)).not.toBeNull();
    expect(
      await authenticate({ email: input.email, password: created.temporaryPassword }),
    ).toMatchObject({ ok: true });

    await changeEmploymentStatus(HR, created.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });

    expect(await loadSessionUser(created.id, signedInAt)).toBeNull();
    expect(await authenticate({ email: input.email, password: created.temporaryPassword })).toEqual(
      { ok: false, code: 'inactive' },
    );
    const [entry] = (await entriesFor(created.employeeId)).slice(-1);
    expect(entry).toMatchObject({
      action: 'update',
      before: { employmentStatus: 'Regular', separationDate: null },
      after: {
        employmentStatus: 'Resigned',
        separationDate: startOfBusinessDate(businessToday()).toISOString(),
      },
    });
  });

  it('clears the separation date on a reversal, which needs a live department', async () => {
    const department = await addDepartment();
    const { id } = await createUser(HR, hire(department));
    await changeEmploymentStatus(HR, id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });
    expect((await getUser(HR, id))?.separationDate).toBe(businessToday());

    await DepartmentModel.updateOne({ _id: department.departmentId }, { deletedAt: new Date() });
    const refused = await changeEmploymentStatus(HR, id, { employmentStatus: 'Regular' }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).field).toBeNull();
    expect((await getUser(HR, id))?.employmentStatus).toBe('Resigned');

    await DepartmentModel.updateOne(
      { _id: department.departmentId, deletedAt: { $ne: null } },
      { deletedAt: null },
    );
    await changeEmploymentStatus(HR, id, { employmentStatus: 'Regular', separationDate: null });
    expect(await getUser(HR, id)).toMatchObject({
      employmentStatus: 'Regular',
      separationDate: null,
      accountStatus: 'active',
    });
  });

  it('refuses the actor’s own row, and HR on a System Administrator', async () => {
    const own = await createUser(HR, hire(HR_DEPARTMENT));
    const change = { employmentStatus: 'Resigned', separationDate: businessToday() } as const;
    await expect(
      changeEmploymentStatus(actor(['hr'], { id: own.id }), own.id, change),
    ).rejects.toThrow(AccessDeniedError);
    const admin = await addAdministrator();
    await expect(changeEmploymentStatus(HR, admin.id, change)).rejects.toThrow(AccessDeniedError);
    expect((await getUser(HR, admin.id))?.employmentStatus).toBe('Regular');
  });
});

// --- Resetting a password -----------------------------------------------------------------------

describe('resetPassword', () => {
  it('sets a new temporary password and ends every session, with one entry', async () => {
    const created = await createUser(HR, hire());
    await UserModel.updateOne({ _id: created.id }, { $set: { mustChangePassword: false } });
    const oldSession = signedInAgo(60);
    expect(await loadSessionUser(created.id, oldSession)).not.toBeNull();

    const startedAt = Date.now();
    const { temporaryPassword } = await resetPassword(HR, created.id);
    expect(temporaryPassword).toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(temporaryPassword).not.toBe(created.temporaryPassword);

    const user = await UserModel.findById(created.id).select('+passwordHash').lean().orFail();
    expect(user.mustChangePassword).toBe(true);
    expect(user.sessionsValidFrom?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user.passwordHash, temporaryPassword)).toBe(true);
    expect(await verifyPassword(user.passwordHash, created.temporaryPassword)).toBe(false);
    expect(await loadSessionUser(created.id, oldSession)).toBeNull();
    expect(await loadSessionUser(created.id, Math.ceil(Date.now() / 1000) + 1)).not.toBeNull();

    const resets = (await entriesFor(created.id)).filter((e) => e.action === 'passwordReset');
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({
      record: { type: 'core.user' },
      before: { mustChangePassword: false },
      after: { mustChangePassword: true },
    });
    const stored = JSON.stringify(resets[0]);
    expect(stored).not.toContain(temporaryPassword);
    expect(stored).not.toContain('$argon2');
    expect(stored).not.toContain('passwordHash');
  });

  it('refuses a self-reset and HR resetting a System Administrator', async () => {
    const own = await createUser(HR, hire(HR_DEPARTMENT));
    await expect(resetPassword(actor(['hr'], { id: own.id }), own.id)).rejects.toThrow(
      AccessDeniedError,
    );
    const admin = await addAdministrator();
    await expect(resetPassword(HR, admin.id)).rejects.toThrow(AccessDeniedError);
    await expect(resetPassword(actor([], { admin: true, id: admin.id }), admin.id)).rejects.toThrow(
      AccessDeniedError,
    );
    await expect(resetPassword(HR, systemAccountId)).rejects.toThrow(ActionError);
    const systemActor = actor([], { admin: true, id: systemAccountId });
    await expect(resetPassword(systemActor, systemAccountId)).rejects.toThrow(AccessDeniedError);
    expect(
      (await AuditLogModel.find({ action: 'passwordReset', 'record.id': admin.id }).lean()).length,
    ).toBe(0);
  });

  it('lets HR reset HR staff and Board members, and another System Administrator reset one', async () => {
    const hrUser = await createUser(HR, hire(HR_DEPARTMENT));
    const boardUser = await createUser(HR, hire(BOARD));
    await expect(resetPassword(HR, hrUser.id)).resolves.toMatchObject({});
    await expect(resetPassword(HR, boardUser.id)).resolves.toMatchObject({});
    const admin = await addAdministrator();
    await expect(resetPassword(ADMIN, admin.id)).resolves.toMatchObject({});
    await expect(resetPassword(ADMIN, systemAccountId)).resolves.toMatchObject({});
  });
});

// --- Department heads ---------------------------------------------------------------------------

describe('the departments list', () => {
  it('marks whether each head is active', async () => {
    const withHead = await addDepartment();
    const head = await createUser(HR, hire(withHead));
    await DepartmentModel.updateOne(
      { _id: withHead.departmentId },
      { headEmployeeId: new Types.ObjectId(head.employeeId) },
    );
    const noHead = await addDepartment();

    const find = async (departmentId: string) =>
      (await listDepartments(HR)).find((department) => department.id === departmentId);
    expect(await find(withHead.departmentId)).toMatchObject({ headActive: true });
    expect(await find(noHead.departmentId)).toMatchObject({ headActive: null });

    await changeEmploymentStatus(HR, head.id, {
      employmentStatus: 'Resigned',
      separationDate: businessToday(),
    });
    expect(await find(withHead.departmentId)).toMatchObject({
      headEmployeeId: head.employeeId,
      headActive: false,
    });
  });
});

// --- "Done when" --------------------------------------------------------------------------------

describe('the step 1.5 "Done when" scenario', () => {
  it('fails a generated 2027 hire after 2027-99 was entered, and writes nothing', async () => {
    const entered = await createUser(
      HR,
      hire({ employeeNumberMode: 'existing', employeeNumber: '2027-99', dateHired: '2027-03-01' }),
    );
    expect(entered.employeeNumber).toBe('2027-99');
    const before = await counts();

    await expect(createUser(HR, hire({ dateHired: '2027-06-01' }))).rejects.toMatchObject({
      name: 'ActionError',
      field: 'employeeNumber',
      message:
        "Employee numbers for 2027 have run out: 2027-99 has been issued. Enter the person's existing company ID if they have one.",
    });
    expect(await counts()).toEqual(before);
    expect((await EmployeeNumberCounterModel.findOne({ year: 2027 }).lean())?.lastSequence).toBe(
      99,
    );
  });
});

// --- Never zero System Administrators -----------------------------------------------------------

// Last in the file: it takes every other System Administrator out of the count.
describe('the last active System Administrator', () => {
  async function onlyThese(count: number) {
    await UserModel.updateMany(
      { isSystemAccount: false },
      { $set: { isSystemAdministrator: false } },
    );
    await UserModel.updateOne({ _id: systemAccountId }, { $set: { systemAccountDisabled: true } });
    const admins = [];
    for (let index = 0; index < count; index += 1) admins.push(await addAdministrator());
    return admins;
  }
  const resign = { employmentStatus: 'Resigned', separationDate: businessToday() } as const;

  /** A System Administrator acting as the user `id` (the actor is re-checked in the database). */
  const asAdministrator = (id: string) => actor([], { admin: true, id });

  it('refuses to separate the last one, and allows it while another stays', async () => {
    const [last] = await onlyThese(1);
    if (!last) throw new Error('No admin.');
    // Acting as the disabled system account, so no other System Administrator is active.
    const system = asAdministrator(systemAccountId);
    await expect(changeEmploymentStatus(system, last.id, resign)).rejects.toThrow(ActionError);
    expect((await getUser(ADMIN, last.id))?.employmentStatus).toBe('Regular');

    // The system account counts while it is active.
    await UserModel.updateOne({ _id: systemAccountId }, { $set: { systemAccountDisabled: false } });
    await changeEmploymentStatus(system, last.id, resign);
    expect((await getUser(ADMIN, last.id))?.employmentStatus).toBe('Resigned');
  });

  it('lets only one of two System Administrators separating each other at once through', async () => {
    for (let round = 0; round < 3; round += 1) {
      const [first, second] = await onlyThese(2);
      if (!first || !second) throw new Error('No admins.');
      const results = await Promise.allSettled([
        changeEmploymentStatus(asAdministrator(first.id), second.id, resign),
        changeEmploymentStatus(asAdministrator(second.id), first.id, resign),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const active = await EmployeeModel.countDocuments({
        _id: { $in: [first.employeeId, second.employeeId] },
        employmentStatus: 'Regular',
      });
      expect(active).toBe(1);
    }
  });

  it('refuses a System Administrator who was separated before their change ran', async () => {
    const [separated, other, target] = await onlyThese(3);
    if (!separated || !other || !target) throw new Error('No admins.');
    // The session was checked before this: the separation lands between the two.
    await changeEmploymentStatus(asAdministrator(other.id), separated.id, resign);

    await expect(
      changeEmploymentStatus(asAdministrator(separated.id), target.id, resign),
    ).rejects.toThrow(ActionError);
    expect((await getUser(ADMIN, target.id))?.employmentStatus).toBe('Regular');
  });
});
