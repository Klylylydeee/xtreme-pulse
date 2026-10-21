import { z } from 'zod';
import type { BusinessDate, Centavos } from '@pulse/core';
import { checkOnboardingGate, type OnboardingGateStatus } from '../onboarding/gates';
import { ONBOARDING_ITEM_LABELS, type OnboardingItemKey } from '../onboarding/items';
import { isBelowMinimumWage } from '../payroll/lookups';
import { isEmployedOn, salaryOn } from './period';
import type { PayrollBreakdown, PayrollCalendarDay, PayrollEmployeeInput } from './types';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Review
// flags"; decisions 352–354 and 361 in docs/BUILD_PLAN.md; HANDOFF items 296–298) — the review
// flags each compute stores on a line (plain, no amount), which can be acknowledged, and which
// still block a submit. Pure code, safe in the browser.

/** `payrollRunEmployees.flags[].kind`, in the order the run page lists them. */
export const PAYROLL_FLAG_KINDS = [
  'onboardingIncomplete',
  'timesheetNotApproved',
  'belowMinimumWage',
  'netPayBelowZero',
  'manualEntryStale',
] as const;
export type PayrollFlagKind = (typeof PAYROLL_FLAG_KINDS)[number];
export const PAYROLL_FLAG_LABELS: Record<PayrollFlagKind, string> = {
  onboardingIncomplete: 'Onboarding incomplete',
  timesheetNotApproved: 'Timesheet not approved',
  belowMinimumWage: 'Below minimum wage',
  netPayBelowZero: 'Net pay below zero',
  manualEntryStale: 'Manual entry needs review',
};

/**
 * The flags HR may acknowledge (`payrollFlagAcknowledgements.flag`). Net pay below zero and a
 * stale manual entry are resolved only by manual entries (decision 353).
 */
export const PAYROLL_ACKNOWLEDGEABLE_FLAGS = [
  'onboardingIncomplete',
  'timesheetNotApproved',
  'belowMinimumWage',
] as const;
export type PayrollAcknowledgeableFlag = (typeof PAYROLL_ACKNOWLEDGEABLE_FLAGS)[number];

export function isAcknowledgeableFlag(kind: PayrollFlagKind): kind is PayrollAcknowledgeableFlag {
  return (PAYROLL_ACKNOWLEDGEABLE_FLAGS as readonly string[]).includes(kind);
}

/**
 * One flag on a line. `items` is plain text-free keys: for `onboardingIncomplete` the missing
 * items as `<item>:<state>` (`bankAccount:waitingForVerification`, `governmentIds:todo`); for
 * `belowMinimumWage` the days below; for `manualEntryStale` the entry ids; else empty.
 */
export interface PayrollLineFlag {
  kind: PayrollFlagKind;
  items: string[];
}

/** Each flag kind's count of flagged lines (`payrollRuns.flagCounts`). */
export type PayrollFlagCounts = Record<PayrollFlagKind, number>;

// ---------------------------------------------------------------------------------------------
// Deriving the flags

/**
 * The days of the cut-off on which the employee is employed and salaried and the daily rate
 * (monthly × 12 ÷ the factor, or the daily rate) is below the minimum wage in effect that day for
 * their work region (step 2.3's check, with HANDOFF item 285's current region). A day with no
 * minimum on file isn't below.
 */
export function daysBelowMinimumWage(input: {
  employee: PayrollEmployeeInput;
  calendar: readonly Pick<PayrollCalendarDay, 'date'>[];
  dailyRateFactor: number;
  /** The daily minimum wage in effect on each day, by date; a missing or null day has none. */
  minimumWageByDay: Readonly<Record<BusinessDate, Centavos | null | undefined>>;
}): BusinessDate[] {
  const below: BusinessDate[] = [];
  for (const { date } of input.calendar) {
    if (!isEmployedOn(input.employee, date)) continue;
    const salary = salaryOn(input.employee.salaries, date);
    const minimum = input.minimumWageByDay[date];
    if (!salary || minimum === null || minimum === undefined) continue;
    if (
      isBelowMinimumWage(salary.amountCentavos, salary.rateType, minimum, input.dailyRateFactor)
    ) {
      below.push(date);
    }
  }
  return below;
}

/**
 * A line's flags from its breakdown and the facts the service gives (decision 352), in
 * {@link PAYROLL_FLAG_KINDS} order:
 * - `onboardingIncomplete`: the `includeInPayroll` gate (government IDs and the bank account
 *   entered and verified) isn't met on the day of the compute;
 * - `timesheetNotApproved`: the cut-off's timesheet isn't approved, or there is none;
 * - `belowMinimumWage`: from {@link daysBelowMinimumWage};
 * - `netPayBelowZero`: the breakdown's negative net pay;
 * - `manualEntryStale`: a manual entry the breakdown couldn't apply.
 */
export function derivePayrollLineFlags(input: {
  breakdown: Pick<PayrollBreakdown, 'facts' | 'negativeNet' | 'manualEntries'>;
  onboarding: OnboardingGateStatus;
  daysBelowMinimumWage: readonly BusinessDate[];
}): PayrollLineFlag[] {
  const flags: PayrollLineFlag[] = [];
  const missing = checkOnboardingGate('includeInPayroll', input.onboarding);
  if (missing.length > 0) {
    flags.push({
      kind: 'onboardingIncomplete',
      items: missing.map((key) => `${key}:${input.onboarding.states[key] ?? 'todo'}`),
    });
  }
  if (!input.breakdown.facts.timesheetApproved) {
    flags.push({ kind: 'timesheetNotApproved', items: [] });
  }
  if (input.daysBelowMinimumWage.length > 0) {
    flags.push({ kind: 'belowMinimumWage', items: [...input.daysBelowMinimumWage] });
  }
  if (input.breakdown.negativeNet) flags.push({ kind: 'netPayBelowZero', items: [] });
  const stale = input.breakdown.manualEntries.filter((entry) => entry.staleReason !== null);
  if (stale.length > 0) {
    flags.push({ kind: 'manualEntryStale', items: stale.map((entry) => entry.entryId) });
  }
  return flags;
}

/** The run's `flagCounts`: per flag kind, how many lines carry it. */
export function countPayrollFlags(lines: readonly { flags: readonly PayrollLineFlag[] }[]) {
  const counts = Object.fromEntries(
    PAYROLL_FLAG_KINDS.map((kind) => [kind, 0]),
  ) as PayrollFlagCounts;
  for (const line of lines) {
    for (const kind of new Set(line.flags.map((flag) => flag.kind))) counts[kind] += 1;
  }
  return counts;
}

/**
 * The flags still in the way of a submit (decision 361): net pay below zero and a stale manual
 * entry always, every other flag unless acknowledged for this run and employee. An
 * acknowledgement counts while its flag is on the line, even one that cleared and came back.
 */
export function unresolvedPayrollFlags(
  flags: readonly PayrollLineFlag[],
  acknowledged: readonly PayrollFlagKind[],
): PayrollLineFlag[] {
  const done = new Set(acknowledged);
  return flags.filter((flag) => !isAcknowledgeableFlag(flag.kind) || !done.has(flag.kind));
}

/** "Resolve or acknowledge 2 flagged employees first." */
export function payrollFlaggedRefusal(employeeCount: number): string {
  return `Resolve or acknowledge ${employeeCount} flagged ${employeeCount === 1 ? 'employee' : 'employees'} first.`;
}

// ---------------------------------------------------------------------------------------------
// Words

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function onboardingItemText(item: string): string {
  const [key, state] = item.split(':') as [OnboardingItemKey, string | undefined];
  const label = ONBOARDING_ITEM_LABELS[key] ?? key;
  return `${lowerFirst(label)} ${state === 'waitingForVerification' ? 'not verified' : 'not entered'}`;
}

/**
 * A flag's badge text: "Onboarding incomplete: payroll bank account not verified", or the flag's
 * label for the others.
 */
export function payrollFlagText(flag: PayrollLineFlag): string {
  const label = PAYROLL_FLAG_LABELS[flag.kind];
  if (flag.kind !== 'onboardingIncomplete' || flag.items.length === 0) return label;
  return `${label}: ${flag.items.map(onboardingItemText).join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// Acknowledging

export const PAYROLL_ACKNOWLEDGE_REASON_MAX_LENGTH = 300;
export const PAYROLL_ACKNOWLEDGE_LABEL = 'Acknowledge';
export const PAYROLL_ACKNOWLEDGE_ALL_LABEL = 'Acknowledge all';
export const PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE =
  'This flag can’t be acknowledged. Fix it with a manual entry, then recompute.';

/** The "Acknowledge" and "Acknowledge all" sheets: the flag and a reason (1–300). */
export const payrollFlagAcknowledgementSchema = z.object({
  flag: z.enum(PAYROLL_ACKNOWLEDGEABLE_FLAGS, { error: PAYROLL_FLAG_NOT_ACKNOWLEDGEABLE_MESSAGE }),
  reason: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: 'Enter the reason.' })
      .min(1, 'Enter the reason.')
      .max(
        PAYROLL_ACKNOWLEDGE_REASON_MAX_LENGTH,
        `Use at most ${PAYROLL_ACKNOWLEDGE_REASON_MAX_LENGTH} characters.`,
      ),
  ),
});
export type PayrollFlagAcknowledgementValues = z.output<typeof payrollFlagAcknowledgementSchema>;

/** The audit entry's reason: "Acknowledged below minimum wage for EMP-0001: <reason>". */
export function payrollAcknowledgementAuditReason(
  flag: PayrollAcknowledgeableFlag,
  employeeNumber: string,
  reason: string,
): string {
  return `Acknowledged ${lowerFirst(PAYROLL_FLAG_LABELS[flag])} for ${employeeNumber}: ${reason}`;
}

/** The person list's note: "Acknowledged: <reason>". */
export function payrollAcknowledgedText(reason: string): string {
  return `Acknowledged: ${reason}`;
}
