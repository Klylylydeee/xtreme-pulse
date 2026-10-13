import type { BusinessDate } from '@pulse/core';
import type {
  AllowanceTypes,
  DeMinimisLimits,
  MinimumWages,
  PagibigContributions,
  PayrollSettingKey,
  PayrollSettings,
  PayrollSettingValues,
  PhilhealthContributions,
  PremiumRates,
  SssContributions,
  SssRow,
  ThirteenthMonthExemption,
  WithholdingTaxSemiMonthly,
} from '../../payroll/schemas';
import type { TimesheetSettings, WorkSchedule } from '../../timesheets/schemas';

// Spec: docs/COMPLIANCE.md#seeded-payroll-rates-build-step-23 (decisions 193–196 in
// docs/BUILD_PLAN.md) — the figures `pnpm seed:admin` seeds, each with its issuance, link and
// effective date, as checked on 2026-10-12. EVERY FIGURE IS AN *ASSUMPTION, TO BE CONFIRMED BY HR
// OR THE ACCOUNTANT*: HR checks each against the current SSS, PhilHealth, Pag-IBIG, BIR and DOLE
// issuances before the first real payroll. The tests test these figures, not the database.
//
// Legal tables take effect on their issuance's own date; company policy (`payrollSettings`,
// `allowanceTypes`) and the premium rates on 2000-01-01, so they cover every date hired.

export interface SeedVersion<K extends PayrollSettingKey> {
  effectiveFrom: BusinessDate;
  value: PayrollSettingValues[K];
  source: string;
}

/** The seed policy date for company policy and the premium rates. */
export const SEED_POLICY_DATE = '2000-01-01';

const pesos = (amount: number) => amount * 100;

// --- Pay schedule ------------------------------------------------------------------------------

export const SEED_PAYROLL_SETTINGS: PayrollSettings = {
  cutOffs: [
    // 26th–10th, paid on the 15th.
    { key: 'midMonth', startDay: 26, endDay: 10, payDay: 15 },
    // 11th–25th, paid on the 30th (the last day of a shorter month).
    { key: 'endOfMonth', startDay: 11, endDay: 25, payDay: 30 },
  ],
  dailyRateFactor: 261,
  hoursPerDay: 8,
  contributionSplit: {
    sss: { midMonth: '0.5', endOfMonth: '0.5' },
    philhealth: { midMonth: '0.5', endOfMonth: '0.5' },
    pagibig: { midMonth: '0.5', endOfMonth: '0.5' },
  },
};

// --- SSS ---------------------------------------------------------------------------------------

/**
 * The SSS schedule (Circular No. 2024-006, from January 2025): monthly salary credits from ₱5,000
 * to ₱35,000 in ₱500 steps. Compensation below ₱5,250 is ₱5,000; each MSC covers ₱250 either
 * side; ₱34,750 and up is ₱35,000. 15% of the MSC: employee 5%, employer 10%. Regular SS up to
 * an MSC of ₱20,000, the rest MPF. EC ₱10 below an MSC of ₱15,000, ₱30 from ₱15,000.
 */
export function generateSssRows(): SssRow[] {
  const rows: SssRow[] = [];
  for (let msc = 5000; msc <= 35000; msc += 500) {
    const regular = Math.min(msc, 20000);
    const mpf = msc - regular;
    // 5% and 10% of whole pesos in ₱500 steps are whole centavos: no rounding happens.
    rows.push({
      minCompensationCentavos: msc === 5000 ? 0 : pesos(msc - 250),
      regularMscCentavos: pesos(regular),
      mpfMscCentavos: pesos(mpf),
      employee: { regularCentavos: regular * 5, mpfCentavos: mpf * 5 },
      employer: { regularCentavos: regular * 10, mpfCentavos: mpf * 10 },
      ecCentavos: msc < 15000 ? pesos(10) : pesos(30),
    });
  }
  return rows;
}

/** Rows pinned against the published schedule; the generator is checked against them. */
export const SSS_ROW_PINS: readonly SssRow[] = [
  {
    minCompensationCentavos: 0,
    regularMscCentavos: pesos(5000),
    mpfMscCentavos: 0,
    employee: { regularCentavos: pesos(250), mpfCentavos: 0 },
    employer: { regularCentavos: pesos(500), mpfCentavos: 0 },
    ecCentavos: pesos(10),
  },
  {
    minCompensationCentavos: pesos(14250),
    regularMscCentavos: pesos(14500),
    mpfMscCentavos: 0,
    employee: { regularCentavos: pesos(725), mpfCentavos: 0 },
    employer: { regularCentavos: pesos(1450), mpfCentavos: 0 },
    ecCentavos: pesos(10),
  },
  {
    minCompensationCentavos: pesos(14750),
    regularMscCentavos: pesos(15000),
    mpfMscCentavos: 0,
    employee: { regularCentavos: pesos(750), mpfCentavos: 0 },
    employer: { regularCentavos: pesos(1500), mpfCentavos: 0 },
    ecCentavos: pesos(30),
  },
  {
    minCompensationCentavos: pesos(19750),
    regularMscCentavos: pesos(20000),
    mpfMscCentavos: 0,
    employee: { regularCentavos: pesos(1000), mpfCentavos: 0 },
    employer: { regularCentavos: pesos(2000), mpfCentavos: 0 },
    ecCentavos: pesos(30),
  },
  {
    minCompensationCentavos: pesos(24750),
    regularMscCentavos: pesos(20000),
    mpfMscCentavos: pesos(5000),
    employee: { regularCentavos: pesos(1000), mpfCentavos: pesos(250) },
    employer: { regularCentavos: pesos(2000), mpfCentavos: pesos(500) },
    ecCentavos: pesos(30),
  },
  {
    minCompensationCentavos: pesos(34750),
    regularMscCentavos: pesos(20000),
    mpfMscCentavos: pesos(15000),
    employee: { regularCentavos: pesos(1000), mpfCentavos: pesos(750) },
    employer: { regularCentavos: pesos(2000), mpfCentavos: pesos(1500) },
    ecCentavos: pesos(30),
  },
];

/** The generated rows, refused at load if they drift from a pinned row or the 61-row count. */
function checkedSssRows(): SssRow[] {
  const rows = generateSssRows();
  if (rows.length !== 61) throw new Error('The seeded SSS schedule must have 61 rows.');
  for (const pin of SSS_ROW_PINS) {
    const row = rows.find((r) => r.minCompensationCentavos === pin.minCompensationCentavos);
    if (JSON.stringify(row) !== JSON.stringify(pin)) {
      throw new Error(
        `The seeded SSS row from ${pin.minCompensationCentavos} centavos doesn't match its pin.`,
      );
    }
  }
  return rows;
}

export const SEED_SSS_CONTRIBUTIONS: SssContributions = { rows: checkedSssRows() };

// --- PhilHealth and Pag-IBIG ------------------------------------------------------------------

export const SEED_PHILHEALTH_CONTRIBUTIONS: PhilhealthContributions = {
  premiumRate: '0.05',
  employeeShare: '0.5',
  floorCentavos: pesos(10000),
  ceilingCentavos: pesos(100000),
};

export const SEED_PAGIBIG_CONTRIBUTIONS: PagibigContributions = {
  brackets: [
    { upToCentavos: pesos(1500), employeeRate: '0.01', employerRate: '0.02' },
    { upToCentavos: null, employeeRate: '0.02', employerRate: '0.02' },
  ],
  maxFundSalaryCentavos: pesos(10000),
};

// --- BIR -----------------------------------------------------------------------------------------

export const SEED_WITHHOLDING_TAX_SEMI_MONTHLY: WithholdingTaxSemiMonthly = {
  brackets: [
    { overCentavos: 0, baseTaxCentavos: 0, rate: '0' },
    { overCentavos: pesos(10417), baseTaxCentavos: 0, rate: '0.15' },
    { overCentavos: pesos(16667), baseTaxCentavos: 93750, rate: '0.20' },
    { overCentavos: pesos(33333), baseTaxCentavos: 427070, rate: '0.25' },
    { overCentavos: pesos(83333), baseTaxCentavos: 1677070, rate: '0.30' },
    { overCentavos: pesos(333333), baseTaxCentavos: 9177070, rate: '0.35' },
  ],
};

// --- Premiums and benefits ---------------------------------------------------------------------

export const SEED_PREMIUM_RATES: PremiumRates = {
  regularHolidayWorked: '2.00',
  regularHolidayUnworked: '1.00',
  specialDayWorked: '1.30',
  specialDayUnworked: '0',
  restDayWorked: '1.30',
  specialDayOnRestDay: '1.50',
  regularHolidayOnRestDay: '2.60',
  overtimeOrdinaryAddOn: '0.25',
  overtimeRestDayHolidayAddOn: '0.30',
  nightDifferentialAddOn: '0.10',
  nightStart: '22:00',
  nightEnd: '06:00',
};

export const SEED_DE_MINIMIS_LIMITS: DeMinimisLimits = {
  items: [
    {
      key: 'riceSubsidy',
      label: 'Rice subsidy',
      period: 'month',
      limitCentavos: pesos(2500),
      rateOfMinimumWage: null,
    },
    {
      key: 'uniformClothing',
      label: 'Uniform and clothing allowance',
      period: 'year',
      limitCentavos: pesos(8000),
      rateOfMinimumWage: null,
    },
    {
      key: 'medicalCashAllowanceDependents',
      label: 'Medical cash allowance to dependents',
      period: 'semester',
      limitCentavos: pesos(2000),
      rateOfMinimumWage: null,
    },
    {
      key: 'actualMedicalAssistance',
      label: 'Actual medical assistance',
      period: 'year',
      limitCentavos: pesos(12000),
      rateOfMinimumWage: null,
    },
    {
      key: 'laundryAllowance',
      label: 'Laundry allowance',
      period: 'month',
      limitCentavos: pesos(400),
      rateOfMinimumWage: null,
    },
    {
      key: 'achievementAwards',
      label: 'Employee achievement awards',
      period: 'year',
      limitCentavos: pesos(12000),
      rateOfMinimumWage: null,
    },
    {
      key: 'christmasGifts',
      label: 'Christmas and major anniversary gifts',
      period: 'year',
      limitCentavos: pesos(6000),
      rateOfMinimumWage: null,
    },
    {
      key: 'overtimeMeals',
      label: 'Overtime or night-shift meal allowance',
      period: 'day',
      limitCentavos: null,
      rateOfMinimumWage: '0.30',
    },
    {
      key: 'cbaProductivityIncentives',
      label: 'CBA and productivity incentives (combined)',
      period: 'year',
      limitCentavos: pesos(12000),
      rateOfMinimumWage: null,
    },
  ],
};

export const SEED_THIRTEENTH_MONTH_EXEMPTION: ThirteenthMonthExemption = {
  exemptCeilingCentavos: pesos(90000),
};

// --- Minimum wage ------------------------------------------------------------------------------

export const SEED_MINIMUM_WAGES_NCR_26: MinimumWages = {
  regions: [{ region: 'NCR', wageOrder: 'Wage Order NCR-26', dailyRateCentavos: pesos(695) }],
};
export const SEED_MINIMUM_WAGES_NCR_28: MinimumWages = {
  regions: [{ region: 'NCR', wageOrder: 'Wage Order NCR-28', dailyRateCentavos: pesos(755) }],
};

// --- Allowance types ---------------------------------------------------------------------------

export const SEED_ALLOWANCE_TYPES: AllowanceTypes = {
  types: [
    {
      key: 'internet',
      name: 'Internet allowance',
      // *Assumption, to be confirmed by the accountant:* an internet allowance isn't BIR de minimis.
      taxTreatment: 'nonTaxable',
      deMinimisKey: null,
      basis: 'perCutOff',
      defaultAmountCentavos: pesos(500),
      autoAssign: true,
      active: true,
    },
  ],
};

// --- Work schedule and timesheet settings (build step 2.4) -------------------------------------

/**
 * The company default schedule (decision 214): Monday to Friday, 08:00 to 17:00, a 60-minute break
 * from 12:00 and a 15-minute grace period; Saturday and Sunday are rest days. *Assumption, to be
 * confirmed by HR:* the break is 12:00 to 13:00 (the spec gives only "a 1-hour break").
 */
export const SEED_WORK_SCHEDULE: WorkSchedule = {
  workDays: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
  breakStart: '12:00',
  breakMinutes: 60,
  graceMinutes: 15,
};

/**
 * How each timesheet type treats claimed extra hours, and the offset ratio (decision 216).
 * *Assumption, to be confirmed by HR:* the 1:1 ratio.
 */
export const SEED_TIMESHEET_SETTINGS: TimesheetSettings = {
  offsetRatio: '1',
  extraHours: { overtime: 'overtime', standard: 'offset' },
};

// --- The seeded versions, by key ---------------------------------------------------------------

export const PAYROLL_SEED_VERSIONS: {
  readonly [K in PayrollSettingKey]: readonly SeedVersion<K>[];
} = {
  'talent.payrollSettings': [
    {
      effectiveFrom: SEED_POLICY_DATE,
      value: SEED_PAYROLL_SETTINGS,
      source:
        'Company policy: docs/modules/talent.md#pay-schedule (no moving for weekends or holidays, an assumption to be confirmed by HR)',
    },
  ],
  'talent.sssContributions': [
    {
      effectiveFrom: '2025-01-01',
      value: SEED_SSS_CONTRIBUTIONS,
      source:
        'SSS Circular No. 2024-006, Schedule of SSS Contributions for All Business Employers and Employees Effective January 2025 (https://www.sss.gov.ph/sss-circulars/)',
    },
  ],
  'talent.philhealthContributions': [
    {
      effectiveFrom: '2024-01-01',
      value: SEED_PHILHEALTH_CONTRIBUTIONS,
      source:
        'PhilHealth Circular No. 2020-0005 (Revision 1), under RA 11223; confirmed by PhilHealth Advisory No. 2025-0002 (https://www.philhealth.gov.ph/advisories/2025/PA2025-0002.pdf)',
    },
  ],
  'talent.pagibigContributions': [
    {
      effectiveFrom: '2024-02-01',
      value: SEED_PAGIBIG_CONTRIBUTIONS,
      source: 'HDMF Circular No. 460 (https://www.pna.gov.ph/articles/1217214)',
    },
  ],
  'talent.withholdingTaxSemiMonthly': [
    {
      effectiveFrom: '2023-01-01',
      value: SEED_WITHHOLDING_TAX_SEMI_MONTHLY,
      source:
        'RR 11-2018 Annex E, under RA 10963 (TRAIN), the table from January 1, 2023 (https://www.pesohub.ph/government/bir/withholding-tax-table-philippines/)',
    },
  ],
  'talent.premiumRates': [
    {
      effectiveFrom: SEED_POLICY_DATE,
      value: SEED_PREMIUM_RATES,
      source:
        'Labor Code and DOLE defaults, as in docs/modules/talent.md#pay-computation-per-cut-off',
    },
  ],
  'talent.deMinimisLimits': [
    {
      effectiveFrom: '2026-01-06',
      value: SEED_DE_MINIMIS_LIMITS,
      source:
        'RR 29-2025, amending RR 2-98 as last amended by RR 4-2025 (https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/updated-de-minimis-benefits-threshold/)',
    },
  ],
  'talent.thirteenthMonthExemption': [
    {
      effectiveFrom: '2018-01-01',
      value: SEED_THIRTEENTH_MONTH_EXEMPTION,
      source: 'RA 10963 (TRAIN)',
    },
  ],
  'talent.minimumWages': [
    {
      effectiveFrom: '2025-07-18',
      value: SEED_MINIMUM_WAGES_NCR_26,
      source: 'Wage Order No. NCR-26 (https://nwpc.dole.gov.ph/ncr/)',
    },
    {
      effectiveFrom: '2026-09-26',
      value: SEED_MINIMUM_WAGES_NCR_28,
      source:
        'Wage Order No. NCR-28 (https://nwpc.dole.gov.ph/wp-content/uploads/2026/09/Wage-Order-No.-NCR-28.pdf)',
    },
  ],
  'talent.allowanceTypes': [
    {
      effectiveFrom: SEED_POLICY_DATE,
      value: SEED_ALLOWANCE_TYPES,
      source:
        'Company policy: docs/modules/talent.md#allowances (non-taxable treatment to be confirmed by the accountant)',
    },
  ],
  'talent.workSchedule': [
    {
      effectiveFrom: SEED_POLICY_DATE,
      value: SEED_WORK_SCHEDULE,
      source: 'Company policy (spec)',
    },
  ],
  'talent.timesheetSettings': [
    {
      effectiveFrom: SEED_POLICY_DATE,
      value: SEED_TIMESHEET_SETTINGS,
      source: 'Company policy (spec)',
    },
  ],
};

/** True when a stored version is one the seed added (same date and source). */
export function isSeededVersion(
  key: PayrollSettingKey,
  effectiveFrom: BusinessDate,
  source: string | null,
): boolean {
  return PAYROLL_SEED_VERSIONS[key].some(
    (seed) => seed.effectiveFrom === effectiveFrom && seed.source === source,
  );
}
