import { z } from 'zod';
import { type BusinessDate, type Centavos, formatDate } from '@pulse/core';
import { PAYROLL_BANK_LABELS, type PayrollBank } from '../fixed-sets';
import { formatPeriodRange } from '../timesheets/submission';
import { payEffectCentavos } from './line';
import { PAYSLIP_ADJUSTED_LABEL, payrollManualLineLabel } from './manual';
import type { PayrollBreakdown, PayrollLine } from './types';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Year-to-
// date", "Payslips"; decisions 363, 364 and 366 in docs/BUILD_PLAN.md; HANDOFF items 289, 309 and
// 310) — the year-to-date figures frozen on a finalized line, and the payslip's view model the PDF
// is rendered from. Pure code, safe in the browser. The view model holds no employer share, rate
// or computation fact, and only the account number's last 4 digits.

// ---------------------------------------------------------------------------------------------
// Year-to-date (decision 364)

/**
 * The year-to-date figures: gross pay, tax withheld, and the employee's SSS (MPF included),
 * PhilHealth and Pag-IBIG shares. A finalized line's own (from its breakdown) and an opening
 * entry's (`payrollOpeningEntries`, the same field names) have this shape.
 */
export interface PayrollYtdFigures {
  grossCentavos: Centavos;
  taxWithheldCentavos: Centavos;
  sssEmployeeCentavos: Centavos;
  philhealthEmployeeCentavos: Centavos;
  pagibigEmployeeCentavos: Centavos;
}

/** The sums, with the three shares as "Contributions". */
export interface PayrollYearToDate extends PayrollYtdFigures {
  contributionsCentavos: Centavos;
}

const ZERO_FIGURES: PayrollYtdFigures = {
  grossCentavos: 0,
  taxWithheldCentavos: 0,
  sssEmployeeCentavos: 0,
  philhealthEmployeeCentavos: 0,
  pagibigEmployeeCentavos: 0,
};

/** A line's own year-to-date figures: what it paid and deducted (overrides included). */
export function payrollYtdFiguresOf(
  breakdown: Pick<PayrollBreakdown, 'totals' | 'contributions'>,
): PayrollYtdFigures {
  return {
    grossCentavos: breakdown.totals.grossCentavos,
    taxWithheldCentavos: breakdown.totals.taxWithheldCentavos,
    sssEmployeeCentavos: breakdown.contributions.sss.thisCutOff.employeeCentavos,
    philhealthEmployeeCentavos: breakdown.contributions.philhealth.thisCutOff.employeeCentavos,
    pagibigEmployeeCentavos: breakdown.contributions.pagibig.thisCutOff.employeeCentavos,
  };
}

/** An opening entry as the sum reads it: its year, when it was entered, and its figures. */
export interface PayrollYtdOpeningInput {
  year: number;
  createdAt: Date;
  figures: PayrollYtdFigures;
}

/** A finalized regular run's line as the sum reads it. */
export interface PayrollYtdLineInput {
  payDate: BusinessDate;
  periodStart: BusinessDate;
  figures: PayrollYtdFigures;
}

/**
 * Year-to-date as of a run (decision 364; *Assumption*, HANDOFF item 310): for the calendar year
 * of the run's pay date, the latest opening entry of that year (only when its year is the pay
 * date's year), plus every given line with a pay date in that year and a period starting on or
 * before the run's, this run's own line included. The caller passes finalized regular runs' lines
 * only, and this run's.
 */
export function payrollYearToDate(input: {
  payDate: BusinessDate;
  periodStart: BusinessDate;
  openingEntries: readonly PayrollYtdOpeningInput[];
  lines: readonly PayrollYtdLineInput[];
}): PayrollYearToDate {
  const year = Number(input.payDate.slice(0, 4));
  const opening = input.openingEntries
    .filter((entry) => entry.year === year)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const sum: PayrollYtdFigures = { ...(opening?.figures ?? ZERO_FIGURES) };
  for (const line of input.lines) {
    if (Number(line.payDate.slice(0, 4)) !== year || line.periodStart > input.periodStart) continue;
    sum.grossCentavos += line.figures.grossCentavos;
    sum.taxWithheldCentavos += line.figures.taxWithheldCentavos;
    sum.sssEmployeeCentavos += line.figures.sssEmployeeCentavos;
    sum.philhealthEmployeeCentavos += line.figures.philhealthEmployeeCentavos;
    sum.pagibigEmployeeCentavos += line.figures.pagibigEmployeeCentavos;
  }
  return {
    ...sum,
    contributionsCentavos:
      sum.sssEmployeeCentavos + sum.philhealthEmployeeCentavos + sum.pagibigEmployeeCentavos,
  };
}

const centavos = z.number().int().refine(Number.isSafeInteger);
export const PAYROLL_YTD_VERSION = 1;
export const payrollYearToDateSchema = z.object({
  ytdVersion: z.literal(PAYROLL_YTD_VERSION),
  grossCentavos: centavos,
  taxWithheldCentavos: centavos,
  sssEmployeeCentavos: centavos,
  philhealthEmployeeCentavos: centavos,
  pagibigEmployeeCentavos: centavos,
  contributionsCentavos: centavos,
});

/** Year-to-date as one JSON string, for the line's encrypted `payslip.ytd`. Never log it. */
export function serializePayrollYearToDate(ytd: PayrollYearToDate): string {
  return JSON.stringify(payrollYearToDateSchema.parse({ ...ytd, ytdVersion: PAYROLL_YTD_VERSION }));
}

/** A stored `payslip.ytd` read back; throws (without the value) when it doesn't match. */
export function parsePayrollYearToDate(json: string): PayrollYearToDate {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RangeError('The year-to-date figures are not valid JSON.');
  }
  const parsed = payrollYearToDateSchema.safeParse(value);
  if (!parsed.success) throw new RangeError('The year-to-date figures do not match version 1.');
  const { ytdVersion: _version, ...ytd } = parsed.data;
  void _version;
  return ytd;
}

// ---------------------------------------------------------------------------------------------
// The payslip (decision 366)

/** The payslip's words (HANDOFF item 317). */
export const PAYSLIP_TITLE = 'Payslip';
export const PAYSLIP_ADJUSTMENTS_LABEL = 'Adjustments from earlier cut-offs';
export const PAYSLIP_PAID_OTHERWISE_TEXT = 'Paid by other means';
export const PAYSLIP_YTD_LABEL = 'Year to date';

/** The last 4 characters of an account number, digits only ("1234"). */
export function accountNumberLastFour(accountNumber: string): string {
  return accountNumber.replace(/\D/g, '').slice(-4);
}

/** "Credited to UnionBank ending 1234", or "Paid by other means" with no account. */
export function payslipCreditedText(
  bank: { bank: PayrollBank; accountNumberLastFour: string } | null,
): string {
  if (!bank) return PAYSLIP_PAID_OTHERWISE_TEXT;
  return `Credited to ${PAYROLL_BANK_LABELS[bank.bank]} ending ${bank.accountNumberLastFour}`;
}

/** The PDF's file name: "Payslip EMP-0001 2026-10-15.pdf". */
export function payslipFileName(employeeNumber: string, payDate: BusinessDate): string {
  return `Payslip ${employeeNumber} ${payDate}.pdf`;
}

/** What the payslip reads from the line's frozen snapshot (decision 363). */
export interface PayslipSnapshotInput {
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  positionTitle: string | null;
  /** The payroll bank account, with only the last 4 digits; null when none was on file. */
  bank: { bank: PayrollBank; accountName: string | null; accountNumberLastFour: string } | null;
}

/** One printed line: its label and amount, no rate. */
export interface PayslipLine {
  label: string;
  /** Earnings and deductions as they read; an adjustment signed by its effect on net pay. */
  amountCentavos: Centavos;
  /** A manual earning or deduction ("Adjustment: <label>"). */
  manual: boolean;
  /** An overridden computed line, marked "Adjusted". */
  adjusted: boolean;
}

/** The payslip's content, everything the PDF prints except the company header. */
export interface PayslipView {
  /** "Payslip PAY-2026-0001". */
  title: string;
  runNumber: string;
  employee: {
    name: string;
    number: string;
    department: string | null;
    position: string | null;
  };
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** "Sep 26 – Oct 10, 2026". */
  periodText: string;
  payDate: BusinessDate;
  /** "Oct 15, 2026". */
  payDateText: string;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  /** Step 2.9's settlements, each labelled with its period. */
  adjustments: PayslipLine[];
  adjustmentsLabel: string;
  adjustedLabel: string;
  grossCentavos: Centavos;
  deductionsCentavos: Centavos;
  netPayCentavos: Centavos;
  /** "Credited to UnionBank ending 1234" or "Paid by other means". */
  creditedText: string;
  yearToDate: PayrollYearToDate;
}

function printed(line: PayrollLine, amountCentavos: Centavos): PayslipLine {
  return {
    label: line.manual ? payrollManualLineLabel(line.label) : line.label,
    amountCentavos,
    manual: line.manual !== null,
    adjusted: line.override !== null,
  };
}

/**
 * The payslip of a finalized line, from its breakdown and frozen snapshot (decision 366;
 * *Assumption*, HANDOFF item 289): Earnings, Deductions and "Adjustments from earlier cut-offs",
 * manual entries as "Adjustment: <label>" and overrides marked "Adjusted"; gross pay, total
 * deductions and net pay; where it was credited; and year-to-date. Employer shares, rates and the
 * "How it was computed" facts are left out.
 */
export function buildPayslipView(input: {
  runNumber: string;
  breakdown: Pick<PayrollBreakdown, 'cutOff' | 'lines' | 'totals'>;
  snapshot: PayslipSnapshotInput;
  yearToDate: PayrollYearToDate;
}): PayslipView {
  const { breakdown, snapshot } = input;
  const { periodStart, periodEnd, payDate } = breakdown.cutOff;
  const of = (group: PayrollLine['group']) =>
    breakdown.lines.filter((line) => line.group === group);
  return {
    title: `${PAYSLIP_TITLE} ${input.runNumber}`,
    runNumber: input.runNumber,
    employee: {
      name: snapshot.employeeName,
      number: snapshot.employeeNumber,
      department: snapshot.departmentName,
      position: snapshot.positionTitle,
    },
    periodStart,
    periodEnd,
    periodText: formatPeriodRange(periodStart, periodEnd),
    payDate,
    payDateText: formatDate(payDate),
    earnings: of('earnings').map((line) => printed(line, line.amountCentavos)),
    deductions: of('deductions').map((line) => printed(line, line.amountCentavos)),
    adjustments: of('settlements').map((line) => printed(line, payEffectCentavos(line))),
    adjustmentsLabel: PAYSLIP_ADJUSTMENTS_LABEL,
    adjustedLabel: PAYSLIP_ADJUSTED_LABEL,
    grossCentavos: breakdown.totals.grossCentavos,
    deductionsCentavos: breakdown.totals.deductionsCentavos,
    netPayCentavos: breakdown.totals.netPayCentavos,
    creditedText: payslipCreditedText(snapshot.bank),
    yearToDate: { ...input.yearToDate },
  };
}
