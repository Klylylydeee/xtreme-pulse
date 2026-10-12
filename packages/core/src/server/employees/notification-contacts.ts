import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { activeHrApprovers } from '../approvals/routing';
import { resolveAccountStatus } from '../auth/account-status';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { employeeName } from './active-employees';
import { EmployeeModel } from './model';

// Spec: docs/modules/core.md#people-data-ownership ("Alert recipients for jobs", decision 186 in
// docs/BUILD_PLAN.md) — a background job has no signed-in user, so it can't go through the
// identity service's access check. These two reads let a job (Pulse Talent's expiry alerts, build
// step 2.2) find who to notify about an employee.
//
// - Server-only, for jobs: they take no actor and must never feed a page or a Server Action.
// - Built field by field from explicit projections: the employee number, name, whether they are
//   separated, their active user and their active supervisors' users. Never a sensitive field,
//   the date hired, the separation date or module access.

/** Who to notify about one employee. */
export interface EmployeeNotificationContact {
  employeeId: string;
  employeeNumber: string;
  /** `First Last`. */
  name: string;
  /** True when the employment status is Resigned, Terminated or Retired. */
  separated: boolean;
  /** The employee's own user id while their account resolves to active; null otherwise. */
  userId: string | null;
  /** The user ids of the active `reportingTo` supervisors, in the stored order, each once. */
  supervisorUserIds: string[];
}

const ACCOUNT_FIELDS = {
  employeeId: 1,
  isSystemAccount: 1,
  systemAccountDisabled: 1,
} as const;

/**
 * Who to notify about each of `employeeIds`: one contact per employee found, in the order given
 * (unknown and malformed ids are left out, each employee once). For background jobs only.
 */
export async function employeeNotificationContacts(
  employeeIds: readonly (Types.ObjectId | string)[],
  { session = null }: { session?: ClientSession | null } = {},
): Promise<EmployeeNotificationContact[]> {
  const ids = employeeIds.flatMap((id) => {
    const objectId = toObjectId(id);
    return objectId ? [objectId] : [];
  });
  if (ids.length === 0) return [];
  await connectDb();
  const employees = await EmployeeModel.find(
    { _id: { $in: ids } },
    { employeeNumber: 1, firstName: 1, lastName: 1, employmentStatus: 1, reportingTo: 1 },
  )
    .session(session)
    .lean();
  if (employees.length === 0) return [];

  const supervisorIds = employees.flatMap((employee) => employee.reportingTo);
  const supervisors = supervisorIds.length
    ? await EmployeeModel.find({ _id: { $in: supervisorIds } }, { employmentStatus: 1 })
        .session(session)
        .lean()
    : [];
  const everyone = [...employees, ...supervisors];
  const users = await UserModel.find(
    { employeeId: { $in: everyone.map((employee) => employee._id) } },
    ACCOUNT_FIELDS,
  )
    .session(session)
    .lean();
  const userByEmployee = new Map(
    users.flatMap((user) => (user.employeeId ? [[user.employeeId.toHexString(), user]] : [])),
  );
  const statusById = new Map(
    everyone.map((employee) => [employee._id.toHexString(), employee.employmentStatus]),
  );

  /** The employee's user id while their account resolves to active. */
  function activeUserId(employeeId: Types.ObjectId): string | null {
    const key = employeeId.toHexString();
    const user = userByEmployee.get(key);
    const employmentStatus = statusById.get(key);
    if (!user || user.isSystemAccount || employmentStatus === undefined) return null;
    return resolveAccountStatus(user, { employmentStatus }) === 'active'
      ? user._id.toHexString()
      : null;
  }

  const byId = new Map(employees.map((employee) => [employee._id.toHexString(), employee]));
  const seen = new Set<string>();
  const contacts: EmployeeNotificationContact[] = [];
  for (const id of ids) {
    const key = id.toHexString();
    const employee = byId.get(key);
    if (!employee || seen.has(key)) continue;
    seen.add(key);
    const supervisorUserIds: string[] = [];
    for (const supervisorId of employee.reportingTo) {
      const userId = activeUserId(supervisorId);
      if (userId && !supervisorUserIds.includes(userId)) supervisorUserIds.push(userId);
    }
    contacts.push({
      employeeId: key,
      employeeNumber: employee.employeeNumber,
      name: employeeName(employee),
      separated: EMPLOYMENT_STATUS[employee.employmentStatus as EmploymentStatus] === 'deactivated',
      userId: activeUserId(employee._id),
      supervisorUserIds,
    });
  }
  return contacts;
}

/**
 * The user ids of every active HR user (a member of the HR department whose account resolves to
 * active), by name. For background jobs only. Empty when no one in HR is active: the caller then
 * notifies the active System Administrators (`activeSystemAdministrators`).
 */
export async function activeHrUserIds({
  session = null,
}: { session?: ClientSession | null } = {}): Promise<string[]> {
  await connectDb();
  const members = await activeHrApprovers(session);
  return members.map((member) => member.userId.toHexString());
}
