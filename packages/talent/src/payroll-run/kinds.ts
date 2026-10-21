import { type BusinessDate, formatDate } from '@pulse/core';
import { formatPeriodRange } from '../timesheets/submission';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 (decisions 327, 340 and 346
// in docs/BUILD_PLAN.md; the wording is HANDOFF item 257) — the payroll run's fixed sets, the
// line kinds and groups, and the words the screens and notification use. Pure code, safe in the
// browser.

/** A run's kind: one regular run per cut-off; step 2.12 adds `thirteenthMonth`. */
export const PAYROLL_RUN_KINDS = ['regular', 'thirteenthMonth'] as const;
export type PayrollRunKind = (typeof PAYROLL_RUN_KINDS)[number];
export const PAYROLL_RUN_KIND_LABELS: Record<PayrollRunKind, string> = {
  regular: 'Regular',
  thirteenthMonth: '13th month pay',
};

/**
 * A run's status. Step 2.9 writes only `draft`; step 2.10 adds the rest: a `returned` run is
 * edited like a draft (decision 351), a `pendingApproval` run is frozen, a `finalized` run locked.
 */
export const PAYROLL_RUN_STATUSES = ['draft', 'pendingApproval', 'returned', 'finalized'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];
export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  draft: 'Draft',
  pendingApproval: 'Waiting for Board approval',
  returned: 'Returned',
  finalized: 'Finalized',
};

/** Why an employee whose employment overlaps the cut-off isn't in the run. */
export const PAYROLL_LEFT_OUT_REASONS = ['noSalary'] as const;
export type PayrollLeftOutReason = (typeof PAYROLL_LEFT_OUT_REASONS)[number];
export const PAYROLL_LEFT_OUT_REASON_LABELS: Record<PayrollLeftOutReason, string> = {
  noSalary: 'No salary on file',
};

/** The run number's prefix: `PAY-YYYY-NNNN`, with the pay date's year (*Assumption*). */
export const PAYROLL_RUN_NUMBER_PREFIX = 'PAY';

/**
 * The kinds of a run's employee lines, in the order the breakdown lists them: earnings, then
 * deductions, then the employer shares. Step 2.10 adds `manual`: a manual earning or deduction
 * (decision 355), whose own line's `side` says which.
 */
export const PAYROLL_LINE_KINDS = [
  'basicPay',
  'holidayPay',
  'overtimeOrdinary',
  'restDayWork',
  'holidayWork',
  'restDayHolidayOvertime',
  'nightDifferential',
  'allowance',
  'reimbursement',
  'absence',
  'leaveWithoutPay',
  'late',
  'undertime',
  'partialAbsence',
  'holidayNotPaid',
  'sssEmployee',
  'philhealthEmployee',
  'pagibigEmployee',
  'withholdingTax',
  'manual',
  'sssEmployer',
  'sssEc',
  'philhealthEmployer',
  'pagibigEmployer',
] as const;
export type PayrollLineKind = (typeof PAYROLL_LINE_KINDS)[number];

export const PAYROLL_LINE_KIND_LABELS: Record<PayrollLineKind, string> = {
  basicPay: 'Basic pay',
  holidayPay: 'Holiday pay',
  overtimeOrdinary: 'Overtime, ordinary day',
  restDayWork: 'Rest day work',
  holidayWork: 'Holiday work',
  restDayHolidayOvertime: 'Rest day and holiday overtime',
  nightDifferential: 'Night differential',
  allowance: 'Allowance',
  reimbursement: 'Reimbursements',
  absence: 'Absences',
  leaveWithoutPay: 'Leave without pay',
  late: 'Late',
  undertime: 'Undertime',
  partialAbsence: 'Partial-day absence',
  holidayNotPaid: 'Holiday not paid',
  sssEmployee: 'SSS',
  philhealthEmployee: 'PhilHealth',
  pagibigEmployee: 'Pag-IBIG',
  withholdingTax: 'Withholding tax',
  manual: 'Adjustment',
  sssEmployer: 'SSS, employer share',
  sssEc: 'EC, employer',
  philhealthEmployer: 'PhilHealth, employer share',
  pagibigEmployer: 'Pag-IBIG, employer share',
};

/** Which side of the pay a kind is on: it adds to gross, is deducted, or is the employer's. */
export const PAYROLL_LINE_SIDES = ['earning', 'deduction', 'employer'] as const;
export type PayrollLineSide = (typeof PAYROLL_LINE_SIDES)[number];

export const PAYROLL_LINE_KIND_SIDES: Record<PayrollLineKind, PayrollLineSide> = {
  basicPay: 'earning',
  holidayPay: 'earning',
  overtimeOrdinary: 'earning',
  restDayWork: 'earning',
  holidayWork: 'earning',
  restDayHolidayOvertime: 'earning',
  nightDifferential: 'earning',
  allowance: 'earning',
  reimbursement: 'earning',
  absence: 'deduction',
  leaveWithoutPay: 'deduction',
  late: 'deduction',
  undertime: 'deduction',
  partialAbsence: 'deduction',
  holidayNotPaid: 'deduction',
  sssEmployee: 'deduction',
  philhealthEmployee: 'deduction',
  pagibigEmployee: 'deduction',
  withholdingTax: 'deduction',
  // A manual line is an earning or a deduction by its entry; this default is never read for it.
  manual: 'earning',
  sssEmployer: 'employer',
  sssEc: 'employer',
  philhealthEmployer: 'employer',
  pagibigEmployer: 'employer',
};

/** The breakdown's groups, in order (decision 340). */
export const PAYROLL_LINE_GROUPS = [
  'earnings',
  'deductions',
  'settlements',
  'employerShares',
] as const;
export type PayrollLineGroup = (typeof PAYROLL_LINE_GROUPS)[number];
export const PAYROLL_LINE_GROUP_LABELS: Record<PayrollLineGroup, string> = {
  earnings: 'Earnings',
  deductions: 'Deductions',
  settlements: 'Settled from earlier cut-offs',
  employerShares: 'Employer shares',
};

/** The unit of a line's quantity. */
export const PAYROLL_QUANTITY_UNITS = ['days', 'minutes', 'receipts'] as const;
export type PayrollQuantityUnit = (typeof PAYROLL_QUANTITY_UNITS)[number];

/**
 * The earnings that count as compensation for contributions and, unless the employee is a
 * minimum wage earner, as taxable compensation (a taxable allowance and a de minimis excess count
 * too, through each line's `taxableCentavos`).
 */
export const COMPENSATION_EARNING_KINDS: readonly PayrollLineKind[] = [
  'basicPay',
  'holidayPay',
  'overtimeOrdinary',
  'restDayWork',
  'holidayWork',
  'restDayHolidayOvertime',
  'nightDifferential',
];

/** The attendance and holiday deductions: they lower compensation and basic salary earned. */
export const ATTENDANCE_DEDUCTION_KINDS: readonly PayrollLineKind[] = [
  'absence',
  'leaveWithoutPay',
  'late',
  'undertime',
  'partialAbsence',
  'holidayNotPaid',
];

// ---------------------------------------------------------------------------------------------
// Words (HANDOFF item 257)

export const PAYROLL_PROVISIONAL_NOTE =
  'Timesheet not approved: basic pay only. The rest settles in the next cut-off once approved.';
export const PAYROLL_PROVISIONAL_BADGE = 'Timesheet not approved · basic pay only';
export const PAYROLL_TIMESHEET_NOT_APPROVED_LABEL = 'Timesheet not approved';
export const PAYROLL_SETTLES_BADGE = 'Settles earlier cut-offs';
export const PAYROLL_SETTLEMENTS_LABEL = PAYROLL_LINE_GROUP_LABELS.settlements;
export const PAYROLL_OFFSET_EARNED_LABEL = 'Offset earned, not paid';
export const PAYROLL_NEGATIVE_NET_LABEL = 'Net pay below zero';
export const PAYROLL_LEFT_OUT_LABEL = 'Left out';
export const PAYROLL_DRAFT_NOTE = 'Draft: amounts change until the run is finalized.';
export const PAYROLL_REVEAL_NOTE = 'Viewing amounts is recorded in the audit log.';
export const PAYROLL_GO_LIVE_REQUIRED_MESSAGE =
  'Set the go-live date in Payroll settings › Leave first.';
export const PAYROLL_HOW_COMPUTED_LABEL = 'How it was computed';

/** "Sep 26 – Oct 10": a period without its year, as settlement lines and the notification read. */
export function payrollPeriodText(periodStart: BusinessDate, periodEnd: BusinessDate): string {
  return formatPeriodRange(periodStart, periodEnd, { year: false });
}

/** The `talent.payrollDraftReady` notification: "Draft payroll for Sep 26 – Oct 10 is ready to review". */
export function payrollDraftReadyText(periodStart: BusinessDate, periodEnd: BusinessDate): string {
  return `Draft payroll for ${payrollPeriodText(periodStart, periodEnd)} is ready to review`;
}

/** A settlement line's label: "Overtime, ordinary day · Sep 26 – Oct 10". */
export function settlementLabel(
  itemLabel: string,
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
): string {
  return `${itemLabel} · ${payrollPeriodText(periodStart, periodEnd)}`;
}

// ---------------------------------------------------------------------------------------------
// Step 2.10's words (HANDOFF item 317; docs/modules/talent.md#payroll-review-approval-and-
// payslips-build-step-210)

/** True while HR may recompute, add manual entries and acknowledge flags (decision 351). */
export function isEditablePayrollRunStatus(status: PayrollRunStatus): boolean {
  return status === 'draft' || status === 'returned';
}

export const PAYROLL_SUBMIT_LABEL = 'Submit for approval';
export const PAYROLL_APPROVE_IN_APPROVALS_LABEL = 'Approve or return in Approvals';
export const PAYROLL_FISCAL_PLACEHOLDER_TEXT =
  'Pulse Fiscal posting: waiting for Pulse Fiscal (Phase 5).';
export const PAYROLL_REGISTER_NOT_AVAILABLE_TEXT =
  'The register is available once the run is finalized.';
export const PAYROLL_REGISTER_REVEAL_NOTE = 'Viewing account numbers is recorded in the audit log.';
export const PAYROLL_NO_BANK_ACCOUNT_LABEL = 'No bank account on file';
export const PAYROLL_COMPANY_PLACEHOLDER_WARNING =
  'Company details are still placeholders, so payslips will print them.';
export const PAYROLL_RUN_CHANGED_MESSAGE =
  'The run changed since the page loaded. Reload it, then submit again.';
export const PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE =
  'The run changed when it was recomputed just now. Review it, then submit again.';
export const PAYROLL_NO_BOARD_MESSAGE =
  'No Board of Directors member is active to approve this run.';

/** "Finalize Sep 26 – Oct 10, 2026 (PAY-2026-0001) first." (decision 361). */
export function payrollFinalizeFirstMessage(
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  runNumber: string,
): string {
  return `Finalize ${formatPeriodRange(periodStart, periodEnd)} (${runNumber}) first.`;
}

/** "Compute and finalize the run for Sep 26 – Oct 10, 2026 first." (decision 361). */
export function payrollComputeFirstMessage(
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
): string {
  return `Compute and finalize the run for ${formatPeriodRange(periodStart, periodEnd)} first.`;
}

/** The approval request's title: "Payroll · Sep 26 – Oct 10, 2026" (decision 362). */
export function payrollApprovalTitle(periodStart: BusinessDate, periodEnd: BusinessDate): string {
  return `Payroll · ${formatPeriodRange(periodStart, periodEnd)}`;
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The approval's summary and the submit sheet's line, in counts only, never an amount or a name:
 * "2 employees · 1 manual entry · 1 flag acknowledged · pay date Oct 15, 2026" (decision 362).
 * Without a pay date (the submit sheet) the last part is left out.
 */
export function payrollSubmitSummary(input: {
  employeeCount: number;
  manualEntryCount: number;
  acknowledgedFlagCount: number;
  payDate?: BusinessDate;
}): string {
  const parts = [
    counted(input.employeeCount, 'employee', 'employees'),
    counted(input.manualEntryCount, 'manual entry', 'manual entries'),
    counted(input.acknowledgedFlagCount, 'flag acknowledged', 'flags acknowledged'),
  ];
  if (input.payDate) parts.push(`pay date ${formatDate(input.payDate)}`);
  return parts.join(' · ');
}

/** The `talent.payslipReady` notification: "Your payslip for Sep 26 – Oct 10 is ready". */
export function payslipReadyText(periodStart: BusinessDate, periodEnd: BusinessDate): string {
  return `Your payslip for ${payrollPeriodText(periodStart, periodEnd)} is ready`;
}
