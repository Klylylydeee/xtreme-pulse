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
// - From step 2.7 (decision 285): anyone who is or was an approver on one of the timesheet's
//   approval requests (Core's `isApproverFor` on `talent.timesheet`) also opens it, read-only and
//   whatever their module access, with directory fields only when they lack Talent Read.
//   Decisions are made on /approvals; corrections still come through a return (HANDOFF item 54).
// - The timesheets list (step 2.7): Talent Read (HANDOFF item 135).

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

/**
 * True when `actor` may open `target`'s timesheet and schedule (read-only unless their own).
 * `approver` is the caller's answer to Core's `isApproverFor` for that timesheet (step 2.7).
 */
export function canViewTimesheet(
  actor: TalentActor,
  target: TimesheetTarget,
  { approver = false }: { approver?: boolean } = {},
): boolean {
  return (
    (actor.employee !== null && actor.employee.id === target.employeeId) ||
    canReadEmployeeRecords(actor) ||
    isSupervisorOf(actor, target) ||
    approver
  );
}

/** Throws {@link AccessDeniedError} unless `actor` may open `target`'s timesheet. */
export function assertCanViewTimesheet(
  actor: TalentActor,
  target: TimesheetTarget,
  options: { approver?: boolean } = {},
): void {
  if (!canViewTimesheet(actor, target, options)) throw new AccessDeniedError(TIMESHEET_DENIED);
}

/** True when `actor` sees the timesheets list (`/talent/timesheets`): Talent Read (item 135). */
export function canSeeTimesheetsList(actor: TalentActor): boolean {
  return canReadEmployeeRecords(actor);
}

/** Throws {@link AccessDeniedError} unless `actor` may see the timesheets list. */
export function assertCanSeeTimesheetsList(actor: TalentActor): void {
  if (!canSeeTimesheetsList(actor)) throw new AccessDeniedError(TALENT_READ_DENIED);
}

// ---------------------------------------------------------------------------------------------
// Step 2.6: the onboarding checklist, verification and change requests (SECURITY.md#sensitive-
// data, SECURITY.md#exceptions-to-module-access and
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26; decisions 260,
// 265, 267, 269, 273 and 274 in docs/BUILD_PLAN.md).
//
// - Verifying government IDs or the bank account ("Mark verified", and a save that verifies):
//   whoever may change that group directly (canChangeSensitiveDetails), never on one's own record.
//   Accounting never verifies.
// - "No supervisor": Talent Read and HR, a Board member or the System Administrator, never on
//   one's own record.
// - Own entries: the employee, on their own employee only (self-service, no module access).
// - Approving a change request, checked again at the decision against the employee as they are
//   then: Contact details and Skills, any approver named at submit; Personal details, HR or the
//   System Administrator; government IDs and the bank account, HR or the System Administrator, and
//   for an employee in the HR department a Board member or the System Administrator.
// - Seeing a change request: its requester, its approvers, the System Administrator, and Talent
//   Read users who may see that section of the employee's record.
// - The /talent onboarding filter and tiles: Talent Read and HR or the System Administrator.

export const VERIFY_DENIED =
  'Only HR and the System Administrator, with Talent Write, verify government IDs and bank details.';
export const HR_VERIFY_DENIED =
  'Only the System Administrator or a Board member, with Talent Write, verifies government IDs and bank details for HR staff.';
export const OWN_VERIFY_DENIED = 'You can’t verify your own details. Ask HR to verify them.';
export const NO_SUPERVISOR_DENIED =
  'Only HR, a Board member or the System Administrator, with Talent access, confirms “No supervisor”.';
export const OWN_NO_SUPERVISOR_DENIED = 'You can’t confirm “No supervisor” on your own record.';
export const NO_EMPLOYEE_RECORD =
  'The system account has no employee record, so it has nothing to fill in.';
export const CHANGE_REQUEST_DENIED = 'You don’t have access to this change request.';

/** Why `actor` may not verify `target`'s government IDs or bank account, or null when they may. */
function verifyRefusal(actor: TalentActor, target: RecordTarget): string | null {
  if (isOwn(actor, target)) return OWN_VERIFY_DENIED;
  if (!hasModuleAccess(actor, 'talent', 'write')) {
    return target.departmentCode === ROLE_DEPARTMENT_CODES.hr ? HR_VERIFY_DENIED : VERIFY_DENIED;
  }
  if (target.departmentCode === ROLE_DEPARTMENT_CODES.hr) {
    return isSystemAdministrator(actor) || isBoard(actor) ? null : HR_VERIFY_DENIED;
  }
  return isSystemAdministrator(actor) || isHR(actor) ? null : VERIFY_DENIED;
}

/** True when `actor` may verify `target`'s government IDs and bank account (the change rule). */
export function canVerifySensitiveDetails(actor: TalentActor, target: RecordTarget): boolean {
  return verifyRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may verify `target`'s IDs and bank account. */
export function assertCanVerifySensitiveDetails(actor: TalentActor, target: RecordTarget): void {
  const refusal = verifyRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** Why `actor` may not confirm or withdraw "No supervisor" for `target`, or null. */
function noSupervisorRefusal(actor: TalentActor, target: RecordTarget): string | null {
  if (!canReadEmployeeRecords(actor)) return TALENT_READ_DENIED;
  if (isOwn(actor, target)) return OWN_NO_SUPERVISOR_DENIED;
  return isHR(actor) || isBoard(actor) || isSystemAdministrator(actor)
    ? null
    : NO_SUPERVISOR_DENIED;
}

/** True when `actor` may confirm or withdraw "No supervisor" for `target`. */
export function canConfirmNoSupervisor(actor: TalentActor, target: RecordTarget): boolean {
  return noSupervisorRefusal(actor, target) === null;
}

/** Throws {@link AccessDeniedError} unless `actor` may confirm or withdraw "No supervisor". */
export function assertCanConfirmNoSupervisor(actor: TalentActor, target: RecordTarget): void {
  const refusal = noSupervisorRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

/** True when `actor` gets the /talent onboarding filter and tiles (HR and the System Administrator). */
export function canSeeOnboardingOverview(actor: TalentActor): boolean {
  return canReadEmployeeRecords(actor) && (isHR(actor) || isSystemAdministrator(actor));
}

/** The change request sections, as the rules need them (`CHANGE_REQUEST_SECTIONS`). */
export type ChangeRequestRuleSection =
  'contact' | 'skills' | 'personal' | 'governmentIds' | 'bankAccount';

/**
 * Why `approver` may no longer approve a change to `section` of `target`'s record, or null when
 * they may. Checked in the decision's transaction against the employee as they are then (the
 * employee may have moved department after submit). Contact details and Skills: any approver named
 * at submit, which the engine has already checked. The reason completes "This change can no longer
 * be approved by you: <reason>. Return it instead."
 */
export function changeRequestApprovalRefusal(
  approver: TalentActor,
  section: ChangeRequestRuleSection,
  target: RecordTarget,
): string | null {
  if (isOwn(approver, target)) return 'it is a change to your own record';
  switch (section) {
    case 'contact':
    case 'skills':
      return null;
    case 'personal':
      return isHR(approver) || isSystemAdministrator(approver)
        ? null
        : 'personal details are approved by HR, and you are no longer in HR';
    case 'governmentIds':
    case 'bankAccount':
      if (isSystemAdministrator(approver)) return null;
      if (target.departmentCode === ROLE_DEPARTMENT_CODES.hr) {
        return isBoard(approver)
          ? null
          : 'the employee is now in HR, so a Board member approves their government IDs and bank details';
      }
      return isHR(approver)
        ? null
        : 'the employee is no longer in HR, so HR approves their government IDs and bank details';
  }
}

/**
 * True when a Talent Read `viewer` may see `section` of `target`'s record, for the change request
 * page: Contact details and Skills with Talent Read; Personal details also needs the date of birth
 * and civil status rule; government IDs and the bank account need the reveal rule.
 */
export function canSeeChangeRequestSection(
  viewer: TalentActor,
  section: ChangeRequestRuleSection,
  target: RecordTarget,
): boolean {
  if (isOwn(viewer, target)) return true;
  if (!canReadEmployeeRecords(viewer)) return false;
  switch (section) {
    case 'contact':
    case 'skills':
      return true;
    case 'personal':
      return canSeeBirthAndCivilStatus(viewer, target);
    case 'governmentIds':
      return canSeeSensitiveSection(viewer, 'governmentId', target);
    case 'bankAccount':
      return canSeeSensitiveSection(viewer, 'bankAccount', target);
  }
}

// ---------------------------------------------------------------------------------------------
// Step 2.8: leave and offset time off (SECURITY.md#exceptions-to-module-access, "The own time off
// and the team's", and SECURITY.md#sensitive-data, "Leave attachments"; decisions 317 and 318 in
// docs/BUILD_PLAN.md).
//
// - Filing, editing and sending again, and cancelling: the employee alone, on their own employee
//   (self-service, no module access, no employee id from the request). Nobody files or changes
//   another person's time off, HR and the System Administrator included.
// - Seeing requests and balances: the employee, Talent Read, a `reportingTo` supervisor, and
//   anyone who is or was an approver on one of the employee's requests, read-only
//   (server/leave/service.ts `timeOffViewerIdentity`). A confidential type reads "Leave" to anyone
//   but the employee, HR and the System Administrator.
// - The attachment (treated as a medical certificate): the employee, HR or the System
//   Administrator with Talent Read, and the request's approvers; never Accounting as such. Every
//   open is audit-logged (server/files/registrations.ts).

export const NO_EMPLOYEE_TIME_OFF =
  'The system account has no employee record, so it has no time off.';

/**
 * True when `actor` may open the attachment of a time off request of `employeeId`. `approver` is
 * the caller's answer to Core's `isApproverFor` on that request (`talent.timeOffRequest`).
 */
export function canOpenTimeOffAttachment(
  actor: TalentActor,
  employeeId: string,
  { approver = false }: { approver?: boolean } = {},
): boolean {
  if (actor.employee !== null && actor.employee.id === employeeId) return true;
  if (approver) return true;
  return canReadEmployeeRecords(actor) && (isHR(actor) || isSystemAdministrator(actor));
}

// ---------------------------------------------------------------------------------------------
// Step 2.9: payroll runs (SECURITY.md#sensitive-data, "Payroll runs";
// docs/modules/talent.md#payroll-run-computation-build-step-29, "Who may see and do what";
// decision 343 in docs/BUILD_PLAN.md).
//
// - Seeing runs (the list, a run, "Show amounts", a breakdown): Talent Read and HR, Accounting or
//   the System Administrator, for every employee in a run, HR staff included (viewing isn't
//   changing). Board members and employees see nothing in step 2.9.
// - Creating and recomputing a draft: Talent Write and HR or the System Administrator. Accounting
//   reads only. Computing changes no pay, so HR computes HR staff's lines like anyone's.

export const PAYROLL_RUNS_DENIED =
  'You don’t have access to payroll runs. HR, Accounting and the System Administrator, with Talent access, see them.';
export const PAYROLL_COMPUTE_DENIED =
  'Only HR and the System Administrator, with Talent Write, compute payroll runs.';

/** True when `actor` sees payroll runs: Talent Read and HR, Accounting or the System Administrator. */
export function canSeePayrollRuns(actor: TalentActor): boolean {
  return (
    canReadEmployeeRecords(actor) &&
    (isHR(actor) || isAccounting(actor) || isSystemAdministrator(actor))
  );
}

/** Throws {@link AccessDeniedError} unless `actor` may see payroll runs. */
export function assertCanSeePayrollRuns(actor: TalentActor): void {
  if (!canSeePayrollRuns(actor)) throw new AccessDeniedError(PAYROLL_RUNS_DENIED);
}

/** True when `actor` may create and recompute draft runs: Talent Write and HR or the System Administrator. */
export function canComputePayrollRuns(actor: TalentActor): boolean {
  return hasModuleAccess(actor, 'talent', 'write') && (isHR(actor) || isSystemAdministrator(actor));
}

/** Throws {@link AccessDeniedError} unless `actor` may create and recompute draft runs. */
export function assertCanComputePayrollRuns(actor: TalentActor): void {
  if (!canComputePayrollRuns(actor)) throw new AccessDeniedError(PAYROLL_COMPUTE_DENIED);
}

// ---------------------------------------------------------------------------------------------
// Step 2.10: payroll review (SECURITY.md#sensitive-data, "Payroll runs";
// docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210, "Manual entries",
// "Review flags" and "Who may see and do what"; decisions 353, 358 and 359 in docs/BUILD_PLAN.md).
//
// - Acknowledging flags: Talent Write and HR or the System Administrator (the compute rule), for
//   every line, HR staff's included, since it changes no pay.
// - Manual entries: Talent Write and HR or the System Administrator; for an employee in the HR
//   department, Talent Write and the System Administrator or a Board member, never HR; never on
//   one's own line. Accounting reads only.

export const PAYROLL_ACKNOWLEDGE_DENIED =
  'Only HR and the System Administrator, with Talent Write, acknowledge payroll flags.';
export const PAYROLL_MANUAL_ENTRY_DENIED =
  'Only HR and the System Administrator, with Talent Write, add manual entries to a payroll run.';
export const PAYROLL_MANUAL_ENTRY_HR_DENIED =
  'Only the System Administrator or a Board member, with Talent Write, adds manual entries for HR staff.';
export const PAYROLL_MANUAL_ENTRY_OWN_DENIED =
  'You can’t add a manual entry on your own line. Ask HR or the System Administrator.';

/** True when `actor` may acknowledge review flags: the compute rule. */
export function canAcknowledgePayrollFlags(actor: TalentActor): boolean {
  return canComputePayrollRuns(actor);
}

/** Throws {@link AccessDeniedError} unless `actor` may acknowledge review flags. */
export function assertCanAcknowledgePayrollFlags(actor: TalentActor): void {
  if (!canAcknowledgePayrollFlags(actor)) throw new AccessDeniedError(PAYROLL_ACKNOWLEDGE_DENIED);
}

/**
 * True when `actor` may enter manual entries for anyone at all (Talent Write and HR, the System
 * Administrator or a Board member); {@link payrollManualEntryRefusal} decides each employee.
 */
export function mayEnterPayrollManualEntries(actor: TalentActor): boolean {
  return (
    hasModuleAccess(actor, 'talent', 'write') &&
    (isHR(actor) || isSystemAdministrator(actor) || isBoard(actor))
  );
}

/** Why `actor` may not add, edit or remove a manual entry on `target`'s line, or null. */
export function payrollManualEntryRefusal(actor: TalentActor, target: RecordTarget): string | null {
  if (!hasModuleAccess(actor, 'talent', 'write')) return PAYROLL_MANUAL_ENTRY_DENIED;
  if (isOwn(actor, target)) return PAYROLL_MANUAL_ENTRY_OWN_DENIED;
  if (target.departmentCode === ROLE_DEPARTMENT_CODES.hr) {
    return isSystemAdministrator(actor) || isBoard(actor) ? null : PAYROLL_MANUAL_ENTRY_HR_DENIED;
  }
  return isSystemAdministrator(actor) || isHR(actor) ? null : PAYROLL_MANUAL_ENTRY_DENIED;
}

/** Throws {@link AccessDeniedError} unless `actor` may enter manual entries on `target`'s line. */
export function assertCanEnterPayrollManualEntry(actor: TalentActor, target: RecordTarget): void {
  const refusal = payrollManualEntryRefusal(actor, target);
  if (refusal) throw new AccessDeniedError(refusal);
}

// ---------------------------------------------------------------------------------------------
// Step 2.10: submitting, the register and payslips (SECURITY.md#sensitive-data, "Payroll review,
// approval and payslips"; docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210,
// "Submitting", "The payroll register", "Payslips"; decisions 360, 367 and 369 in
// docs/BUILD_PLAN.md).
//
// - Submitting a run: Talent Write and HR or the System Administrator (the compute rule), since it
//   changes no pay. Approving and returning are the Board's, through the approvals engine.
// - The payroll register: Talent Read and HR, Accounting or the System Administrator (the rule for
//   seeing runs), for a finalized run only.
// - A payslip: the employee (their own, outside module access), and Talent Read and HR,
//   Accounting or the System Administrator for anyone, HR staff included; never a Board member as
//   such, nor a supervisor.

export const PAYROLL_SUBMIT_DENIED =
  'Only HR and the System Administrator, with Talent Write, submit payroll runs for approval.';
export const PAYROLL_REGISTER_DENIED =
  'You don’t have access to the payroll register. HR, Accounting and the System Administrator, with Talent access, see it.';
export const PAYSLIP_DENIED = 'You don’t have access to this payslip.';

/** True when `actor` may submit runs for approval: the compute rule. */
export function canSubmitPayrollRuns(actor: TalentActor): boolean {
  return canComputePayrollRuns(actor);
}

/** Throws {@link AccessDeniedError} unless `actor` may submit runs for approval. */
export function assertCanSubmitPayrollRuns(actor: TalentActor): void {
  if (!canSubmitPayrollRuns(actor)) throw new AccessDeniedError(PAYROLL_SUBMIT_DENIED);
}

/** True when `actor` may open a finalized run's register: the rule for seeing runs. */
export function canSeePayrollRegister(actor: TalentActor): boolean {
  return canSeePayrollRuns(actor);
}

/** Throws {@link AccessDeniedError} unless `actor` may open the payroll register. */
export function assertCanSeePayrollRegister(actor: TalentActor): void {
  if (!canSeePayrollRegister(actor)) throw new AccessDeniedError(PAYROLL_REGISTER_DENIED);
}

/**
 * True when `actor` may open the payslip of `employeeId`: their own, or Talent Read and HR,
 * Accounting or the System Administrator (the `payslip` reveal rule).
 */
export function canOpenPayslip(actor: TalentActor, employeeId: string): boolean {
  if (actor.employee !== null && actor.employee.id === employeeId) return true;
  return canSeePayrollRuns(actor);
}
