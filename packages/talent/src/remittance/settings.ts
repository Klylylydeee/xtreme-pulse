import { z } from 'zod';
import { addDays, type BusinessDate } from '@pulse/core';
import {
  addRemittanceMonths,
  firstDayOfMonth,
  lastDayOfMonth,
  REMITTANCE_AGENCIES,
  type RemittanceAgency,
  type RemittanceMonth,
} from './agencies';

// Spec: docs/DATA_MODEL.md#versioned-configuration (`talent.remittanceSettings`, build step 2.11)
// and docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Remittance
// settings"; decisions 383 and 384 in docs/BUILD_PLAN.md) — each agency's due date and the
// reminder lead days, as one versioned setting. Pure code, safe in the browser: the Remittances
// card's "Add version" sheet and the service parse with the same schema. A month's due date uses
// the version in effect on the first day of the month after it. Every seeded value is an
// *Assumption, to be confirmed by the accountant and HR* (HANDOFF items 373–376).

export const REMITTANCE_SETTINGS_KEY = 'talent.remittanceSettings';
export const REMITTANCE_SETTINGS_SEED_EFFECTIVE_FROM: BusinessDate = '2000-01-01';
export const REMITTANCE_SETTINGS_SEED_SOURCE =
  'Agency rules as understood on 2026-10-25 (step 2.11): check before the first remittance';
/** The setting's label on Payroll settings › Pay schedule. */
export const REMITTANCE_SETTINGS_LABEL = 'Remittances';

export const REMITTANCE_REMINDER_LEAD_DAYS_MAX = 30;

const dayOfMonthField = (what: string) =>
  z
    .number({ error: `Enter the ${what}.` })
    .int(`Enter the ${what} as a whole number.`)
    .min(1, `The ${what} runs from 1 to 31.`)
    .max(31, `The ${what} runs from 1 to 31.`);

export const remittanceDueRuleSchema = z.object({
  /** 1–31; a day past the month's end is its last day. */
  dueDay: dayOfMonthField('due day'),
  /** The due month: 1 (the next month) or 2 months after the remittance month. */
  monthsAfter: z
    .number({ error: 'Choose the month it is due in.' })
    .int('Choose the month it is due in.')
    .min(1, 'It is due 1 or 2 months after the remittance month.')
    .max(2, 'It is due 1 or 2 months after the remittance month.'),
  /** The day used for the December month instead of `dueDay`, or null. */
  decemberDueDay: dayOfMonthField('December due day').nullable(),
});
export type RemittanceDueRule = z.output<typeof remittanceDueRuleSchema>;

export const remittanceSettingsSchema = z.object({
  dueDates: z.object({
    sss: remittanceDueRuleSchema,
    philhealth: remittanceDueRuleSchema,
    pagibig: remittanceDueRuleSchema,
    bir1601c: remittanceDueRuleSchema,
  }) satisfies z.ZodType<Record<RemittanceAgency, RemittanceDueRule>>,
  reminderLeadDays: z
    .number({ error: 'Enter the reminder lead days.' })
    .int('Enter the reminder lead days as a whole number.')
    .min(0, `Enter 0 to ${REMITTANCE_REMINDER_LEAD_DAYS_MAX} days.`)
    .max(
      REMITTANCE_REMINDER_LEAD_DAYS_MAX,
      `Enter 0 to ${REMITTANCE_REMINDER_LEAD_DAYS_MAX} days.`,
    ),
});
export type RemittanceSettings = z.output<typeof remittanceSettingsSchema>;

/**
 * `talent.remittanceSettings` as `pnpm seed:admin` adds it from 2000-01-01 (decision 383): the
 * earliest possible date where the rule depends on the employer (decision 384). SSS the last day
 * of the next month (SSS Circular No. 2019-012); PhilHealth the 15th (the earlier window); Pag-IBIG
 * the 14th (HDMF Circular No. 275's earliest window; Circular No. 499-2026 not read); BIR 1601-C
 * the 10th, December's on January 15 (RR 2-98 as amended by RR 11-2018); 5 days' lead.
 */
export const SEED_REMITTANCE_SETTINGS: Readonly<RemittanceSettings> =
  Object.freeze<RemittanceSettings>({
    dueDates: {
      sss: { dueDay: 31, monthsAfter: 1, decemberDueDay: null },
      philhealth: { dueDay: 15, monthsAfter: 1, decemberDueDay: null },
      pagibig: { dueDay: 14, monthsAfter: 1, decemberDueDay: null },
      bir1601c: { dueDay: 10, monthsAfter: 1, decemberDueDay: 15 },
    },
    reminderLeadDays: 5,
  });

/** The day the month's due date's settings version is read on: the first of the next month. */
export function remittanceSettingsDayFor(month: RemittanceMonth): BusinessDate {
  return firstDayOfMonth(addRemittanceMonths(month, 1));
}

/**
 * The due date of `agency`'s remittance for `month` under `settings` (decision 383): `dueDay` (or
 * `decemberDueDay` for the December month) of the month `monthsAfter` after it, a day past that
 * month's end moved to its last day. Never moved for weekends or holidays (decision 384).
 */
export function remittanceDueDate(
  agency: RemittanceAgency,
  month: RemittanceMonth,
  settings: Pick<RemittanceSettings, 'dueDates'>,
): BusinessDate {
  const rule = settings.dueDates[agency];
  const dueMonth = addRemittanceMonths(month, rule.monthsAfter);
  const december = month.slice(5, 7) === '12';
  const day = december && rule.decemberDueDay !== null ? rule.decemberDueDay : rule.dueDay;
  const last = lastDayOfMonth(dueMonth);
  const lastDay = Number(last.slice(8, 10));
  return `${dueMonth}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/** The first day the `soon` reminder may go: `reminderLeadDays` before the due date. */
export function remittanceSoonFrom(
  dueDate: BusinessDate,
  settings: Pick<RemittanceSettings, 'reminderLeadDays'>,
): BusinessDate {
  return addDays(dueDate, -settings.reminderLeadDays);
}

/** Every agency's due date for `month`. */
export function remittanceDueDates(
  month: RemittanceMonth,
  settings: Pick<RemittanceSettings, 'dueDates'>,
): Record<RemittanceAgency, BusinessDate> {
  return Object.fromEntries(
    REMITTANCE_AGENCIES.map((agency) => [agency, remittanceDueDate(agency, month, settings)]),
  ) as Record<RemittanceAgency, BusinessDate>;
}
