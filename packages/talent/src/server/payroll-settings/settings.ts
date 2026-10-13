import type { ClientSession } from 'mongoose';
import { connectDb } from '@pulse/db';
import {
  type ConfigDate,
  type ConfigSetting,
  type ConfigVersion,
  defineConfigSetting,
  findConfigVersion,
} from '@pulse/core/server';
import {
  PAYROLL_SETTING_KEYS,
  PAYROLL_SETTING_SCHEMAS,
  type PayrollSettingKey,
  type PayrollSettingValues,
} from '../../payroll/schemas';

// Spec: docs/DATA_MODEL.md#versioned-configuration ("Payroll settings", build step 2.3; decision
// 192 in docs/BUILD_PLAN.md) — the twelve Talent payroll settings (the work schedule and timesheet
// settings from build step 2.4, decisions 214 and 216), declared on Core's versioned
// configuration store. Amounts are whole centavos and rates decimal strings.

export const PAYROLL_SETTINGS_SETTING = defineConfigSetting(
  'talent.payrollSettings',
  PAYROLL_SETTING_SCHEMAS['talent.payrollSettings'],
);
export const SSS_CONTRIBUTIONS_SETTING = defineConfigSetting(
  'talent.sssContributions',
  PAYROLL_SETTING_SCHEMAS['talent.sssContributions'],
);
export const PHILHEALTH_CONTRIBUTIONS_SETTING = defineConfigSetting(
  'talent.philhealthContributions',
  PAYROLL_SETTING_SCHEMAS['talent.philhealthContributions'],
);
export const PAGIBIG_CONTRIBUTIONS_SETTING = defineConfigSetting(
  'talent.pagibigContributions',
  PAYROLL_SETTING_SCHEMAS['talent.pagibigContributions'],
);
export const WITHHOLDING_TAX_SEMI_MONTHLY_SETTING = defineConfigSetting(
  'talent.withholdingTaxSemiMonthly',
  PAYROLL_SETTING_SCHEMAS['talent.withholdingTaxSemiMonthly'],
);
export const PREMIUM_RATES_SETTING = defineConfigSetting(
  'talent.premiumRates',
  PAYROLL_SETTING_SCHEMAS['talent.premiumRates'],
);
export const DE_MINIMIS_LIMITS_SETTING = defineConfigSetting(
  'talent.deMinimisLimits',
  PAYROLL_SETTING_SCHEMAS['talent.deMinimisLimits'],
);
export const THIRTEENTH_MONTH_EXEMPTION_SETTING = defineConfigSetting(
  'talent.thirteenthMonthExemption',
  PAYROLL_SETTING_SCHEMAS['talent.thirteenthMonthExemption'],
);
export const MINIMUM_WAGES_SETTING = defineConfigSetting(
  'talent.minimumWages',
  PAYROLL_SETTING_SCHEMAS['talent.minimumWages'],
);
export const ALLOWANCE_TYPES_SETTING = defineConfigSetting(
  'talent.allowanceTypes',
  PAYROLL_SETTING_SCHEMAS['talent.allowanceTypes'],
);
export const WORK_SCHEDULE_SETTING = defineConfigSetting(
  'talent.workSchedule',
  PAYROLL_SETTING_SCHEMAS['talent.workSchedule'],
);
export const TIMESHEET_SETTINGS_SETTING = defineConfigSetting(
  'talent.timesheetSettings',
  PAYROLL_SETTING_SCHEMAS['talent.timesheetSettings'],
);

type SettingOf<K extends PayrollSettingKey> = ConfigSetting<(typeof PAYROLL_SETTING_SCHEMAS)[K]>;

/** Every payroll setting, by key. */
export const PAYROLL_SETTINGS: { readonly [K in PayrollSettingKey]: SettingOf<K> } = {
  'talent.payrollSettings': PAYROLL_SETTINGS_SETTING,
  'talent.sssContributions': SSS_CONTRIBUTIONS_SETTING,
  'talent.philhealthContributions': PHILHEALTH_CONTRIBUTIONS_SETTING,
  'talent.pagibigContributions': PAGIBIG_CONTRIBUTIONS_SETTING,
  'talent.withholdingTaxSemiMonthly': WITHHOLDING_TAX_SEMI_MONTHLY_SETTING,
  'talent.premiumRates': PREMIUM_RATES_SETTING,
  'talent.deMinimisLimits': DE_MINIMIS_LIMITS_SETTING,
  'talent.thirteenthMonthExemption': THIRTEENTH_MONTH_EXEMPTION_SETTING,
  'talent.minimumWages': MINIMUM_WAGES_SETTING,
  'talent.allowanceTypes': ALLOWANCE_TYPES_SETTING,
  'talent.workSchedule': WORK_SCHEDULE_SETTING,
  'talent.timesheetSettings': TIMESHEET_SETTINGS_SETTING,
};

// Every key in the list is declared (a compile-time and a load-time check).
for (const key of PAYROLL_SETTING_KEYS) {
  if (PAYROLL_SETTINGS[key].key !== key) throw new Error(`Payroll setting ${key} is miswired.`);
}

/**
 * The version of payroll setting `key` in effect on `on`, or null when none is. For later steps:
 * SSS, PhilHealth and Pag-IBIG on the 1st of the contribution month; the withholding table, the
 * de minimis limits and the 13th month ceiling on the pay date; premium rates, minimum wage and
 * allowance types on each day; `payrollSettings` on the cut-off's start date (decision 199); the
 * work schedule and timesheet settings on each day (step 2.4).
 */
export async function payrollSettingVersionOn<K extends PayrollSettingKey>(
  key: K,
  on: ConfigDate,
  { session }: { session?: ClientSession } = {},
): Promise<ConfigVersion<PayrollSettingValues[K]> | null> {
  await connectDb();
  const setting = PAYROLL_SETTINGS[key] as ConfigSetting<(typeof PAYROLL_SETTING_SCHEMAS)[K]>;
  return (await findConfigVersion(setting, on, { session })) as ConfigVersion<
    PayrollSettingValues[K]
  > | null;
}
