import { beforeAll, describe, expect, it } from 'vitest';
import type { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { PositionModel } from '../positions/model';
import { coreSeedLoaders } from '../seed/loaders';
import { UserModel } from '../users/model';
import { accessReminderKey, runAccessReminder, USERS_NEED_ACCESS_EVENT } from './reminder-job';
import { countUsersNeedingAccess } from './service';

// The users-needing-access reminder (docs/modules/core.md#user-access-page,
// docs/TESTING.md#user-access-tests, decision 72). Made-up people only.

let sequence = 0;

async function person(
  departmentCode: string,
  employmentStatus: EmploymentStatus,
  { isSystemAdministrator = false, talent = 'none' as 'none' | 'read' } = {},
): Promise<Types.ObjectId> {
  sequence += 1;
  const department = await DepartmentModel.findOne({ code: departmentCode }).lean().orFail();
  const position = await PositionModel.findOne({ departmentId: department._id }).lean().orFail();
  const employee = await EmployeeModel.create({
    employeeNumber: `2026-${String(sequence).padStart(2, '0')}`,
    firstName: 'Sample',
    lastName: `Person ${sequence}`,
    departmentId: department._id,
    positionId: position._id,
    employmentStatus,
    dateHired: new Date('2026-01-05T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[employmentStatus] === 'deactivated'
        ? new Date('2026-06-01T00:00:00+08:00')
        : null,
  });
  const user = await UserModel.create({
    email: `person.${sequence}@xtreme-works.com`,
    passwordHash: 'made-up-not-a-hash',
    mustChangePassword: false,
    isSystemAdministrator,
    employeeId: employee._id,
    moduleAccess: { talent },
  });
  return user._id;
}

const people: Record<string, Types.ObjectId> = {};

function personId(key: string): Types.ObjectId {
  const id = people[key];
  if (!id) throw new Error(`No test person "${key}".`);
  return id;
}

async function remindersFor(userId: Types.ObjectId) {
  return NotificationModel.find({ recipientUserId: userId, event: USERS_NEED_ACCESS_EVENT }).lean();
}

const DAY = new Date('2026-10-05T00:30:00Z'); // 08:30 in Manila

beforeAll(async () => {
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  await NotificationModel.init();
  // Everyone here has access, apart from those made to need it in the tests.
  people.hrActive = await person('HR', 'Regular', { talent: 'read' });
  people.hrResigned = await person('HR', 'Resigned', { talent: 'read' });
  people.adminActive = await person('NET', 'Regular', { isSystemAdministrator: true });
  people.adminTerminated = await person('NET', 'Terminated', { isSystemAdministrator: true });
  people.staff = await person('NET', 'Regular', { talent: 'read' });
  const system = await UserModel.create({
    email: 'system.account@xtreme-works.com',
    passwordHash: 'made-up-not-a-hash',
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  people.systemAccount = system._id;
});

describe('runAccessReminder', () => {
  it('sends nothing while nobody needs access', async () => {
    // System Administrators (the system account included) and separated users never count.
    expect(await countUsersNeedingAccess()).toBe(0);
    const before = await NotificationModel.countDocuments({});
    expect(await runAccessReminder(DAY)).toEqual({ needingAccess: 0, notified: 0, skipped: 0 });
    expect(await NotificationModel.countDocuments({})).toBe(before);
  });

  it('notifies only active HR users and System Administrators, linking /admin/access', async () => {
    people.newcomer = await person('NET', 'Probationary');
    people.newcomerHr = await person('HR', 'Contractual');
    await person('NET', 'Resigned'); // separated: doesn't count
    expect(await countUsersNeedingAccess()).toBe(2);

    const result = await runAccessReminder(DAY);
    expect(result).toEqual({ needingAccess: 2, notified: 4, skipped: 0 });
    for (const key of ['hrActive', 'newcomerHr', 'adminActive', 'systemAccount']) {
      const reminders = await remindersFor(personId(key));
      expect(reminders, key).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        module: 'core',
        href: '/admin/access',
        title: '2 users still need access',
        dedupeKey: accessReminderKey(DAY),
        readAt: null,
      });
    }
    for (const key of ['hrResigned', 'adminTerminated', 'staff', 'newcomer']) {
      expect(await remindersFor(personId(key)), key).toHaveLength(0);
    }
  });

  it('sends nothing more on a second run the same Manila day, and again the next day', async () => {
    const before = await NotificationModel.countDocuments({ event: USERS_NEED_ACCESS_EVENT });
    expect(await runAccessReminder(new Date('2026-10-05T15:00:00Z'))).toMatchObject({
      notified: 0,
      skipped: 4,
    });
    expect(await NotificationModel.countDocuments({ event: USERS_NEED_ACCESS_EVENT })).toBe(before);
    // 2026-10-05T16:30Z is 00:30 on 6 October in Manila.
    const next = new Date('2026-10-05T16:30:00Z');
    expect(accessReminderKey(next)).toBe('core.accessReminder:2026-10-06');
    expect(await runAccessReminder(next)).toMatchObject({ notified: 4, skipped: 0 });
  });
});
