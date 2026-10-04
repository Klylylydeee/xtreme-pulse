import type { Types } from 'mongoose';
import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { now, startOfBusinessDate, toBusinessDate } from '../../dates';
import { resolveAccountStatus } from '../auth/account-status';
import { ROLE_DEPARTMENT_CODES } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { defineJob, defineSchedule } from '../jobs/define';
import { notify, recipientsNotifiedSince } from '../notifications/service';
import { UserModel } from '../users/model';
import { getCompanyDetailsStatus } from './service';

// Spec: docs/modules/core.md#company-settings-page and docs/ARCHITECTURE.md#background-jobs — the
// company details reminder. Weekly, Mondays at 08:00 Asia/Manila, while any company detail (the
// logo included) is still a placeholder, it notifies every active HR user and System
// Administrator (event `core.companyDetailsPending`): the System Administrator is linked to
// `/admin/settings`, HR to `/admin`. It is idempotent per Manila day: a recipient who already got
// this event that day is skipped, so a retry or a second run sends nothing twice.

/** The notification event. */
export const COMPANY_DETAILS_PENDING_EVENT = 'core.companyDetailsPending';

/** The job: no data, everything is read when it runs. */
export const COMPANY_DETAILS_REMINDER_JOB = defineJob('core.companyDetailsReminder', {
  schema: z.object({}),
});

/** Mondays at 8:00 AM Manila. */
export const COMPANY_DETAILS_REMINDER_SCHEDULE = defineSchedule({
  id: 'core.companyDetailsReminder',
  job: COMPANY_DETAILS_REMINDER_JOB,
  data: {},
  pattern: '0 8 * * 1',
});

const SETTINGS_HREF = '/admin/settings';
const ADMIN_HREF = '/admin';

export interface CompanyDetailsReminderResult {
  /** How many details are pending (0 means nothing was sent). */
  pending: number;
  /** Notifications written in this run. */
  notified: number;
  /** Recipients skipped because they already got the reminder that Manila day. */
  skipped: number;
}

const ACTIVE_STATUSES = Object.entries(EMPLOYMENT_STATUS)
  .filter(([, status]) => status === 'active')
  .map(([employmentStatus]) => employmentStatus as EmploymentStatus);

interface Recipient {
  id: Types.ObjectId;
  isSystemAdministrator: boolean;
}

/** Active System Administrators and active HR users, each once. */
async function reminderRecipients(): Promise<Recipient[]> {
  // HR: the employees in the HR department (a retired department keeps its role for its members,
  // as in loadSessionUser) whose employment status is active.
  const hrDepartments = await DepartmentModel.find(
    { code: ROLE_DEPARTMENT_CODES.hr },
    { _id: 1 },
    { withDeleted: true },
  ).lean();
  const hrEmployees = hrDepartments.length
    ? await EmployeeModel.find(
        {
          departmentId: { $in: hrDepartments.map((department) => department._id) },
          employmentStatus: { $in: ACTIVE_STATUSES },
        },
        { _id: 1 },
      ).lean()
    : [];

  const users = await UserModel.find(
    {
      $or: [
        { isSystemAdministrator: true },
        { employeeId: { $in: hrEmployees.map((employee) => employee._id) } },
      ],
    },
    { isSystemAdministrator: 1, isSystemAccount: 1, systemAccountDisabled: 1, employeeId: 1 },
  ).lean();

  // Work out each user's account status (SECURITY.md#account-status), the way sign-in does.
  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = await EmployeeModel.find(
    { _id: { $in: employeeIds } },
    { employmentStatus: 1 },
  ).lean();
  const statusByEmployee = new Map(
    employees.map((employee) => [employee._id.toHexString(), employee.employmentStatus]),
  );
  const hrEmployeeIds = new Set(hrEmployees.map((employee) => employee._id.toHexString()));

  const recipients: Recipient[] = [];
  for (const user of users) {
    const employeeKey = user.employeeId?.toHexString() ?? null;
    const status = employeeKey ? statusByEmployee.get(employeeKey) : undefined;
    const accountStatus = resolveAccountStatus(
      user,
      status === undefined ? null : { employmentStatus: status },
    );
    if (accountStatus !== 'active') continue;
    const isHR = !user.isSystemAccount && employeeKey !== null && hrEmployeeIds.has(employeeKey);
    if (!user.isSystemAdministrator && !isHR) continue;
    recipients.push({ id: user._id, isSystemAdministrator: user.isSystemAdministrator });
  }
  return recipients;
}

/**
 * Sends the company details reminder for the Manila day of `at`, if any detail is pending. Safe to
 * run again: recipients who already got it that day are skipped.
 */
export async function runCompanyDetailsReminder(
  at: Date = now(),
): Promise<CompanyDetailsReminderResult> {
  const { pending } = await getCompanyDetailsStatus();
  if (pending.length === 0) return { pending: 0, notified: 0, skipped: 0 };

  await connectDb();
  const recipients = await reminderRecipients();
  const dayStart = startOfBusinessDate(toBusinessDate(at));
  const already = await recipientsNotifiedSince(
    COMPANY_DETAILS_PENDING_EVENT,
    dayStart,
    recipients.map((recipient) => recipient.id),
  );
  const toNotify = recipients.filter((recipient) => !already.has(recipient.id.toHexString()));

  const title =
    pending.length === 1
      ? 'A company detail is still a placeholder'
      : `${pending.length} company details are still placeholders`;
  const body = `Still missing: ${pending.map((detail) => detail.label).join(', ')}.`;
  const base = { module: 'core' as const, event: COMPANY_DETAILS_PENDING_EVENT, title };

  let notified = 0;
  const administrators = toNotify.filter((recipient) => recipient.isSystemAdministrator);
  const hr = toNotify.filter((recipient) => !recipient.isSystemAdministrator);
  if (administrators.length) {
    notified += await notify({
      ...base,
      body: `${body} Fill them in on the company settings page.`,
      href: SETTINGS_HREF,
      recipients: administrators.map((recipient) => recipient.id),
    });
  }
  if (hr.length) {
    notified += await notify({
      ...base,
      body: `${body} Ask the System Administrator to fill them in.`,
      href: ADMIN_HREF,
      recipients: hr.map((recipient) => recipient.id),
    });
  }
  return { pending: pending.length, notified, skipped: recipients.length - toNotify.length };
}
