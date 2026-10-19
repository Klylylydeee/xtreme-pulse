import { z } from 'zod';
import { TIMESHEET_TYPES } from '@pulse/core';
import { RATE_TYPES } from '../fixed-sets';
import { CUT_OFF_KEYS } from '../payroll/schemas';
import { TIMESHEET_STATUSES } from '../timesheets/schemas';
import {
  PAYROLL_LINE_GROUP_LABELS,
  PAYROLL_LINE_GROUPS,
  PAYROLL_LINE_KINDS,
  PAYROLL_LINE_SIDES,
  PAYROLL_QUANTITY_UNITS,
  type PayrollLineGroup,
} from './kinds';
import type { PayrollBreakdown, PayrollLine } from './types';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollRunEmployees.breakdown`, decision 343)
// — the breakdown is one JSON value, encrypted as a `sensitiveField()` (category `payslip`), with
// `breakdownVersion` 1. `serializePayrollBreakdown` writes it and `parsePayrollBreakdown` reads it
// back, refusing anything that doesn't match version 1. Never log either.

export const PAYROLL_BREAKDOWN_VERSION = 1;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const centavos = z.number().int().refine(Number.isSafeInteger);
const count = z.number().int().min(0);

const lineSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(PAYROLL_LINE_KINDS),
  group: z.enum(PAYROLL_LINE_GROUPS),
  side: z.enum(PAYROLL_LINE_SIDES),
  label: z.string(),
  periodStart: date,
  periodEnd: date,
  quantity: z.string().nullable(),
  unit: z.enum(PAYROLL_QUANTITY_UNITS).nullable(),
  rateText: z.string().nullable(),
  amountCentavos: centavos,
  taxable: z.boolean(),
  taxableCentavos: centavos,
  deMinimisKey: z.string().nullable(),
  typeKey: z.string().nullable(),
});

const itemSchema = lineSchema
  .pick({
    key: true,
    kind: true,
    label: true,
    quantity: true,
    unit: true,
    rateText: true,
    amountCentavos: true,
    taxableCentavos: true,
    deMinimisKey: true,
    typeKey: true,
  })
  .extend({ side: z.enum(['earning', 'deduction']) });

const shares = z.object({
  employeeCentavos: centavos,
  employerCentavos: centavos,
  ecCentavos: centavos,
});
const basis = z.enum(['monthlyBasicSalary', 'monthCompensation']);
const agency = z.object({
  basis,
  basisCentavos: centavos,
  month: shares,
  midMonthDeducted: shares.nullable(),
  thisCutOff: shares,
});

export const payrollBreakdownSchema = z.object({
  breakdownVersion: z.literal(PAYROLL_BREAKDOWN_VERSION),
  cutOff: z.object({
    key: z.enum(CUT_OFF_KEYS),
    periodStart: date,
    periodEnd: date,
    payDate: date,
    contributionMonth: z.string().regex(/^\d{4}-\d{2}$/),
  }),
  facts: z.object({
    rateType: z.enum(RATE_TYPES).nullable(),
    salaryCentavos: centavos.nullable(),
    dailyRateCentavos: centavos.nullable(),
    hourlyRateCentavos: centavos.nullable(),
    dailyRateFactor: count,
    hoursPerDay: count,
    timesheetType: z.enum(TIMESHEET_TYPES).nullable(),
    timesheetStatus: z.enum(TIMESHEET_STATUSES).nullable(),
    timesheetApproved: z.boolean(),
    provisional: z.boolean(),
    baseDays: count,
    employedBaseDays: count,
    presentDays: count,
    offsetEarnedMinutes: count,
    minimumWageEarner: z.boolean(),
  }),
  lines: z.array(lineSchema),
  attendanceItems: z.array(
    z.object({ periodStart: date, periodEnd: date, items: z.array(itemSchema) }),
  ),
  settledPeriods: z.array(date),
  compensationForContributionsCentavos: centavos,
  contributions: z.object({
    method: z.enum(['estimate', 'remainder', 'estimateOnly']),
    contributionMonth: z.string(),
    monthlyBasicSalaryCentavos: centavos,
    monthCompensationCentavos: centavos.nullable(),
    sss: agency.extend({
      mscCentavos: centavos,
      employeeRegularCentavos: centavos,
      employeeMpfCentavos: centavos,
    }),
    philhealth: agency,
    pagibig: agency,
  }),
  taxableCompensationCentavos: centavos,
  taxCentavos: centavos,
  deMinimis: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      period: z.enum(['month', 'semester', 'year', 'day']),
      limitCentavos: centavos,
      alreadyPaidCentavos: centavos,
      amountCentavos: centavos,
      nonTaxableCentavos: centavos,
      excessCentavos: centavos,
    }),
  ),
  basicSalaryEarnedCentavos: centavos,
  totals: z.object({
    grossCentavos: centavos,
    deductionsCentavos: centavos,
    netPayCentavos: centavos,
    reimbursementsCentavos: centavos,
    taxWithheldCentavos: centavos,
    employeeContributionsCentavos: centavos,
    employerContributionsCentavos: centavos,
  }),
  negativeNet: z.boolean(),
});

/** The breakdown as one JSON string, for its encrypted field. */
export function serializePayrollBreakdown(breakdown: PayrollBreakdown): string {
  return JSON.stringify(payrollBreakdownSchema.parse(breakdown));
}

/** A stored breakdown read back; throws when it isn't a version 1 breakdown. */
export function parsePayrollBreakdown(json: string): PayrollBreakdown {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RangeError('The payroll breakdown is not valid JSON.');
  }
  const parsed = payrollBreakdownSchema.safeParse(value);
  // Never include the value in the error: it holds pay amounts.
  if (!parsed.success) throw new RangeError('The payroll breakdown does not match version 1.');
  return parsed.data;
}

// The parsed shape must stay assignable to the engine's type, and back.
type Parsed = z.output<typeof payrollBreakdownSchema>;
const _toEngine = (value: Parsed): PayrollBreakdown => value;
const _fromEngine = (value: PayrollBreakdown): Parsed => value;
void _toEngine;
void _fromEngine;

/** The breakdown sheet's groups, in order, each with its lines (empty groups left out). */
export function groupPayrollLines(
  lines: readonly PayrollLine[],
): { group: PayrollLineGroup; label: string; lines: PayrollLine[] }[] {
  return PAYROLL_LINE_GROUPS.map((group) => ({
    group,
    label: PAYROLL_LINE_GROUP_LABELS[group],
    lines: lines.filter((line) => line.group === group),
  })).filter((entry) => entry.lines.length > 0);
}
