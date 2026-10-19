import { z } from 'zod';
import type { BusinessDate } from '@pulse/core';
import type { ContributionAgency } from './schemas';

// Spec: docs/DATA_MODEL.md#versioned-configuration (`talent.payrollRunSettings`, build step 2.9)
// and docs/modules/talent.md#payroll-run-computation-build-step-29 ("Run settings"; decision 326
// in docs/BUILD_PLAN.md) — the payroll run policy as one versioned setting: the contribution base
// of each agency, whether a monthly-rated employee's unworked special day is deducted, and how
// many earlier cut-offs a run reconciles. Pure code, safe in the browser: the "Payroll run" card's
// "Add version" sheet and the service parse with the same schema. A run uses the version in
// effect on its cut-off's start. Every seeded value is an *Assumption, to be confirmed by the
// accountant* (HANDOFF items 225–257).
//
// The field names are the spec's exactly, so the pay engine's `PayrollRunPolicy`
// (../payroll-run/) is the same shape.

/** The setting's key. */
export const PAYROLL_RUN_SETTINGS_KEY = 'talent.payrollRunSettings';
/** The seeded version's effective date and source. */
export const PAYROLL_RUN_SETTINGS_SEED_EFFECTIVE_FROM: BusinessDate = '2000-01-01';
export const PAYROLL_RUN_SETTINGS_SEED_SOURCE =
  'Company policy (spec) and step 2.9 recommendations';
/** The setting's label on Payroll settings › Pay schedule. */
export const PAYROLL_RUN_SETTINGS_LABEL = 'Payroll run';

/**
 * What an agency's contribution is computed on: the monthly basic salary in effect on the first
 * day of the contribution month, or the month's compensation for contributions (both cut-offs).
 */
export const CONTRIBUTION_BASE_KINDS = ['monthlyBasicSalary', 'monthCompensation'] as const;
export type ContributionBaseKind = (typeof CONTRIBUTION_BASE_KINDS)[number];
export const CONTRIBUTION_BASE_KIND_LABELS: Record<ContributionBaseKind, string> = {
  monthlyBasicSalary: 'Monthly basic salary',
  monthCompensation: 'The month’s compensation',
};

/** A monthly-rated employee's unworked special day: covered by the salary, or deducted. */
export const UNWORKED_SPECIAL_DAY_TREATMENTS = ['paid', 'deducted'] as const;
export type UnworkedSpecialDayTreatment = (typeof UNWORKED_SPECIAL_DAY_TREATMENTS)[number];
export const UNWORKED_SPECIAL_DAY_TREATMENT_LABELS: Record<UnworkedSpecialDayTreatment, string> = {
  paid: 'Paid (the monthly salary covers it)',
  deducted: 'Deducted',
};

/** `adjustmentLookbackCutOffs` runs from 1 to 48 whole cut-offs (two years). */
export const ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN = 1;
export const ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX = 48;

const contributionBaseField = (agency: string) =>
  z.enum(CONTRIBUTION_BASE_KINDS, {
    error: `Choose the ${agency} base: the monthly basic salary or the month’s compensation.`,
  });

export const contributionBasesSchema = z.object({
  sss: contributionBaseField('SSS'),
  philhealth: contributionBaseField('PhilHealth'),
  pagibig: contributionBaseField('Pag-IBIG'),
}) satisfies z.ZodType<Record<ContributionAgency, ContributionBaseKind>>;
export type ContributionBases = z.output<typeof contributionBasesSchema>;

export const payrollRunSettingsSchema = z.object({
  contributionBases: contributionBasesSchema,
  monthlyRatedUnworkedSpecialDay: z.enum(UNWORKED_SPECIAL_DAY_TREATMENTS, {
    error: 'Choose whether an unworked special day is paid or deducted.',
  }),
  adjustmentLookbackCutOffs: z
    .number({ error: 'Enter how many cut-offs to look back.' })
    .int('Enter the cut-offs to look back as a whole number.')
    .min(
      ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN,
      `The lookback runs from ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN} to ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX} cut-offs.`,
    )
    .max(
      ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX,
      `The lookback runs from ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MIN} to ${ADJUSTMENT_LOOKBACK_CUT_OFFS_MAX} cut-offs.`,
    ),
});
export type PayrollRunSettings = z.output<typeof payrollRunSettingsSchema>;
export type PayrollRunSettingsInput = z.input<typeof payrollRunSettingsSchema>;

/**
 * `talent.payrollRunSettings` as `pnpm seed:admin` adds it from 2000-01-01 (decision 326): PhilHealth
 * on the monthly basic salary, SSS and Pag-IBIG on the month's compensation (step 2.3's
 * recommendation), an unworked special day paid for the monthly-rated, and a lookback of 24
 * cut-offs (a year). Every value an *Assumption, to be confirmed by the accountant*.
 */
export const SEED_PAYROLL_RUN_SETTINGS: Readonly<PayrollRunSettings> =
  Object.freeze<PayrollRunSettings>({
    contributionBases: {
      sss: 'monthCompensation',
      philhealth: 'monthlyBasicSalary',
      pagibig: 'monthCompensation',
    },
    monthlyRatedUnworkedSpecialDay: 'paid',
    adjustmentLookbackCutOffs: 24,
  });
