import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { DepartmentModel } from '../departments/model';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';
import { activeHrUserIds, employeeNotificationContacts } from './notification-contacts';

// The alert recipient helpers for background jobs (build step 2.2, decision 186 in
// docs/BUILD_PLAN.md, docs/modules/core.md#people-data-ownership). Made-up data only.

const CONTACT_KEYS = [
  'employeeId',
  'employeeNumber',
  'name',
  'separated',
  'supervisorUserIds',
  'userId',
].sort();

interface Person {
  employeeId: string;
  userId: string | null;
  employeeNumber: string;
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
  }: {
    department?: string;
    status?: EmploymentStatus;
    reportingTo?: Person[];
    account?: boolean;
  } = {},
): Promise<Person> {
  counter += 1;
  const employeeNumber = `2025-${String(counter).padStart(2, '0')}`;
  const employee = await EmployeeModel.create({
    employeeNumber,
    firstName,
    lastName: 'Contact',
    departmentId: await departmentId(department),
    positionId: new Types.ObjectId(),
    reportingTo: reportingTo.map((supervisor) => new Types.ObjectId(supervisor.employeeId)),
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  const user = account
    ? await UserModel.create({
        email: `contact${counter}@xtreme-works.com`,
        passwordHash: 'made-up-hash-never-sent',
        employeeId: employee._id,
      })
    : null;
  return {
    employeeId: employee._id.toHexString(),
    userId: user?._id.toHexString() ?? null,
    employeeNumber,
  };
}

beforeAll(async () => {
  await connectDb();
  await Promise.all([EmployeeModel.init(), UserModel.init(), DepartmentModel.init()]);
});

describe('employeeNotificationContacts', () => {
  it('gives each employee’s number, name, active user and active supervisors’ users', async () => {
    const boss = await person('Bea');
    const gone = await person('Gil', { status: 'Resigned' });
    const noAccount = await person('Ned', { account: false });
    const ana = await person('Ana', { reportingTo: [gone, boss, noAccount, boss] });

    const [contact] = await employeeNotificationContacts([ana.employeeId]);
    expect(contact).toEqual({
      employeeId: ana.employeeId,
      employeeNumber: ana.employeeNumber,
      name: 'Ana Contact',
      separated: false,
      userId: ana.userId,
      supervisorUserIds: [boss.userId],
    });
    expect(Object.keys(contact ?? {}).sort()).toEqual(CONTACT_KEYS);
    const json = JSON.stringify(contact);
    for (const forbidden of ['dateHired', 'employmentStatus', 'separationDate', 'moduleAccess']) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).not.toContain('made-up-hash-never-sent');
  });

  it('marks a separated employee, whose user is no longer active', async () => {
    const gone = await person('Lea', { status: 'Terminated' });
    const [contact] = await employeeNotificationContacts([gone.employeeId]);
    expect(contact).toMatchObject({ separated: true, userId: null });
  });

  it('keeps the order given, lists each employee once and leaves out unknown ids', async () => {
    const one = await person('One');
    const two = await person('Two');
    const contacts = await employeeNotificationContacts([
      two.employeeId,
      'not-an-id',
      new Types.ObjectId(),
      one.employeeId,
      two.employeeId,
    ]);
    expect(contacts.map((c) => c.employeeId)).toEqual([two.employeeId, one.employeeId]);
    expect(await employeeNotificationContacts([])).toEqual([]);
  });
});

describe('activeHrUserIds', () => {
  it('lists the active HR users only', async () => {
    expect(await activeHrUserIds()).toEqual([]);
    const hr = await person('Hana', { department: 'HR' });
    await person('Hugo', { department: 'HR', status: 'Resigned' });
    await person('Nora');
    expect(await activeHrUserIds()).toEqual([hr.userId]);
  });
});
