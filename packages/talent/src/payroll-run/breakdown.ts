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
import { PAYROLL_MANUAL_ENTRY_KINDS, PAYROLL_MANUAL_STALE_REASONS } from './manual';
import type { PayrollBreakdown, PayrollLine } from './types';

// Spec: docs/DATA_MODEL.md#collection-ownership (`payrollRunEmployees.breakdown`, decisions 343
// and 372) — the breakdown is one JSON value, encrypted as a `sensitiveField()` (category
// `payslip`). Version 2 (step 2.10) adds each line's `manual` and `override` and the line's
// `manualEntries`. `serializePayrollBreakdown` writes version 2; `parsePayrollBreakdown` reads
// version 2, and version 1 with those fields null and empty (its version kept), and refuses
// anything else. Never log either.

export const PAYROLL_BREAKDOWN_VERSION = 2;

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

const lineSchemaV2 = lineSchema.extend({
  manual: z
    .object({
      entryId: z.string().min(1),
      countsAsBasicSalary: z.boolean(),
      reducesTaxablePay: z.boolean().nullable(),
      authorizedInWriting: z.boolean().nullable(),
    })
    .nullable(),
  override: z.object({ entryId: z.string().min(1), computedAmountCentavos: centavos }).nullable(),
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

/** Version 1 (step 2.9), still read. */
export const payrollBreakdownV1Schema = z.object({
  breakdownVersion: z.literal(1),
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

/** Version 2 (step 2.10): version 1 plus manual and overridden lines and the manual entries. */
export const payrollBreakdownSchema = payrollBreakdownV1Schema.extend({
  breakdownVersion: z.literal(PAYROLL_BREAKDOWN_VERSION),
  lines: z.array(lineSchemaV2),
  manualEntries: z.array(
    z.object({
      entryId: z.string().min(1),
      kind: z.enum(PAYROLL_MANUAL_ENTRY_KINDS),
      targetLineKey: z.string().nullable(),
      label: z.string(),
      amountCentavos: centavos,
      computedAmountCentavos: centavos.nullable(),
      staleReason: z.enum(PAYROLL_MANUAL_STALE_REASONS).nullable(),
    }),
  ),
});

/** The breakdown as one JSON string (always version 2), for its encrypted field. */
export function serializePayrollBreakdown(breakdown: PayrollBreakdown): string {
  return JSON.stringify(
    payrollBreakdownSchema.parse({ ...breakdown, breakdownVersion: PAYROLL_BREAKDOWN_VERSION }),
  );
}

/** A version 1 breakdown in the engine's shape: no manual or overridden line, no entries. */
function fromVersion1(value: z.output<typeof payrollBreakdownV1Schema>): PayrollBreakdown {
  return {
    ...value,
    lines: value.lines.map((line) => ({ ...line, manual: null, override: null })),
    manualEntries: [],
  };
}

/**
 * A stored breakdown read back: version 2 as it is, version 1 with no manual or overridden line
 * (its `breakdownVersion` kept as 1). Throws on anything else.
 */
export function parsePayrollBreakdown(json: string): PayrollBreakdown {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RangeError('The payroll breakdown is not valid JSON.');
  }
  const version =
    typeof value === 'object' && value !== null
      ? (value as { breakdownVersion?: unknown }).breakdownVersion
      : undefined;
  // Never include the value in the error: it holds pay amounts.
  if (version === 1) {
    const parsed = payrollBreakdownV1Schema.safeParse(value);
    if (parsed.success) return fromVersion1(parsed.data);
  } else {
    const parsed = payrollBreakdownSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  throw new RangeError('The payroll breakdown does not match version 1 or 2.');
}

// The parsed shape must stay assignable to the engine's type, and back.
type Parsed = z.output<typeof payrollBreakdownSchema>;
const _toEngine = (value: Parsed): PayrollBreakdown => value;
const _fromEngine = (value: PayrollBreakdown & { breakdownVersion: 2 }): Parsed => value;
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
