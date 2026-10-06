import { AccessDeniedError } from '../../actions';

// Spec: SECURITY.md#roles — the HR, Accounting and Board of Directors roles follow the employee's
// department, from their next request. The System Administrator role is a flag on the account,
// granted only by another System Administrator. The bootstrap system account has no department,
// so it holds no department role (docs/modules/core.md#bootstrap-system-administrator-account).

/** The department code behind each department role. Department codes never change. */
export const ROLE_DEPARTMENT_CODES = {
  hr: 'HR',
  accounting: 'ACCT',
  board: 'BOD',
} as const;

export type DepartmentRole = keyof typeof ROLE_DEPARTMENT_CODES;
export type Role = DepartmentRole | 'systemAdministrator';

const DEPARTMENT_ROLES = Object.keys(ROLE_DEPARTMENT_CODES) as DepartmentRole[];

/** The department roles that come with `departmentCode` (none for no department). */
export function departmentRolesFor(departmentCode: string | null): DepartmentRole[] {
  if (!departmentCode) return [];
  return DEPARTMENT_ROLES.filter((role) => ROLE_DEPARTMENT_CODES[role] === departmentCode);
}

/** What the role helpers read from a signed-in user. */
export interface RoleHolder {
  isSystemAdministrator: boolean;
  roles: readonly DepartmentRole[];
}

/** True when `user` holds `role`. */
export function hasRole(user: RoleHolder, role: Role): boolean {
  return role === 'systemAdministrator' ? user.isSystemAdministrator : user.roles.includes(role);
}

/** A member of the Human Resource department (`HR`). */
export const isHR = (user: RoleHolder) => hasRole(user, 'hr');
/** A member of the Accounting department (`ACCT`). */
export const isAccounting = (user: RoleHolder) => hasRole(user, 'accounting');
/** A member of the Board of Directors department (`BOD`). */
export const isBoard = (user: RoleHolder) => hasRole(user, 'board');
/** A System Administrator (the account flag, not a department). */
export const isSystemAdministrator = (user: RoleHolder) => hasRole(user, 'systemAdministrator');

// Spec: docs/modules/core.md#managing-departments-and-positions — departments and positions are
// managed by HR and the System Administrator, checked by role, not module access
// (SECURITY.md#rules, decision 54 in docs/BUILD_PLAN.md).
/** True when `user` may view and change departments and positions. */
export const canManageOrgStructure = (user: RoleHolder) =>
  isHR(user) || isSystemAdministrator(user);

// Spec: docs/modules/core.md#managing-user-accounts, SECURITY.md#system-administrator and
// SECURITY.md#sign-in-and-passwords — who may do what on `/admin/users` (decisions 31–37 in
// docs/BUILD_PLAN.md). Users are managed by HR and the System Administrator, checked by role, not
// module access (decision 54). The page uses these for its row actions; each service checks them
// again itself.

/** True when `user` may list, create and edit user accounts. */
export const canManageUsers = (user: RoleHolder) => isHR(user) || isSystemAdministrator(user);

/** The account an action on `/admin/users` is aimed at. */
export interface AccountTarget {
  /** The user ID. */
  id: string;
  isSystemAdministrator: boolean;
  /** The bootstrap system account. */
  isSystemAccount: boolean;
}

/** An actor on `/admin/users`: a role holder with an ID (a `CurrentUser` fits). */
export interface AccountActor extends RoleHolder {
  id: string;
}

/** A System Administrator's account, or the bootstrap system account. */
function isAdministratorAccount(target: AccountTarget): boolean {
  return target.isSystemAdministrator || target.isSystemAccount;
}

/**
 * True when `actor` may edit `target`'s identity (name, department, position, reporting lines,
 * date hired). Nobody edits their own row, and the system account is read-only. HR may edit a
 * System Administrator's identity, apart from the email and employment status
 * ({@link canChangeProtectedFieldsOf}).
 */
export function canEditAccountOf(actor: AccountActor, target: AccountTarget): boolean {
  return canManageUsers(actor) && actor.id !== target.id && !target.isSystemAccount;
}

/**
 * True when `actor` may change `target`'s email and employment status: as {@link canEditAccountOf},
 * and a System Administrator's only by another System Administrator.
 */
export function canChangeProtectedFieldsOf(actor: AccountActor, target: AccountTarget): boolean {
  return (
    canEditAccountOf(actor, target) &&
    (!isAdministratorAccount(target) || isSystemAdministrator(actor))
  );
}

/**
 * True when `actor` may reset `target`'s password. Never one's own (that is `/change-password`).
 * A System Administrator's, and the system account's, only by a different System Administrator;
 * HR may reset anyone else's, HR staff and Board members included.
 */
export function canResetPasswordOf(actor: AccountActor, target: AccountTarget): boolean {
  if (!canManageUsers(actor) || actor.id === target.id) return false;
  return !isAdministratorAccount(target) || isSystemAdministrator(actor);
}

// Spec: docs/modules/core.md#company-settings-page — the company settings (details, logo, allowed
// email domains, upload settings) are for the System Administrator only, checked by role, not
// module access (decision 54). The page guards the screen; each service checks again with this.
const SYSTEM_ADMINISTRATOR_ONLY = 'Only the System Administrator can change company settings.';

/** Throws {@link AccessDeniedError} unless `actor` is a System Administrator. */
export function assertSystemAdministrator(
  actor: RoleHolder | null | undefined,
  message: string = SYSTEM_ADMINISTRATOR_ONLY,
): asserts actor is RoleHolder {
  if (!actor || !isSystemAdministrator(actor)) throw new AccessDeniedError(message);
}

// Spec: docs/modules/core.md#user-access-page and SECURITY.md#module-access-rwo — who may set
// module access on `/admin/access` (decisions 65–80 in docs/BUILD_PLAN.md). Checked by role, not
// module access (decision 54). The page uses these for its read-only rows and the switch; the
// access service checks them again itself, in its transaction.

/** True when `user` may list users' access and set it (HR and the System Administrator). */
export const canManageAccess = (user: RoleHolder) => isHR(user) || isSystemAdministrator(user);

/**
 * True when `actor` may change `target`'s module levels. Never one's own, never the bootstrap
 * system account, and a System Administrator's only by a System Administrator.
 */
export function canEditAccessOf(actor: AccountActor, target: AccountTarget): boolean {
  return (
    canManageAccess(actor) &&
    actor.id !== target.id &&
    !target.isSystemAccount &&
    (!target.isSystemAdministrator || isSystemAdministrator(actor))
  );
}

/**
 * True when `actor` may turn `target`'s System Administrator switch on or off: only a System
 * Administrator, never on their own row or the bootstrap system account. Turning it off is also
 * refused when it would leave no active System Administrator (auth/administrators.ts).
 */
export function canToggleSystemAdministrator(actor: AccountActor, target: AccountTarget): boolean {
  return isSystemAdministrator(actor) && actor.id !== target.id && !target.isSystemAccount;
}
