import type { ClientSession, Types } from 'mongoose';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { UserModel } from '../users/model';
import { resolveAccountStatus } from './account-status';
import { ROLE_DEPARTMENT_CODES } from './roles';

// Who hears about Core's administration events (docs/modules/core.md#user-access-page,
// docs/modules/core.md#company-settings-page): every active HR user and every active System
// Administrator, the bootstrap system account included while it isn't disabled. Account status is
// worked out the way sign-in does (SECURITY.md#account-status).

export interface AdminRecipient {
  /** The user id. */
  id: Types.ObjectId;
  isSystemAdministrator: boolean;
}

const ACTIVE_STATUSES = Object.entries(EMPLOYMENT_STATUS)
  .filter(([, status]) => status === 'active')
  .map(([employmentStatus]) => employmentStatus as EmploymentStatus);

/**
 * Active System Administrators and active HR users, each once. Pass the session to read inside a
 * transaction (a create or an edit that notifies them).
 */
export async function activeHrAndSystemAdministrators(
  session?: ClientSession | null,
): Promise<AdminRecipient[]> {
  const inSession = session ?? null;
  // HR: the employees in the HR department (a retired department keeps its role for its members,
  // as in loadSessionUser) whose employment status is active.
  const hrDepartments = await DepartmentModel.find(
    { code: ROLE_DEPARTMENT_CODES.hr },
    { _id: 1 },
    { withDeleted: true },
  )
    .session(inSession)
    .lean();
  const hrEmployees = hrDepartments.length
    ? await EmployeeModel.find(
        {
          departmentId: { $in: hrDepartments.map((department) => department._id) },
          employmentStatus: { $in: ACTIVE_STATUSES },
        },
        { _id: 1 },
      )
        .session(inSession)
        .lean()
    : [];

  const users = await UserModel.find(
    {
      $or: [
        { isSystemAdministrator: true },
        { employeeId: { $in: hrEmployees.map((employee) => employee._id) } },
      ],
    },
    { isSystemAdministrator: 1, isSystemAccount: 1, systemAccountDisabled: 1, employeeId: 1 },
  )
    .session(inSession)
    .lean();

  const employeeIds = users.flatMap((user) => (user.employeeId ? [user.employeeId] : []));
  const employees = await EmployeeModel.find({ _id: { $in: employeeIds } }, { employmentStatus: 1 })
    .session(inSession)
    .lean();
  const statusByEmployee = new Map(
    employees.map((employee) => [employee._id.toHexString(), employee.employmentStatus]),
  );
  const hrEmployeeIds = new Set(hrEmployees.map((employee) => employee._id.toHexString()));

  const recipients: AdminRecipient[] = [];
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
