import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { EmploymentStatus } from '../../account';
import { normalizeModuleAccess } from '../../module-access';
import { needsAccess } from '../../user-access';
import { resolveAccountStatus } from '../auth/account-status';
import { ROLE_DEPARTMENT_CODES } from '../auth/roles';
import { DepartmentModel } from '../departments/model';
import { toObjectId } from '../paging';
import { UserModel } from '../users/model';
import { EmployeeModel } from './model';

// Spec: docs/modules/core.md#people-data-ownership ("Onboarding facts", build step 2.6, decision
// 274 in docs/BUILD_PLAN.md) — what Pulse Talent's onboarding checklist needs from Core
// (docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26). Talent reads
// these facts here, never through Core's collections.
//
// - Server-only, with no actor: Talent's onboarding service calls it after its own access check.
// - Built field by field from explicit projections. Never a sensitive field, the password hash,
//   the date hired, the separation date, or module access beyond the "Needs access" flag.

/** Core's facts about one employee, for the onboarding checklist. */
export interface EmployeeOnboardingFacts {
  employeeId: string;
  /** The employee's user id, or null when they have no account. */
  userId: string | null;
  /** The account still has a temporary password (`mustChangePassword`). False with no account. */
  hasTemporaryPassword: boolean;
  /**
   * In the User access page's "Needs access" group: an active account that isn't a System
   * Administrator (nor the system account) with None stored on every module. False with no
   * account, and for an account that isn't active.
   */
  needsAccess: boolean;
  /** A profile photo is set. */
  hasPhoto: boolean;
  /** In the Board of Directors department (a retired department still counts by its code). */
  isBoardMember: boolean;
  /** How many distinct `reportingTo` supervisors have an account that resolves to active. */
  activeSupervisorCount: number;
  departmentId: string;
  positionId: string;
  employmentStatus: EmploymentStatus;
}

const USER_FIELDS = {
  employeeId: 1,
  mustChangePassword: 1,
  isSystemAdministrator: 1,
  isSystemAccount: 1,
  systemAccountDisabled: 1,
  moduleAccess: 1,
} as const;

/**
 * Core's onboarding facts for each of `employeeIds`: one entry per employee found, in the order
 * given (unknown and malformed ids are left out, each employee once). Server-only, no actor: the
 * caller checks access first.
 */
export async function employeeOnboardingFacts(
  employeeIds: readonly (Types.ObjectId | string)[],
  { session = null }: { session?: ClientSession | null } = {},
): Promise<EmployeeOnboardingFacts[]> {
  const ids = employeeIds.flatMap((id) => {
    const objectId = toObjectId(id);
    return objectId ? [objectId] : [];
  });
  if (ids.length === 0) return [];
  await connectDb();
  const employees = await EmployeeModel.find(
    { _id: { $in: ids } },
    { departmentId: 1, positionId: 1, employmentStatus: 1, reportingTo: 1, photoFileId: 1 },
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
    USER_FIELDS,
  )
    .session(session)
    .lean();
  const boardDepartments = await DepartmentModel.find(
    { code: ROLE_DEPARTMENT_CODES.board },
    { _id: 1 },
    { withDeleted: true },
  )
    .session(session)
    .lean();

  const userByEmployee = new Map(
    users.flatMap((user) => (user.employeeId ? [[user.employeeId.toHexString(), user]] : [])),
  );
  const statusById = new Map(
    everyone.map((employee) => [employee._id.toHexString(), employee.employmentStatus]),
  );
  const boardIds = new Set(boardDepartments.map((department) => department._id.toHexString()));

  /** True when the employee has an account that resolves to active (never the system account). */
  function isActive(employeeId: Types.ObjectId): boolean {
    const key = employeeId.toHexString();
    const user = userByEmployee.get(key);
    const employmentStatus = statusById.get(key);
    if (!user || user.isSystemAccount || employmentStatus === undefined) return false;
    return resolveAccountStatus(user, { employmentStatus }) === 'active';
  }

  const byId = new Map(employees.map((employee) => [employee._id.toHexString(), employee]));
  const seen = new Set<string>();
  const facts: EmployeeOnboardingFacts[] = [];
  for (const id of ids) {
    const key = id.toHexString();
    const employee = byId.get(key);
    if (!employee || seen.has(key)) continue;
    seen.add(key);
    const user = userByEmployee.get(key) ?? null;
    const activeSupervisors = new Set(
      employee.reportingTo
        .filter((supervisorId) => isActive(supervisorId))
        .map((supervisorId) => supervisorId.toHexString()),
    );
    facts.push({
      employeeId: key,
      userId: user?._id.toHexString() ?? null,
      hasTemporaryPassword: user?.mustChangePassword === true,
      // The same rule as the User access page's group (access/service.ts, decision 68).
      needsAccess:
        user !== null &&
        isActive(employee._id) &&
        !user.isSystemAdministrator &&
        needsAccess(normalizeModuleAccess(user.moduleAccess)),
      hasPhoto: employee.photoFileId != null,
      isBoardMember: boardIds.has(employee.departmentId.toHexString()),
      activeSupervisorCount: activeSupervisors.size,
      departmentId: employee.departmentId.toHexString(),
      positionId: employee.positionId.toHexString(),
      employmentStatus: employee.employmentStatus,
    });
  }
  return facts;
}
