import {
  type DepartmentRole,
  isAccounting,
  isBoard,
  isHR,
  isSystemAdministrator,
  ROLE_DEPARTMENT_CODES,
} from '../auth/roles';
import type { SensitiveCategory, SensitiveSubject } from './registry';

// Spec: SECURITY.md#sensitive-data — who may reveal a sensitive value.
//
// - The System Administrator, HR and Accounting: any category, any record.
// - The employee: anything on their own record.
// - The Board of Directors: salary, allowances, government IDs and bank accounts of employees in
//   the HR department only (HR can't change these for their own department).
// - Everyone else: nothing. Module access never grants a reveal.
//
// The cases that depend on context (the approving supervisor's view of one medical certificate,
// the Board's views of payroll runs and disciplinary cases) are refused here until the step that
// builds them adds them to SECURITY.md and to this function.

/** What the reveal rules read from the signed-in user (a `CurrentUser` fits). */
export interface RevealActor {
  id: string;
  email: string;
  isSystemAdministrator: boolean;
  roles: readonly DepartmentRole[];
  employee: { id: string } | null;
}

const BOARD_HR_CATEGORIES: ReadonlySet<SensitiveCategory> = new Set([
  'salary',
  'allowances',
  'governmentId',
  'bankAccount',
]);

/** True when `actor` may reveal a value of `category` belonging to `subject`. */
export function canRevealSensitive(
  actor: RevealActor,
  category: SensitiveCategory,
  subject: SensitiveSubject | null,
): boolean {
  if (isSystemAdministrator(actor) || isHR(actor) || isAccounting(actor)) return true;
  if (!subject) return false;
  if (actor.employee && actor.employee.id === subject.employeeId) return true;
  if (
    isBoard(actor) &&
    subject.departmentCode === ROLE_DEPARTMENT_CODES.hr &&
    BOARD_HR_CATEGORIES.has(category)
  ) {
    return true;
  }
  return false;
}
