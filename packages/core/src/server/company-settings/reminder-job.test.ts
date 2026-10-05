import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { NotificationModel } from '../notifications/model';
import { PositionModel } from '../positions/model';
import { coreSeedLoaders } from '../seed/loaders';
import { UserModel } from '../users/model';
import { COMPANY_SETTINGS_KEY, CompanySettingsModel } from './model';
import { COMPANY_DETAILS_PENDING_EVENT, runCompanyDetailsReminder } from './reminder-job';

// The company details reminder (docs/modules/core.md#company-settings-page,
// docs/TESTING.md#core-administration-tests). Made-up people only.

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
    // A separated status needs a separation date (SECURITY.md#account-status).
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
  });
  return user._id;
}

const people: Record<string, Types.ObjectId> = {};

function personId(key: string): Types.ObjectId {
  const id = people[key];
  if (!id) throw new Error(`No test person "${key}".`);
  return id;
}

beforeAll(async () => {
  await connectDb();
  for (const loader of coreSeedLoaders) await loader.run();
  people.hrActive = await person('HR', 'Regular');
  people.hrProbationary = await person('HR', 'Probationary');
  people.hrResigned = await person('HR', 'Resigned');
  people.adminActive = await person('NET', 'Regular', { isSystemAdministrator: true });
  people.adminTerminated = await person('NET', 'Terminated', { isSystemAdministrator: true });
  people.staff = await person('NET', 'Regular');
  people.accounting = await person('ACCT', 'Regular');
  const system = await UserModel.create({
    email: 'system.account@xtreme-works.com',
    passwordHash: 'made-up-not-a-hash',
    isSystemAdministrator: true,
    isSystemAccount: true,
    employeeId: null,
  });
  people.systemAccount = system._id;
});

async function remindersFor(userId: Types.ObjectId) {
  return NotificationModel.find({
    recipientUserId: userId,
    event: COMPANY_DETAILS_PENDING_EVENT,
  }).lean();
}

describe('runCompanyDetailsReminder', () => {
  it('notifies active HR users and System Administrators only, with the right link', async () => {
    const result = await runCompanyDetailsReminder();
    expect(result.pending).toBeGreaterThan(0);
    expect(result.notified).toBe(4);
    expect(result.skipped).toBe(0);

    for (const key of ['hrActive', 'hrProbationary']) {
      const reminders = await remindersFor(personId(key));
      expect(reminders, key).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ module: 'core', href: '/admin', readAt: null });
      expect(reminders[0]?.body).toContain('Company logo');
    }
    for (const key of ['adminActive', 'systemAccount']) {
      const reminders = await remindersFor(personId(key));
      expect(reminders, key).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ href: '/admin/settings' });
    }
    for (const key of ['hrResigned', 'adminTerminated', 'staff', 'accounting']) {
      expect(await remindersFor(personId(key)), key).toHaveLength(0);
    }
  });

  it('sends nothing more when it runs again the same Manila day', async () => {
    const before = await NotificationModel.countDocuments({ event: COMPANY_DETAILS_PENDING_EVENT });
    const result = await runCompanyDetailsReminder();
    expect(result).toMatchObject({ notified: 0, skipped: 4 });
    expect(await NotificationModel.countDocuments({ event: COMPANY_DETAILS_PENDING_EVENT })).toBe(
      before,
    );
  });

  it('sends a recipient who has none today their reminder, and skips the rest', async () => {
    const newcomer = await person('HR', 'Contractual');
    const result = await runCompanyDetailsReminder();
    expect(result).toMatchObject({ notified: 1, skipped: 4 });
    expect(await remindersFor(newcomer)).toHaveLength(1);
  });

  it('sends nothing once every detail and the logo are filled in', async () => {
    await CompanySettingsModel.updateOne(
      { singletonKey: COMPANY_SETTINGS_KEY },
      {
        $set: {
          registeredName: 'Made-up Systems Inc.',
          businessAddress: '1 Sample Street, Makati City',
          tin: '000-000-000-00000',
          rdoCode: '050',
          sssEmployerNumber: '00-0000000-0',
          philhealthEmployerNumber: '00-000000000-0',
          pagibigEmployerId: '0000-0000-0000',
          birRegistration: { casPermitDetails: 'Made-up permit', invoiceSeries: '0001-9999' },
          logoFileId: new Types.ObjectId(),
        },
      },
    );
    const before = await NotificationModel.countDocuments({});
    const result = await runCompanyDetailsReminder();
    expect(result).toEqual({ pending: 0, notified: 0, skipped: 0 });
    expect(await NotificationModel.countDocuments({})).toBe(before);
  });
});
