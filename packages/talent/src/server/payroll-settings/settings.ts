import type { ClientSession } from 'mongoose';
import { connectDb } from '@pulse/db';
import {
  type ConfigDate,
  type ConfigSetting,
  type ConfigVersion,
  defineConfigSetting,
  findConfigVersion,
} from '@pulse/core/server';
import { type BusinessDate, businessToday } from '@pulse/core';
import {
  PAYROLL_RUN_SETTINGS_KEY,
  type PayrollRunSettings,
  payrollRunSettingsSchema,
  SEED_PAYROLL_RUN_SETTINGS,
} from '../../payroll/run-settings';
import {
  REMITTANCE_SETTINGS_KEY,
  type RemittanceSettings,
  remittanceSettingsSchema,
  SEED_REMITTANCE_SETTINGS,
} from '../../remittance/settings';
import {
  LEAVE_SETTINGS_KEY,
  type LeaveSettings,
  leaveSettingsSchema,
  SEED_LEAVE_SETTINGS,
} from '../../time-off/settings';
import {
  PAYROLL_SETTING_KEYS,
  PAYROLL_SETTING_SCHEMAS,
  type PayrollSettingKey,
  type PayrollSettingValues,
} from '../../payroll/schemas';

// Spec: docs/DATA_MODEL.md#versioned-configuration ("Payroll settings", build step 2.3; decision
// 192 in docs/BUILD_PLAN.md) — the thirteen Talent payroll settings (the work schedule and
// timesheet settings from build step 2.4, decisions 214 and 216; the reimbursement settings from
// build step 2.5, decision 235), declared on Core's versioned
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
export const REIMBURSEMENT_SETTINGS_SETTING = defineConfigSetting(
  'talent.reimbursementSettings',
  PAYROLL_SETTING_SCHEMAS['talent.reimbursementSettings'],
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
  'talent.reimbursementSettings': REIMBURSEMENT_SETTINGS_SETTING,
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
 * work schedule and timesheet settings on each day (step 2.4); the reimbursement settings on a
 * line's receipt date for its type, required fields and limit, and today for the filing window
 * (step 2.5).
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

// ---------------------------------------------------------------------------------------------
// Step 2.8: `talent.leaveSettings` (decisions 300, 301 and 306 in docs/BUILD_PLAN.md). Kept apart
// from the thirteen payroll settings above, with its own view and "Add version" in ./service.ts
// (the Leave segment of Payroll settings), under the same step 2.3 rules plus the go-live lock.

export const LEAVE_SETTINGS_SETTING = defineConfigSetting(LEAVE_SETTINGS_KEY, leaveSettingsSchema);

/**
 * `talent.leaveSettings` in effect on `on` (today by default). Before any version exists (only
 * before `pnpm seed:admin` has run) the seeded value applies; its go-live date is null, so nothing
 * is credited and no opening entry can be entered.
 */
export async function leaveSettingsOn(
  on: ConfigDate = businessToday(),
  { session }: { session?: ClientSession | null } = {},
): Promise<LeaveSettings> {
  await connectDb();
  const version = await findConfigVersion(LEAVE_SETTINGS_SETTING, on, {
    session: session ?? undefined,
  });
  return version?.value ?? structuredClone(SEED_LEAVE_SETTINGS);
}

// ---------------------------------------------------------------------------------------------
// Step 2.9: `talent.payrollRunSettings` (decision 326 in docs/BUILD_PLAN.md): the contribution
// bases, the monthly-rated unworked special day and the adjustment lookback. Kept apart from the
// thirteen payroll settings, like the leave settings, with its own view and "Add version" in
// ./service.ts (the "Payroll run" card in the Pay schedule segment), under the step 2.3 rules.

export const PAYROLL_RUN_SETTINGS_SETTING = defineConfigSetting(
  PAYROLL_RUN_SETTINGS_KEY,
  payrollRunSettingsSchema,
);

/**
 * `talent.payrollRunSettings` in effect on `on` (a run passes its cut-off's start), with the
 * version's effective date for the run's `settingVersions`. Before any version exists (only
 * before `pnpm seed:admin` has run) the seeded value applies, with a null date.
 */
export async function payrollRunSettingsOn(
  on: ConfigDate,
  { session }: { session?: ClientSession | null } = {},
): Promise<{ value: PayrollRunSettings; effectiveFrom: BusinessDate | null }> {
  await connectDb();
  const version = await findConfigVersion(PAYROLL_RUN_SETTINGS_SETTING, on, {
    session: session ?? undefined,
  });
  return version
    ? { value: version.value, effectiveFrom: version.effectiveFrom }
    : { value: structuredClone(SEED_PAYROLL_RUN_SETTINGS), effectiveFrom: null };
}

// ---------------------------------------------------------------------------------------------
// Step 2.11: `talent.remittanceSettings` (decision 383 in docs/BUILD_PLAN.md): each agency's due date
// and the reminder lead days. Kept apart from the thirteen payroll settings, like the payroll run
// settings, with its own view and "Add version" in ./service.ts (the
// "Remittances" card in the Pay schedule segment), under the step 2.3 rules.

export const REMITTANCE_SETTINGS_SETTING = defineConfigSetting(
  REMITTANCE_SETTINGS_KEY,
  remittanceSettingsSchema,
);

/**
 * `talent.remittanceSettings` in effect on `on` (a month's due date reads the first day of the
 * month after it), with the version's effective date for the report's `settingVersions`. Before
 * any version exists (only before `pnpm seed:admin` has run) the seeded value applies, with a
 * null date.
 */
export async function remittanceSettingsOn(
  on: ConfigDate,
  { session }: { session?: ClientSession | null } = {},
): Promise<{ value: RemittanceSettings; effectiveFrom: BusinessDate | null }> {
  await connectDb();
  const version = await findConfigVersion(REMITTANCE_SETTINGS_SETTING, on, {
    session: session ?? undefined,
  });
  return version
    ? { value: version.value, effectiveFrom: version.effectiveFrom }
    : { value: structuredClone(SEED_REMITTANCE_SETTINGS), effectiveFrom: null };
}
