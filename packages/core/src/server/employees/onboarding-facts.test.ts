import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { DepartmentModel } from '../departments/model';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';
import { employeeOnboardingFacts } from './onboarding-facts';

// Core's onboarding facts for Pulse Talent's checklist (build step 2.6, decision 274 in
// docs/BUILD_PLAN.md, docs/modules/core.md#people-data-ownership, docs/TESTING.md#onboarding-and-
// change-request-tests). Made-up data only.

const FACT_KEYS = [
  'activeSupervisorCount',
  'departmentId',
  'employeeId',
  'employmentStatus',
  'hasPhoto',
  'hasTemporaryPassword',
  'isBoardMember',
  'needsAccess',
  'positionId',
  'userId',
].sort();

interface Person {
  employeeId: string;
  userId: string | null;
  departmentId: string;
  positionId: string;
}

let counter = 0;

async function departmentId(code: string): Promise<Types.ObjectId> {
  const found = await DepartmentModel.findOne({ code }, { _id: 1 }).lean();
  if (found) return found._id;
  return (await DepartmentModel.create({ name: `Department ${code}`, code }))._id;
}

async function person(
  firstName: string,
  {
    department = 'NET',
    status = 'Regular',
    reportingTo = [],
    account = true,
    mustChangePassword = false,
    isSystemAdministrator = false,
    moduleAccess = { talent: 'read' },
    photo = false,
  }: {
    department?: string;
    status?: EmploymentStatus;
    reportingTo?: Person[];
    account?: boolean;
    mustChangePassword?: boolean;
    isSystemAdministrator?: boolean;
    moduleAccess?: Record<string, string>;
    photo?: boolean;
  } = {},
): Promise<Person> {
  counter += 1;
  const positionId = new Types.ObjectId();
  const employee = await EmployeeModel.create({
    employeeNumber: `2024-${String(counter).padStart(2, '0')}`,
    firstName,
    lastName: 'Facts',
    departmentId: await departmentId(department),
    positionId,
    reportingTo: reportingTo.map((supervisor) => new Types.ObjectId(supervisor.employeeId)),
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
    photoFileId: photo ? new Types.ObjectId() : null,
  });
  const user = account
    ? await UserModel.create({
        email: `facts${counter}@xtreme-works.com`,
        passwordHash: 'made-up-hash-never-sent',
        employeeId: employee._id,
        mustChangePassword,
        isSystemAdministrator,
        moduleAccess,
      })
    : null;
  return {
    employeeId: employee._id.toHexString(),
    userId: user?._id.toHexString() ?? null,
    departmentId: employee.departmentId.toHexString(),
    positionId: positionId.toHexString(),
  };
}

async function factsOf(someone: Person) {
  const [facts] = await employeeOnboardingFacts([someone.employeeId]);
  return facts;
}

beforeAll(async () => {
  await connectDb();
  await Promise.all([EmployeeModel.init(), UserModel.init(), DepartmentModel.init()]);
});

describe('employeeOnboardingFacts', () => {
  it('gives the account facts, the department, position and status, and no sensitive field', async () => {
    const boss = await person('Bea');
    const ana = await person('Ana', { reportingTo: [boss], photo: true });

    const facts = await factsOf(ana);
    expect(facts).toEqual({
      employeeId: ana.employeeId,
      userId: ana.userId,
      hasTemporaryPassword: false,
      needsAccess: false,
      hasPhoto: true,
      isBoardMember: false,
      activeSupervisorCount: 1,
      departmentId: ana.departmentId,
      positionId: ana.positionId,
      employmentStatus: 'Regular',
    });
    expect(Object.keys(facts ?? {}).sort()).toEqual(FACT_KEYS);
    const json = JSON.stringify(facts);
    for (const forbidden of [
      'dateHired',
      'separationDate',
      'moduleAccess',
      'passwordHash',
      'email',
      'firstName',
      'lastName',
      'photoFileId',
    ]) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).not.toContain('made-up-hash-never-sent');
    expect(json).not.toContain('xtreme-works.com');
  });

  it('flags a temporary password, and no photo', async () => {
    const fresh = await person('Fey', { mustChangePassword: true });
    expect(await factsOf(fresh)).toMatchObject({ hasTemporaryPassword: true, hasPhoto: false });
  });

  it('follows the "Needs access" rule', async () => {
    const none = await person('Nia', { moduleAccess: {} });
    const allNone = await person('Noa', { moduleAccess: { talent: 'none', ops: 'none' } });
    const admin = await person('Ada', { moduleAccess: {}, isSystemAdministrator: true });
    const gone = await person('Gus', { moduleAccess: {}, status: 'Resigned' });
    const someAccess = await person('Sam', { moduleAccess: { ops: 'write' } });

    expect((await factsOf(none))?.needsAccess).toBe(true);
    expect((await factsOf(allNone))?.needsAccess).toBe(true);
    expect((await factsOf(admin))?.needsAccess).toBe(false);
    expect((await factsOf(gone))?.needsAccess).toBe(false);
    expect((await factsOf(someAccess))?.needsAccess).toBe(false);
  });

  it('gives no account facts for an employee with no account', async () => {
    const noAccount = await person('Ned', { account: false });
    expect(await factsOf(noAccount)).toMatchObject({
      userId: null,
      hasTemporaryPassword: false,
      needsAccess: false,
    });
  });

  it('marks a Board member, by the department code', async () => {
    const director = await person('Dina', { department: 'BOD' });
    const hr = await person('Hana', { department: 'HR' });
    expect((await factsOf(director))?.isBoardMember).toBe(true);
    expect((await factsOf(hr))?.isBoardMember).toBe(false);
  });

  it('counts only active supervisors, each once', async () => {
    const boss = await person('Bo');
    const other = await person('Oli');
    const separated = await person('Sep', { status: 'Terminated' });
    const noAccount = await person('Nat', { account: false });
    const lea = await person('Lea', { reportingTo: [boss, separated, noAccount, other, boss] });
    const solo = await person('Sol');
    const onlyGone = await person('Ola', { reportingTo: [separated] });

    expect((await factsOf(lea))?.activeSupervisorCount).toBe(2);
    expect((await factsOf(solo))?.activeSupervisorCount).toBe(0);
    expect((await factsOf(onlyGone))?.activeSupervisorCount).toBe(0);
  });

  it('keeps the order given, lists each employee once and leaves out unknown ids', async () => {
    const one = await person('One');
    const two = await person('Two');
    const facts = await employeeOnboardingFacts([
      two.employeeId,
      'not-an-id',
      new Types.ObjectId(),
      one.employeeId,
      two.employeeId,
    ]);
    expect(facts.map((f) => f.employeeId)).toEqual([two.employeeId, one.employeeId]);
    expect(await employeeOnboardingFacts([])).toEqual([]);
  });
});
