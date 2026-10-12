import { z } from 'zod';
import { businessDateField, pesoField } from '@pulse/core';
import { employeeIdField } from '../validation';
import { ALLOWANCE_ASSIGNMENT_KINDS } from './allowances';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 ("Allowance
// assignments", decision 203 in docs/BUILD_PLAN.md) — the "Assign allowance" sheet. Pure code,
// safe in the browser. The sheet parses with the form schema (the amount typed in pesos); the
// service takes the result and parses it again with `allowanceAssignmentSchema`.

export const ALLOWANCE_REASON_MAX_LENGTH = 1000;

const reasonField = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z
    .string({ error: 'Enter the reason for this change.' })
    .min(1, 'Enter the reason for this change.')
    .max(ALLOWANCE_REASON_MAX_LENGTH, `Use at most ${ALLOWANCE_REASON_MAX_LENGTH} characters.`),
);

const typeKeyField = z
  .string({ error: 'Choose an allowance type.' })
  .trim()
  .regex(/^[a-z][a-zA-Z0-9]{0,39}$/, 'Choose an allowance type.');

/** A new allowance assignment, as the service takes it: the amount in whole centavos (set only). */
export const allowanceAssignmentSchema = z
  .object({
    employeeId: employeeIdField,
    typeKey: typeKeyField,
    effectiveDate: businessDateField('Enter the effective date.'),
    kind: z.enum(ALLOWANCE_ASSIGNMENT_KINDS, { error: 'Choose set an amount or end.' }),
    amountCentavos: z
      .number({ error: 'Enter the amount.' })
      .int('Enter the amount in pesos and centavos.')
      .positive('Enter an amount above zero.')
      .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.')
      .nullable()
      .optional(),
    reason: reasonField,
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === 'set' &&
      (value.amountCentavos === null || value.amountCentavos === undefined)
    ) {
      ctx.addIssue({ code: 'custom', path: ['amountCentavos'], message: 'Enter the amount.' });
    }
  })
  .transform((value) => ({
    ...value,
    amountCentavos: value.kind === 'set' ? (value.amountCentavos ?? null) : null,
  }));
export type AllowanceAssignmentInput = z.input<typeof allowanceAssignmentSchema>;
export type AllowanceAssignmentValues = z.output<typeof allowanceAssignmentSchema>;

/**
 * The "Assign allowance" form: the amount typed in pesos (`amount`, ignored for "End"), shaped
 * like {@link allowanceAssignmentSchema}. Field errors on the amount come back under `amount`.
 */
export const allowanceAssignmentFormSchema = z
  .object({
    employeeId: employeeIdField,
    typeKey: typeKeyField,
    effectiveDate: businessDateField('Enter the effective date.'),
    kind: z.enum(ALLOWANCE_ASSIGNMENT_KINDS, { error: 'Choose set an amount or end.' }),
    amount: z.unknown().optional(),
    reason: reasonField,
  })
  .transform((value, ctx): AllowanceAssignmentValues => {
    let amountCentavos: number | null = null;
    if (value.kind === 'set') {
      const parsed = pesoField({ requiredMessage: 'Enter the amount.' })
        .refine((centavos) => centavos > 0, { message: 'Enter an amount above zero.' })
        .safeParse(value.amount ?? '');
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          message: parsed.error.issues[0]?.message ?? 'Enter the amount.',
        });
        return z.NEVER;
      }
      amountCentavos = parsed.data;
    }
    return {
      employeeId: value.employeeId,
      typeKey: value.typeKey,
      effectiveDate: value.effectiveDate,
      kind: value.kind,
      amountCentavos,
      reason: value.reason,
    };
  });
