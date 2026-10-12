import { centavosToDecimalString } from '@pulse/core';
import type { PayrollSettingKey, PayrollSettingValues } from '@pulse/talent';

// Spec: docs/modules/talent.md#payroll-settings-and-allowances-build-step-23 — the pure helpers of
// `/talent/payroll-settings`: the segmented control's views, how a rate and a day read, and the
// "Add version" sheet's draft (every figure as the text in its input). Amounts stay exact: a
// draft amount is the decimal string of its centavos, and the Server Action converts it back with
// `parsePesos`. No floating point anywhere.

export type PayrollView =
  'schedule' | 'contributions' | 'withholding' | 'benefits' | 'minimumWage' | 'allowances';

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
];

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
