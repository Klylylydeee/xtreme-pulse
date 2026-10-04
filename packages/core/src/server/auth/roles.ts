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

// Spec: docs/modules/core.md#managing-departments-and-positions — until module access arrives in
// build step 1.6, departments and positions are managed by HR and the System Administrator only.
/** True when `user` may view and change departments and positions. */
export const canManageOrgStructure = (user: RoleHolder) =>
  isHR(user) || isSystemAdministrator(user);

// Spec: docs/modules/core.md#company-settings-page — until module access arrives in build step
// 1.6, the company settings (details, logo, allowed email domains, upload settings) are for the
// System Administrator only. The page guards the screen; each service checks again with this.
const SYSTEM_ADMINISTRATOR_ONLY = 'Only the System Administrator can change company settings.';

/** Throws {@link AccessDeniedError} unless `actor` is a System Administrator. */
export function assertSystemAdministrator(
  actor: RoleHolder | null | undefined,
  message: string = SYSTEM_ADMINISTRATOR_ONLY,
): asserts actor is RoleHolder {
  if (!actor || !isSystemAdministrator(actor)) throw new AccessDeniedError(message);
}
