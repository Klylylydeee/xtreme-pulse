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

// ---------------------------------------------------------------------------------------------
// Step 2.2: 201 documents, certifications, skills, the e-signature and the expiry alert setting
// (SECURITY.md#sensitive-data, "201 documents, the photo and the e-signature"; decisions 175, 179,
// 180, 182–184 and 187 in docs/BUILD_PLAN.md).
//
// - Seeing others' 201 documents: Talent Read and the reveal rule for the category (`file201`, or
//   `medical`, which Accounting doesn't get). The employee always sees their own.
// - Adding, editing and archiving: Talent Write and HR or the System Administrator, never on one's
//   own record. HR may manage other HR staff's documents.
// - Certifications: adding and editing need Talent Write, removing Talent Owner, never on one's
//   own record. The attachment opens for the employee, Talent Read and the System Administrator.
// - Skills: Talent Write, never on one's own record.
// - The e-signature: only its owner uploads and applies it; its image opens for the owner and the
//   System Administrator only.
// - The certification read services: Talent, Engage or Ops Read, or the System Administrator.
// - The expiry alert setting: Talent Owner.

export const DOCUMENTS_MANAGE_DENIED =
  'Only HR and the System Administrator, with Talent Write, change 201 file documents.';
export const CERTIFICATION_REMOVE_DENIED =
  'You need Talent Owner access to remove a certification. Ask HR or the System Administrator.';
export const NO_EMPLOYEE_SIGNATURE =
  'The system account has no employee record, so it has no e-signature.';
export const CERTIFICATIONS_READ_DENIED =
  'You need Talent, Engage or Ops access to see certifications. Ask HR or the System Administrator.';
export const EXPIRY_SETTINGS_DENIED =
  'You need Talent Owner access to change the expiry alert settings. Ask HR or the System Administrator.';

/** True when `actor` may see `target`'s 201 documents of `category` (and their files). */
export function canSeeDocumentCategory(
  actor: TalentActor,
  category: Extract<SensitiveCategory, 'file201' | 'medical'>,
  target: RecordTarget,
): boolean {
  if (isOwn(actor, target)) return true;
  return canReadEmployeeRecords(actor) && canRevealSensitive(actor, category, target);
}

/** Why `actor` may not add, edit or archive `target`'s 201 documents, or null. */
function documentsRefusal(actor: TalentActor, target: RecordTarget): string | null {
  const refusal = editRefusal(actor, target);
  if (refusal) return refusal;
  return isSystemAdministrator(actor) || isHR(actor) ? null : DOCUMENTS_MANAGE_DENIED;
}

/** True when `actor` may add, edit and archive `target`'s 201 documents. */
export function canManageDocuments(actor: TalentActor, target: RecordTarget): boolean {
  return documentsRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may add, edit and archive the documents. */
export function assertCanManageDocuments(actor: TalentActor, target: RecordTarget): void {
  const refusal = documentsRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** True when `actor` may add and edit `target`'s certifications (Talent Write, not their own). */
export function canEditCertifications(actor: TalentActor, target: RecordTarget): boolean {
  return editRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may add and edit the certifications. */
export function assertCanEditCertifications(actor: TalentActor, target: RecordTarget): void {
  assertCanEditEmployeeRecord(actor, target);
}

/** Why `actor` may not remove `target`'s certifications, or null. */
function certificationRemoveRefusal(actor: TalentActor, target: RecordTarget): string | null {
  const refusal = editRefusal(actor, target);
  if (refusal) return refusal;
  return hasModuleAccess(actor, 'talent', 'owner') ? null : CERTIFICATION_REMOVE_DENIED;
}

/** True when `actor` may remove `target`'s certifications (Talent Owner, not their own). */
export function canRemoveCertifications(actor: TalentActor, target: RecordTarget): boolean {
  return certificationRemoveRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may remove the certifications. */
export function assertCanRemoveCertifications(actor: TalentActor, target: RecordTarget): void {
  const refusal = certificationRemoveRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** True when `actor` may open the attachment of a certification of `employeeId`. */
export function canOpenCertificationAttachment(actor: TalentActor, employeeId: string): boolean {
  return (
    (actor.employee !== null && actor.employee.id === employeeId) ||
    canReadEmployeeRecords(actor) ||
    isSystemAdministrator(actor)
  );
}

/** True when `actor` may change `target`'s skills (Talent Write, not their own). */
export function canEditSkills(actor: TalentActor, target: RecordTarget): boolean {
  return editRefusal(actor, target) === null;
}

/** True when `actor` may see the e-signature images of `employeeId`: the owner and the System Administrator. */
export function canSeeESignatureImage(actor: TalentActor, employeeId: string): boolean {
  return (
    (actor.employee !== null && actor.employee.id === employeeId) || isSystemAdministrator(actor)
  );
}

/** True when `actor` may call the certification read services. */
export function canReadCertifications(actor: TalentActor): boolean {
  return (
    isSystemAdministrator(actor) ||
    hasModuleAccess(actor, 'talent', 'read') ||
    hasModuleAccess(actor, 'engage', 'read') ||
    hasModuleAccess(actor, 'ops', 'read')
  );
}

/** Throws {@link AccessDeniedError} unless `actor` may call the certification read services. */
export function assertCanReadCertifications(actor: TalentActor): void {
  if (!canReadCertifications(actor)) throw new AccessDeniedError(CERTIFICATIONS_READ_DENIED);
}

/** True when `actor` may change the expiry alert lead days (Talent Owner). */
export function canChangeExpiryAlertSettings(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'owner');
}

/** Throws {@link AccessDeniedError} unless `actor` may change the expiry alert lead days. */
export function assertCanChangeExpiryAlertSettings(actor: TalentActor): void {
  if (!canChangeExpiryAlertSettings(actor)) throw new AccessDeniedError(EXPIRY_SETTINGS_DENIED);
}

// ---------------------------------------------------------------------------------------------
// Step 2.3: payroll settings, allowances and the wage order list (SECURITY.md#sensitive-data,
// "Payroll settings and allowances"; decisions 198, 203, 204 and 207 in docs/BUILD_PLAN.md).
//
// - Viewing the payroll settings: Talent Read (the rates aren't sensitive).
// - Adding a version: Talent Owner and HR or the System Administrator.
// - Seeing an employee's allowances: whoever may reveal `allowances` for that employee.
// - Assigning allowances: the salary rule (canChangeSensitiveDetails).
// - The wage order list and counts: Talent Read and HR, Accounting or the System Administrator.

export const PAYROLL_SETTINGS_CHANGE_DENIED =
  'Only HR or the System Administrator, with Talent Owner access, add payroll settings versions.';
export const WAGE_ORDER_LIST_DENIED =
  'The wage order list is visible to HR, Accounting and the System Administrator, with Talent access.';

/** True when `actor` may add a payroll settings version. */
export function canAddPayrollSettingsVersion(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'owner') && (isHR(actor) || isSystemAdministrator(actor));
}

/** Throws {@link AccessDeniedError} unless `actor` may add a payroll settings version. */
export function assertCanAddPayrollSettingsVersion(actor: TalentActor): void {
  if (!canAddPayrollSettingsVersion(actor)) {
    throw new AccessDeniedError(PAYROLL_SETTINGS_CHANGE_DENIED);
  }
}

/** True when `actor` is sent `target`'s allowances (the reveal rule for `allowances`). */
export function canSeeAllowances(actor: TalentActor, target: RecordTarget): boolean {
  return canRevealSensitive(actor, 'allowances', target);
}

/** True when `actor` may see the wage order counts and list. */
export function canViewWageOrderList(actor: TalentActor): boolean {
  return (
    canReadEmployeeRecords(actor) &&
    (isHR(actor) || isAccounting(actor) || isSystemAdministrator(actor))
  );
}

/** Throws {@link AccessDeniedError} unless `actor` may see the wage order counts and list. */
export function assertCanViewWageOrderList(actor: TalentActor): void {
  if (!canReadEmployeeRecords(actor)) throw new AccessDeniedError(TALENT_READ_DENIED);
  if (!canViewWageOrderList(actor)) throw new AccessDeniedError(WAGE_ORDER_LIST_DENIED);
}

// ---------------------------------------------------------------------------------------------
// Step 2.4: work schedules and timesheets (SECURITY.md#exceptions-to-module-access, "The own
// timesheet" and "Supervisors see their team's timesheets"; decisions 215 and 221 in
// docs/BUILD_PLAN.md).
//
// - Setting an employee's own schedule: Talent Write and HR or the System Administrator, never on
//   one's own record. HR may set HR staff's (a schedule isn't pay).
// - Seeing a schedule or a timesheet: the employee, Talent Read, or a supervisor in the
//   employee's `reportingTo` (read-only, whatever their module access).
// - Changing time entries: the employee alone, on their own employee; nobody changes another
//   person's entries in step 2.4, HR and the System Administrator included.

export const WORK_SCHEDULE_SET_DENIED =
  'Only HR and the System Administrator, with Talent Write, set work schedules.';
export const NO_EMPLOYEE_TIMESHEET =
  'The system account has no employee record, so it has no timesheet.';
export const TIMESHEET_DENIED = 'You don’t have access to this timesheet.';

/** Who a timesheet or schedule belongs to, as the viewing rule needs it. */
export interface TimesheetTarget {
  employeeId: string;
  /** The employee's supervisors' employee ids. */
  reportingTo: readonly { id: string }[];
}

/** Why `actor` may not set `target`'s work schedule, or null when they may. */
function workScheduleRefusal(actor: TalentActor, target: RecordTarget): string | null {
  const refusal = editRefusal(actor, target);
  if (refusal) return refusal;
  return isSystemAdministrator(actor) || isHR(actor) ? null : WORK_SCHEDULE_SET_DENIED;
}

/** True when `actor` may set `target`'s work schedule ("Set schedule"). */
export function canSetWorkSchedule(actor: TalentActor, target: RecordTarget): boolean {
  return workScheduleRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may set `target`'s work schedule. */
export function assertCanSetWorkSchedule(actor: TalentActor, target: RecordTarget): void {
  const refusal = workScheduleRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** True when `actor` is one of `target`'s `reportingTo` supervisors. */
export function isSupervisorOf(actor: TalentActor, target: TimesheetTarget): boolean {
  const own = actor.employee?.id;
  return own !== undefined && target.reportingTo.some((supervisor) => supervisor.id === own);
}

/** True when `actor` may open `target`'s timesheet and schedule (read-only unless their own). */
export function canViewTimesheet(actor: TalentActor, target: TimesheetTarget): boolean {
  return (
    (actor.employee !== null && actor.employee.id === target.employeeId) ||
    canReadEmployeeRecords(actor) ||
    isSupervisorOf(actor, target)
  );
}

/** Throws {@link AccessDeniedError} unless `actor` may open `target`'s timesheet. */
export function assertCanViewTimesheet(actor: TalentActor, target: TimesheetTarget): void {
  if (!canViewTimesheet(actor, target)) throw new AccessDeniedError(TIMESHEET_DENIED);
}
