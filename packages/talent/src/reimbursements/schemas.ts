import { z } from 'zod';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Reimbursement settings") and
// docs/DATA_MODEL.md#versioned-configuration (`talent.reimbursementSettings`; decisions 235–237 in
// docs/BUILD_PLAN.md). Pure code, safe in the browser: the Reimbursements segment of Payroll
// settings and the services parse with the same schema.
//
// Self-contained on purpose: `payroll/schemas.ts` registers this schema under its setting key, so
// this file must not import from it. Amounts are whole centavos.

/** The filing window runs from 0 to 6 previous cut-offs. */
export const FILING_WINDOW_PREVIOUS_CUT_OFFS_MAX = 6;
/** A reimbursement type's name: 1 to 100 characters. */
export const REIMBURSEMENT_TYPE_NAME_MAX_LENGTH = 100;

/** What a type's limit counts: one line, or the employee's lines of that type on one day. */
export const REIMBURSEMENT_LIMIT_PERS = ['line', 'day'] as const;
export type ReimbursementLimitPer = (typeof REIMBURSEMENT_LIMIT_PERS)[number];
export const REIMBURSEMENT_LIMIT_PER_LABELS: Record<ReimbursementLimitPer, string> = {
  line: 'per receipt',
  day: 'per day',
};

const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;

export const reimbursementLimitSchema = z.object({
  amountCentavos: z
    .number({ error: 'Enter the limit.' })
    .int('Enter the limit in whole centavos.')
    .min(1, 'Enter a limit above zero.')
    .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.'),
  per: z.enum(REIMBURSEMENT_LIMIT_PERS, { error: 'Choose per receipt or per day.' }),
});
export type ReimbursementLimit = z.output<typeof reimbursementLimitSchema>;

export const reimbursementTypeSchema = z.object({
  key: z
    .string({ error: 'Enter the reimbursement type key.' })
    .trim()
    .regex(KEY, 'Use a key of letters and digits starting with a lowercase letter, like meal.'),
  name: z
    .string({ error: 'Enter the name.' })
    .trim()
    .min(1, 'Enter the name.')
    .max(
      REIMBURSEMENT_TYPE_NAME_MAX_LENGTH,
      `Use at most ${REIMBURSEMENT_TYPE_NAME_MAX_LENGTH} characters.`,
    ),
  active: z.boolean(),
  /** Pick-up and drop-off are required. */
  requiresRoute: z.boolean(),
  /** A description of the expense is required. */
  requiresDescription: z.boolean(),
  /** The client is required. */
  requiresClient: z.boolean(),
  /** Null: no limit. */
  limit: reimbursementLimitSchema.nullable(),
});
export type ReimbursementType = z.output<typeof reimbursementTypeSchema>;

export const reimbursementSettingsSchema = z
  .object({
    filingWindowPreviousCutOffs: z
      .number({ error: 'Enter the number of previous cut-offs.' })
      .int('Enter the number of previous cut-offs as a whole number.')
      .min(0, `Enter 0 to ${FILING_WINDOW_PREVIOUS_CUT_OFFS_MAX} previous cut-offs.`)
      .max(
        FILING_WINDOW_PREVIOUS_CUT_OFFS_MAX,
        `Enter 0 to ${FILING_WINDOW_PREVIOUS_CUT_OFFS_MAX} previous cut-offs.`,
      ),
    types: z.array(reimbursementTypeSchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.types.forEach((type, index) => {
      if (seen.has(type.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', index, 'key'],
          message: 'Each reimbursement type key can appear only once.',
        });
      }
      seen.add(type.key);
    });
  });
export type ReimbursementSettings = z.output<typeof reimbursementSettingsSchema>;

/**
 * The reimbursement type keys of `previous` missing from `next`. Keys are never removed: a type
 * no longer used is marked inactive. The service refuses a version when this isn't empty for any
 * stored version.
 */
export function removedReimbursementTypeKeys(
  previous: ReimbursementSettings | null | undefined,
  next: ReimbursementSettings,
): string[] {
  if (!previous) return [];
  const kept = new Set(next.types.map((type) => type.key));
  return previous.types.map((type) => type.key).filter((key) => !kept.has(key));
}

/** The type `key` in a version's value, or null when the version has no such type. */
export function reimbursementTypeOf(
  settings: ReimbursementSettings | null | undefined,
  key: string,
): ReimbursementType | null {
  return settings?.types.find((type) => type.key === key) ?? null;
}
