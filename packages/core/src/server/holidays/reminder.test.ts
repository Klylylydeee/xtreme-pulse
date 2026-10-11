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
import { HolidayModel } from './model';
import {
  HOLIDAYS_UNCONFIRMED_EVENT,
  holidayReminderKey,
  holidayReminderYear,
  runHolidayReminder,
} from './reminder';

// The unconfirmed holidays reminder (docs/modules/core.md#holiday-calendar,
// docs/TESTING.md#holiday-calendar-tests, decision 115). Made-up people only.

let sequence = 0;

async function person(
  departmentCode: string,
  employmentStatus: EmploymentStatus,
  { isSystemAdministrator = false } = {},
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
    email: `reminder.person.${sequence}@xtreme-works.com`,
    passwordHash: 'made-up-not-a-hash',
    mustChangePassword: false,
    isSystemAdministrator,
    employeeId: employee._id,
  });
  return user._id;
}

const people: Record<string, Types.ObjectId> = {};

async function remindersFor(key: string) {
  return NotificationModel.find({
    recipientUserId: people[key],
    event: HOLIDAYS_UNCONFIRMED_EVENT,
  }).lean();
}

/** 08:00 Manila on a Manila day, as UTC. */
function at8(day: string): Date {
  return new Date(`${day}T08:00:00+08:00`);
}

async function confirmedHoliday(year: number) {
  await HolidayModel.create({
    name: 'Sample confirmed',
    date: new Date(`${year}-01-01T00:00:00+08:00`),
    year,
    type: 'regular',
    scope: 'nationwide',
    legalBasis: 'Proclamation No. 1',
    status: 'confirmed',
    source: 'manual',
  });
}

beforeAll(async () => {
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  await Promise.all([NotificationModel.init(), HolidayModel.init()]);
  people.hr = await person('HR', 'Regular');
  people.hrResigned = await person('HR', 'Resigned');
  people.admin = await person('NET', 'Regular', { isSystemAdministrator: true });
  people.staff = await person('NET', 'Regular');
});

describe('holidayReminderYear', () => {
  it('is next year on December 1, 8, 15, 22 and 29, and nothing on other December days', () => {
    for (const day of ['01', '08', '15', '22', '29']) {
      expect(holidayReminderYear(at8(`2026-12-${day}`)), day).toBe(2027);
    }
    for (const day of ['02', '07', '25', '31']) {
      expect(holidayReminderYear(at8(`2026-12-${day}`)), day).toBeNull();
    }
  });

  it('is the current year on Mondays in January and February only', () => {
    expect(holidayReminderYear(at8('2027-01-04'))).toBe(2027); // Monday
    expect(holidayReminderYear(at8('2027-02-22'))).toBe(2027); // Monday
    expect(holidayReminderYear(at8('2027-01-05'))).toBeNull(); // Tuesday
    expect(holidayReminderYear(at8('2027-03-01'))).toBeNull(); // Monday in March
    expect(holidayReminderYear(at8('2026-11-30'))).toBeNull();
  });

  it('reads the day in Manila', () => {
    // 16:30 UTC on November 30 is 00:30 on December 1 in Manila.
    expect(holidayReminderYear(new Date('2026-11-30T16:30:00Z'))).toBe(2027);
  });
});

describe('runHolidayReminder', () => {
  it('notifies active HR users and System Administrators only, while next year has none', async () => {
    const result = await runHolidayReminder(at8('2026-12-01'));
    expect(result).toEqual({ year: 2027, confirmed: false, notified: 2, skipped: 0 });
    for (const key of ['hr', 'admin']) {
      const reminders = await remindersFor(key);
      expect(reminders, key).toHaveLength(1);
      expect(reminders[0]).toMatchObject({
        module: 'core',
        href: '/holidays',
        dedupeKey: holidayReminderKey(2027, '2026-12-01'),
        readAt: null,
      });
      expect(reminders[0]?.title).toContain('2027');
    }
    for (const key of ['hrResigned', 'staff']) {
      expect(await remindersFor(key), key).toHaveLength(0);
    }
  });

  it('sends nothing more on a second run the same Manila day', async () => {
    expect(await runHolidayReminder(new Date('2026-12-01T09:00:00Z'))).toMatchObject({
      notified: 0,
      skipped: 2,
    });
    expect(await remindersFor('hr')).toHaveLength(1);
    // A week later it is sent again.
    expect(await runHolidayReminder(at8('2026-12-08'))).toMatchObject({ notified: 2 });
  });

  it('sends nothing on a day outside the windows', async () => {
    expect(await runHolidayReminder(at8('2026-12-02'))).toEqual({
      year: null,
      confirmed: false,
      notified: 0,
      skipped: 0,
    });
  });

  it('checks the current year in January and February', async () => {
    const result = await runHolidayReminder(at8('2027-01-04'));
    expect(result).toMatchObject({ year: 2027, notified: 2 });
    const keys = (await remindersFor('hr')).map((n) => n.dedupeKey);
    expect(keys).toContain('core.holidayReminder:2027:2027-01-04');
  });

  it('sends nothing once the year has a confirmed holiday', async () => {
    await confirmedHoliday(2027);
    const before = await NotificationModel.countDocuments({ event: HOLIDAYS_UNCONFIRMED_EVENT });
    expect(await runHolidayReminder(at8('2026-12-15'))).toEqual({
      year: 2027,
      confirmed: true,
      notified: 0,
      skipped: 0,
    });
    expect(await runHolidayReminder(at8('2027-01-11'))).toMatchObject({ confirmed: true });
    expect(await NotificationModel.countDocuments({ event: HOLIDAYS_UNCONFIRMED_EVENT })).toBe(
      before,
    );
    // A draft-only year still gets it.
    expect(await runHolidayReminder(at8('2027-12-01'))).toMatchObject({ year: 2028, notified: 2 });
  });
});
