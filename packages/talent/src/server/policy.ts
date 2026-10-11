import { AccessDeniedError } from '@pulse/core';
import {
  canRevealSensitive,
  hasModuleAccess,
  isAccounting,
  isBoard,
  isHR,
  isSystemAdministrator,
  type ModuleAccessHolder,
  type RevealActor,
  ROLE_DEPARTMENT_CODES,
  type SensitiveCategory,
} from '@pulse/core/server';

// Spec: SECURITY.md#sensitive-data ("The Talent employee record") and
// docs/modules/talent.md#the-employee-record-build-step-21 (decisions 158, 159, 161 and 162 in
// docs/BUILD_PLAN.md) — who may see and change each part of an employee record. The pages and
// Server Actions use these for their controls and checks; every service checks them again in its
// transaction, against the actor and the employee as they are then.
//
// - Seeing the Compensation, Government IDs and Payroll bank account sections: only a viewer who
//   may reveal that category for that employee (canRevealSensitive).
// - Seeing the date of birth and civil status: HR, Accounting, the System Administrator and the
//   employee; never Talent access alone, Board members included.
// - Changing government IDs, the bank account or compensation: Talent Write and HR or the System
//   Administrator; for an employee in the HR department, Talent Write and the System Administrator
//   or a Board member, never HR. Accounting reveals but never changes.
// - Changing the date of birth or civil status: Talent Write and HR or the System Administrator.
// - Changing any other Talent field: Talent Write.
// - In step 2.1 nobody changes anything on their own record, the System Administrator included.

/** Who reads or changes employee records (a `CurrentUser` fits). */
export interface TalentActor extends RevealActor, ModuleAccessHolder {}

/** The employee a record belongs to, as the rules need it. */
export interface RecordTarget {
  employeeId: string;
  /** The employee's current department code; null for none. */
  departmentCode: string | null;
}

/** The message for a refused change. */
export const TALENT_WRITE_DENIED =
  'You don’t have access to change employee records. Ask HR or the System Administrator.';
export const OWN_RECORD_DENIED =
  'You can’t change your own employee record. Ask HR to change it for you.';
export const SENSITIVE_CHANGE_DENIED =
  'Only HR and the System Administrator change pay, government IDs and bank details.';
export const HR_SENSITIVE_CHANGE_DENIED =
  'Only the System Administrator or a Board member changes pay, government IDs and bank details for HR staff.';
export const BIRTH_AND_CIVIL_STATUS_DENIED =
  'Only HR and the System Administrator change the date of birth and civil status.';
export const TALENT_READ_DENIED =
  'You don’t have access to Pulse Talent. Ask HR or the System Administrator.';

function isOwn(actor: TalentActor, target: RecordTarget): boolean {
  return actor.employee !== null && actor.employee.id === target.employeeId;
}

/** True when `actor` has Talent Read (the employee list and other people's records). */
export function canReadEmployeeRecords(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'read');
}

/** Throws {@link AccessDeniedError} unless `actor` has Talent Read. */
export function assertCanReadEmployeeRecords(actor: TalentActor): void {
  if (!canReadEmployeeRecords(actor)) throw new AccessDeniedError(TALENT_READ_DENIED);
}

/** True when `actor` may see the section of `category` (salary, governmentId, bankAccount). */
export function canSeeSensitiveSection(
  actor: TalentActor,
  category: Extract<SensitiveCategory, 'salary' | 'governmentId' | 'bankAccount'>,
  target: RecordTarget,
): boolean {
  return canRevealSensitive(actor, category, target);
}

/** True when `actor` is sent the date of birth and civil status of `target`. */
export function canSeeBirthAndCivilStatus(actor: TalentActor, target: RecordTarget): boolean {
  return isSystemAdministrator(actor) || isHR(actor) || isAccounting(actor) || isOwn(actor, target);
}

/** Why `actor` may not change `target`'s Talent fields at all, or null when they may. */
function editRefusal(actor: TalentActor, target: RecordTarget): string | null {
  if (!hasModuleAccess(actor, 'talent', 'write')) return TALENT_WRITE_DENIED;
  if (isOwn(actor, target)) return OWN_RECORD_DENIED;
  return null;
}

/** Why `actor` may not change `target`'s IDs, bank account or compensation, or null. */
function sensitiveChangeRefusal(actor: TalentActor, target: RecordTarget): string | null {
  const refusal = editRefusal(actor, target);
  if (refusal) return refusal;
  if (target.departmentCode === ROLE_DEPARTMENT_CODES.hr) {
    return isSystemAdministrator(actor) || isBoard(actor) ? null : HR_SENSITIVE_CHANGE_DENIED;
  }
  return isSystemAdministrator(actor) || isHR(actor) ? null : SENSITIVE_CHANGE_DENIED;
}

/** Why `actor` may not change `target`'s date of birth and civil status, or null. */
function birthAndCivilStatusRefusal(actor: TalentActor, target: RecordTarget): string | null {
  const refusal = editRefusal(actor, target);
  if (refusal) return refusal;
  return isSystemAdministrator(actor) || isHR(actor) ? null : BIRTH_AND_CIVIL_STATUS_DENIED;
}

/** True when `actor` may change `target`'s Personal (other than below) and Employment fields. */
export function canEditEmployeeRecord(actor: TalentActor, target: RecordTarget): boolean {
  return editRefusal(actor, target) === null;
}

/** True when `actor` may change `target`'s date of birth and civil status. */
export function canChangeBirthAndCivilStatus(actor: TalentActor, target: RecordTarget): boolean {
  return birthAndCivilStatusRefusal(actor, target) === null;
}

/** True when `actor` may change `target`'s government IDs, bank account and compensation. */
export function canChangeSensitiveDetails(actor: TalentActor, target: RecordTarget): boolean {
  return sensitiveChangeRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may change `target`'s Talent fields. */
export function assertCanEditEmployeeRecord(actor: TalentActor, target: RecordTarget): void {
  const refusal = editRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** Throws {@link AccessDeniedError} unless `actor` may change the date of birth and civil status. */
export function assertCanChangeBirthAndCivilStatus(actor: TalentActor, target: RecordTarget): void {
  const refusal = birthAndCivilStatusRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** Throws {@link AccessDeniedError} unless `actor` may change IDs, bank and compensation. */
export function assertCanChangeSensitiveDetails(actor: TalentActor, target: RecordTarget): void {
  const refusal = sensitiveChangeRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** True when `actor` gets "Edit in Users" and "Manage access" (HR and the System Administrator). */
export function canManageEmployeeAccount(actor: TalentActor): boolean {
  return isHR(actor) || isSystemAdministrator(actor);
}
