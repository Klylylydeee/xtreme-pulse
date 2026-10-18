import { centavosToDecimalString } from '@pulse/core';
import {
  DEFAULT_SUBMISSION_DEADLINE_DAYS,
  ISO_WEEKDAY_LABELS,
  ISO_WEEKDAYS,
  type IsoWeekday,
  isOvernightSchedule,
  minutesOfClockTime,
  type PayrollSettingKey,
  type PayrollSettingValues,
  type ReimbursementSettings,
  type WorkSchedule,
} from '@pulse/talent';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 — the pure helpers of
// `/talent/payroll-settings`: the segmented control's views, how a rate and a day read, and the
// "Add version" sheet's draft (every figure as the text in its input). Amounts stay exact: a
// draft amount is the decimal string of its centavos, and the Server Action converts it back with
// `parsePesos`. No floating point anywhere.
//
// From build step 2.4 (docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)
// the Work schedule view holds `talent.workSchedule` and `talent.timesheetSettings`. A schedule
// draft's work days and minutes are typed as text; `draftToValue` turns them into numbers before
// the sheet sends the version (text that isn't digits stays text, so the schema names the field).
// The schedule helpers below are shared with the employee record's Work schedule section.
//
// From build step 2.5 (docs/modules/talent.md#reimbursements-build-step-25) the Reimbursements
// view holds `talent.reimbursementSettings`: company policy, like the work schedule. A type's
// limit draft is '' for no limit, or its amount in pesos and per receipt or per day.
//
// From build step 2.7 (decision 279) `talent.timesheetSettings` has the submission deadline, in
// days after the cut-off (1 to 10). A version without it (the seeded one) reads as 1, so the draft
// starts from 1 and a new version always stores the number.

export type PayrollView =
  | 'schedule'
  | 'contributions'
  | 'withholding'
  | 'benefits'
  | 'minimumWage'
  | 'allowances'
  | 'workSchedule'
  | 'reimbursements';

/** The segmented control's views, in order, with the settings each shows. */
export const PAYROLL_VIEWS: readonly {
  value: PayrollView;
  label: string;
  keys: readonly PayrollSettingKey[];
}[] = [
  { value: 'schedule', label: 'Pay schedule', keys: ['talent.payrollSettings'] },
  {
    value: 'contributions',
    label: 'Contributions',
    keys: [
      'talent.sssContributions',
      'talent.philhealthContributions',
      'talent.pagibigContributions',
    ],
  },
  { value: 'withholding', label: 'Withholding tax', keys: ['talent.withholdingTaxSemiMonthly'] },
  {
    value: 'benefits',
    label: 'Premiums & benefits',
    keys: ['talent.premiumRates', 'talent.deMinimisLimits', 'talent.thirteenthMonthExemption'],
  },
  { value: 'minimumWage', label: 'Minimum wage', keys: ['talent.minimumWages'] },
  { value: 'allowances', label: 'Allowance types', keys: ['talent.allowanceTypes'] },
  {
    value: 'workSchedule',
    label: 'Work schedule',
    keys: ['talent.workSchedule', 'talent.timesheetSettings'],
  },
  // Build step 2.5: the reimbursement types and the filing window.
  { value: 'reimbursements', label: 'Reimbursements', keys: ['talent.reimbursementSettings'] },
];

/** The settings that are company policy, not a government issuance. */
export const POLICY_SETTINGS: ReadonlySet<PayrollSettingKey> = new Set([
  'talent.workSchedule',
  'talent.timesheetSettings',
  'talent.reimbursementSettings',
]);

/** The settings whose figures are a table, which get the wider "Add version" sheet. */
export const TABLE_SETTINGS: ReadonlySet<PayrollSettingKey> = new Set([
  'talent.sssContributions',
  'talent.pagibigContributions',
  'talent.withholdingTaxSemiMonthly',
  'talent.deMinimisLimits',
  'talent.minimumWages',
]);

/** `"0.05"` → `"5%"`, `"1.3"` → `"130%"`, `"0.025"` → `"2.5%"`: exact, by moving the point. */
export function rateAsPercent(rate: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!match) return rate;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const integer = `${whole}${fraction.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = fraction.slice(2).replace(/0+$/, '');
  return `${integer}${rest ? `.${rest}` : ''}%`;
}

/** `1` → `"1st"`, `22` → `"22nd"`, `11` → `"11th"`. */
export function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

// ---------------------------------------------------------------------------------------------
// The "Add version" draft

/** A setting's value as the sheet edits it: every number and null as the text in its input. */
export type Draft<T> = T extends boolean
  ? boolean
  : T extends string | number | null | undefined
    ? string
    : T extends readonly (infer U)[]
      ? Draft<U>[]
      : T extends object
        ? { [K in keyof T]: Draft<T[K]> }
        : string;

export type SettingDraft<K extends PayrollSettingKey = PayrollSettingKey> = Draft<
  PayrollSettingValues[K]
>;

function draftOf(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => draftOf(item, ''));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        draftOf(item, name),
      ]),
    );
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    // Amounts as pesos ("1234.50"), exactly; days and counts as digits.
    return key.endsWith('Centavos') ? centavosToDecimalString(value) : String(value);
  }
  return value;
}

/** A version's value as the sheet's draft. */
export function toDraft<K extends PayrollSettingKey>(
  value: PayrollSettingValues[K],
): SettingDraft<K> {
  return draftOf(value, '') as SettingDraft<K>;
}

/** The value the sheet starts from when a setting has no version at all. */
export function emptyDraft<K extends PayrollSettingKey>(key: K): SettingDraft<K> {
  const empty: { [P in PayrollSettingKey]: SettingDraft<P> } = {
    'talent.payrollSettings': {
      cutOffs: [
        { key: 'midMonth', startDay: '', endDay: '', payDay: '' },
        { key: 'endOfMonth', startDay: '', endDay: '', payDay: '' },
      ],
      dailyRateFactor: '',
      hoursPerDay: '',
      contributionSplit: {
        sss: { midMonth: '', endOfMonth: '' },
        philhealth: { midMonth: '', endOfMonth: '' },
        pagibig: { midMonth: '', endOfMonth: '' },
      },
    },
    'talent.sssContributions': { rows: [newSssRow()] },
    'talent.philhealthContributions': {
      premiumRate: '',
      employeeShare: '',
      floorCentavos: '',
      ceilingCentavos: '',
    },
    'talent.pagibigContributions': { brackets: [newPagibigBracket()], maxFundSalaryCentavos: '' },
    'talent.withholdingTaxSemiMonthly': {
      brackets: [{ overCentavos: '0.00', baseTaxCentavos: '0.00', rate: '0' }],
    },
    'talent.premiumRates': {
      regularHolidayWorked: '',
      regularHolidayUnworked: '',
      specialDayWorked: '',
      specialDayUnworked: '',
      restDayWorked: '',
      specialDayOnRestDay: '',
      regularHolidayOnRestDay: '',
      overtimeOrdinaryAddOn: '',
      overtimeRestDayHolidayAddOn: '',
      nightDifferentialAddOn: '',
      nightStart: '',
      nightEnd: '',
    },
    'talent.deMinimisLimits': { items: [] },
    'talent.thirteenthMonthExemption': { exemptCeilingCentavos: '' },
    'talent.minimumWages': { regions: [newMinimumWageRegion()] },
    'talent.allowanceTypes': { types: [] },
    // Build step 2.4: the Work schedule segment.
    'talent.workSchedule': {
      workDays: [],
      start: '',
      end: '',
      breakStart: '',
      breakMinutes: '',
      graceMinutes: '',
    },
    'talent.timesheetSettings': {
      offsetRatio: '',
      extraHours: { overtime: 'overtime', standard: 'offset' },
      // Build step 2.7: the spec's default deadline.
      submissionDeadlineDays: String(DEFAULT_SUBMISSION_DEADLINE_DAYS),
    },
    // Build step 2.5: the Reimbursements segment.
    'talent.reimbursementSettings': { filingWindowPreviousCutOffs: '', types: [] },
  };
  return empty[key] as SettingDraft<K>;
}

export function newSssRow(): SettingDraft<'talent.sssContributions'>['rows'][number] {
  return {
    minCompensationCentavos: '',
    regularMscCentavos: '',
    mpfMscCentavos: '',
    employee: { regularCentavos: '', mpfCentavos: '' },
    employer: { regularCentavos: '', mpfCentavos: '' },
    ecCentavos: '',
  };
}

export function newPagibigBracket(): SettingDraft<'talent.pagibigContributions'>['brackets'][number] {
  return { upToCentavos: '', employeeRate: '', employerRate: '' };
}

export function newWithholdingBracket(): SettingDraft<'talent.withholdingTaxSemiMonthly'>['brackets'][number] {
  return { overCentavos: '', baseTaxCentavos: '', rate: '' };
}

export function newDeMinimisItem(): SettingDraft<'talent.deMinimisLimits'>['items'][number] {
  return { key: '', label: '', period: 'month', limitCentavos: '', rateOfMinimumWage: '' };
}

export function newMinimumWageRegion(): SettingDraft<'talent.minimumWages'>['regions'][number] {
  return { region: '', wageOrder: '', dailyRateCentavos: '' };
}

export function newAllowanceType(): SettingDraft<'talent.allowanceTypes'>['types'][number] {
  return {
    key: '',
    name: '',
    taxTreatment: 'taxable',
    deMinimisKey: '',
    basis: 'perCutOff',
    defaultAmountCentavos: '',
    autoAssign: false,
    active: true,
  };
}

export function newReimbursementType(): SettingDraft<'talent.reimbursementSettings'>['types'][number] {
  return {
    key: '',
    name: '',
    active: true,
    requiresRoute: false,
    requiresDescription: false,
    requiresClient: false,
    // No limit: a limit's draft is '' for none, or its amount (pesos) and what it counts.
    limit: '',
  };
}

/**
 * The reimbursement settings "Add version" starts from (build step 2.5): the version in effect,
 * plus any type of another version (a scheduled one) that it lacks, newest first, since no
 * version's type may be dropped.
 */
export function withEveryReimbursementType(
  start: ReimbursementSettings,
  versions: readonly ReimbursementSettings[],
): ReimbursementSettings {
  const types = [...start.types];
  const keys = new Set(types.map((type) => type.key));
  for (const version of versions) {
    for (const type of version.types) {
      if (keys.has(type.key)) continue;
      keys.add(type.key);
      types.push(type);
    }
  }
  return { ...start, types };
}

/** Reads `path` ("employee.regularCentavos") from a draft row. */
export function getIn(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[part]
          : undefined,
      source,
    );
}

/** A copy of `source` with `path` set to `value`. */
export function setIn<T>(source: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return source;
  const current = (source ?? {}) as Record<string, unknown>;
  const next = rest.length === 0 ? value : setIn(current[head], rest.join('.'), value);
  if (Array.isArray(source)) {
    const copy = [...source];
    copy[Number(head)] = next;
    return copy as T;
  }
  return { ...current, [head]: next } as T;
}

// ---------------------------------------------------------------------------------------------
// Draft to value (build step 2.4)

/** Digits as a number; anything else stays as typed, so the schema names the field. */
function wholeNumber(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/** A work schedule draft as the schema takes it: work days and minutes as numbers. */
export function scheduleDraftToValue(draft: SettingDraft<'talent.workSchedule'>): {
  [K in keyof WorkSchedule]: unknown;
} {
  return {
    workDays: [...draft.workDays].map(Number).sort((a, b) => a - b),
    start: draft.start,
    end: draft.end,
    breakStart: draft.breakStart,
    breakMinutes: wholeNumber(draft.breakMinutes),
    graceMinutes: wholeNumber(draft.graceMinutes),
  };
}

/**
 * A reimbursement settings draft as the schema takes it (build step 2.5): the filing window as a
 * number, and each type's limit as null (none) or its amount as typed, in pesos, with what it
 * counts. The Server Action converts the amount with `parsePesos`.
 */
export function reimbursementDraftToValue(
  draft: SettingDraft<'talent.reimbursementSettings'>,
): unknown {
  return {
    filingWindowPreviousCutOffs: wholeNumber(draft.filingWindowPreviousCutOffs),
    types: draft.types.map((type) => ({
      ...type,
      limit: typeof type.limit === 'string' ? null : type.limit,
    })),
  };
}

/**
 * The submission deadline as the sheet shows it (build step 2.7, decision 279): the draft's text,
 * or the default when the version it started from has none (the seeded one), so a new version
 * always stores the number.
 */
export function submissionDeadlineDraft(draft: SettingDraft<'talent.timesheetSettings'>): string {
  return draft.submissionDeadlineDays ?? String(DEFAULT_SUBMISSION_DEADLINE_DAYS);
}

/**
 * Timesheet settings as the schema takes them (build step 2.7): the submission deadline as a
 * number. A blank one stays text, so the schema asks for it rather than storing none.
 */
export function timesheetSettingsDraftToValue(
  draft: SettingDraft<'talent.timesheetSettings'>,
): unknown {
  const days = submissionDeadlineDraft(draft);
  return { ...draft, submissionDeadlineDays: wholeNumber(days) ?? days };
}

/**
 * The sheet's draft as the Server Action takes it. Amounts stay as typed (the action converts
 * them with `parsePesos`); a work schedule's days and minutes, the timesheet submission deadline
 * and the reimbursement filing window become numbers here.
 */
export function draftToValue(key: PayrollSettingKey, draft: SettingDraft): unknown {
  if (key === 'talent.workSchedule') {
    return scheduleDraftToValue(draft as SettingDraft<'talent.workSchedule'>);
  }
  if (key === 'talent.timesheetSettings') {
    return timesheetSettingsDraftToValue(draft as SettingDraft<'talent.timesheetSettings'>);
  }
  if (key === 'talent.reimbursementSettings') {
    return reimbursementDraftToValue(draft as SettingDraft<'talent.reimbursementSettings'>);
  }
  return draft;
}

// ---------------------------------------------------------------------------------------------
// Work schedules, for display (build step 2.4)

/** `"08:00"` → `"8:00 AM"`, `"17:30"` → `"5:30 PM"`, `"00:00"` → `"12:00 AM"`. */
export function formatClockTime(time: string): string {
  const minutes = minutesOfClockTime(time);
  const hours = Math.floor(minutes / 60);
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** The clock time `minutes` after `time`, past midnight wrapping round. */
function clockTimeAfter(time: string, minutes: number): string {
  const total = (minutesOfClockTime(time) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * ISO weekdays as words: a run of three or more reads "Monday to Friday", the rest are listed
 * ("Monday, Wednesday and Friday"). Every day reads "Every day".
 */
export function formatWeekdays(days: readonly number[]): string {
  const sorted = [...new Set(days)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (sorted.length === 0) return 'None';
  if (sorted.length === 7) return 'Every day';
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    const first = ISO_WEEKDAY_LABELS[sorted[index] as IsoWeekday];
    const last = ISO_WEEKDAY_LABELS[sorted[end] as IsoWeekday];
    if (end - index >= 2) {
      parts.push(`${first} to ${last}`);
    } else {
      for (let day = index; day <= end; day += 1) {
        parts.push(ISO_WEEKDAY_LABELS[sorted[day] as IsoWeekday]);
      }
    }
    index = end + 1;
  }
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The weekdays a schedule doesn't list: its rest days. */
export function restDaysOf(workDays: readonly number[]): IsoWeekday[] {
  return ISO_WEEKDAYS.filter((day) => !workDays.includes(day));
}

/** "8:00 AM to 5:00 PM", with "the next day" when the schedule ends after midnight. */
export function scheduleHoursText(schedule: Pick<WorkSchedule, 'start' | 'end'>): string {
  const text = `${formatClockTime(schedule.start)} to ${formatClockTime(schedule.end)}`;
  return isOvernightSchedule(schedule) ? `${text} the next day` : text;
}

/** "12:00 PM to 1:00 PM (60 min)", or "No break". */
export function scheduleBreakText(
  schedule: Pick<WorkSchedule, 'breakStart' | 'breakMinutes'>,
): string {
  if (schedule.breakMinutes === 0) return 'No break';
  const end = clockTimeAfter(schedule.breakStart, schedule.breakMinutes);
  return `${formatClockTime(schedule.breakStart)} to ${formatClockTime(end)} (${schedule.breakMinutes} min)`;
}

/** "15 min", or "None". */
export function graceText(minutes: number): string {
  return minutes === 0 ? 'None' : `${minutes} min`;
}

/** One line: "Monday to Friday, 8:00 AM to 5:00 PM". */
export function scheduleSummary(schedule: WorkSchedule): string {
  return `${formatWeekdays(schedule.workDays)}, ${scheduleHoursText(schedule)}`;
}
