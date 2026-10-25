import { describe, expect, it } from 'vitest';
import type { BusinessDate, Centavos } from '@pulse/core';
import type { CutOffPeriod } from '../payroll/lookups';
import type { PayrollBreakdown, PayrollLine } from '../payroll-run/types';
import { PAYROLL_LINE_KIND_SIDES, type PayrollLineKind } from '../payroll-run/kinds';
import {
  PAYROLL_SEED_VERSIONS,
  SEED_PAGIBIG_CONTRIBUTIONS,
  SEED_PHILHEALTH_CONTRIBUTIONS,
  SEED_SSS_CONTRIBUTIONS,
} from '../server/payroll-settings/seed-data';
import { firstPayrollCutOff } from '../payroll-run/periods';
import {
  addRemittanceMonths,
  bir1601cItemsOf,
  buildRemittanceReport,
  CURRENT_REMITTANCE_FORMATS,
  currentRemittanceFormatId,
  firstIncompleteCutOff,
  formatRemittanceMonth,
  goLivePeriodsText,
  isAsciiCrLfText,
  lastDayOfMonth,
  maskedIdText,
  PAGIBIG_MCRF_ASSUMED_2026_10,
  PHILHEALTH_RF1_ASSUMED_2026_10,
  REMITTANCE_BIR_NO_UPLOAD_TEXT,
  REMITTANCE_FORMATS,
  remittanceDueDate,
  remittanceDueDates,
  type RemittanceAgency,
  type RemittanceEmployee,
  remittanceFinalizeFirstMessage,
  remittanceGoLiveNoteText,
  remittanceMonthCutOffs,
  remittanceMonthsThrough,
  remittanceReminderKindOn,
  remittanceReminderText,
  remittanceSettingsDayFor,
  remittanceSettingsSchema,
  type RemittanceSnapshot,
  remittanceSoonFrom,
  type RemittanceSourceLine,
  type RemittanceSourceRun,
  remittanceUploadRefusal,
  SEED_REMITTANCE_SETTINGS,
  splitRegularFirst,
  SSS_R3_ASSUMED_2026_10,
  asciiText,
  csvLine,
} from './index';

// The remittance engine tests (docs/TESTING.md#remittance-tests, build step 2.11, decisions
// 377–400 in docs/BUILD_PLAN.md): the pure parts of cases R1, R3, R5, R11–R13 and R15 of
// docs/modules/talent.md#employer-contributions-and-remittances-build-step-211, each to the
// centavo, from hand-built lines with the figures steps 2.9 and 2.10 compute (P1, P2 and P6),
// plus the 1601-C mapping, the months and completeness, and each upload definition's exact text.
// The amounts and IDs are invented test figures, never client data.

const pesos = (amount: number): Centavos => Math.round(amount * 100);
const PAYROLL_VERSIONS = PAYROLL_SEED_VERSIONS['talent.payrollSettings'];

// ---------------------------------------------------------------------------------------------
// Hand-built lines

let keyCounter = 0;
function line(
  kind: PayrollLineKind,
  amount: number,
  extra: Partial<PayrollLine> = {},
): PayrollLine {
  keyCounter += 1;
  const side = PAYROLL_LINE_KIND_SIDES[kind];
  const group =
    side === 'earning' ? 'earnings' : side === 'deduction' ? 'deductions' : 'employerShares';
  return {
    key: `${kind}:${keyCounter}`,
    kind,
    group,
    side,
    label: kind,
    periodStart: '2026-09-26',
    periodEnd: '2026-10-10',
    quantity: null,
    unit: null,
    rateText: null,
    amountCentavos: pesos(amount),
    taxable: false,
    taxableCentavos: 0,
    deMinimisKey: null,
    typeKey: null,
    manual: null,
    override: null,
    ...extra,
  };
}

interface ContributionFacts {
  msc: number;
  employeeRegular: number;
  employeeMpf: number;
  philhealthBasis: number;
  pagibigBasis: number;
}

function breakdown(
  lines: PayrollLine[],
  facts: ContributionFacts,
  { taxable = 0, mwe = false }: { taxable?: number; mwe?: boolean } = {},
): PayrollBreakdown {
  const zero = { employeeCentavos: 0, employerCentavos: 0, ecCentavos: 0 };
  const agency = (basis: number) => ({
    basis: 'monthCompensation' as const,
    basisCentavos: pesos(basis),
    month: zero,
    midMonthDeducted: null,
    thisCutOff: zero,
  });
  return {
    breakdownVersion: 2,
    cutOff: {
      key: 'midMonth',
      periodStart: '2026-09-26',
      periodEnd: '2026-10-10',
      payDate: '2026-10-15',
      contributionMonth: '2026-10',
    },
    facts: {
      rateType: 'monthly',
      salaryCentavos: 0,
      dailyRateCentavos: null,
      hourlyRateCentavos: null,
      dailyRateFactor: 261,
      hoursPerDay: 8,
      timesheetType: 'overtime',
      timesheetStatus: 'approved',
      timesheetApproved: true,
      provisional: false,
      baseDays: 10,
      employedBaseDays: 10,
      presentDays: 10,
      offsetEarnedMinutes: 0,
      minimumWageEarner: mwe,
    },
    lines,
    attendanceItems: [],
    settledPeriods: [],
    compensationForContributionsCentavos: 0,
    contributions: {
      method: 'estimate',
      contributionMonth: '2026-10',
      monthlyBasicSalaryCentavos: 0,
      monthCompensationCentavos: null,
      sss: {
        ...agency(0),
        mscCentavos: pesos(facts.msc),
        employeeRegularCentavos: pesos(facts.employeeRegular),
        employeeMpfCentavos: pesos(facts.employeeMpf),
      },
      philhealth: agency(facts.philhealthBasis),
      pagibig: agency(facts.pagibigBasis),
    },
    taxableCompensationCentavos: pesos(taxable),
    taxCentavos: 0,
    deMinimis: [],
    basicSalaryEarnedCentavos: 0,
    totals: {
      grossCentavos: 0,
      deductionsCentavos: 0,
      netPayCentavos: 0,
      reimbursementsCentavos: 0,
      taxWithheldCentavos: 0,
      employeeContributionsCentavos: 0,
      employerContributionsCentavos: 0,
    },
    negativeNet: false,
    manualEntries: [],
  };
}

const TABLES = {
  sss: SEED_SSS_CONTRIBUTIONS,
  philhealth: SEED_PHILHEALTH_CONTRIBUTIONS,
  pagibig: SEED_PAGIBIG_CONTRIBUTIONS,
};

const RUNS: RemittanceSourceRun[] = [
  {
    runId: 'run1',
    number: 'PAY-2026-0001',
    periodStart: '2026-09-26',
    periodEnd: '2026-10-10',
    payDate: '2026-10-15',
    tables: TABLES,
  },
  {
    runId: 'run2',
    number: 'PAY-2026-0002',
    periodStart: '2026-10-11',
    periodEnd: '2026-10-25',
    payDate: '2026-10-30',
    tables: TABLES,
  },
];

/** P1's employee in PAY-2026-0001 (step 2.9's P1, net ₱11,595.20). */
function p1Mid(): PayrollBreakdown {
  return breakdown(
    [
      line('basicPay', 10875),
      line('overtimeOrdinary', 1250),
      line('restDayWork', 650),
      line('nightDifferential', 12.5),
      line('allowance', 500, { typeKey: 'internet' }),
      line('reimbursement', 350),
      line('absence', 1000),
      line('late', 62.5),
      line('sssEmployee', 550),
      line('philhealthEmployee', 271.88),
      line('pagibigEmployee', 100),
      line('withholdingTax', 57.92),
      line('sssEmployer', 1100),
      line('sssEc', 15),
      line('philhealthEmployer', 271.88),
      line('pagibigEmployer', 100),
    ],
    {
      msc: 22000,
      employeeRegular: 1000,
      employeeMpf: 100,
      philhealthBasis: 21750,
      pagibigBasis: 10000,
    },
    { taxable: 10803.12 },
  );
}

/** P1's employee in PAY-2026-0002 (step 2.9's P6: MSC ₱22,500, SSS ₱575.00). */
function p1End(sssEmployee = 575): PayrollBreakdown {
  return breakdown(
    [
      line('basicPay', 10875),
      line('sssEmployee', sssEmployee),
      line('philhealthEmployee', 271.87),
      line('pagibigEmployee', 100),
      line('withholdingTax', 0),
      line('sssEmployer', 1150),
      line('sssEc', 15),
      line('philhealthEmployer', 271.87),
      line('pagibigEmployer', 100),
    ],
    {
      msc: 22500,
      employeeRegular: 1000,
      employeeMpf: 125,
      philhealthBasis: 21750,
      pagibigBasis: 10000,
    },
    { taxable: 9928.13 },
  );
}

/** P2's employee in PAY-2026-0001 (step 2.9's P2, net ₱11,092.74). */
function p2Mid(): PayrollBreakdown {
  return breakdown(
    [
      line('basicPay', 13050),
      line('allowance', 500, { typeKey: 'internet' }),
      line('undertime', 150),
      line('leaveWithoutPay', 1200),
      line('sssEmployee', 650),
      line('philhealthEmployee', 326.25),
      line('pagibigEmployee', 100),
      line('withholdingTax', 31.01),
      line('sssEmployer', 1300),
      line('sssEc', 15),
      line('philhealthEmployer', 326.25),
      line('pagibigEmployer', 100),
    ],
    {
      msc: 26000,
      employeeRegular: 1000,
      employeeMpf: 300,
      philhealthBasis: 26100,
      pagibigBasis: 10000,
    },
    { taxable: 10623.75 },
  );
}

/** P2's employee in PAY-2026-0002: present every day (MSC ₱25,000). */
function p2End(sssEmployee = 600): PayrollBreakdown {
  return breakdown(
    [
      line('basicPay', 13050),
      line('sssEmployee', sssEmployee),
      line('philhealthEmployee', 326.25),
      line('pagibigEmployee', 100),
      line('withholdingTax', 0),
      line('sssEmployer', 1200),
      line('sssEc', 15),
      line('philhealthEmployer', 326.25),
      line('pagibigEmployer', 100),
    ],
    {
      msc: 25000,
      employeeRegular: 1000,
      employeeMpf: 250,
      philhealthBasis: 26100,
      pagibigBasis: 10000,
    },
    { taxable: 12023.75 },
  );
}

function employee(
  id: string,
  lastName: string,
  overrides: Partial<RemittanceEmployee> = {},
): RemittanceEmployee {
  return {
    employeeId: id,
    employeeNumber: `2025-${id}`,
    firstName: 'Test',
    middleName: 'Made',
    lastName,
    dateHired: '2025-01-01',
    separationDate: null,
    dateOfBirth: '1990-05-17',
    sex: 'female',
    ids: {
      sss: '0498765432',
      philhealth: '120987654329',
      pagibig: '121234567893',
      tin: '900123456781',
    },
    idsVerified: true,
    ...overrides,
  };
}

const P1 = employee('01', 'Payee1');
const P2 = employee('02', 'Payee2', {
  ids: {
    sss: '0412345678',
    philhealth: '120000000017',
    pagibig: '121000000025',
    tin: '900000000033',
  },
});

function october(
  agency: RemittanceAgency,
  {
    p2EndSss = 600,
    employees = [P1, P2],
  }: { p2EndSss?: number; employees?: RemittanceEmployee[] } = {},
) {
  const lines: RemittanceSourceLine[] = [
    { runId: 'run1', employeeId: '01', breakdown: p1Mid() },
    { runId: 'run1', employeeId: '02', breakdown: p2Mid() },
    { runId: 'run2', employeeId: '01', breakdown: p1End() },
    { runId: 'run2', employeeId: '02', breakdown: p2End(p2EndSss) },
  ];
  return buildRemittanceReport({
    agency,
    month: '2026-10',
    runs: RUNS,
    lines,
    employees: new Map(employees.map((e) => [e.employeeId, e])),
  });
}

function snapshotOf(
  agency: RemittanceAgency,
  built: ReturnType<typeof october>,
  employer: Partial<RemittanceSnapshot['employer']> = {},
): RemittanceSnapshot {
  return {
    agency,
    month: '2026-10',
    rows: built.rows,
    totals: built.totals,
    employer: {
      registeredName: 'Made-up Systems Integrator, Inc.',
      businessAddress: 'Unit 1, Made-up Tower, Pasig City',
      tin: '000-111-222-000',
      rdoCode: '043',
      employerNumber: '03-9999999-1',
      placeholder: false,
      ...employer,
    },
    dueDate: '2026-11-30',
    goLivePeriods: null,
  };
}

// ---------------------------------------------------------------------------------------------

describe('R1: the SSS report equals the runs’ lines (the Done when)', () => {
  it('sums each employee’s lines, with the regular SS and MPF split, to the centavo', () => {
    const { rows, totals, flagCounts } = october('sss');
    const [a, b] = rows;
    expect(a).toMatchObject({
      employeeId: '01',
      basisCentavos: pesos(22500),
      employee: {
        totalCentavos: pesos(1125),
        regularCentavos: pesos(1000),
        mpfCentavos: pesos(125),
      },
      employer: {
        totalCentavos: pesos(2250),
        regularCentavos: pesos(2000),
        mpfCentavos: pesos(250),
      },
      ecCentavos: pesos(30),
      totalCentavos: pesos(3405),
      flags: { differsFromSchedule: false, missingId: false, unverifiedId: false },
    });
    expect(b).toMatchObject({
      employeeId: '02',
      basisCentavos: pesos(25000),
      employee: {
        totalCentavos: pesos(1250),
        regularCentavos: pesos(1000),
        mpfCentavos: pesos(250),
      },
      employer: {
        totalCentavos: pesos(2500),
        regularCentavos: pesos(2000),
        mpfCentavos: pesos(500),
      },
      ecCentavos: pesos(30),
      totalCentavos: pesos(3780),
    });
    expect(totals).toMatchObject({
      employeeCount: 2,
      employee: { totalCentavos: pesos(2375) },
      employer: { totalCentavos: pesos(4750) },
      ecCentavos: pesos(60),
      amountDueCentavos: pesos(7185),
      bir: null,
    });
    expect(flagCounts).toEqual({ differsFromSchedule: 0, missingId: 0, unverifiedId: 0 });
  });

  it('marks new hires and separations in the month, and masks IDs to the last 4 digits', () => {
    const { rows } = october('sss', {
      employees: [
        employee('01', 'Payee1', { dateHired: '2026-10-05' }),
        employee('02', 'Payee2', { separationDate: '2026-10-20' }),
      ],
    });
    expect(rows[0]).toMatchObject({ status: 'newHire', statusDate: '2026-10-05' });
    expect(rows[1]).toMatchObject({ status: 'separated', statusDate: '2026-10-20' });
    expect(maskedIdText('04-9876543-2')).toBe('••••5432');
    expect(maskedIdText(null)).toBeNull();
  });
});

describe('R3: PhilHealth and Pag-IBIG for October 2026', () => {
  it('PhilHealth: the basis from the latest line, PS and ES summed, ₱2,392.50 due', () => {
    const { rows, totals } = october('philhealth');
    expect(rows[0]).toMatchObject({
      basisCentavos: pesos(21750),
      employee: { totalCentavos: pesos(543.75) },
      employer: { totalCentavos: pesos(543.75) },
      dateOfBirth: '1990-05-17',
      sex: 'female',
      flags: { differsFromSchedule: false },
    });
    expect(rows[1]).toMatchObject({
      basisCentavos: pesos(26100),
      employee: { totalCentavos: pesos(652.5) },
      employer: { totalCentavos: pesos(652.5) },
    });
    expect(totals.amountDueCentavos).toBe(pesos(2392.5));
  });

  it('Pag-IBIG: ₱200.00 and ₱200.00 each on a ₱10,000.00 basis, ₱800.00 due', () => {
    const { rows, totals } = october('pagibig');
    for (const row of rows) {
      expect(row).toMatchObject({
        basisCentavos: pesos(10000),
        employee: { totalCentavos: pesos(200) },
        employer: { totalCentavos: pesos(200) },
        dateOfBirth: null,
        flags: { differsFromSchedule: false },
      });
    }
    expect(totals.amountDueCentavos).toBe(pesos(800));
  });
});

describe('R5: an override shows as "Differs from the schedule", the totals still the runs’', () => {
  it('flags P2’s row with the employee share the lines hold, split regular SS first', () => {
    const { rows, totals, flagCounts } = october('sss', { p2EndSss: 0 });
    expect(rows[1]).toMatchObject({
      employee: { totalCentavos: pesos(650), regularCentavos: pesos(650), mpfCentavos: 0 },
      flags: { differsFromSchedule: true },
    });
    expect(totals.employee.totalCentavos).toBe(pesos(550 + 575 + 650 + 0));
    expect(flagCounts.differsFromSchedule).toBe(1);
  });

  it('splits a total over the row’s regular part into MPF', () => {
    expect(splitRegularFirst(pesos(1300), pesos(1000))).toEqual({
      totalCentavos: pesos(1300),
      regularCentavos: pesos(1000),
      mpfCentavos: pesos(300),
    });
    expect(splitRegularFirst(pesos(-50), pesos(1000))).toEqual({
      totalCentavos: pesos(-50),
      regularCentavos: pesos(-50),
      mpfCentavos: 0,
    });
  });

  it('flags a missing and an unverified ID', () => {
    const { rows, flagCounts } = october('sss', {
      employees: [
        employee('01', 'Payee1', { idsVerified: false }),
        employee('02', 'Payee2', {
          ids: { sss: null, philhealth: null, pagibig: null, tin: null },
        }),
      ],
    });
    expect(rows[0]?.flags).toEqual({
      differsFromSchedule: false,
      missingId: false,
      unverifiedId: true,
    });
    expect(rows[1]?.flags).toEqual({
      differsFromSchedule: false,
      missingId: true,
      unverifiedId: false,
    });
    expect(flagCounts).toEqual({ differsFromSchedule: 0, missingId: 1, unverifiedId: 1 });
  });
});

describe('R11: due dates from the seeded settings', () => {
  it('October 2026: SSS Nov 30, PhilHealth Nov 15, Pag-IBIG Nov 14, BIR 1601-C Nov 10', () => {
    expect(remittanceDueDates('2026-10', SEED_REMITTANCE_SETTINGS)).toEqual({
      sss: '2026-11-30',
      philhealth: '2026-11-15',
      pagibig: '2026-11-14',
      bir1601c: '2026-11-10',
    });
  });

  it('December 2026: BIR Jan 15, 2027 and SSS Jan 31, 2027; February’s end for a day 31', () => {
    expect(remittanceDueDate('bir1601c', '2026-12', SEED_REMITTANCE_SETTINGS)).toBe('2027-01-15');
    expect(remittanceDueDate('sss', '2026-12', SEED_REMITTANCE_SETTINGS)).toBe('2027-01-31');
    expect(remittanceDueDate('sss', '2027-01', SEED_REMITTANCE_SETTINGS)).toBe('2027-02-28');
    expect(remittanceDueDate('sss', '2028-01', SEED_REMITTANCE_SETTINGS)).toBe('2028-02-29');
  });

  it('reads the version on the first day of the next month, and a 2-month rule', () => {
    expect(remittanceSettingsDayFor('2026-10')).toBe('2026-11-01');
    expect(remittanceSettingsDayFor('2026-12')).toBe('2027-01-01');
    const twoMonths = {
      dueDates: {
        ...SEED_REMITTANCE_SETTINGS.dueDates,
        philhealth: { dueDay: 20, monthsAfter: 2, decemberDueDay: null },
      },
    };
    expect(remittanceDueDate('philhealth', '2026-11', twoMonths)).toBe('2027-01-20');
  });

  it('times the reminders: soon from the lead days, today, then overdue', () => {
    const due = '2026-11-30';
    const soonFrom = remittanceSoonFrom(due, SEED_REMITTANCE_SETTINGS);
    expect(soonFrom).toBe('2026-11-25');
    expect(remittanceReminderKindOn('2026-11-24', due, soonFrom)).toBeNull();
    expect(remittanceReminderKindOn('2026-11-25', due, soonFrom)).toBe('soon');
    expect(remittanceReminderKindOn('2026-11-28', due, soonFrom)).toBe('soon');
    expect(remittanceReminderKindOn('2026-11-30', due, soonFrom)).toBe('today');
    expect(remittanceReminderKindOn('2026-12-01', due, soonFrom)).toBe('overdue');
    expect(remittanceReminderText('soon', 'sss', '2026-10', due)).toBe(
      'SSS remittance for October 2026 is due Nov 30, 2026',
    );
    expect(remittanceReminderText('today', 'sss', '2026-10', due)).toBe(
      'SSS remittance for October 2026 is due today',
    );
    expect(remittanceReminderText('overdue', 'sss', '2026-10', due)).toBe(
      'SSS remittance for October 2026 is overdue (due Nov 30, 2026)',
    );
  });

  it('validates the setting: days 1–31, 1 or 2 months after, a lead of 0–30', () => {
    expect(remittanceSettingsSchema.safeParse(SEED_REMITTANCE_SETTINGS).success).toBe(true);
    const bad = (change: object) =>
      remittanceSettingsSchema.safeParse({ ...SEED_REMITTANCE_SETTINGS, ...change }).success;
    expect(bad({ reminderLeadDays: 31 })).toBe(false);
    expect(bad({ reminderLeadDays: -1 })).toBe(false);
    expect(
      bad({
        dueDates: {
          ...SEED_REMITTANCE_SETTINGS.dueDates,
          sss: { dueDay: 32, monthsAfter: 1, decemberDueDay: null },
        },
      }),
    ).toBe(false);
    expect(
      bad({
        dueDates: {
          ...SEED_REMITTANCE_SETTINGS.dueDates,
          sss: { dueDay: 31, monthsAfter: 3, decemberDueDay: null },
        },
      }),
    ).toBe(false);
  });
});

describe('R12: BIR 1601-C for October 2026', () => {
  it('maps the lines to items 14–25, and item 22 matches the runs’ taxable compensation', () => {
    const { rows, totals } = october('bir1601c');
    const items = totals.bir;
    expect(items).not.toBeNull();
    // P1: 10,875 + 1,250 + 650 + 12.50 + 500 − 1,000 − 62.50 = 12,225; then 10,875.
    // P2: 13,050 + 500 − 150 − 1,200 = 12,200; then 13,050.
    expect(items?.item14).toBe(pesos(12225 + 10875 + 12200 + 13050));
    expect(items?.item15).toBe(0);
    expect(items?.item16).toBe(0);
    expect(items?.item17).toBe(0);
    expect(items?.item18).toBe(0);
    expect(items?.item19).toBe(
      pesos(550 + 271.88 + 100 + 575 + 271.87 + 100 + 650 + 326.25 + 100 + 600 + 326.25 + 100),
    );
    expect(items?.item20).toBe(pesos(1000));
    expect(items?.item21).toBe((items?.item19 ?? 0) + pesos(1000));
    expect(items?.item22).toBe((items?.item14 ?? 0) - (items?.item21 ?? 0));
    expect(items?.runsTaxableCentavos).toBe(pesos(10803.12 + 9928.13 + 10623.75 + 12023.75));
    expect(items?.item22DifferenceCentavos).toBe(0);
    // Item 25: P1's ₱57.92 + ₱0.00 and P2's ₱31.01 + ₱0.00.
    expect(rows[0]?.bir?.taxWithheldCentavos).toBe(pesos(57.92));
    expect(items?.item25).toBe(pesos(57.92 + 31.01));
    expect(totals.amountDueCentavos).toBe(pesos(88.93));
    // Both withheld tax: nothing for item 23.
    expect(items?.item23).toBe(0);
    expect(items?.item24).toBe(items?.item22);
    expect(rows[0]?.idNumber).toBe('900123456781');
  });

  it('item 23: a non-minimum wage earner with ₱0.00 withheld; a minimum wage earner’s 15 and 16', () => {
    const noTax = breakdown(
      [line('basicPay', 9000), line('sssEmployee', 450), line('withholdingTax', 0)],
      {
        msc: 9000,
        employeeRegular: 450,
        employeeMpf: 0,
        philhealthBasis: 10000,
        pagibigBasis: 9000,
      },
      { taxable: 8550 },
    );
    const mwe = breakdown(
      [
        line('basicPay', 7550),
        line('overtimeOrdinary', 235.94),
        line('absence', 755),
        line('sssEmployee', 350),
        line('withholdingTax', 0),
      ],
      {
        msc: 7000,
        employeeRegular: 350,
        employeeMpf: 0,
        philhealthBasis: 10000,
        pagibigBasis: 7550,
      },
      { mwe: true },
    );
    const built = buildRemittanceReport({
      agency: 'bir1601c',
      month: '2026-10',
      runs: RUNS.slice(0, 1),
      lines: [
        { runId: 'run1', employeeId: '01', breakdown: noTax },
        { runId: 'run1', employeeId: '02', breakdown: mwe },
      ],
      employees: new Map([P1, P2].map((e) => [e.employeeId, e])),
    });
    const [a, b] = built.rows;
    expect(a?.bir?.taxableNotWithheldCentavos).toBe(pesos(8550));
    expect(b?.minimumWageEarner).toBe(true);
    expect(b?.bir).toMatchObject({
      statutoryMinimumWageCentavos: pesos(7550 - 755),
      mweHolidayOvertimeCentavos: pesos(235.94),
      taxableNotWithheldCentavos: 0,
    });
    expect(built.totals.bir?.item23).toBe(pesos(8550));
    expect(built.totals.bir?.item24).toBe(
      (built.totals.bir?.item22 ?? 0) - (built.totals.bir?.item23 ?? 0),
    );
  });

  it('counts de minimis and other non-taxable pay, and manual deductions that lower taxable pay', () => {
    const lines = breakdown(
      [
        line('basicPay', 10000),
        line('allowance', 2500, { deMinimisKey: 'riceSubsidy', taxableCentavos: pesos(500) }),
        line('manual', 300, {
          manual: {
            entryId: 'e1',
            countsAsBasicSalary: false,
            reducesTaxablePay: null,
            authorizedInWriting: null,
          },
        }),
        line('manual', 200, {
          side: 'deduction',
          group: 'deductions',
          manual: {
            entryId: 'e2',
            countsAsBasicSalary: false,
            reducesTaxablePay: true,
            authorizedInWriting: false,
          },
        }),
        line('manual', 100, {
          side: 'deduction',
          group: 'deductions',
          manual: {
            entryId: 'e3',
            countsAsBasicSalary: false,
            reducesTaxablePay: false,
            authorizedInWriting: true,
          },
        }),
      ],
      {
        msc: 10000,
        employeeRegular: 500,
        employeeMpf: 0,
        philhealthBasis: 10000,
        pagibigBasis: 10000,
      },
    );
    const built = buildRemittanceReport({
      agency: 'bir1601c',
      month: '2026-10',
      runs: RUNS.slice(0, 1),
      lines: [{ runId: 'run1', employeeId: '01', breakdown: lines }],
      employees: new Map([[P1.employeeId, P1]]),
    });
    const figures = built.rows[0]?.bir;
    if (!figures) throw new Error('No BIR figures.');
    const items = bir1601cItemsOf([figures]);
    expect(items.item14).toBe(pesos(10000 + 2500 + 300 - 200));
    expect(items.item18).toBe(pesos(2000));
    expect(items.item20).toBe(pesos(300));
    expect(items.item22).toBe(pesos(10000 + 500 - 200));
  });
});

describe('R13: the SSS upload file for R1', () => {
  it('builds one header, two details and one trailer, fixed-width, CR LF', () => {
    const built = october('sss');
    const text = SSS_R3_ASSUMED_2026_10.build(snapshotOf('sss', built));
    expect(isAsciiCrLfText(text)).toBe(true);
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe('');
    const [header, first, second, trailer] = lines;
    expect(header).toBe(`00${'0399999991'}${'MADE-UP SYSTEMS INTEGRATOR, INC.'.padEnd(40)}102026`);
    expect(first).toBe(
      `20${'0498765432'}${'PAYEE1'.padEnd(20)}${'TEST'.padEnd(20)}M${'3000.00'.padStart(10)}${'30.00'.padStart(8)}${'375.00'.padStart(10)} ${' '.repeat(8)}`,
    );
    // P2's detail: regular SS ₱3,000.00, EC ₱30.00 and MPF ₱750.00.
    expect(second?.slice(53, 63)).toBe('3000.00'.padStart(10));
    expect(second?.slice(63, 71)).toBe('30.00'.padStart(8));
    expect(second?.slice(71, 81)).toBe('750.00'.padStart(10));
    expect(second).toHaveLength(first?.length ?? 0);
    // The trailer's totals: ₱6,000.00, ₱60.00 and ₱1,125.00.
    expect(trailer).toBe(
      `99000002${'6000.00'.padStart(12)}${'60.00'.padStart(12)}${'1125.00'.padStart(12)}`,
    );
  });

  it('writes new hires and separations with their dates, and Ñ as N', () => {
    const built = october('sss', {
      employees: [
        employee('01', 'Añonuevo', { dateHired: '2026-10-05', middleName: 'Ángeles' }),
        employee('02', 'Payee2', { separationDate: '2026-10-20' }),
      ],
    });
    const lines = SSS_R3_ASSUMED_2026_10.build(snapshotOf('sss', built)).split('\r\n');
    expect(lines[1]?.slice(12, 32)).toBe('ANONUEVO'.padEnd(20));
    expect(lines[1]?.slice(52, 53)).toBe('A');
    expect(lines[1]?.slice(81)).toBe('N10052026');
    expect(lines[2]?.slice(81)).toBe('S10202026');
  });

  it('is refused while a row has no ID or the employer number is a placeholder', () => {
    const missing = october('sss', {
      employees: [
        P1,
        employee('02', 'Payee2', {
          ids: { sss: null, philhealth: null, pagibig: null, tin: null },
        }),
      ],
    });
    expect(remittanceUploadRefusal(snapshotOf('sss', missing))).toBe(
      'Enter the SS numbers of 1 employee first.',
    );
    expect(remittanceUploadRefusal(snapshotOf('sss', october('sss'), { placeholder: true }))).toBe(
      'Fill in the SSS employer number in Company settings, then regenerate the report.',
    );
    expect(remittanceUploadRefusal(snapshotOf('sss', october('sss')))).toBeNull();
    expect(remittanceUploadRefusal(snapshotOf('bir1601c', october('bir1601c')))).toBe(
      REMITTANCE_BIR_NO_UPLOAD_TEXT,
    );
  });
});

describe('The PhilHealth and Pag-IBIG upload definitions', () => {
  it('PhilHealth RF-1: the employer line, the header, a line per row and the TOTAL line', () => {
    const text = PHILHEALTH_RF1_ASSUMED_2026_10.build(
      snapshotOf('philhealth', october('philhealth'), { employerNumber: '01-000000001-2' }),
    );
    expect(isAsciiCrLfText(text)).toBe(true);
    expect(text.split('\r\n')).toEqual([
      '010000000012,"MADE-UP SYSTEMS INTEGRATOR, INC.",000111222000,"UNIT 1, MADE-UP TOWER, PASIG CITY",10/2026',
      'PIN,LAST NAME,FIRST NAME,MIDDLE NAME,DATE OF BIRTH,SEX,MONTHLY BASIC SALARY,PS,ES,STATUS,STATUS DATE',
      '120987654329,PAYEE1,TEST,MADE,05/17/1990,F,21750.00,543.75,543.75,,',
      '120000000017,PAYEE2,TEST,MADE,05/17/1990,F,26100.00,652.50,652.50,,',
      'TOTAL,2,1196.25,1196.25',
      '',
    ]);
  });

  it('Pag-IBIG MCRF: the employer line, the header and a line per row with remarks', () => {
    const built = october('pagibig', {
      employees: [P1, employee('02', 'Payee2', { separationDate: '2026-10-20' })],
    });
    const text = PAGIBIG_MCRF_ASSUMED_2026_10.build(
      snapshotOf('pagibig', built, { employerNumber: '2000-1234-5678' }),
    );
    expect(isAsciiCrLfText(text)).toBe(true);
    expect(text.split('\r\n')).toEqual([
      '200012345678,"MADE-UP SYSTEMS INTEGRATOR, INC.","UNIT 1, MADE-UP TOWER, PASIG CITY",202610',
      'MID,LAST NAME,FIRST NAME,MIDDLE NAME,MONTHLY COMPENSATION,EE SHARE,ER SHARE,TOTAL,REMARKS',
      '121234567893,PAYEE1,TEST,MADE,10000.00,200.00,200.00,400.00,',
      '121234567893,PAYEE2,TEST,MADE,10000.00,200.00,200.00,400.00,SEPARATED 10/20/2026',
      '',
    ]);
  });

  it('keeps every definition isolated, versioned and not verified', () => {
    expect(REMITTANCE_FORMATS.map((format) => format.id)).toEqual([
      'sss.r3.assumed-2026-10',
      'philhealth.rf1.assumed-2026-10',
      'pagibig.mcrf.assumed-2026-10',
    ]);
    for (const format of REMITTANCE_FORMATS) expect(format.verified).toBe(false);
    expect(CURRENT_REMITTANCE_FORMATS.sss.contentType).toBe('text/plain');
    expect(CURRENT_REMITTANCE_FORMATS.philhealth.contentType).toBe('text/csv');
    expect(currentRemittanceFormatId('bir1601c')).toBeNull();
  });

  it('writes upper-case ASCII and quotes a value with a comma or a quote', () => {
    expect(asciiText('Ñiño Dela Cruz-Peña')).toBe('NINO DELA CRUZ-PENA');
    expect(asciiText('  José   “Pepe”  ')).toBe('JOSE PEPE');
    expect(csvLine(['A', 'B, C', 'say "hi"'])).toBe('A,"B, C","say ""hi"""');
    expect(isAsciiCrLfText('A\r\nB\r\n')).toBe(true);
    expect(isAsciiCrLfText('A\nB\r\n')).toBe(false);
    expect(isAsciiCrLfText('Ñ\r\n')).toBe(false);
    expect(isAsciiCrLfText('A')).toBe(false);
  });
});

describe('R15 and completeness: the months, their cut-offs and the go-live month', () => {
  const cutOff = (start: BusinessDate, end: BusinessDate, payDate: BusinessDate) =>
    expect.objectContaining({ start, end, payDate }) as unknown as CutOffPeriod;

  it('with go-live on 2026-09-26, October holds both cut-offs and no note', () => {
    const first = firstPayrollCutOff('2026-09-26', PAYROLL_VERSIONS);
    if (!first) throw new Error('No first cut-off.');
    const october2026 = remittanceMonthCutOffs('2026-10', first, PAYROLL_VERSIONS);
    expect(october2026.cutOffs).toEqual([
      cutOff('2026-09-26', '2026-10-10', '2026-10-15'),
      cutOff('2026-10-11', '2026-10-25', '2026-10-30'),
    ]);
    expect(october2026.paidBeforeGoLive).toEqual([]);
    expect(remittanceMonthCutOffs('2026-09', first, PAYROLL_VERSIONS)).toEqual({
      cutOffs: [],
      paidBeforeGoLive: [],
    });
    expect(remittanceMonthsThrough(first, '2026-12')).toEqual(['2026-12', '2026-11', '2026-10']);
    expect(remittanceMonthsThrough(null, '2026-12')).toEqual([]);
  });

  it('R15: go-live on 2026-10-11 makes October complete with Oct 11 – 25 alone, with the note', () => {
    const first = firstPayrollCutOff('2026-10-11', PAYROLL_VERSIONS);
    if (!first) throw new Error('No first cut-off.');
    const october2026 = remittanceMonthCutOffs('2026-10', first, PAYROLL_VERSIONS);
    expect(october2026.cutOffs).toEqual([cutOff('2026-10-11', '2026-10-25', '2026-10-30')]);
    const periods = goLivePeriodsText(october2026.paidBeforeGoLive);
    expect(periods).toBe('Sep 26 – Oct 10, 2026');
    expect(remittanceGoLiveNoteText(periods ?? '')).toBe(
      'Covers only the cut-offs paid in Pulse Talent. Sep 26 – Oct 10, 2026 was paid before go-live: add its contributions and tax to this remittance outside Pulse.',
    );
    // November is a normal month.
    expect(remittanceMonthCutOffs('2026-11', first, PAYROLL_VERSIONS).paidBeforeGoLive).toEqual([]);
  });

  it('names the first cut-off not finalized, and never counts a draft or a returned run', () => {
    const first = firstPayrollCutOff('2026-09-26', PAYROLL_VERSIONS);
    if (!first) throw new Error('No first cut-off.');
    const [a, b] = remittanceMonthCutOffs('2026-10', first, PAYROLL_VERSIONS).cutOffs;
    if (!a || !b) throw new Error('Two cut-offs expected.');
    const finalized = { number: 'PAY-2026-0001', status: 'finalized' };
    expect(
      firstIncompleteCutOff([
        { cutOff: a, run: finalized },
        { cutOff: b, run: null },
      ]),
    ).toEqual({ cutOff: b, reason: 'noRun' });
    for (const status of ['draft', 'returned', 'pendingApproval']) {
      expect(
        firstIncompleteCutOff([
          { cutOff: a, run: finalized },
          { cutOff: b, run: { number: 'PAY-2026-0002', status } },
        ]),
      ).toEqual({ cutOff: b, reason: 'notFinalized' });
    }
    expect(
      firstIncompleteCutOff([
        { cutOff: a, run: finalized },
        { cutOff: b, run: { number: 'PAY-2026-0002', status: 'finalized' } },
      ]),
    ).toBeNull();
    expect(remittanceFinalizeFirstMessage(b.start, b.end, '2026-10')).toBe(
      'Finalize Oct 11 – 25, 2026 first: its pay date is in October 2026.',
    );
  });

  it('formats and steps months', () => {
    expect(formatRemittanceMonth('2026-10')).toBe('October 2026');
    expect(addRemittanceMonths('2026-12', 1)).toBe('2027-01');
    expect(addRemittanceMonths('2027-01', -1)).toBe('2026-12');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
  });
});
