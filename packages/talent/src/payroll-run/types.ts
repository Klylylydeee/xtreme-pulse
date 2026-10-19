import type { BusinessDate, Centavos, TimesheetType } from '@pulse/core';
import type { DtrDay } from '../dtr/compute';
import type { DtrDayStatus } from '../dtr/statuses';
import type { RateType } from '../fixed-sets';
import type { AllowanceEntryTimeline } from '../payroll/allowances';
import type { CutOffPeriod } from '../payroll/lookups';
import type {
  AllowanceTypes,
  DeMinimisLimits,
  PagibigContributions,
  PayrollSettings,
  PhilhealthContributions,
  PremiumRates,
  SssContributions,
  WithholdingTaxSemiMonthly,
} from '../payroll/schemas';
import type { DayKind } from '../timesheets/compute';
import type { EffectiveVersion } from '../timesheets/schedule';
import type { TimesheetStatus } from '../timesheets/schemas';
import type {
  PayrollLineGroup,
  PayrollLineKind,
  PayrollLineSide,
  PayrollQuantityUnit,
} from './kinds';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 (decisions 325–341 in
// docs/BUILD_PLAN.md) — the pure pay engine's inputs and outputs. Inputs are plain data the run
// service loads (no database here); every amount is a whole number of centavos.

// ---------------------------------------------------------------------------------------------
// The run policy (`talent.payrollRunSettings`, decision 326)

/** Which pay a contribution is computed on. */
export type PayrollContributionBasis = 'monthlyBasicSalary' | 'monthCompensation';

/**
 * The shape of the versioned setting `talent.payrollRunSettings` (docs/DATA_MODEL.md#versioned-
 * configuration), as the engine reads it. The setting's own schema lives with the other payroll
 * settings and must keep this shape. The version in effect on the cut-off's start applies.
 */
export interface PayrollRunPolicy {
  /** For each agency, the basis of the month's contribution (seeded PhilHealth on the basic salary). */
  contributionBases: {
    sss: PayrollContributionBasis;
    philhealth: PayrollContributionBasis;
    pagibig: PayrollContributionBasis;
  };
  /**
   * A monthly-rated employee's unworked special day on a work day: `paid` (the salary covers it)
   * or `deducted` (at `1 − specialDayUnworked` of the daily rate).
   */
  monthlyRatedUnworkedSpecialDay: 'paid' | 'deducted';
  /** How many cut-offs before the run's are reconciled (1–48; seeded 24). */
  adjustmentLookbackCutOffs: number;
}

// ---------------------------------------------------------------------------------------------
// Inputs

/** One compensation entry (step 2.1), decrypted. The latest on or before a day is its salary. */
export interface PayrollSalaryEntry {
  id: string;
  effectiveDate: BusinessDate;
  createdAt: Date;
  rateType: RateType;
  amountCentavos: Centavos;
  minimumWageEarner: boolean;
}

/** An explicit allowance entry with its amount (null for `end`). */
export type PayrollAllowanceEntry = AllowanceEntryTimeline;

export interface PayrollEmployeeInput {
  dateHired: BusinessDate;
  /** The last day employed, when separated. */
  separationDate: BusinessDate | null;
  salaries: readonly PayrollSalaryEntry[];
  allowanceEntries: readonly PayrollAllowanceEntry[];
}

/** One calendar day of the cut-off: its schedule and confirmed nationwide holiday (`dayKindOf`). */
export interface PayrollCalendarDay {
  date: BusinessDate;
  /** True when the schedule in effect that day doesn't list the weekday. */
  restDay: boolean;
  /** `ordinary`, `restDay`, `regularHoliday` or `specialDay` (two holidays count as one). */
  kind: DayKind;
}

/**
 * A day before the cut-off, for the workday-before rule of a holiday early in it: its calendar
 * and, when its timesheet is approved, its DTR status (null when the DTR doesn't list it).
 */
export interface PayrollPriorDay extends PayrollCalendarDay {
  status: DtrDayStatus | null;
  /** True when the timesheet holding the day is approved; otherwise the rule counts as met. */
  approved: boolean;
}

/** What the engine reads from a DTR day (`computeDtr`, with step 2.8's time off). */
export type PayrollDtrDay = Pick<
  DtrDay,
  | 'date'
  | 'status'
  | 'workedMinutes'
  | 'overtime'
  | 'nightDifferentialMinutes'
  | 'offsetMinutes'
  | 'lateMinutes'
  | 'undertimeMinutes'
  | 'absentMinutes'
  | 'leaveWithoutPayDays'
>;

/** The cut-off's timesheet, or null when the employee has none. */
export interface PayrollTimesheetInput {
  type: TimesheetType;
  status: TimesheetStatus;
  /** The DTR's days (read only when `status` is `approved`). */
  days: readonly PayrollDtrDay[];
  /** The approved timesheet's live reimbursement lines (read only when approved). */
  reimbursements: { receipts: number; totalCentavos: Centavos };
}

/** Everything one cut-off's own pay needs, without contributions, tax or settlements. */
export interface PayrollPeriodInput {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  employee: PayrollEmployeeInput;
  /** Every day from `periodStart` to `periodEnd`. */
  calendar: readonly PayrollCalendarDay[];
  /** Days before the cut-off, back to at least its last scheduled work day that isn't a holiday. */
  previousDays: readonly PayrollPriorDay[];
  timesheet: PayrollTimesheetInput | null;
  /** `talent.payrollSettings` in effect on the cut-off's start. */
  payrollSettings: PayrollSettings;
  /** `talent.payrollRunSettings` in effect on the cut-off's start. */
  policy: PayrollRunPolicy;
  /** `talent.premiumRates` versions: the one in effect on each day applies. */
  premiumRates: readonly EffectiveVersion<PremiumRates>[];
  /** `talent.allowanceTypes` versions: the one in effect on each day applies. */
  allowanceTypes: readonly EffectiveVersion<AllowanceTypes>[];
}

/** What the same month's mid-month run deducted, read from its line (`midMonthFiguresOf`). */
export interface PayrollMidMonthFigures {
  compensationForContributionsCentavos: Centavos;
  sss: { employeeCentavos: Centavos; employerCentavos: Centavos; ecCentavos: Centavos };
  philhealth: { employeeCentavos: Centavos; employerCentavos: Centavos };
  pagibig: { employeeCentavos: Centavos; employerCentavos: Centavos };
}

/** An earlier cut-off to reconcile: its attendance items now, and what finalized runs paid. */
export interface PayrollEarlierPeriodInput {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** `computePeriodPay(...).attendanceItems` for the period, computed now. */
  now: readonly PayrollAttendanceItem[];
  /** Every finalized line's items for the period, summed (`sumAttendanceItems`). */
  paid: readonly PayrollAttendanceItem[];
}

/** A run line's input: the cut-off's own pay plus contributions, tax and settlements. */
export interface PayrollLineInput extends Omit<PayrollPeriodInput, 'periodStart' | 'periodEnd'> {
  /** The run's cut-off (`cutOffFor`), with its key and pay date. */
  cutOff: CutOffPeriod;
  /** The contribution tables in effect on the first day of the contribution month. */
  sss: SssContributions;
  philhealth: PhilhealthContributions;
  pagibig: PagibigContributions;
  /** The withholding table and de minimis limits in effect on the pay date. */
  withholding: WithholdingTaxSemiMonthly;
  deMinimisLimits: DeMinimisLimits;
  /** The daily minimum wage of the employee's region on the pay date, or null when none. */
  minimumWageDailyCentavos: Centavos | null;
  /**
   * For each de minimis key, what finalized runs already paid against its limit in the limit's
   * period (the pay date's month, semester or year; ignored for a daily limit).
   */
  deMinimisPaidCentavos: Readonly<Record<string, Centavos>>;
  /** End-of-month only: the same month's mid-month line (finalized, else draft), or null. */
  midMonth: PayrollMidMonthFigures | null;
  /** Earlier cut-offs within the lookback, on or after the first payroll cut-off. */
  earlierPeriods: readonly PayrollEarlierPeriodInput[];
}

// ---------------------------------------------------------------------------------------------
// Outputs

/** One line of a run's employee line. Amounts are signed within their side. */
export interface PayrollLine {
  /** Unique within its period: the kind, or `allowance:<type>`, `holidayPay:<date>`, …. */
  key: string;
  kind: PayrollLineKind;
  group: PayrollLineGroup;
  /** Earnings add to gross, deductions to total deductions, employer shares to neither. */
  side: PayrollLineSide;
  label: string;
  /** The period the line belongs to (an earlier one for a settlement). */
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** A decimal string ("1", "0.5", "480"), or null. */
  quantity: string | null;
  unit: PayrollQuantityUnit | null;
  /** The rate in words ("₱1,000.00 a day"), or null. */
  rateText: string | null;
  /** Earnings and deductions as they read (a deduction is positive); a settlement is signed. */
  amountCentavos: Centavos;
  /** Whether the line is taxable for this employee (a minimum wage earner's exempt pay isn't). */
  taxable: boolean;
  /**
   * The part that counts as compensation (for contributions, and for tax unless exempt): the
   * amount for pay, attendance deductions and taxable allowances, a de minimis line's excess, and
   * 0 for non-taxable lines, reimbursements and contributions.
   */
  taxableCentavos: Centavos;
  /** The de minimis limit an allowance counts against, or null. */
  deMinimisKey: string | null;
  /** The allowance type, for an allowance line. */
  typeKey: string | null;
}

/** An attendance item of a period: the waiting items and holiday pay (decision 339). */
export type PayrollAttendanceItem = Pick<
  PayrollLine,
  | 'key'
  | 'kind'
  | 'label'
  | 'quantity'
  | 'unit'
  | 'rateText'
  | 'amountCentavos'
  | 'taxableCentavos'
  | 'deMinimisKey'
  | 'typeKey'
> & { side: 'earning' | 'deduction' };

/** The facts a line was computed from ("How it was computed"). */
export interface PayrollFacts {
  /** The salary on the last salaried employed day of the cut-off, or null with none. */
  rateType: RateType | null;
  salaryCentavos: Centavos | null;
  /** Rounded for display only; every line uses the exact rate. */
  dailyRateCentavos: Centavos | null;
  hourlyRateCentavos: Centavos | null;
  dailyRateFactor: number;
  hoursPerDay: number;
  timesheetType: TimesheetType | null;
  timesheetStatus: TimesheetStatus | null;
  timesheetApproved: boolean;
  /** True when the timesheet isn't approved: basic pay only. */
  provisional: boolean;
  baseDays: number;
  employedBaseDays: number;
  /** The DTR's `present` days (0 when not approved). */
  presentDays: number;
  /** Standard timesheet: offset minutes earned in the cut-off ("Offset earned, not paid"). */
  offsetEarnedMinutes: number;
  minimumWageEarner: boolean;
}

/** One cut-off's own pay: its lines before contributions and tax, and its attendance items. */
export interface PeriodPay {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  facts: PayrollFacts;
  /** Earnings and deductions, in kind order. */
  lines: PayrollLine[];
  /** The attendance items among them (holiday pay included), for later reconciliation. */
  attendanceItems: PayrollAttendanceItem[];
}

export interface AgencyContribution {
  basis: PayrollContributionBasis;
  basisCentavos: Centavos;
  /** The month's shares on that basis. */
  month: { employeeCentavos: Centavos; employerCentavos: Centavos; ecCentavos: Centavos };
  /** What the mid-month run deducted, for the end-of-month remainder; null otherwise. */
  midMonthDeducted: {
    employeeCentavos: Centavos;
    employerCentavos: Centavos;
    ecCentavos: Centavos;
  } | null;
  /** Deducted (and paid by the employer) in this cut-off; may be negative at end of month. */
  thisCutOff: { employeeCentavos: Centavos; employerCentavos: Centavos; ecCentavos: Centavos };
}

export interface PayrollContributions {
  /** `estimate` (mid-month), `remainder` (end of month after a mid-month run), `estimateOnly`. */
  method: 'estimate' | 'remainder' | 'estimateOnly';
  contributionMonth: string;
  monthlyBasicSalaryCentavos: Centavos;
  /** End of month after a mid-month run: the month's compensation for contributions. */
  monthCompensationCentavos: Centavos | null;
  sss: AgencyContribution & {
    mscCentavos: Centavos;
    /** The month's employee share split into regular SS and MPF. */
    employeeRegularCentavos: Centavos;
    employeeMpfCentavos: Centavos;
  };
  philhealth: AgencyContribution;
  pagibig: AgencyContribution;
}

export interface PayrollDeMinimis {
  key: string;
  label: string;
  period: 'month' | 'semester' | 'year' | 'day';
  /** The limit for this cut-off (a daily limit × the present days). */
  limitCentavos: Centavos;
  alreadyPaidCentavos: Centavos;
  /** Everything counted against the limit in this line (settlements included). */
  amountCentavos: Centavos;
  nonTaxableCentavos: Centavos;
  excessCentavos: Centavos;
}

export interface PayrollTotals {
  grossCentavos: Centavos;
  deductionsCentavos: Centavos;
  netPayCentavos: Centavos;
  reimbursementsCentavos: Centavos;
  taxWithheldCentavos: Centavos;
  employeeContributionsCentavos: Centavos;
  employerContributionsCentavos: Centavos;
}

/** What a line paid for one period: its own items, or a settlement's differences. */
export interface PayrollPeriodItems {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  items: PayrollAttendanceItem[];
}

/** A run's employee line, as stored in its encrypted breakdown (version 1). */
export interface PayrollBreakdown {
  breakdownVersion: 1;
  cutOff: {
    key: CutOffPeriod['key'];
    periodStart: BusinessDate;
    periodEnd: BusinessDate;
    payDate: BusinessDate;
    contributionMonth: string;
  };
  facts: PayrollFacts;
  /** Earnings, deductions, settlements and employer shares, in that order. */
  lines: PayrollLine[];
  /** The own period first, then each settled period with a difference. */
  attendanceItems: PayrollPeriodItems[];
  /** The earlier period starts this line settles (a difference other than 0). */
  settledPeriods: BusinessDate[];
  compensationForContributionsCentavos: Centavos;
  contributions: PayrollContributions;
  taxableCompensationCentavos: Centavos;
  taxCentavos: Centavos;
  deMinimis: PayrollDeMinimis[];
  /** For 13th month pay: basic pay less attendance and holiday deductions (settlements included). */
  basicSalaryEarnedCentavos: Centavos;
  totals: PayrollTotals;
  negativeNet: boolean;
}
