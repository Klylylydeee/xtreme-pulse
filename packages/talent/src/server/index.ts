// Pulse Talent's server-only services and registrations (docs/ARCHITECTURE.md#modules-and-packages).
// Import them from `@pulse/talent/server`; the pure code is in `@pulse/talent`. Services only: the
// models are never exported.

// The employee record (docs/modules/talent.md#the-employee-record-build-step-21, build step 2.1)
export {
  getEmployeeRecordView,
  getOwnRecordView,
  listEmployeeRecords,
  type ListEmployeeRecordsOptions,
  setBankAccount,
  setGovernmentIds,
  setSkills,
  updateEmployment,
  updatePersonal,
} from './employee-records/service';
export { addCompensationEntry, type AddCompensationEntryResult } from './compensation/service';

// The 201 file (build step 2.2): add (optionally archiving the document a renewal replaces),
// edit the details, archive with a reason, and the gated list.
export {
  addEmployeeDocument,
  archiveEmployeeDocument,
  type DocumentsSection,
  listEmployeeDocuments,
  REPLACED_BY_RENEWAL_REASON,
  updateEmployeeDocument,
} from './documents/service';
// The e-signature (build step 2.2): owner-only upload and history, the one apply service, and the
// approval signer registration (call beside registerCoreApprovalTypes()).
export {
  applyESignature,
  type ApplyESignatureInput,
  getESignatureStatus,
  listOwnESignatures,
  registerTalentApprovalSigner,
  uploadESignature,
} from './e-signatures/service';
// Certifications (build step 2.2) and the read services for Pulse Ops and Pulse Engage.
export {
  countCertifiedEmployeesByBrand,
  createCertification,
  listCertifications,
  type ListCertificationsOptions,
  removeCertification,
  updateCertification,
} from './certifications/service';
// The expiry alerts (build step 2.2): the lead days setting and the daily job.
export {
  DEFAULT_EXPIRY_LEAD_DAYS_SETTING,
  EXPIRY_ALERTS_SETTING,
  expiryLeadDaysOn,
  type ExpiryLeadDays,
  getExpiryAlertSettings,
  updateExpiryAlertSettings,
} from './expiry-alerts/settings';
export {
  CERTIFICATION_EXPIRED_EVENT,
  CERTIFICATION_EXPIRING_EVENT,
  DOCUMENT_EXPIRED_EVENT,
  DOCUMENT_EXPIRING_EVENT,
  EXPIRY_ALERTS_JOB,
  EXPIRY_ALERTS_SCHEDULE,
  expiryAlertKey,
  type ExpiryAlertsResult,
  runExpiryAlerts,
} from './expiry-alerts/job';
// Payroll settings (build step 2.3): the ten versioned settings, the page's view and "Add
// version"; the seed loaders are in `@pulse/talent/server/seed`.
export {
  ALLOWANCE_TYPES_SETTING,
  DE_MINIMIS_LIMITS_SETTING,
  MINIMUM_WAGES_SETTING,
  PAGIBIG_CONTRIBUTIONS_SETTING,
  PAYROLL_SETTINGS,
  PAYROLL_SETTINGS_SETTING,
  payrollSettingVersionOn,
  PHILHEALTH_CONTRIBUTIONS_SETTING,
  PREMIUM_RATES_SETTING,
  SSS_CONTRIBUTIONS_SETTING,
  THIRTEENTH_MONTH_EXEMPTION_SETTING,
  WITHHOLDING_TAX_SEMI_MONTHLY_SETTING,
} from './payroll-settings/settings';
export { addPayrollSettingsVersion, getPayrollSettingsView } from './payroll-settings/service';
// Allowances (build step 2.3): "Assign allowance" and the allowances in effect (server-only).
export { allowancesInEffect, assignAllowance } from './allowances/service';
// The minimum wage (build step 2.3): the wage order counts and list.
export {
  countEmployeesBelowMinimumWage,
  listEmployeesBelowMinimumWage,
} from './minimum-wage/service';
// Work schedules and timesheets (build step 2.4): "Set schedule" and the Work schedule section;
// the own timesheet's clock and entries (self-service, no employee id), the read-only views and
// My team; the daily `talent.openTimesheets` job for the worker.
export { WORK_SCHEDULE_SETTING, TIMESHEET_SETTINGS_SETTING } from './payroll-settings/settings';
export {
  getWorkScheduleSection,
  NO_COMPANY_SCHEDULE,
  setWorkSchedule,
} from './work-schedules/service';
export {
  ACTIVITY_REQUIRED,
  ALREADY_TIMED_IN,
  createTimeEntry,
  deleteTimeEntry,
  ENTRY_NOT_FOUND,
  getOwnTimesheetView,
  getTimesheetView,
  listMyTeam,
  NOT_TIMED_IN,
  timeIn,
  timeOut,
  type TimesheetViewOptions,
  updateTimeEntry,
} from './timesheets/service';
export { NO_PAY_SCHEDULE, OTHER_POSITION_MISSING, POSITION_MISSING } from './timesheets/periods';
export {
  OPEN_TIMESHEETS_JOB,
  OPEN_TIMESHEETS_SCHEDULE,
  type OpenTimesheetsResult,
  runOpenTimesheets,
} from './timesheets/open-job';
// Timesheet approval, the DTR and the offset balance (build step 2.7,
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27).
// - Submit and resubmit: self-service, the own timesheet by its id (no employee id). The status,
//   banner, submit sheet, DTR segment, offset balance and credit come on the timesheet view.
// - The approval type `talent.timesheet` is registered by `registerTalentApprovalTypes()` (below).
// - The timesheets list (`/talent/timesheets`, Talent Read).
// - The daily `talent.timesheetReminders` job for the worker, and the holidays-changed listener
//   `talent.recomputeDtr` the worker registers at start-up.
// - `getDtr` and `getOffsetBalance`: the services steps 2.8, 2.9 and 2.13 read, under the
//   timesheet's viewing rule.
export {
  submitTimesheet,
  type SubmitTimesheetInput,
  type SubmitTimesheetResult,
  TIMESHEET_GONE,
} from './timesheets/submission';
export { TIMESHEET_APPROVAL_STEPS, TIMESHEET_APPROVAL_TYPE_LABEL } from './timesheets/approval';
export {
  getTimesheetsList,
  TIMESHEET_LIST_CUT_OFFS,
  type TimesheetsListOptions,
} from './timesheets/list';
export {
  runTimesheetReminders,
  TIMESHEET_DUE_EVENT,
  TIMESHEET_REMINDERS_JOB,
  TIMESHEET_REMINDERS_SCHEDULE,
  type TimesheetRemindersResult,
  TIMESHEETS_MISSING_EVENT,
} from './timesheets/reminders';
export { DTR_MAX_DAYS, DTR_RANGE_INVALID, type EmployeeDtr, getDtr } from './dtr/service';
export {
  RECOMPUTE_DTR_LISTENER,
  type RecomputeDtrResult,
  recomputeDtrOnHolidaysChanged,
  registerTalentHolidaysChangedListener,
} from './dtr/listener';
export {
  getOffsetBalance,
  type OffsetReconcileResult,
  reconcileOffsetCredits,
} from './offset/service';
// Leave balances, crediting, opening balances and the leave settings (build step 2.8,
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28; chunk C).
// - `getLeaveBalances` and `getOffsetBalance` (now with the available balance): the employee,
//   Talent Read, a `reportingTo` supervisor, or an approver of one of their time off requests.
// - The writers the time off service calls in its transactions: `writeLeaveUsage`,
//   `writeLeaveAdjustment`, `writeOffsetUsage`, and the available balances it checks.
// - The daily `talent.leaveCredits` job for the worker.
// - `/talent/opening-balances` (Talent Write and HR or the System Administrator; year-to-date pay
//   under the salary rule) and the inspector's year-to-date pay (whoever may reveal `salary`).
// - The Leave segment of Payroll settings.
export {
  availableLeaveHalfDaysOf,
  canSeeConfidentialFor,
  type EntryAuthor,
  getLeaveBalances,
  insertLeaveEntry,
  isRegularizationDateMissing,
  LEAVE_TYPE_NOT_CREDITED,
  leaveBalanceOf,
  leaveEntriesOf,
  listLeaveEntries,
  TIME_OFF_DENIED,
  timeOffViewerIdentity,
  writeLeaveAdjustment,
  writeLeaveUsage,
} from './leave/service';
export {
  isTimeOffApproverOf,
  pendingLeavePaidHalfDays,
  pendingOffsetMinutes,
  perYearUsedHalfDays,
} from './leave/holdings';
export {
  LEAVE_CREDITS_JOB,
  LEAVE_CREDITS_SCHEDULE,
  type LeaveCreditsResult,
  runLeaveCredits,
} from './leave/credits';
export { availableOffsetMinutesOf, offsetBalanceOf, writeOffsetUsage } from './offset/service';
export {
  addLeaveCorrection,
  addOffsetCorrection,
  assertCanManageOpeningBalances,
  canEnterOpeningBalances,
  canManageOpeningBalances,
  enterLeaveOpening,
  enterOffsetOpening,
  enterPayrollOpening,
  getOpeningBalances,
  getPayrollOpeningSection,
  type OpeningBalanceRow,
  OPENING_BALANCES_DENIED,
  type OpeningBalancesView,
  type OpeningLeaveCell,
  OWN_OPENING_BALANCES_DENIED,
  PAYROLL_OPENING_STALE,
  type PayrollOpeningInput,
  payrollOpeningInputSchema,
  type PayrollOpeningSectionView,
  type PayrollOpeningVersionView,
} from './opening-balances/service';
export {
  PAYROLL_OPENING_ENTRY_TYPE,
  PAYROLL_OPENING_FIELD_LABELS,
  PAYROLL_OPENING_FIELDS,
  type PayrollOpeningField,
} from './opening-balances/model';
export { LEAVE_SETTINGS_SETTING, leaveSettingsOn } from './payroll-settings/settings';
export {
  addLeaveSettingsVersion,
  getLeaveSettingsView,
  type LeaveSettingsVersionInput,
  type LeaveSettingsVersionView,
  type LeaveSettingsView,
  openingEntryExists,
} from './payroll-settings/service';
// Leave and offset time off requests (build step 2.8,
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28; chunk D).
// - Self-service (no employee id): `fileTimeOff`, `resendTimeOff`, `cancelTimeOff`,
//   `previewTimeOff` and `getOwnTimeOff` act on the signed-in user's own employee.
// - Read-only: `getEmployeeTimeOff` (`/talent/time-off/<employeeId>`) and `getTimeOffRequestPage`
//   (`/talent/time-off-requests/<id>`) for the employee, Talent Read, a `reportingTo` supervisor
//   and the request's approvers.
// - `talent.leave` and `talent.offsetTimeOff` are registered by `registerTalentApprovalTypes()`;
//   the attachment's file access by `registerTalentFileAccess()`; the listener's reconcile runs in
//   `talent.recomputeDtr`.
export {
  cancelTimeOff,
  type EmployeeTimeOffView,
  type FiledTimeOff,
  fileTimeOff,
  getEmployeeTimeOff,
  getOwnTimeOff,
  getTimeOffRequestPage,
  type OwnTimeOffView,
  previewTimeOff,
  resendTimeOff,
  TIME_OFF_ACCOUNT_INACTIVE,
  TIME_OFF_KIND_FIXED,
  TIME_OFF_NOT_CANCELLABLE,
  TIME_OFF_NOT_RETURNED,
  TIME_OFF_REQUEST_DENIED,
  TIME_OFF_REQUEST_GONE,
  type TimeOffEmployeeView,
  type TimeOffRequestPageView,
  type TimeOffSheetLeaveType,
} from './time-off/service';
export {
  LEAVE_TYPE_NO_ATTACHMENT,
  LEAVE_TYPE_UNKNOWN,
  OFFSET_NO_ATTACHMENT,
  TimeOffRefusedError,
} from './time-off/checks';
export {
  isHrRequester,
  registerTimeOffApprovalTypes,
  timeOffApprovalSteps,
} from './time-off/approval';
export { approvedTimeOffInputs } from './time-off/days';
export { reconcileTimeOffRequests, type TimeOffReconcileResult } from './time-off/reconcile';
// Reimbursements (build step 2.5): the own timesheet's lines (self-service, no employee id; the
// segment itself comes on the timesheet view as `reimbursements`), and the register of claimed
// receipts: `claimReceipt` and `releaseReceiptClaim` run in the caller's transaction and are the
// service Pulse Fiscal's petty cash vouchers call from step 5.11 (the TIN and key normalizers are
// in `@pulse/talent`). "Check a receipt" is for Talent Read.
export {
  addReimbursement,
  deleteReimbursement,
  REIMBURSEMENT_SETTINGS_MISSING,
  REIMBURSEMENT_TIMESHEET_NOT_FOUND,
  updateReimbursement,
} from './reimbursements/service';
export {
  assertReceiptNotClaimed,
  checkReceipt,
  claimReceipt,
  type ClaimReceiptInput,
  type ReceiptClaim,
  type ReceiptClaimOptions,
  type ReceiptKeyParts,
  receiptKeyPartsOf,
  releaseReceiptClaim,
  type ReleaseReceiptClaimInput,
} from './receipt-claims/service';
// Onboarding and change requests (build step 2.6,
// docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26).
// - The checklist: own (self-service, no employee id), the inspector's Onboarding section (Talent
//   Read, hidden items), and the /talent filter and tiles (`listEmployeeRecords({ onboarding })`).
// - "Mark verified" and "No supervisor" on the inspector.
// - Own entries on /talent/me (self-service): each save fills blanks straight away and sends
//   changes to filled-in values as change requests; the employee's own 201 upload and certification.
// - Change requests: send again or cancel a returned one, the own list and Edit states, the request
//   page, and `registerTalentApprovalTypes()` (call it beside `registerCoreApprovalTypes()` and
//   `registerTalentApprovalSigner()` before deciding).
// - The required onboarding documents setting (Settings on /talent, Talent Owner).
export {
  deriveOnboarding,
  type DerivedOnboarding,
  getEmployeeOnboarding,
  getOwnOnboarding,
  getOwnOnboardingReminder,
  hiddenOnboardingItems,
  ONBOARDING_FILTERS,
  type OnboardingFilter,
} from './onboarding/service';
export {
  addOnboardingSettingsVersion,
  canChangeOnboardingSettings,
  getOnboardingSettings,
  ONBOARDING_SEED_VERSION,
  ONBOARDING_SETTINGS_DENIED,
  ONBOARDING_SETTINGS_SETTING,
  onboardingSettingsOn,
} from './onboarding/settings';
export {
  isVerificationGroupComplete,
  markVerified,
  setNoSupervisorConfirmation,
} from './employee-records/service';
export {
  saveOwnBankAccount,
  saveOwnGovernmentIds,
  saveOwnPersonal,
  saveOwnSkills,
  VERIFICATION_NEEDED_EVENT,
} from './employee-records/own';
export {
  addOwnEmployeeDocument,
  DOCUMENT_UPLOADED_EVENT,
  OWN_DOCUMENT_TYPE_REFUSED,
  type OwnDocumentUploadInput,
} from './documents/service';
export { addOwnCertification, type OwnCertificationInput } from './certifications/service';
export {
  cancelChangeRequest,
  CHANGE_REQUEST_APPROVED_REASON,
  CHANGE_REQUEST_GONE,
  CHANGE_REQUEST_NOT_RETURNED,
  CHANGE_REQUEST_TYPE,
  CHANGE_REQUEST_TYPE_LABEL,
  getChangeRequestView,
  getOwnChangeRequestStates,
  listOwnChangeRequests,
  registerTalentApprovalTypes,
  resendChangeRequest,
} from './change-requests/service';
// File access (build step 2.2): the file route calls this beside registerCoreFileAccess().
export { registerTalentFileAccess } from './files/registrations';

// Who may see and change what (SECURITY.md#sensitive-data). Each service checks again itself.
export {
  assertCanAddPayrollSettingsVersion,
  assertCanChangeBirthAndCivilStatus,
  assertCanChangeExpiryAlertSettings,
  assertCanChangeSensitiveDetails,
  assertCanEditCertifications,
  assertCanEditEmployeeRecord,
  assertCanManageDocuments,
  assertCanReadCertifications,
  assertCanReadEmployeeRecords,
  assertCanViewWageOrderList,
  assertCanRemoveCertifications,
  BIRTH_AND_CIVIL_STATUS_DENIED,
  canAddPayrollSettingsVersion,
  canChangeBirthAndCivilStatus,
  canChangeExpiryAlertSettings,
  canChangeSensitiveDetails,
  canEditCertifications,
  canEditEmployeeRecord,
  canEditSkills,
  canManageDocuments,
  canManageEmployeeAccount,
  canOpenCertificationAttachment,
  canReadCertifications,
  canReadEmployeeRecords,
  canRemoveCertifications,
  canViewWageOrderList,
  canSeeAllowances,
  canSeeBirthAndCivilStatus,
  canSeeDocumentCategory,
  canSeeESignatureImage,
  canSeeSensitiveSection,
  CERTIFICATION_REMOVE_DENIED,
  CERTIFICATIONS_READ_DENIED,
  DOCUMENTS_MANAGE_DENIED,
  EXPIRY_SETTINGS_DENIED,
  NO_EMPLOYEE_SIGNATURE,
  HR_SENSITIVE_CHANGE_DENIED,
  OWN_RECORD_DENIED,
  PAYROLL_SETTINGS_CHANGE_DENIED,
  type RecordTarget,
  SENSITIVE_CHANGE_DENIED,
  type TalentActor,
  TALENT_READ_DENIED,
  TALENT_WRITE_DENIED,
  WAGE_ORDER_LIST_DENIED,
  // Step 2.4
  assertCanSetWorkSchedule,
  assertCanViewTimesheet,
  canSetWorkSchedule,
  canViewTimesheet,
  isSupervisorOf,
  NO_EMPLOYEE_TIMESHEET,
  TIMESHEET_DENIED,
  type TimesheetTarget,
  WORK_SCHEDULE_SET_DENIED,
  // Step 2.7
  assertCanSeeTimesheetsList,
  canSeeTimesheetsList,
  // Step 2.8
  canOpenTimeOffAttachment,
  NO_EMPLOYEE_TIME_OFF,
  // Step 2.6
  assertCanConfirmNoSupervisor,
  assertCanVerifySensitiveDetails,
  canConfirmNoSupervisor,
  canSeeChangeRequestSection,
  canSeeOnboardingOverview,
  canVerifySensitiveDetails,
  CHANGE_REQUEST_DENIED,
  changeRequestApprovalRefusal,
  HR_VERIFY_DENIED,
  NO_EMPLOYEE_RECORD,
  NO_SUPERVISOR_DENIED,
  OWN_NO_SUPERVISOR_DENIED,
  OWN_VERIFY_DENIED,
  VERIFY_DENIED,
} from './policy';

// The reveals (SECURITY.md#sensitive-data): call before `revealSensitiveField`.
export { registerTalentSensitiveReveals } from './sensitive/reveals';
