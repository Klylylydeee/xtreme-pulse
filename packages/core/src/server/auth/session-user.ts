import { isValidObjectId } from 'mongoose';
import { connectDb } from '@pulse/db';
import { SESSION_MAX_AGE_HOURS } from '../../account';
import { now } from '../../dates';
import type { ModuleAccess } from '../../module-access';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { UserModel } from '../users/model';
import { resolveAccountStatus } from './account-status';
import { resolveModuleAccess } from './module-access';
import { type DepartmentRole, departmentRolesFor } from './roles';

// Spec: SECURITY.md#account-status — JWT sessions can't be revoked on their own, so the account is
// reloaded on every request: a deactivated user is signed out at once, and a department move
// changes the user's roles from their next request (SECURITY.md#roles). Module access is resolved
// from the same account read, so a change to it also applies from the next request
// (SECURITY.md#resolving-and-enforcing-build-step-16).

/** The signed-in user, as pages and actions see it. Never holds the password hash. */
export interface CurrentUser {
  id: string;
  email: string;
  /** True while the password is temporary: every page but change-password is closed. */
  mustChangePassword: boolean;
  isSystemAdministrator: boolean;
  /** The bootstrap system account, which has no employee. */
  isSystemAccount: boolean;
  employee: { id: string; name: string; departmentCode: string | null } | null;
  /** HR, Accounting and Board, from the employee's department. */
  roles: DepartmentRole[];
  /**
   * The effective access per module, never the stored map: Owner on every module and Read on
   * Insight for a System Administrator, otherwise the stored levels with a missing one as None.
   */
  moduleAccess: ModuleAccess;
}

const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_HOURS * 60 * 60 * 1000;
// A sign-in time this far ahead of the server clock is accepted (clock skew between servers).
// Anything later is refused, or the session would never expire.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** True while a session started at `signedInAt` (seconds since the epoch) is within its limit. */
export function isSessionCurrent(signedInAt: number): boolean {
  if (!Number.isFinite(signedInAt)) return false;
  const age = now().getTime() - signedInAt * 1000;
  return age > -MAX_CLOCK_SKEW_MS && age < SESSION_MAX_AGE_MS;
}

/**
 * False when a session started at `signedInAt` (seconds since the epoch) began before the user's
 * `sessionsValidFrom`, which a password reset sets (SECURITY.md#sign-in-and-passwords). Null means
 * no reset yet: every session counts.
 *
 * `signedInAt` is whole seconds, rounded down, so a sign-in in the same second as the reset but
 * after it reads as before it and is refused too: the user signs in once more. It fails closed.
 */
export function isSessionAfterReset(signedInAt: number, sessionsValidFrom: Date | null): boolean {
  if (sessionsValidFrom === null) return true;
  const validFrom = sessionsValidFrom.getTime();
  if (!Number.isFinite(signedInAt) || Number.isNaN(validFrom)) return false;
  return signedInAt * 1000 >= validFrom;
}

/**
 * Loads the signed-in user fresh from the database. Returns null, so the caller signs the user
 * out, when the account no longer exists, is deactivated, the session is past
 * SESSION_MAX_AGE_HOURS from `signedInAt` (seconds since the epoch, set once at sign-in), or it
 * started before the user's `sessionsValidFrom` (a password reset ends every session).
 *
 * The proxy (apps/web/proxy.ts) and the pages, layouts and Server Actions (apps/web/lib/auth.ts)
 * all come through here, so each of them applies every one of these checks.
 */
export async function loadSessionUser(
  userId: string,
  signedInAt: number,
): Promise<CurrentUser | null> {
  if (!isSessionCurrent(signedInAt) || !isValidObjectId(userId)) return null;
  await connectDb();

  const user = await UserModel.findById(userId).lean();
  if (!user || !isSessionAfterReset(signedInAt, user.sessionsValidFrom ?? null)) return null;

  let employee: CurrentUser['employee'] = null;
  let employment: { employmentStatus: string } | null = null;
  if (!user.isSystemAccount && user.employeeId) {
    const record = await EmployeeModel.findById(user.employeeId).lean();
    if (record) {
      employment = record;
      // A retired department keeps its code, and its members keep its role until they move.
      const department = await DepartmentModel.findById(
        record.departmentId,
        { code: 1 },
        { withDeleted: true },
      ).lean();
      employee = {
        id: record._id.toString(),
        name: `${record.firstName} ${record.lastName}`,
        departmentCode: department?.code ?? null,
      };
    }
  }

  if (resolveAccountStatus(user, employment) !== 'active') return null;

  return {
    id: user._id.toString(),
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    isSystemAdministrator: user.isSystemAdministrator,
    isSystemAccount: user.isSystemAccount,
    employee,
    // The system account has no department, so no department role.
    roles: user.isSystemAccount ? [] : departmentRolesFor(employee?.departmentCode ?? null),
    moduleAccess: resolveModuleAccess(user),
  };
}
