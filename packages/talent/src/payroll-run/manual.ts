import { z } from 'zod';
import { type Centavos, formatPeso, pesoField } from '@pulse/core';
import { isAttendanceItem } from './period';
import type { PayrollLine } from './types';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Manual
// entries"; decisions 355–358 in docs/BUILD_PLAN.md; HANDOFF items 286, 288, 299 and 300) — a
// run line's manual entries: earnings, deductions and overrides, their form, which computed lines
// an override may replace, and the live entries of an entry chain. Applying them is
// `computePayrollLine`'s job (`line.ts`). Pure code, safe in the browser. Every pay reading is an
// *Assumption, to be confirmed by the accountant and counsel*.

/** `payrollManualEntries.kind`. */
export const PAYROLL_MANUAL_ENTRY_KINDS = ['earning', 'deduction', 'override'] as const;
export type PayrollManualEntryKind = (typeof PAYROLL_MANUAL_ENTRY_KINDS)[number];
export const PAYROLL_MANUAL_ENTRY_KIND_LABELS: Record<PayrollManualEntryKind, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
  override: 'Override',
};

export const PAYROLL_MANUAL_LABEL_MAX_LENGTH = 80;
export const PAYROLL_MANUAL_REASON_MAX_LENGTH = 500;

/**
 * The computed lines an override may replace by key, beside basic pay and a per cut-off allowance
 * (`allowance:<type>`): the employee's contribution shares, withholding tax, and the employer
 * shares and EC (decision 356). These exist on every line, even at ₱0.00.
 */
export const PAYROLL_OVERRIDE_CONTRIBUTION_KEYS = [
  'sssEmployee',
  'philhealthEmployee',
  'pagibigEmployee',
  'withholdingTax',
  'sssEmployer',
  'sssEc',
  'philhealthEmployer',
  'pagibigEmployer',
] as const;
export type PayrollOverrideContributionKey = (typeof PAYROLL_OVERRIDE_CONTRIBUTION_KEYS)[number];

const CONTRIBUTION_KEYS = new Set<string>(PAYROLL_OVERRIDE_CONTRIBUTION_KEYS);

export function isOverrideContributionKey(key: string): key is PayrollOverrideContributionKey {
  return CONTRIBUTION_KEYS.has(key);
}

/** Words (HANDOFF item 317). */
export const PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE =
  'An override here would be settled again next cut-off. Add a manual earning or deduction instead.';
export const PAYROLL_OVERRIDE_TARGET_MESSAGE = 'Choose a line to override.';
export const PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE =
  'Tick “authorized in writing by the employee or required by law” for a deduction after tax.';
export const PAYROLL_AUTHORIZED_IN_WRITING_LABEL =
  'Authorized in writing by the employee or required by law';
export const PAYROLL_MANUAL_REASON_HINT = 'Don’t type amounts in the reason.';
export const PAYROLL_MANUAL_BADGE = 'Manual';
export const PAYSLIP_ADJUSTED_LABEL = 'Adjusted';

/** A manual line's label on the payslip: "Adjustment: Back pay: salary increase from Sep 15". */
export function payrollManualLineLabel(label: string): string {
  return `Adjustment: ${label}`;
}

/** An overridden line's note: "Overridden (computed ₱57.92)". */
export function payrollOverriddenText(computedCentavos: Centavos): string {
  return `Overridden (computed ${formatPeso(computedCentavos)})`;
}

/**
 * Why a key can't be overridden, or null when it can: basic pay, a per cut-off allowance
 * (`allowance:<type>`) and the contribution and tax keys. Every attendance item (overtime,
 * premiums, night differential, holiday pay and deductions, a per day present allowance,
 * reimbursements, absences, late, undertime) gets the settlement message, since a later run would
 * settle the override back (decision 356).
 */
export function overrideTargetRefusal(key: string): string | null {
  if (key === 'basicPay' || isOverrideContributionKey(key)) return null;
  if (/^allowance:[a-z][a-zA-Z0-9]{0,39}$/.test(key)) return null;
  const kind = key.split(':')[0] ?? '';
  if (isAttendanceItem({ kind: kind as PayrollLine['kind'], key })) {
    return PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE;
  }
  return PAYROLL_OVERRIDE_TARGET_MESSAGE;
}

export function isOverridableLineKey(key: string): boolean {
  return overrideTargetRefusal(key) === null;
}

// ---------------------------------------------------------------------------------------------
// The engine's input

/**
 * One live manual entry, as the engine reads it (decrypted, flat like `payrollManualEntries`).
 * Fields that don't apply to the kind are null: `targetLineKey` is an override's only;
 * `taxable` an earning's; `reducesTaxablePay` and `authorizedInWriting` a deduction's;
 * `countsAsBasicSalary` an earning's or a deduction's.
 */
export interface PayrollManualEntryInput {
  id: string;
  kind: PayrollManualEntryKind;
  targetLineKey: string | null;
  /** Printed on the payslip ("Adjustment: <label>"); an override's is its line's label. */
  label: string;
  /** Whole centavos: 1 or more, or 0 or more for an override. */
  amountCentavos: Centavos;
  taxable: boolean | null;
  reducesTaxablePay: boolean | null;
  authorizedInWriting: boolean | null;
  countsAsBasicSalary: boolean | null;
}

/**
 * Why a live manual entry needs review (`manualEntryStale`): its employee left the run (the
 * service's to say, since such an entry has no line), its override target is gone or can't be
 * overridden, or a later override replaces the same line.
 */
export const PAYROLL_MANUAL_STALE_REASONS = [
  'employeeNotInRun',
  'targetMissing',
  'notOverridable',
  'duplicateTarget',
] as const;
export type PayrollManualStaleReason = (typeof PAYROLL_MANUAL_STALE_REASONS)[number];
export const PAYROLL_MANUAL_STALE_REASON_LABELS: Record<PayrollManualStaleReason, string> = {
  employeeNotInRun: 'The employee is no longer in this run.',
  targetMissing: 'The line it overrides is no longer computed.',
  notOverridable: PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE,
  duplicateTarget: 'A later override replaces the same line.',
};

// ---------------------------------------------------------------------------------------------
// The form (the manual entry sheet) and the service's schema

const reasonField = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z
    .string({ error: 'Enter the reason for this entry.' })
    .min(1, 'Enter the reason for this entry.')
    .max(
      PAYROLL_MANUAL_REASON_MAX_LENGTH,
      `Use at most ${PAYROLL_MANUAL_REASON_MAX_LENGTH} characters.`,
    ),
);

const labelField = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z
    .string({ error: 'Enter a label.' })
    .min(1, 'Enter a label.')
    .max(
      PAYROLL_MANUAL_LABEL_MAX_LENGTH,
      `Use at most ${PAYROLL_MANUAL_LABEL_MAX_LENGTH} characters.`,
    ),
);

const centavosField = (min: 0 | 1) =>
  z
    .number({ error: 'Enter the amount.' })
    .int('Enter the amount in pesos and centavos.')
    .min(min, min === 1 ? 'Enter an amount above zero.' : 'Enter ₱0.00 or more.')
    .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.');

const targetField = z
  .string({ error: PAYROLL_OVERRIDE_TARGET_MESSAGE })
  .trim()
  .min(1, PAYROLL_OVERRIDE_TARGET_MESSAGE)
  .superRefine((key, ctx) => {
    const refusal = overrideTargetRefusal(key);
    if (refusal) ctx.addIssue({ code: 'custom', message: refusal });
  });

/**
 * A manual entry as the service takes it (amounts in whole centavos), flat like the collection.
 * An override has no label of its own: the service sets its line's label.
 */
export const payrollManualEntrySchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('earning'),
      label: labelField,
      amountCentavos: centavosField(1),
      taxable: z.boolean({ error: 'Say whether it is taxable.' }),
      countsAsBasicSalary: z.boolean({ error: 'Say whether it counts as basic salary.' }),
      reason: reasonField,
    }),
    z.object({
      kind: z.literal('deduction'),
      label: labelField,
      amountCentavos: centavosField(1),
      reducesTaxablePay: z.boolean({ error: 'Say whether it reduces taxable pay.' }),
      authorizedInWriting: z.boolean().default(false),
      countsAsBasicSalary: z.boolean({ error: 'Say whether it counts as basic salary.' }),
      reason: reasonField,
    }),
    z.object({
      kind: z.literal('override'),
      targetLineKey: targetField,
      amountCentavos: centavosField(0),
      reason: reasonField,
    }),
  ])
  .superRefine((value, ctx) => {
    // Labor Code Art. 113 (decision 355; HANDOFF item 286): an after-tax deduction needs the tick.
    if (value.kind === 'deduction' && !value.reducesTaxablePay && !value.authorizedInWriting) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorizedInWriting'],
        message: PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE,
      });
    }
  })
  .transform((value): PayrollManualEntryValues => ({
    kind: value.kind,
    targetLineKey: value.kind === 'override' ? value.targetLineKey : null,
    label: value.kind === 'override' ? null : value.label,
    amountCentavos: value.amountCentavos,
    taxable: value.kind === 'earning' ? value.taxable : null,
    reducesTaxablePay: value.kind === 'deduction' ? value.reducesTaxablePay : null,
    authorizedInWriting: value.kind === 'deduction' ? value.authorizedInWriting : null,
    countsAsBasicSalary: value.kind === 'override' ? null : value.countsAsBasicSalary,
    reason: value.reason,
  }));

/** A parsed manual entry: `label` is null for an override (the service sets its line's label). */
export interface PayrollManualEntryValues {
  kind: PayrollManualEntryKind;
  targetLineKey: string | null;
  label: string | null;
  amountCentavos: Centavos;
  taxable: boolean | null;
  reducesTaxablePay: boolean | null;
  authorizedInWriting: boolean | null;
  countsAsBasicSalary: boolean | null;
  reason: string;
}
export type PayrollManualEntryInputValues = z.input<typeof payrollManualEntrySchema>;

/**
 * The manual entry sheet: the amount typed in pesos (`amount`), the switches as booleans, shaped
 * into {@link PayrollManualEntryValues}. Field errors on the amount come back under `amount`.
 */
export const payrollManualEntryFormSchema = z
  .looseObject({
    kind: z.enum(PAYROLL_MANUAL_ENTRY_KINDS, { error: 'Choose earning, deduction or override.' }),
    amount: z.unknown().optional(),
  })
  .transform((value, ctx): PayrollManualEntryValues => {
    const amount = pesoField({ requiredMessage: 'Enter the amount.' }).safeParse(
      value.amount ?? '',
    );
    if (!amount.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: amount.error.issues[0]?.message ?? 'Enter the amount.',
      });
      return z.NEVER;
    }
    const { amount: _typed, ...rest } = value;
    void _typed;
    const parsed = payrollManualEntrySchema.safeParse({ ...rest, amountCentavos: amount.data });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [head, ...tail] = issue.path;
        ctx.addIssue({
          code: 'custom',
          path: head === 'amountCentavos' ? ['amount', ...tail] : issue.path,
          message: issue.message,
        });
      }
      return z.NEVER;
    }
    return parsed.data;
  });

// ---------------------------------------------------------------------------------------------
// Entry chains (decision 358)

/** What the chain rule reads from a stored entry. */
export interface PayrollManualEntryLink {
  id: string;
  supersedesId: string | null;
  removed: boolean;
  createdAt: Date;
}

/**
 * The live entries: the latest of each chain (an entry nothing supersedes) that isn't a removal,
 * oldest first by `createdAt` (then id), the order the engine applies them in.
 */
export function livePayrollManualEntries<T extends PayrollManualEntryLink>(
  entries: readonly T[],
): T[] {
  const superseded = new Set(
    entries.flatMap((entry) => (entry.supersedesId ? [entry.supersedesId] : [])),
  );
  return entries
    .filter((entry) => !superseded.has(entry.id) && !entry.removed)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** An entry's earlier versions, newest first (the breakdown's History), the entry itself first. */
export function payrollManualEntryHistory<T extends PayrollManualEntryLink>(
  entries: readonly T[],
  id: string,
): T[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: T[] = [];
  let current = byId.get(id);
  while (current && chain.length <= entries.length) {
    chain.push(current);
    current = current.supersedesId ? byId.get(current.supersedesId) : undefined;
  }
  return chain;
}
