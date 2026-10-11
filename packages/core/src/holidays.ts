import { z } from 'zod';
import { OBJECT_ID_PATTERN } from './audit';
import { addDays, type BusinessDate, isBusinessDate } from './dates';
import { businessDateField } from './validation';

// Spec: docs/modules/core.md#holiday-calendar (build step 1.10, decisions 111–132 in
// docs/BUILD_PLAN.md) — the holiday calendar's fixed sets, the form schemas, the auto-draft rule
// shapes and the date rules (Easter, the last weekday of a month). Pure code, safe in the
// browser, so the `/holidays` sheets and the services (`@pulse/core/server`) check the same rules.
//
// Every date here is a business date (`"YYYY-MM-DD"`, a Manila calendar day). The service stores
// it as 00:00 Manila in UTC (`startOfBusinessDate`), like `employees.separationDate`.

// ---------------------------------------------------------------------------------------------
// Fixed sets (docs/CODE_STYLE.md#constants-versus-data)

/** A holiday's type. How each is paid is a Talent payroll rule (Phase 2), not decided here. */
export const HOLIDAY_TYPES = ['regular', 'specialNonWorking', 'specialWorking'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];
export const HOLIDAY_TYPE_LABELS: Readonly<Record<HolidayType, string>> = {
  regular: 'Regular holiday',
  specialNonWorking: 'Special non-working day',
  specialWorking: 'Special working day',
};

/** Nationwide, or a specific city or municipality (`location`). */
export const HOLIDAY_SCOPES = ['nationwide', 'local'] as const;
export type HolidayScope = (typeof HOLIDAY_SCOPES)[number];
export const HOLIDAY_SCOPE_LABELS: Readonly<Record<HolidayScope, string>> = {
  nationwide: 'Nationwide',
  local: 'Local',
};

/** Only confirmed holidays affect attendance, leave and payroll. There is no unconfirm. */
export const HOLIDAY_STATUSES = ['draft', 'confirmed'] as const;
export type HolidayStatus = (typeof HOLIDAY_STATUSES)[number];
export const HOLIDAY_STATUS_LABELS: Readonly<Record<HolidayStatus, string>> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
};

/** Where a holiday came from: added by hand (or declared), an auto-draft rule, or the feed. */
export const HOLIDAY_SOURCES = ['manual', 'rule', 'online'] as const;
export type HolidaySource = (typeof HOLIDAY_SOURCES)[number];
export const HOLIDAY_SOURCE_LABELS: Readonly<Record<HolidaySource, string>> = {
  manual: 'Added by hand',
  rule: 'Auto-draft',
  online: 'Online source',
};

// ---------------------------------------------------------------------------------------------
// Limits

export const HOLIDAY_NAME_MAX_LENGTH = 100;
export const HOLIDAY_LOCATION_MAX_LENGTH = 100;
export const HOLIDAY_LEGAL_BASIS_MAX_LENGTH = 200;
/** The years a holiday can be in (any four-digit year; the auto-draft by hand is narrower). */
export const HOLIDAY_YEAR_MIN = 1000;
export const HOLIDAY_YEAR_MAX = 9999;

/** A holiday's `year`: the Manila calendar year of its date. */
export function holidayYearOf(date: BusinessDate): number {
  return Number(date.slice(0, 4));
}

/** The audit label: `<name> · <YYYY-MM-DD>`, for example `Christmas Day · 2027-12-25`. */
export function holidayAuditLabel(holiday: { name: string; date: BusinessDate }): string {
  return `${holiday.name} · ${holiday.date}`;
}

// ---------------------------------------------------------------------------------------------
// Form schemas. Each *Input type is what a service takes: the form's values as sent (the service
// parses them again with the same schema).

const holidayName = z
  .string({ error: 'Enter the holiday’s name.' })
  .trim()
  .min(1, 'Enter the holiday’s name.')
  .max(HOLIDAY_NAME_MAX_LENGTH, `Use ${HOLIDAY_NAME_MAX_LENGTH} characters or fewer.`);

const holidayType = z.enum(HOLIDAY_TYPES, { error: 'Choose a type.' });
const holidayScope = z.enum(HOLIDAY_SCOPES, { error: 'Choose nationwide or local.' });

/** Optional text: empty or missing reads as null. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null));
}

const LOCATION_REQUIRED = 'Enter the city or municipality for a local holiday.';
const LEGAL_BASIS_REQUIRED = 'Enter the legal basis, for example “Proclamation No. 1006”.';

const holidayFields = z.object({
  name: holidayName,
  date: businessDateField('Enter the holiday’s date.'),
  type: holidayType,
  scope: holidayScope,
  location: optionalText(HOLIDAY_LOCATION_MAX_LENGTH),
  legalBasis: optionalText(HOLIDAY_LEGAL_BASIS_MAX_LENGTH),
});

type HolidayFields = z.output<typeof holidayFields>;

/** A local holiday needs its location; a nationwide one stores none (a leftover value is dropped). */
function withLocationRule<T extends HolidayFields>(value: T, ctx: z.RefinementCtx): T {
  if (value.scope === 'local' && !value.location) {
    ctx.addIssue({ code: 'custom', path: ['location'], message: LOCATION_REQUIRED });
    return value;
  }
  return value.scope === 'nationwide' ? { ...value, location: null } : value;
}

/** Adding a holiday (a draft). The legal basis is optional on a draft. */
export const holidayInputSchema = holidayFields.transform(withLocationRule);
export type HolidayInput = z.input<typeof holidayInputSchema>;
export type HolidayValues = z.output<typeof holidayInputSchema>;

/** The ISO time the sheet loaded (`updatedAt`), for the stale-form check. */
const expectedUpdatedAt = z.iso.datetime({
  offset: true,
  error: 'Reload the page and try again.',
});

/**
 * Editing a holiday: the same fields, plus the `updatedAt` the sheet loaded. The date can move only
 * within the holiday's year (checked by the service, which knows the year). Source and source key
 * aren't fields, so they can't be changed.
 */
export const holidayUpdateSchema = holidayFields
  .extend({
    id: z.string().regex(OBJECT_ID_PATTERN, 'This holiday no longer exists. Reload the page.'),
    expectedUpdatedAt,
  })
  .transform(withLocationRule);
export type HolidayUpdateInput = z.input<typeof holidayUpdateSchema>;

/** Declaring a holiday at short notice: confirmed at once, so the legal basis is required. */
export const declareHolidaySchema = holidayFields
  .extend({
    legalBasis: z
      .string({ error: LEGAL_BASIS_REQUIRED })
      .trim()
      .min(1, LEGAL_BASIS_REQUIRED)
      .max(
        HOLIDAY_LEGAL_BASIS_MAX_LENGTH,
        `Use ${HOLIDAY_LEGAL_BASIS_MAX_LENGTH} characters or fewer.`,
      ),
  })
  .transform(withLocationRule);
export type DeclareHolidayInput = z.input<typeof declareHolidaySchema>;

/** Confirming or deleting one holiday. `expectedUpdatedAt` is optional (the stale-form check). */
export const holidayActionSchema = z.object({
  id: z.string().regex(OBJECT_ID_PATTERN, 'This holiday no longer exists. Reload the page.'),
  expectedUpdatedAt: expectedUpdatedAt.optional(),
});
export type HolidayActionInput = z.input<typeof holidayActionSchema>;

/** A year field (Confirm all, Run auto-draft, the year picker). */
export const holidayYearSchema = z.coerce
  .number({ error: 'Choose a year.' })
  .int('Choose a year.')
  .min(HOLIDAY_YEAR_MIN, 'Choose a year.')
  .max(HOLIDAY_YEAR_MAX, 'Choose a year.');

export const LEGAL_BASIS_REQUIRED_MESSAGE = LEGAL_BASIS_REQUIRED;

// ---------------------------------------------------------------------------------------------
// Auto-draft rules: the shape of the versioned setting `core.holidayRules` (decision 112). The
// setting itself is defined server-side with `defineConfigSetting`.

/** A rule's stable key: camelCase, so its source key `rule:<key>` stays the same for good. */
export const HOLIDAY_RULE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,49}$/;
export const HOLIDAY_RULE_KINDS = ['fixed', 'lastWeekday', 'easterOffset'] as const;
export type HolidayRuleKind = (typeof HOLIDAY_RULE_KINDS)[number];
/** The most rules one version holds. */
export const HOLIDAY_RULES_MAX = 100;

/** Days in each month of a leap year, so a rule can't name an impossible date. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const ruleBase = {
  key: z.string().regex(HOLIDAY_RULE_KEY_PATTERN),
  name: z.string().trim().min(1).max(HOLIDAY_NAME_MAX_LENGTH),
  type: z.enum(HOLIDAY_TYPES),
};
const month = z.number().int().min(1).max(12);

const fixedRule = z
  .object({ ...ruleBase, kind: z.literal('fixed'), month, day: z.number().int().min(1).max(31) })
  .refine((rule) => rule.day <= (MONTH_DAYS[rule.month - 1] ?? 0), {
    path: ['day'],
    message: 'The month has no such day.',
  })
  // February 29 is refused too: it doesn't exist in most years, and no holiday falls on it.
  .refine((rule) => !(rule.month === 2 && rule.day === 29), {
    path: ['day'],
    message: 'February 29 isn’t in every year.',
  });

const lastWeekdayRule = z.object({
  ...ruleBase,
  kind: z.literal('lastWeekday'),
  month,
  /** 0 is Sunday, 1 Monday … 6 Saturday. */
  weekday: z.number().int().min(0).max(6),
});

/**
 * Easter Sunday falls between March 22 and April 25, so an offset from −80 to +250 days always
 * stays in the same year.
 */
const easterOffsetRule = z.object({
  ...ruleBase,
  kind: z.literal('easterOffset'),
  offsetDays: z.number().int().min(-80).max(250),
});

export const holidayRuleSchema = z.discriminatedUnion('kind', [
  fixedRule,
  lastWeekdayRule,
  easterOffsetRule,
]);
export type HolidayRule = z.output<typeof holidayRuleSchema>;

/** One version's value: the rules, each key once. */
export const holidayRulesSchema = z
  .array(holidayRuleSchema)
  .min(1)
  .max(HOLIDAY_RULES_MAX)
  .refine((rules) => new Set(rules.map((rule) => rule.key)).size === rules.length, {
    message: 'Each rule needs its own key.',
  });
export type HolidayRules = z.output<typeof holidayRulesSchema>;

// ---------------------------------------------------------------------------------------------
// Date rules

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function assertYear(year: number): void {
  if (!Number.isSafeInteger(year) || year < HOLIDAY_YEAR_MIN || year > HOLIDAY_YEAR_MAX) {
    throw new RangeError(`${year} is not a four-digit year.`);
  }
}

/** `YYYY-MM-DD` for a year, month (1–12) and day. */
function businessDateOf(year: number, monthNumber: number, day: number): BusinessDate {
  const value = `${pad(year, 4)}-${pad(monthNumber)}-${pad(day)}`;
  if (!isBusinessDate(value)) throw new RangeError(`${value} is not a date.`);
  return value;
}

/**
 * Easter Sunday of `year` (Gregorian calendar), by the anonymous Gregorian algorithm
 * (Meeus/Jones/Butcher). 2026 → `2026-04-05`, 2027 → `2027-03-28`, 2028 → `2028-04-16`.
 */
export function easterSunday(year: number): BusinessDate {
  assertYear(year);
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monthNumber = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return businessDateOf(year, monthNumber, day);
}

/**
 * The last `weekday` (0 Sunday … 6 Saturday) of `month` (1–12) in `year`. National Heroes Day is
 * `lastWeekdayOfMonth(year, 8, 1)`: 2026-08-31, 2027-08-30, 2028-08-28.
 */
export function lastWeekdayOfMonth(
  year: number,
  monthNumber: number,
  weekday: number,
): BusinessDate {
  assertYear(year);
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError(`${monthNumber} is not a month.`);
  }
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(`${weekday} is not a weekday (0 Sunday to 6 Saturday).`);
  }
  // Day 0 of the next month is the last day of this one (calendar arithmetic only, in UTC).
  const last = new Date(Date.UTC(year, monthNumber, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return businessDateOf(year, monthNumber, last.getUTCDate() - back);
}

/** The source key of a rule's auto-draft: `rule:<key>`. */
export function ruleSourceKey(key: string): string {
  return `rule:${key}`;
}

/** The source key of an online-source draft: `online:<YYYY-MM-DD>`. */
export function onlineSourceKey(date: BusinessDate): string {
  return `online:${date}`;
}

/** One rule worked out for a year: the draft the auto-draft would add. */
export interface ExpandedHolidayRule {
  key: string;
  /** `rule:<key>`. */
  sourceKey: string;
  name: string;
  type: HolidayType;
  /** The Manila day, `YYYY-MM-DD`. */
  date: BusinessDate;
}

/** The date `rule` gives in `year`. */
export function holidayRuleDate(rule: HolidayRule, year: number): BusinessDate {
  switch (rule.kind) {
    case 'fixed':
      return businessDateOf(year, rule.month, rule.day);
    case 'lastWeekday':
      return lastWeekdayOfMonth(year, rule.month, rule.weekday);
    case 'easterOffset':
      return addDays(easterSunday(year), rule.offsetDays);
  }
}

/** Every rule worked out for `year`, by date and then name. */
export function expandHolidayRules(
  rules: readonly HolidayRule[],
  year: number,
): ExpandedHolidayRule[] {
  assertYear(year);
  return rules
    .map((rule) => ({
      key: rule.key,
      sourceKey: ruleSourceKey(rule.key),
      name: rule.name,
      type: rule.type,
      date: holidayRuleDate(rule, year),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
}
