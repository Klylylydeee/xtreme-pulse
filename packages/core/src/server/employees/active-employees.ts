import type { ClientSession, Types } from 'mongoose';
import { EMPLOYMENT_STATUS, EMPLOYMENT_STATUSES } from '../../account';
import { resolveAccountStatus } from '../auth/account-status';
import { UserModel } from '../users/model';
import { type EmployeeRecord, EmployeeModel } from './model';

// Spec: SECURITY.md#account-status — "an employee whose account is active", the rule behind the
// department head picker (docs/modules/core.md#managing-departments-and-positions) and the owning
// Account Manager on a client (docs/modules/engage.md#clients-sites-and-contacts). An employee
// counts only when they have an account and it resolves to active, so an employee with no account
// counts as inactive. The bootstrap system account has no employee record, so it never matches.

/** The employment statuses whose account is active (SECURITY.md#account-status). */
export const ACTIVE_EMPLOYMENT_STATUSES = EMPLOYMENT_STATUSES.filter(
  (status) => EMPLOYMENT_STATUS[status] === 'active',
);

/** Matches employees whose employment status is active. */
export const ACTIVE_EMPLOYEES = { employmentStatus: { $in: ACTIVE_EMPLOYMENT_STATUSES } };

/** `First Last`, as the directory shows it. */
export function employeeName(employee: { firstName: string; lastName: string }): string {
  return `${employee.firstName} ${employee.lastName}`;
}

/** True when the employee exists and their account resolves to active. */
export async function isActiveEmployee(
  employeeId: Types.ObjectId,
  session: ClientSession | null,
): Promise<boolean> {
  const employee = await EmployeeModel.findById(employeeId, { employmentStatus: 1 })
    .session(session)
    .lean();
  if (!employee) return false;
  const user = await UserModel.findOne(
    { employeeId },
    { isSystemAccount: 1, systemAccountDisabled: 1 },
  )
    .session(session)
    .lean();
  return user !== null && resolveAccountStatus(user, employee) === 'active';
}

/**
 * Whether each employee's account resolves to active, keyed by employee ID: the same rule as
 * {@link isActiveEmployee}, so an employee with no account counts as inactive.
 */
export async function activeEmployeeMap(
  employees: { _id: Types.ObjectId; employmentStatus: string }[],
): Promise<Map<string, boolean>> {
  if (employees.length === 0) return new Map();
  const users = await UserModel.find(
    { employeeId: { $in: employees.map((employee) => employee._id) } },
    { employeeId: 1, isSystemAccount: 1, systemAccountDisabled: 1 },
  ).lean();
  const userByEmployee = new Map(users.map((user) => [user.employeeId?.toHexString(), user]));
  return new Map(
    employees.map((employee) => {
      const id = employee._id.toHexString();
      const user = userByEmployee.get(id);
      return [id, user !== undefined && resolveAccountStatus(user, employee) === 'active'];
    }),
  );
}

/** An employee found by {@link searchActiveEmployees}. */
export type ActiveEmployeeMatch = Pick<
  EmployeeRecord,
  '_id' | 'firstName' | 'lastName' | 'employeeNumber' | 'employmentStatus' | 'departmentId'
>;

export const ACTIVE_EMPLOYEE_SEARCH_LIMIT = 20;
// Read more than the limit, since some candidates may have no active account.
const CANDIDATE_LIMIT = 100;
const SEARCH_MAX_LENGTH = 100;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Employees whose account resolves to active, from any department, for an employee picker:
 * each word of `search` matched on first name, last name or employee number, by last name, at
 * most {@link ACTIVE_EMPLOYEE_SEARCH_LIMIT}.
 */
export async function searchActiveEmployees(search = ''): Promise<ActiveEmployeeMatch[]> {
  const filter: Record<string, unknown> = { ...ACTIVE_EMPLOYEES };
  const words = search.trim().slice(0, SEARCH_MAX_LENGTH).split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    filter.$and = words.map((word) => {
      const pattern = new RegExp(escapeRegExp(word), 'i');
      return {
        $or: [{ firstName: pattern }, { lastName: pattern }, { employeeNumber: pattern }],
      };
    });
  }
  const candidates = await EmployeeModel.find(filter, {
    firstName: 1,
    lastName: 1,
    employeeNumber: 1,
    employmentStatus: 1,
    departmentId: 1,
  })
    .sort({ lastName: 1, firstName: 1, _id: 1 })
    .limit(CANDIDATE_LIMIT)
    .lean();
  if (candidates.length === 0) return [];

  const active = await activeEmployeeMap(candidates);
  return candidates
    .filter((employee) => active.get(employee._id.toHexString()) === true)
    .slice(0, ACTIVE_EMPLOYEE_SEARCH_LIMIT);
}
