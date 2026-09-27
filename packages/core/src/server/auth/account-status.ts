import { type AccountStatus, EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';

// Spec: SECURITY.md#account-status — account status is derived, never stored. The bootstrap system
// account is active unless another System Administrator disabled it
// (docs/modules/core.md#bootstrap-system-administrator-account); every other account follows its
// employee's employment status.

export interface AccountStatusInput {
  isSystemAccount: boolean;
  systemAccountDisabled: boolean;
}

/**
 * The account status of `user`. `employee` is the linked employee, or null when none was found.
 * An ordinary account with no employee record, or an unknown employment status, is deactivated:
 * the check fails closed.
 */
export function resolveAccountStatus(
  user: AccountStatusInput,
  employee: { employmentStatus: string } | null,
): AccountStatus {
  if (user.isSystemAccount) return user.systemAccountDisabled ? 'deactivated' : 'active';
  if (!employee) return 'deactivated';
  const status = employee.employmentStatus;
  return Object.hasOwn(EMPLOYMENT_STATUS, status)
    ? EMPLOYMENT_STATUS[status as EmploymentStatus]
    : 'deactivated';
}
