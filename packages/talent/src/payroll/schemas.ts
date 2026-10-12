import { z } from 'zod';
import { businessDateField, type Ratio, ratio } from '@pulse/core';
import { WORK_REGIONS } from '../fixed-sets';

// Spec: docs/DATA_MODEL.md#versioned-configuration ("Payroll settings", build step 2.3) and
// docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 (decisions 192, 197, 200 and
// 201 in docs/BUILD_PLAN.md) — the shape and checks of the ten Talent payroll settings. Pure code,
// safe in the browser: the "Add version" sheets and the service parse with the same schemas.
//
// Every number is a whole number (centavos, days, counts); rates are decimal strings ("0.05"),
// read exactly with the money helpers (`ratio`). Core's store also refuses any fractional number.

/** The ten payroll setting keys, in the page's order. */
export const PAYROLL_SETTING_KEYS = [
  'talent.payrollSettings',
  'talent.sssContributions',
  'talent.philhealthContributions',
  'talent.pagibigContributions',
  'talent.withholdingTaxSemiMonthly',
  'talent.premiumRates',
  'talent.deMinimisLimits',
  'talent.thirteenthMonthExemption',
  'talent.minimumWages',
  'talent.allowanceTypes',
] as const;
export type PayrollSettingKey = (typeof PAYROLL_SETTING_KEYS)[number];

export const PAYROLL_SETTING_LABELS: Record<PayrollSettingKey, string> = {
  'talent.payrollSettings': 'Pay schedule',
  'talent.sssContributions': 'SSS contributions',
  'talent.philhealthContributions': 'PhilHealth contributions',
  'talent.pagibigContributions': 'Pag-IBIG contributions',
  'talent.withholdingTaxSemiMonthly': 'Withholding tax (semi-monthly)',
  'talent.premiumRates': 'Premium rates',
  'talent.deMinimisLimits': 'De minimis limits',
  'talent.thirteenthMonthExemption': '13th month ceiling',
  'talent.minimumWages': 'Minimum wage',
  'talent.allowanceTypes': 'Allowance types',
};

export function isPayrollSettingKey(value: unknown): value is PayrollSettingKey {
  return typeof value === 'string' && (PAYROLL_SETTING_KEYS as readonly string[]).includes(value);
}

/** The source of a version added from the page: required, up to 300 characters. */
export const PAYROLL_SOURCE_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------------------------
// Building blocks

const DECIMAL = /^\d{1,6}(?:\.\d{1,6})?$/;

/** The exact value of a decimal string, or null when it isn't one (an issue is already raised). */
function safeRatio(value: unknown): Ratio | null {
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return null;
  return ratio(value);
}

/** A non-negative decimal string rate, such as "0.05" or "2.60". */
export const rateField = z
  .string({ error: 'Enter a rate, like 0.05.' })
  .trim()
  .regex(DECIMAL, 'Enter a rate as a decimal number, like 0.05.');

/** A rate from 0 to 1 inclusive. */
export const shareField = rateField.refine(
  (value) => {
    const r = safeRatio(value);
    return r === null || r.numerator <= r.denominator;
  },
  { message: 'Enter a share from 0 to 1.' },
);

/** A whole number of centavos, zero or more. */
export const centavosField = z
  .number({ error: 'Enter an amount.' })
  .int('Enter the amount in whole centavos.')
  .min(0, 'Enter an amount of zero or more.')
  .max(Number.MAX_SAFE_INTEGER, 'The amount is too large.');

/** A whole number of centavos above zero. */
export const positiveCentavosField = centavosField.refine((value) => value > 0, {
  message: 'Enter an amount above zero.',
});

const sameRate = (a: string, b: string) => {
  const x = safeRatio(a);
  const y = safeRatio(b);
  return x !== null && y !== null && x.numerator === y.numerator && x.denominator === y.denominator;
};

// ---------------------------------------------------------------------------------------------
// talent.payrollSettings

export const CUT_OFF_KEYS = ['midMonth', 'endOfMonth'] as const;
export type CutOffKey = (typeof CUT_OFF_KEYS)[number];
export const CUT_OFF_LABELS: Record<CutOffKey, string> = {
  midMonth: 'Mid-month pay',
  endOfMonth: 'End-of-month pay',
};
export const CONTRIBUTION_AGENCIES = ['sss', 'philhealth', 'pagibig'] as const;
export type ContributionAgency = (typeof CONTRIBUTION_AGENCIES)[number];

const dayField = (max: number, what: string) =>
  z
    .number({ error: `Enter the ${what}.` })
    .int(`Enter the ${what} as a whole number.`)
    .min(1, `The ${what} runs from 1 to ${max}.`)
    .max(max, `The ${what} runs from 1 to ${max}.`);

export const cutOffSchema = z.object({
  key: z.enum(CUT_OFF_KEYS, { error: 'Choose mid-month or end-of-month.' }),
  startDay: dayField(28, 'start day'),
  endDay: dayField(28, 'end day'),
  payDay: dayField(31, 'pay day'),
});
export type CutOff = z.output<typeof cutOffSchema>;

const splitSchema = z.object({ midMonth: shareField, endOfMonth: shareField });

/** True when cut-off `c` covers day `d` (1 to 31) of a 31-day month. */
function covers(c: CutOff, d: number): boolean {
  if (c.startDay <= c.endDay) return d >= c.startDay && (d <= c.endDay || c.endDay === 28);
  return d >= c.startDay || d <= c.endDay;
}

export const payrollSettingsSchema = z
  .object({
    cutOffs: z.array(cutOffSchema).length(2, 'Enter exactly two cut-offs.'),
    dailyRateFactor: z
      .number({ error: 'Enter the daily rate factor.' })
      .int('Enter the daily rate factor as a whole number.')
      .min(1, 'Enter a daily rate factor above zero.')
      .max(366, 'Enter a daily rate factor of at most 366.'),
    hoursPerDay: z
      .number({ error: 'Enter the hours per day.' })
      .int('Enter the hours per day as a whole number.')
      .min(1, 'Enter 1 to 24 hours per day.')
      .max(24, 'Enter 1 to 24 hours per day.'),
    contributionSplit: z.object({
      sss: splitSchema,
      philhealth: splitSchema,
      pagibig: splitSchema,
    }),
  })
  .superRefine((value, ctx) => {
    const keys = new Set(value.cutOffs.map((c) => c.key));
    if (keys.size !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['cutOffs'],
        message: 'Enter one mid-month and one end-of-month cut-off.',
      });
      return;
    }
    for (let d = 1; d <= 31; d += 1) {
      const count = value.cutOffs.filter((c) => covers(c, d)).length;
      if (count !== 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['cutOffs'],
          message:
            count === 0
              ? `The cut-offs leave day ${d} out. Together they must cover every day of the month.`
              : `The cut-offs overlap on day ${d}. Each day belongs to exactly one cut-off.`,
        });
        return;
      }
    }
    value.cutOffs.forEach((c, index) => {
      // The pay date falls in the month the cut-off ends, after its end day, in every month
      // (a pay day past the month's end moves to its last day, so check February's 28 too).
      if (Math.min(c.payDay, 28) <= c.endDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['cutOffs', index, 'payDay'],
          message: 'The pay day must come after the cut-off’s end day, in the month it ends.',
        });
      }
    });
    for (const agency of CONTRIBUTION_AGENCIES) {
      const split = value.contributionSplit[agency];
      const total = safeRatio(split.midMonth);
      const other = safeRatio(split.endOfMonth);
      if (!total || !other) continue;
      const sum = total.numerator * other.denominator + other.numerator * total.denominator;
      if (sum !== total.denominator * other.denominator) {
        ctx.addIssue({
          code: 'custom',
          path: ['contributionSplit', agency],
          message: 'The two parts of the split must add up to exactly 1.',
        });
      }
    }
  });
export type PayrollSettings = z.output<typeof payrollSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// talent.sssContributions

const sharePartsSchema = z.object({ regularCentavos: centavosField, mpfCentavos: centavosField });

export const sssRowSchema = z.object({
  minCompensationCentavos: centavosField,
  regularMscCentavos: positiveCentavosField,
  mpfMscCentavos: centavosField,
  employee: sharePartsSchema,
  employer: sharePartsSchema,
  ecCentavos: centavosField,
});
export type SssRow = z.output<typeof sssRowSchema>;

export const sssContributionsSchema = z
  .object({ rows: z.array(sssRowSchema).min(1, 'Enter at least one row.') })
  .superRefine((value, ctx) => {
    if (value.rows[0]?.minCompensationCentavos !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows', 0, 'minCompensationCentavos'],
        message: 'The first row must start at ₱0.00.',
      });
    }
    value.rows.forEach((row, index) => {
      const previous = value.rows[index - 1];
      if (previous && row.minCompensationCentavos <= previous.minCompensationCentavos) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index, 'minCompensationCentavos'],
          message: 'Each row must start above the row before it.',
        });
      }
      if (
        previous &&
        row.regularMscCentavos + row.mpfMscCentavos <=
          previous.regularMscCentavos + previous.mpfMscCentavos
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index, 'regularMscCentavos'],
          message: 'Each row’s salary credit (regular SS + MPF) must be above the row before it.',
        });
      }
      if (row.mpfMscCentavos === 0 && (row.employee.mpfCentavos || row.employer.mpfCentavos)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', index, 'mpfMscCentavos'],
          message: 'A row with no MPF salary credit can’t have MPF shares.',
        });
      }
    });
  });
export type SssContributions = z.output<typeof sssContributionsSchema>;

// ---------------------------------------------------------------------------------------------
// talent.philhealthContributions

export const philhealthContributionsSchema = z
  .object({
    premiumRate: shareField,
    employeeShare: shareField,
    floorCentavos: centavosField,
    ceilingCentavos: positiveCentavosField,
  })
  .refine((value) => value.floorCentavos <= value.ceilingCentavos, {
    path: ['ceilingCentavos'],
    message: 'The ceiling must be at least the floor.',
  });
export type PhilhealthContributions = z.output<typeof philhealthContributionsSchema>;

// ---------------------------------------------------------------------------------------------
// talent.pagibigContributions

export const pagibigBracketSchema = z.object({
  upToCentavos: positiveCentavosField.nullable(),
  employeeRate: shareField,
  employerRate: shareField,
});
export type PagibigBracket = z.output<typeof pagibigBracketSchema>;

export const pagibigContributionsSchema = z
  .object({
    brackets: z.array(pagibigBracketSchema).min(1, 'Enter at least one bracket.'),
    maxFundSalaryCentavos: positiveCentavosField,
  })
  .superRefine((value, ctx) => {
    value.brackets.forEach((bracket, index) => {
      const last = index === value.brackets.length - 1;
      if (last !== (bracket.upToCentavos === null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['brackets', index, 'upToCentavos'],
          message: last
            ? 'The last bracket has no upper limit.'
            : 'Every bracket but the last needs an upper limit.',
        });
      }
      const previous = value.brackets[index - 1]?.upToCentavos;
      if (
        typeof previous === 'number' &&
        bracket.upToCentavos !== null &&
        bracket.upToCentavos <= previous
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['brackets', index, 'upToCentavos'],
          message: 'Each bracket must end above the bracket before it.',
        });
      }
    });
  });
export type PagibigContributions = z.output<typeof pagibigContributionsSchema>;

// ---------------------------------------------------------------------------------------------
// talent.withholdingTaxSemiMonthly

export const withholdingBracketSchema = z.object({
  overCentavos: centavosField,
  baseTaxCentavos: centavosField,
  rate: shareField,
});
export type WithholdingBracket = z.output<typeof withholdingBracketSchema>;

export const withholdingTaxSemiMonthlySchema = z
  .object({ brackets: z.array(withholdingBracketSchema).min(1, 'Enter at least one bracket.') })
  .superRefine((value, ctx) => {
    const first = value.brackets[0];
    if (
      !first ||
      first.overCentavos !== 0 ||
      first.baseTaxCentavos !== 0 ||
      !sameRate(first.rate, '0')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['brackets', 0],
        message: 'The first bracket must be over ₱0.00, with no base tax and a rate of 0.',
      });
    }
    value.brackets.forEach((bracket, index) => {
      const previous = value.brackets[index - 1];
      if (previous && bracket.overCentavos <= previous.overCentavos) {
        ctx.addIssue({
          code: 'custom',
          path: ['brackets', index, 'overCentavos'],
          message: 'Each bracket must start above the bracket before it.',
        });
      }
    });
  });
export type WithholdingTaxSemiMonthly = z.output<typeof withholdingTaxSemiMonthlySchema>;

// ---------------------------------------------------------------------------------------------
// talent.premiumRates

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const timeField = z
  .string({ error: 'Enter a time, like 22:00.' })
  .trim()
  .regex(TIME, 'Enter a time as HH:MM, like 22:00.');

export const PREMIUM_RATE_FIELDS = [
  'regularHolidayWorked',
  'regularHolidayUnworked',
  'specialDayWorked',
  'specialDayUnworked',
  'restDayWorked',
  'specialDayOnRestDay',
  'regularHolidayOnRestDay',
  'overtimeOrdinaryAddOn',
  'overtimeRestDayHolidayAddOn',
  'nightDifferentialAddOn',
] as const;
export type PremiumRateField = (typeof PREMIUM_RATE_FIELDS)[number];
export const PREMIUM_RATE_LABELS: Record<PremiumRateField, string> = {
  regularHolidayWorked: 'Regular holiday, worked',
  regularHolidayUnworked: 'Regular holiday, unworked',
  specialDayWorked: 'Special non-working day, worked',
  specialDayUnworked: 'Special non-working day, unworked',
  restDayWorked: 'Rest day, worked',
  specialDayOnRestDay: 'Special non-working day on a rest day',
  regularHolidayOnRestDay: 'Regular holiday on a rest day',
  overtimeOrdinaryAddOn: 'Overtime add-on, ordinary days',
  overtimeRestDayHolidayAddOn: 'Overtime add-on, rest days and holidays',
  nightDifferentialAddOn: 'Night differential add-on',
};

export const premiumRatesSchema = z
  .object({
    ...(Object.fromEntries(PREMIUM_RATE_FIELDS.map((field) => [field, rateField])) as Record<
      PremiumRateField,
      typeof rateField
    >),
    nightStart: timeField,
    nightEnd: timeField,
  })
  .refine((value) => value.nightStart !== value.nightEnd, {
    path: ['nightEnd'],
    message: 'The night window must end at a different time than it starts.',
  });
export type PremiumRates = z.output<typeof premiumRatesSchema>;

// ---------------------------------------------------------------------------------------------
// talent.deMinimisLimits

export const DE_MINIMIS_PERIODS = ['month', 'semester', 'year', 'day'] as const;
export type DeMinimisPeriod = (typeof DE_MINIMIS_PERIODS)[number];
export const DE_MINIMIS_PERIOD_LABELS: Record<DeMinimisPeriod, string> = {
  month: 'a month',
  semester: 'a semester',
  year: 'a year',
  day: 'a day',
};

const KEY = /^[a-z][a-zA-Z0-9]{0,39}$/;
const keyField = (what: string) =>
  z
    .string({ error: `Enter the ${what} key.` })
    .trim()
    .regex(
      KEY,
      `Use a key of letters and digits starting with a lowercase letter, like riceSubsidy.`,
    );

export const deMinimisItemSchema = z
  .object({
    key: keyField('benefit'),
    label: z
      .string({ error: 'Enter the label.' })
      .trim()
      .min(1, 'Enter the label.')
      .max(200, 'Use at most 200 characters.'),
    period: z.enum(DE_MINIMIS_PERIODS, { error: 'Choose a period.' }),
    limitCentavos: positiveCentavosField.nullable(),
    rateOfMinimumWage: shareField.nullable(),
  })
  .refine((value) => (value.limitCentavos === null) !== (value.rateOfMinimumWage === null), {
    path: ['limitCentavos'],
    message: 'Enter either an amount or a share of the minimum wage, not both.',
  });
export type DeMinimisItem = z.output<typeof deMinimisItemSchema>;

export const deMinimisLimitsSchema = z
  .object({ items: z.array(deMinimisItemSchema) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.items.forEach((item, index) => {
      if (seen.has(item.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'key'],
          message: 'Each benefit key can appear only once.',
        });
      }
      seen.add(item.key);
    });
  });
export type DeMinimisLimits = z.output<typeof deMinimisLimitsSchema>;

// ---------------------------------------------------------------------------------------------
// talent.thirteenthMonthExemption

export const thirteenthMonthExemptionSchema = z.object({
  exemptCeilingCentavos: positiveCentavosField,
});
export type ThirteenthMonthExemption = z.output<typeof thirteenthMonthExemptionSchema>;

// ---------------------------------------------------------------------------------------------
// talent.minimumWages

export const minimumWageRegionSchema = z.object({
  region: z.enum(WORK_REGIONS, { error: 'Choose a region from the list.' }),
  wageOrder: z
    .string({ error: 'Enter the wage order.' })
    .trim()
    .min(1, 'Enter the wage order.')
    .max(100, 'Use at most 100 characters.'),
  dailyRateCentavos: positiveCentavosField,
});
export type MinimumWageRegion = z.output<typeof minimumWageRegionSchema>;

export const minimumWagesSchema = z
  .object({ regions: z.array(minimumWageRegionSchema).min(1, 'Enter at least one region.') })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.regions.forEach((row, index) => {
      if (seen.has(row.region)) {
        ctx.addIssue({
          code: 'custom',
          path: ['regions', index, 'region'],
          message: 'Each region can appear only once.',
        });
      }
      seen.add(row.region);
    });
  });
export type MinimumWages = z.output<typeof minimumWagesSchema>;

// ---------------------------------------------------------------------------------------------
// talent.allowanceTypes

export const ALLOWANCE_TAX_TREATMENTS = ['taxable', 'nonTaxable', 'deMinimis'] as const;
export type AllowanceTaxTreatment = (typeof ALLOWANCE_TAX_TREATMENTS)[number];
export const ALLOWANCE_TAX_TREATMENT_LABELS: Record<AllowanceTaxTreatment, string> = {
  taxable: 'Taxable',
  nonTaxable: 'Non-taxable',
  deMinimis: 'De minimis',
};
export const ALLOWANCE_BASES = ['perCutOff', 'perDayPresent'] as const;
export type AllowanceBasis = (typeof ALLOWANCE_BASES)[number];
export const ALLOWANCE_BASIS_LABELS: Record<AllowanceBasis, string> = {
  perCutOff: 'per cut-off',
  perDayPresent: 'per day present',
};

export const allowanceTypeSchema = z
  .object({
    key: keyField('allowance type'),
    name: z
      .string({ error: 'Enter the name.' })
      .trim()
      .min(1, 'Enter the name.')
      .max(100, 'Use at most 100 characters.'),
    taxTreatment: z.enum(ALLOWANCE_TAX_TREATMENTS, { error: 'Choose a tax treatment.' }),
    deMinimisKey: z.string().trim().regex(KEY, 'Choose a de minimis limit.').nullable(),
    basis: z.enum(ALLOWANCE_BASES, { error: 'Choose a basis.' }),
    defaultAmountCentavos: centavosField,
    autoAssign: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if ((value.taxTreatment === 'deMinimis') !== (value.deMinimisKey !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['deMinimisKey'],
        message:
          value.taxTreatment === 'deMinimis'
            ? 'Choose the de minimis limit this allowance counts against.'
            : 'Only a de minimis allowance names a de minimis limit.',
      });
    }
    if (value.autoAssign && value.basis !== 'perCutOff') {
      ctx.addIssue({
        code: 'custom',
        path: ['autoAssign'],
        message: 'Only a fixed amount per cut-off can be assigned automatically.',
      });
    }
    if (value.autoAssign && value.defaultAmountCentavos <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultAmountCentavos'],
        message: 'An automatic allowance needs a default amount above zero.',
      });
    }
  });
export type AllowanceType = z.output<typeof allowanceTypeSchema>;

export const allowanceTypesSchema = z
  .object({ types: z.array(allowanceTypeSchema) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.types.forEach((type, index) => {
      if (seen.has(type.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', index, 'key'],
          message: 'Each allowance type key can appear only once.',
        });
      }
      seen.add(type.key);
    });
  });
export type AllowanceTypes = z.output<typeof allowanceTypesSchema>;

/** The allowance type keys of `previous` missing from `next` (keys are never removed). */
export function removedAllowanceTypeKeys(
  previous: AllowanceTypes | null | undefined,
  next: AllowanceTypes,
): string[] {
  if (!previous) return [];
  const kept = new Set(next.types.map((type) => type.key));
  return previous.types.map((type) => type.key).filter((key) => !kept.has(key));
}

// ---------------------------------------------------------------------------------------------
// The schemas by key

export const PAYROLL_SETTING_SCHEMAS = {
  'talent.payrollSettings': payrollSettingsSchema,
  'talent.sssContributions': sssContributionsSchema,
  'talent.philhealthContributions': philhealthContributionsSchema,
  'talent.pagibigContributions': pagibigContributionsSchema,
  'talent.withholdingTaxSemiMonthly': withholdingTaxSemiMonthlySchema,
  'talent.premiumRates': premiumRatesSchema,
  'talent.deMinimisLimits': deMinimisLimitsSchema,
  'talent.thirteenthMonthExemption': thirteenthMonthExemptionSchema,
  'talent.minimumWages': minimumWagesSchema,
  'talent.allowanceTypes': allowanceTypesSchema,
} as const satisfies Record<PayrollSettingKey, z.ZodType>;

/** Each setting's value, by key. */
export type PayrollSettingValues = {
  [K in PayrollSettingKey]: z.output<(typeof PAYROLL_SETTING_SCHEMAS)[K]>;
};

/** "Add version" for any setting: the value is checked against that key's schema separately. */
export const payrollSettingsVersionSchema = z.object({
  key: z.enum(PAYROLL_SETTING_KEYS, { error: 'Choose a setting.' }),
  effectiveFrom: businessDateField('Enter the effective date.'),
  source: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: 'Enter the source, like the circular or wage order.' })
      .min(1, 'Enter the source, like the circular or wage order.')
      .max(PAYROLL_SOURCE_MAX_LENGTH, `Use at most ${PAYROLL_SOURCE_MAX_LENGTH} characters.`),
  ),
  value: z.unknown(),
});
export type PayrollSettingsVersionInput = z.input<typeof payrollSettingsVersionSchema>;
