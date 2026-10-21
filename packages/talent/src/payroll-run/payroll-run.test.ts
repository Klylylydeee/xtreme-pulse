import { describe, expect, it } from 'vitest';
import { addDays, type BusinessDate, type Centavos, type TimesheetType } from '@pulse/core';
import { computeDtr, type DtrTimeOffInput } from '../dtr/compute';
import type { DtrTimeOffStatus } from '../dtr/statuses';
import { type CutOffPeriod, cutOffFor } from '../payroll/lookups';
import type { AllowanceTypes } from '../payroll/schemas';
import { PAYROLL_SEED_VERSIONS, SEED_PAYROLL_SETTINGS } from '../server/payroll-settings/seed-data';
import type { TimeEntryHoursInput, TimesheetHoliday } from '../timesheets/compute';
import { type EffectiveVersion, versionOn } from '../timesheets/schedule';
import type { TimesheetStatus } from '../timesheets/schemas';
import {
  computePayrollLine,
  computePeriodPay,
  firstPayrollCutOff,
  groupPayrollLines,
  midMonthFiguresOf,
  parsePayrollBreakdown,
  payEffectCentavos,
  payrollCalendar,
  payrollDraftReadyText,
  payrollRunMembership,
  type PayrollBreakdown,
  type PayrollEarlierPeriodInput,
  type PayrollLine,
  type PayrollLineInput,
  type PayrollMidMonthFigures,
  type PayrollPriorDay,
  type PayrollRunPolicy,
  type PayrollSalaryEntry,
  serializePayrollBreakdown,
  settlementCutOffs,
  sumAttendanceItems,
  attendanceItemsPaidFor,
  accountNumberLastFour,
  buildPayslipView,
  countPayrollFlags,
  daysBelowMinimumWage,
  derivePayrollLineFlags,
  isAcknowledgeableFlag,
  isEditablePayrollRunStatus,
  isOverridableLineKey,
  livePayrollManualEntries,
  overrideTargetRefusal,
  parsePayrollYearToDate,
  PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE,
  PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE,
  PAYROLL_OVERRIDE_TARGET_MESSAGE,
  payrollAcknowledgementAuditReason,
  payrollApprovalTitle,
  payrollFinalizeFirstMessage,
  payrollFlagAcknowledgementSchema,
  payrollFlaggedRefusal,
  payrollFlagText,
  payrollManualEntryFormSchema,
  payrollManualEntryHistory,
  payrollManualEntrySchema,
  payrollOverriddenText,
  payrollSubmitSummary,
  payrollYearToDate,
  payrollYtdFiguresOf,
  payslipFileName,
  payslipReadyText,
  serializePayrollYearToDate,
  unresolvedPayrollFlags,
  type PayrollLineFlag,
  type PayrollManualEntryInput,
  type PayrollYtdOpeningInput,
  type PayslipSnapshotInput,
} from './index';

// The payroll run engine tests (docs/TESTING.md#payroll-run-tests, build step 2.9, decisions
// 325–349 in docs/BUILD_PLAN.md; from step 2.10 also the pure parts of cases A1–A7, at the end): the hand-checked cases P1–P12 and H2 of
// docs/modules/talent.md#payroll-run-computation-build-step-29, each its own test, to the
// centavo, from hand-built inputs (DTRs from `computeDtr`, the seeded rates and schedule). P1
// and P2 are the step's Done when. The salaries are invented test figures (HANDOFF item 256).

const V = PAYROLL_SEED_VERSIONS;
const SEEDED_POLICY: PayrollRunPolicy = {
  contributionBases: {
    sss: 'monthCompensation',
    philhealth: 'monthlyBasicSalary',
    pagibig: 'monthCompensation',
  },
  monthlyRatedUnworkedSpecialDay: 'paid',
  adjustmentLookbackCutOffs: 24,
};

const pesos = (amount: number): Centavos => Math.round(amount * 100);
const at = (day: string, time: string) => new Date(`${day}T${time}:00+08:00`);

let ids = 0;
function entry(day: string, from: string, to: string, marked = false): TimeEntryHoursInput {
  ids += 1;
  return {
    id: `e${String(ids).padStart(4, '0')}`,
    timeIn: at(day, from),
    timeOut: at(day, to),
    extraHours: marked ? { reason: 'Network cutover for a client' } : null,
  };
}
const full = (day: string) => entry(day, '08:00', '17:00');

function holiday(
  date: string,
  type: 'regular' | 'specialNonWorking',
  name: string,
): TimesheetHoliday {
  return { date, name, type, scope: 'nationwide', status: 'confirmed' };
}
const BONIFACIO = holiday('2026-11-30', 'regular', 'Bonifacio Day');
const IMMACULATE = holiday('2026-12-08', 'specialNonWorking', 'Feast of the Immaculate Conception');

function timeOff(date: string, status: DtrTimeOffStatus): DtrTimeOffInput {
  return {
    date,
    status,
    portion: 'whole',
    kind: status === 'offsetPaid' ? 'offset' : 'leave',
    shortName: status === 'offsetPaid' ? 'Offset' : 'VL',
    requestId: `r-${date}`,
  };
}

function salary(
  amount: number,
  rateType: 'monthly' | 'daily' = 'monthly',
  effectiveDate = '2020-01-06',
  minimumWageEarner = false,
): PayrollSalaryEntry {
  return {
    id: `s-${effectiveDate}-${amount}`,
    effectiveDate,
    createdAt: new Date(`${effectiveDate}T00:00:00Z`),
    rateType,
    amountCentavos: pesos(amount),
    minimumWageEarner,
  };
}

const value = <T>(versions: readonly EffectiveVersion<T>[], day: BusinessDate): T => {
  const found = versionOn(versions, day);
  if (!found) throw new Error(`No version on ${day}.`);
  return found.value;
};

const cutOff = (day: BusinessDate): CutOffPeriod => cutOffFor(day, SEED_PAYROLL_SETTINGS);
const SEP26 = cutOff('2026-09-26');
const OCT11 = cutOff('2026-10-11');
const NOV26 = cutOff('2026-11-26');
const DEC11 = cutOff('2026-12-11');

/** Every scheduled work day of the cut-off that isn't a holiday, worked 08:00–17:00. */
function presentEveryDay(
  period: CutOffPeriod,
  holidays: TimesheetHoliday[] = [],
  skip: string[] = [],
) {
  return payrollCalendar({
    from: period.start,
    to: period.end,
    workSchedules: V['talent.workSchedule'],
    assignments: [],
    holidays,
  })
    .filter((day) => day.kind === 'ordinary' && !skip.includes(day.date))
    .map((day) => full(day.date));
}

interface Case {
  period?: CutOffPeriod;
  salaries: PayrollSalaryEntry[];
  dateHired?: BusinessDate;
  separationDate?: BusinessDate | null;
  type?: TimesheetType;
  /** null: no timesheet. */
  status?: TimesheetStatus | null;
  entries?: TimeEntryHoursInput[];
  timeOff?: DtrTimeOffInput[];
  holidays?: TimesheetHoliday[];
  reimbursements?: { receipts: number; totalCentavos: Centavos };
  allowanceTypes?: readonly EffectiveVersion<AllowanceTypes>[];
  allowanceEntries?: PayrollLineInput['employee']['allowanceEntries'];
  policy?: Partial<PayrollRunPolicy>;
  midMonth?: PayrollMidMonthFigures | null;
  earlierPeriods?: PayrollEarlierPeriodInput[];
  deMinimisPaid?: Record<string, Centavos>;
  previousStatus?: PayrollPriorDay['status'];
}

function inputOf(c: Case): PayrollLineInput {
  const period = c.period ?? SEP26;
  const holidays = c.holidays ?? [];
  const dateHired = c.dateHired ?? '2020-01-06';
  const status = c.status === undefined ? 'approved' : c.status;
  const type = c.type ?? 'overtime';
  const dtr = computeDtr({
    timesheetType: type,
    periodStart: period.start,
    periodEnd: period.end,
    entries: c.entries ?? [],
    holidays,
    workSchedules: V['talent.workSchedule'],
    assignments: [],
    premiumRates: V['talent.premiumRates'],
    timesheetSettings: V['talent.timesheetSettings'],
    payrollSettings: V['talent.payrollSettings'],
    approved: status === 'approved',
    dateHired,
    separationDate: c.separationDate ?? null,
    today: '2026-12-31',
    timeOff: c.timeOff ?? [],
  });
  const calendar = (from: BusinessDate, to: BusinessDate) =>
    payrollCalendar({
      from,
      to,
      workSchedules: V['talent.workSchedule'],
      assignments: [],
      holidays,
    });
  const previousDays: PayrollPriorDay[] = calendar(
    addDays(period.start, -10),
    addDays(period.start, -1),
  ).map((day) => ({
    ...day,
    status: day.restDay ? 'restDay' : (c.previousStatus ?? 'present'),
    approved: true,
  }));
  const firstOfMonth = `${period.payDate.slice(0, 7)}-01`;
  return {
    cutOff: period,
    employee: {
      dateHired,
      separationDate: c.separationDate ?? null,
      salaries: c.salaries,
      allowanceEntries: c.allowanceEntries ?? [],
    },
    calendar: calendar(period.start, period.end),
    previousDays,
    timesheet:
      status === null
        ? null
        : {
            type,
            status,
            days: dtr.days,
            reimbursements: c.reimbursements ?? { receipts: 0, totalCentavos: 0 },
          },
    payrollSettings: value(V['talent.payrollSettings'], period.start),
    policy: { ...SEEDED_POLICY, ...c.policy },
    premiumRates: V['talent.premiumRates'],
    allowanceTypes: c.allowanceTypes ?? V['talent.allowanceTypes'],
    sss: value(V['talent.sssContributions'], firstOfMonth),
    philhealth: value(V['talent.philhealthContributions'], firstOfMonth),
    pagibig: value(V['talent.pagibigContributions'], firstOfMonth),
    withholding: value(V['talent.withholdingTaxSemiMonthly'], period.payDate),
    deMinimisLimits: value(V['talent.deMinimisLimits'], period.payDate),
    minimumWageDailyCentavos:
      value(V['talent.minimumWages'], period.payDate).regions.find((r) => r.region === 'NCR')
        ?.dailyRateCentavos ?? null,
    deMinimisPaidCentavos: c.deMinimisPaid ?? {},
    midMonth: c.midMonth ?? null,
    earlierPeriods: c.earlierPeriods ?? [],
  };
}

const run = (c: Case): PayrollBreakdown => computePayrollLine(inputOf(c));

/** The amount of the line with this key (own period unless a group is given), or undefined. */
function amountOf(
  result: PayrollBreakdown,
  key: string,
  group: PayrollLine['group'] | null = null,
): Centavos | undefined {
  const line = result.lines.find(
    (candidate) => candidate.key === key && (group === null || candidate.group === group),
  );
  return line?.amountCentavos;
}
function lineOf(result: PayrollBreakdown, key: string, group: PayrollLine['group'] | null = null) {
  const line = result.lines.find(
    (candidate) => candidate.key === key && (group === null || candidate.group === group),
  );
  if (!line) throw new Error(`No line ${key}.`);
  return line;
}

// --- The hand-checked cases ------------------------------------------------------------------

const P1: Case = {
  salaries: [salary(21750)],
  type: 'overtime',
  entries: [
    entry('2026-09-28', '08:00', '19:00', true),
    full('2026-09-29'),
    full('2026-09-30'),
    entry('2026-10-01', '08:30', '17:00'),
    // Oct 2: no entry.
    entry('2026-10-03', '08:00', '12:00', true),
    full('2026-10-05'),
    entry('2026-10-06', '08:00', '23:00', true),
    full('2026-10-07'),
    full('2026-10-08'),
    full('2026-10-09'),
  ],
  reimbursements: { receipts: 1, totalCentavos: pesos(350) },
};

const P2: Case = {
  salaries: [salary(26100)],
  type: 'standard',
  entries: [
    full('2026-09-28'),
    entry('2026-09-29', '08:00', '19:00', true),
    entry('2026-09-30', '08:00', '16:00'),
    full('2026-10-01'),
    full('2026-10-02'),
    entry('2026-10-03', '08:00', '12:00', true),
    full('2026-10-05'),
    full('2026-10-06'),
    full('2026-10-07'),
  ],
  timeOff: [timeOff('2026-10-08', 'onLeavePaid'), timeOff('2026-10-09', 'leaveWithoutPay')],
};

describe('the hand-checked cases (docs/modules/talent.md#payroll-run-computation-build-step-29)', () => {
  it('P1: an Overtime timesheet, monthly ₱21,750 (the Done when)', () => {
    const result = run(P1);
    expect(result.facts.baseDays).toBe(10);
    expect(result.facts.dailyRateCentavos).toBe(pesos(1000));
    expect(result.facts.hourlyRateCentavos).toBe(pesos(125));
    expect(amountOf(result, 'basicPay')).toBe(pesos(10875));
    expect(lineOf(result, 'overtimeOrdinary')).toMatchObject({
      quantity: '480',
      amountCentavos: pesos(1250),
    });
    expect(lineOf(result, 'restDayWork')).toMatchObject({
      quantity: '240',
      amountCentavos: pesos(650),
    });
    expect(lineOf(result, 'nightDifferential')).toMatchObject({
      quantity: '60',
      amountCentavos: pesos(12.5),
    });
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(500));
    expect(lineOf(result, 'reimbursement')).toMatchObject({
      label: 'Reimbursements (1 receipt)',
      amountCentavos: pesos(350),
      taxable: false,
    });
    expect(result.totals.grossCentavos).toBe(pesos(13637.5));

    expect(lineOf(result, 'absence')).toMatchObject({ quantity: '1', amountCentavos: pesos(1000) });
    expect(lineOf(result, 'late')).toMatchObject({ quantity: '30', amountCentavos: pesos(62.5) });
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(550));
    expect(result.contributions.sss.mscCentavos).toBe(pesos(22000));
    expect(result.contributions.sss.month.employeeCentavos).toBe(pesos(1100));
    expect(amountOf(result, 'philhealthEmployee')).toBe(pesos(271.88));
    expect(result.contributions.philhealth.month.employeeCentavos).toBe(pesos(543.75));
    expect(amountOf(result, 'pagibigEmployee')).toBe(pesos(100));
    expect(result.taxableCompensationCentavos).toBe(pesos(10803.12));
    expect(result.taxCentavos).toBe(pesos(57.92));
    expect(amountOf(result, 'withholdingTax')).toBe(pesos(57.92));
    expect(result.totals.deductionsCentavos).toBe(pesos(2042.3));
    expect(result.totals.netPayCentavos).toBe(pesos(11595.2));

    expect(amountOf(result, 'sssEmployer', 'employerShares')).toBe(pesos(1100));
    expect(amountOf(result, 'sssEc', 'employerShares')).toBe(pesos(15));
    expect(amountOf(result, 'philhealthEmployer', 'employerShares')).toBe(pesos(271.88));
    expect(amountOf(result, 'pagibigEmployer', 'employerShares')).toBe(pesos(100));
    expect(result.totals.employerContributionsCentavos).toBe(pesos(1486.88));
    expect(result.totals.reimbursementsCentavos).toBe(pesos(350));
    expect(result.contributions.method).toBe('estimate');
    expect(result.negativeNet).toBe(false);
    // Basic salary earned: basic less absences and late.
    expect(result.basicSalaryEarnedCentavos).toBe(pesos(10875 - 1000 - 62.5));
  });

  it('P2: a Standard timesheet, monthly ₱26,100 (the Done when)', () => {
    const result = run(P2);
    expect(amountOf(result, 'basicPay')).toBe(pesos(13050));
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(500));
    expect(result.totals.grossCentavos).toBe(pesos(13550));
    // No premium line: the extra hours became offset (6.0 h), not pay.
    for (const kind of [
      'overtimeOrdinary',
      'restDayWork',
      'holidayWork',
      'restDayHolidayOvertime',
    ]) {
      expect(result.lines.some((line) => line.kind === kind)).toBe(false);
    }
    expect(result.facts.offsetEarnedMinutes).toBe(360);

    expect(lineOf(result, 'undertime')).toMatchObject({
      quantity: '60',
      amountCentavos: pesos(150),
    });
    expect(lineOf(result, 'leaveWithoutPay')).toMatchObject({
      quantity: '1',
      amountCentavos: pesos(1200),
    });
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(650));
    expect(result.contributions.sss.mscCentavos).toBe(pesos(26000));
    expect(amountOf(result, 'philhealthEmployee')).toBe(pesos(326.25));
    expect(amountOf(result, 'pagibigEmployee')).toBe(pesos(100));
    expect(result.taxableCompensationCentavos).toBe(pesos(10623.75));
    expect(result.taxCentavos).toBe(pesos(31.01));
    expect(result.totals.deductionsCentavos).toBe(pesos(2457.26));
    expect(result.totals.netPayCentavos).toBe(pesos(11092.74));
  });

  it('P3: P1 with the timesheet still waiting for HR gets basic pay only', () => {
    const result = run({ ...P1, status: 'pendingHr' });
    expect(result.facts.provisional).toBe(true);
    expect(result.lines.filter((line) => line.side === 'earning').map((line) => line.key)).toEqual([
      'basicPay',
      'allowance:internet',
    ]);
    expect(amountOf(result, 'basicPay')).toBe(pesos(10875));
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(500));
    expect(result.totals.employeeContributionsCentavos).toBe(pesos(921.88));
    expect(result.taxableCompensationCentavos).toBe(pesos(9953.12));
    expect(result.taxCentavos).toBe(0);
    expect(result.totals.netPayCentavos).toBe(pesos(10453.12));
    expect(result.attendanceItems).toEqual([
      { periodStart: SEP26.start, periodEnd: SEP26.end, items: [] },
    ]);
  });

  it('P4: P3 finalized, then approved: the next draft settles its attendance items', () => {
    const p3 = run({ ...P1, status: 'pendingHr' });
    const now = computePeriodPay({
      ...inputOf(P1),
      periodStart: SEP26.start,
      periodEnd: SEP26.end,
    });
    const result = run({
      period: OCT11,
      salaries: P1.salaries,
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(p3),
      earlierPeriods: [
        {
          periodStart: SEP26.start,
          periodEnd: SEP26.end,
          now: now.attendanceItems,
          paid: sumAttendanceItems([attendanceItemsPaidFor(p3, SEP26.start)]),
        },
      ],
    });
    const settled = result.lines.filter((line) => line.group === 'settlements');
    expect(Object.fromEntries(settled.map((line) => [line.key, payEffectCentavos(line)]))).toEqual({
      overtimeOrdinary: pesos(1250),
      restDayWork: pesos(650),
      nightDifferential: pesos(12.5),
      reimbursement: pesos(350),
      absence: pesos(-1000),
      late: pesos(-62.5),
    });
    expect(lineOf(result, 'overtimeOrdinary', 'settlements').label).toBe(
      'Overtime, ordinary day · Sep 26 – Oct 10',
    );
    expect(result.settledPeriods).toEqual([SEP26.start]);
    expect(result.attendanceItems[1]?.periodStart).toBe(SEP26.start);
    // Settlements count in gross and deductions, and as compensation this month.
    expect(result.totals.grossCentavos).toBe(pesos(10875 + 500 + 1250 + 650 + 12.5 + 350));
    expect(result.compensationForContributionsCentavos).toBe(
      pesos(10875 + 1250 + 650 + 12.5 - 1000 - 62.5),
    );
  });

  it('P5: P1 finalized, then an approved SL covers Oct 2: the absence is reversed', () => {
    const p1 = run(P1);
    const now = computePeriodPay({
      ...inputOf({ ...P1, timeOff: [timeOff('2026-10-02', 'onLeavePaid')] }),
      periodStart: SEP26.start,
      periodEnd: SEP26.end,
    });
    const result = run({
      period: OCT11,
      salaries: P1.salaries,
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(p1),
      earlierPeriods: [
        {
          periodStart: SEP26.start,
          periodEnd: SEP26.end,
          now: now.attendanceItems,
          paid: attendanceItemsPaidFor(p1, SEP26.start),
        },
      ],
    });
    const settled = result.lines.filter((line) => line.group === 'settlements');
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      key: 'absence',
      side: 'deduction',
      amountCentavos: pesos(-1000),
    });
    expect(payEffectCentavos(settled[0] as PayrollLine)).toBe(pesos(1000));
  });

  it('P6: the end-of-month cut-off deducts the real month less the mid-month run', () => {
    const p1 = run(P1);
    const result = run({
      period: OCT11,
      salaries: P1.salaries,
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(p1),
    });
    expect(p1.compensationForContributionsCentavos).toBe(pesos(11725));
    expect(result.compensationForContributionsCentavos).toBe(pesos(10875));
    expect(result.contributions.method).toBe('remainder');
    expect(result.contributions.monthCompensationCentavos).toBe(pesos(22600));
    expect(result.contributions.sss.mscCentavos).toBe(pesos(22500));
    expect(result.contributions.sss.month.employeeCentavos).toBe(pesos(1125));
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(575));
    expect(amountOf(result, 'philhealthEmployee')).toBe(pesos(271.87));
    expect(amountOf(result, 'pagibigEmployee')).toBe(pesos(100));
    expect(result.taxableCompensationCentavos).toBe(pesos(9928.13));
    expect(result.taxCentavos).toBe(0);
    // Employer: SSS 2,250 − 1,100; EC 30 − 15; PhilHealth 543.75 − 271.88; Pag-IBIG 200 − 100.
    expect(amountOf(result, 'sssEmployer')).toBe(pesos(1150));
    expect(amountOf(result, 'sssEc')).toBe(pesos(15));
    expect(amountOf(result, 'philhealthEmployer')).toBe(pesos(271.87));
    expect(amountOf(result, 'pagibigEmployer')).toBe(pesos(100));
  });

  it('P7: hired Monday Oct 5, inside the cut-off', () => {
    const result = run({
      salaries: [salary(21750, 'monthly', '2026-10-05')],
      dateHired: '2026-10-05',
      entries: presentEveryDay(SEP26).filter((e) => e.timeIn >= at('2026-10-05', '00:00')),
    });
    expect(lineOf(result, 'basicPay')).toMatchObject({
      quantity: '5',
      amountCentavos: pesos(5000),
    });
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(250));
    expect(result.facts.employedBaseDays).toBe(5);
  });

  it('P8: a salary change inside the cut-off is one basic pay line', () => {
    const result = run({
      salaries: [salary(21750), salary(26100, 'monthly', '2026-10-05')],
      entries: presentEveryDay(SEP26),
    });
    expect(result.lines.filter((line) => line.kind === 'basicPay')).toHaveLength(1);
    expect(amountOf(result, 'basicPay')).toBe(pesos(11962.5));
  });

  it('P9: daily-rated ₱800, an unworked regular holiday and special day', () => {
    const holidays = [BONIFACIO, IMMACULATE];
    const result = run({
      period: NOV26,
      salaries: [salary(800, 'daily')],
      holidays,
      entries: presentEveryDay(NOV26, holidays),
    });
    expect(lineOf(result, 'basicPay')).toMatchObject({
      quantity: '9',
      amountCentavos: pesos(7200),
    });
    expect(lineOf(result, 'holidayPay:2026-11-30')).toMatchObject({
      label: 'Holiday pay · Nov 30',
      amountCentavos: pesos(800),
    });
    expect(result.lines.some((line) => line.key === 'holidayPay:2026-12-08')).toBe(false);
  });

  it('P10: absent on the workday before: daily-rated and monthly-rated', () => {
    const holidays = [BONIFACIO, IMMACULATE];
    const entries = presentEveryDay(NOV26, holidays, ['2026-11-27']);
    const daily = run({ period: NOV26, salaries: [salary(800, 'daily')], holidays, entries });
    expect(daily.lines.some((line) => line.kind === 'holidayPay')).toBe(false);
    expect(amountOf(daily, 'absence')).toBe(pesos(800));

    const monthly = run({ period: NOV26, salaries: [salary(21750)], holidays, entries });
    expect(amountOf(monthly, 'basicPay')).toBe(pesos(10875));
    expect(amountOf(monthly, 'absence')).toBe(pesos(1000));
    expect(lineOf(monthly, 'holidayNotPaid:2026-11-30')).toMatchObject({
      label: 'Holiday not paid (absent on Nov 27)',
      amountCentavos: pesos(1000),
    });
    expect(monthly.basicSalaryEarnedCentavos).toBe(pesos(10875 - 1000 - 1000));
  });

  it('P11: a worked regular holiday on an Overtime timesheet', () => {
    const holidays = [BONIFACIO, IMMACULATE];
    const entries = [
      ...presentEveryDay(NOV26, holidays),
      entry('2026-11-30', '08:00', '17:00', true),
    ];
    const monthly = run({ period: NOV26, salaries: [salary(21750)], holidays, entries });
    expect(lineOf(monthly, 'holidayWork')).toMatchObject({
      quantity: '480',
      amountCentavos: pesos(1000),
    });
    expect(amountOf(monthly, 'basicPay')).toBe(pesos(10875));

    const daily = run({ period: NOV26, salaries: [salary(800, 'daily')], holidays, entries });
    expect(amountOf(daily, 'holidayPay:2026-11-30')).toBe(pesos(800));
    expect(amountOf(daily, 'holidayWork')).toBe(pesos(800));
  });

  it('P12: a daily-rated minimum wage earner with overtime pays no tax', () => {
    const result = run({
      salaries: [salary(755, 'daily', '2020-01-06', true)],
      entries: [
        entry('2026-09-28', '08:00', '19:00', true),
        ...presentEveryDay(SEP26, [], ['2026-09-28']),
      ],
    });
    expect(amountOf(result, 'basicPay')).toBe(pesos(7550));
    expect(lineOf(result, 'overtimeOrdinary')).toMatchObject({
      quantity: '120',
      amountCentavos: pesos(235.94),
    });
    expect(result.facts.minimumWageEarner).toBe(true);
    expect(result.taxableCompensationCentavos).toBe(0);
    expect(result.taxCentavos).toBe(0);
    expect(lineOf(result, 'basicPay').taxable).toBe(false);
  });

  it('H2: a holiday confirmed after its run was finalized is settled', () => {
    const entries = presentEveryDay(NOV26, [IMMACULATE]).filter(
      (e) => e.timeIn < at('2026-11-30', '00:00') || e.timeIn >= at('2026-12-01', '00:00'),
    );
    const base = { period: NOV26, salaries: [salary(21750)], entries };
    // Finalized with Nov 30 still a draft: an absence.
    const before = run({ ...base, holidays: [IMMACULATE] });
    expect(amountOf(before, 'absence')).toBe(pesos(1000));
    // Confirmed: the DTR shows a holiday, the rule met on Nov 27.
    const now = computePeriodPay({
      ...inputOf({ ...base, holidays: [BONIFACIO, IMMACULATE] }),
      periodStart: NOV26.start,
      periodEnd: NOV26.end,
    });
    const next = run({
      period: DEC11,
      salaries: base.salaries,
      entries: presentEveryDay(DEC11),
      earlierPeriods: [
        {
          periodStart: NOV26.start,
          periodEnd: NOV26.end,
          now: now.attendanceItems,
          paid: attendanceItemsPaidFor(before, NOV26.start),
        },
      ],
    });
    const settled = next.lines.filter((line) => line.group === 'settlements');
    expect(settled.map((line) => [line.key, payEffectCentavos(line)])).toEqual([
      ['absence', pesos(1000)],
    ]);
    expect(lineOf(next, 'absence', 'settlements').label).toBe('Absences · Nov 26 – Dec 10');
  });
});

// --- Rules beyond the cases ------------------------------------------------------------------

describe('basic pay, holidays and premiums', () => {
  it('pays a separation inside the cut-off by employed base days', () => {
    const result = run({
      salaries: [salary(21750)],
      separationDate: '2026-10-02',
      entries: presentEveryDay(SEP26).filter((e) => e.timeIn < at('2026-10-03', '00:00')),
    });
    expect(amountOf(result, 'basicPay')).toBe(pesos(5000));
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(250));
  });

  it('a Standard timesheet with P1’s entries earns no premium and no night differential beyond schedule', () => {
    const result = run({ ...P1, type: 'standard' });
    expect(
      result.lines.filter((line) => line.group === 'earnings').map((line) => line.key),
    ).toEqual(['basicPay', 'allowance:internet', 'reimbursement']);
    expect(result.facts.offsetEarnedMinutes).toBe(120 + 240 + 360);
  });

  it('rest day work beyond the first 8 hours is overtime at the day’s rate × 1.30', () => {
    const result = run({
      salaries: [salary(21750)],
      entries: [...presentEveryDay(SEP26), entry('2026-10-03', '08:00', '19:00', true)],
    });
    // 10 h worked: 8 h × ₱125 × 1.30 = ₱1,300; 2 h × ₱125 × 1.30 × 1.30 = ₱422.50.
    expect(amountOf(result, 'restDayWork')).toBe(pesos(1300));
    expect(amountOf(result, 'restDayHolidayOvertime')).toBe(pesos(422.5));
  });

  it('meets the workday-before rule with paid leave and fails it with leave without pay', () => {
    const holidays = [BONIFACIO];
    const entries = presentEveryDay(NOV26, holidays, ['2026-11-27']);
    const paid = run({
      period: NOV26,
      salaries: [salary(800, 'daily')],
      holidays,
      entries,
      timeOff: [timeOff('2026-11-27', 'onLeavePaid')],
    });
    expect(amountOf(paid, 'holidayPay:2026-11-30')).toBe(pesos(800));
    const unpaid = run({
      period: NOV26,
      salaries: [salary(800, 'daily')],
      holidays,
      entries,
      timeOff: [timeOff('2026-11-27', 'leaveWithoutPay')],
    });
    expect(unpaid.lines.some((line) => line.kind === 'holidayPay')).toBe(false);
    expect(amountOf(unpaid, 'leaveWithoutPay')).toBe(pesos(800));
  });

  it('looks before the cut-off for the workday before, skipping rest days', () => {
    // A regular holiday on Monday Sep 28: the workday before is Friday Sep 25 (the previous cut-off).
    const holidays = [holiday('2026-09-28', 'regular', 'Test holiday')];
    const entries = presentEveryDay(SEP26, holidays);
    const met = run({ salaries: [salary(800, 'daily')], holidays, entries });
    expect(amountOf(met, 'holidayPay:2026-09-28')).toBe(pesos(800));
    const failed = run({
      salaries: [salary(800, 'daily')],
      holidays,
      entries,
      previousStatus: 'absentUnpaid',
    });
    expect(failed.lines.some((line) => line.kind === 'holidayPay')).toBe(false);
  });

  it('pays an unworked regular holiday on a rest day, for a monthly salary too', () => {
    const holidays = [holiday('2026-10-03', 'regular', 'Test holiday on a Saturday')];
    const result = run({
      salaries: [salary(21750)],
      holidays,
      entries: presentEveryDay(SEP26, holidays),
    });
    expect(amountOf(result, 'basicPay')).toBe(pesos(10875));
    expect(amountOf(result, 'holidayPay:2026-10-03')).toBe(pesos(1000));
  });

  it('deducts a monthly-rated unworked special day only when the policy says so', () => {
    const holidays = [IMMACULATE];
    const entries = presentEveryDay(NOV26, holidays);
    const paid = run({ period: NOV26, salaries: [salary(21750)], holidays, entries });
    expect(paid.lines.some((line) => line.kind === 'holidayNotPaid')).toBe(false);
    const deducted = run({
      period: NOV26,
      salaries: [salary(21750)],
      holidays,
      entries,
      policy: { monthlyRatedUnworkedSpecialDay: 'deducted' },
    });
    expect(lineOf(deducted, 'holidayNotPaid:2026-12-08')).toMatchObject({
      label: 'Special day not worked (Dec 8)',
      amountCentavos: pesos(1000),
    });
  });

  it('keeps an unapproved timesheet’s holiday pay with the rule counted as met', () => {
    const holidays = [BONIFACIO];
    const result = run({
      period: NOV26,
      salaries: [salary(800, 'daily')],
      holidays,
      status: 'pendingSupervisor',
      entries: presentEveryDay(NOV26, holidays, ['2026-11-27']),
    });
    expect(amountOf(result, 'holidayPay:2026-11-30')).toBe(pesos(800));
    expect(result.lines.some((line) => line.kind === 'absence')).toBe(false);
    expect(result.attendanceItems[0]?.items.map((item) => item.key)).toEqual([
      'holidayPay:2026-11-30',
    ]);
  });

  it('pays basic pay with no timesheet at all', () => {
    const result = run({ salaries: [salary(21750)], status: null });
    expect(result.facts.timesheetStatus).toBeNull();
    expect(result.facts.provisional).toBe(true);
    expect(amountOf(result, 'basicPay')).toBe(pesos(10875));
  });
});

describe('allowances and de minimis', () => {
  const RICE: AllowanceTypes = {
    types: [
      ...(V['talent.allowanceTypes'][0]?.value.types ?? []),
      {
        key: 'rice',
        name: 'Rice subsidy',
        taxTreatment: 'deMinimis',
        deMinimisKey: 'riceSubsidy',
        basis: 'perCutOff',
        defaultAmountCentavos: pesos(1500),
        autoAssign: true,
        active: true,
      },
      {
        key: 'meal',
        name: 'Meal allowance',
        taxTreatment: 'taxable',
        deMinimisKey: null,
        basis: 'perDayPresent',
        defaultAmountCentavos: pesos(100),
        autoAssign: false,
        active: true,
      },
    ],
  };
  const types = [{ effectiveFrom: '2000-01-01', value: RICE }];
  const meal = [
    {
      id: 'a1',
      typeKey: 'meal',
      effectiveDate: '2020-01-06',
      kind: 'set' as const,
      createdAt: new Date('2020-01-06T00:00:00Z'),
      amountCentavos: pesos(100),
    },
  ];

  it('pays a per day present allowance on present days only, and waits while unapproved', () => {
    const approved = run({ ...P1, allowanceTypes: types, allowanceEntries: meal });
    // 9 present days (Oct 2 absent, Oct 3 a rest day).
    expect(lineOf(approved, 'allowanceDay:meal')).toMatchObject({
      quantity: '9',
      amountCentavos: pesos(900),
    });
    const waiting = run({
      ...P1,
      status: 'pendingHr',
      allowanceTypes: types,
      allowanceEntries: meal,
    });
    expect(waiting.lines.some((line) => line.key === 'allowanceDay:meal')).toBe(false);
  });

  it('taxes a de minimis allowance only above its monthly limit, counting finalized payments', () => {
    const under = run({ ...P1, allowanceTypes: types });
    expect(under.deMinimis[0]).toMatchObject({
      key: 'riceSubsidy',
      amountCentavos: pesos(1500),
      excessCentavos: 0,
    });
    expect(under.compensationForContributionsCentavos).toBe(pesos(11725));

    const over = run({ ...P1, allowanceTypes: types, deMinimisPaid: { riceSubsidy: pesos(1500) } });
    // ₱2,500 limit, ₱1,500 already paid: ₱1,000 non-taxable, ₱500 taxable.
    expect(over.deMinimis[0]).toMatchObject({
      nonTaxableCentavos: pesos(1000),
      excessCentavos: pesos(500),
    });
    expect(lineOf(over, 'allowance:rice')).toMatchObject({
      taxable: true,
      taxableCentavos: pesos(500),
    });
    expect(over.compensationForContributionsCentavos).toBe(pesos(11725 + 500));
  });

  it('taxes a minimum wage earner’s taxable allowance with no contribution subtracted', () => {
    const result = run({
      salaries: [salary(755, 'daily', '2020-01-06', true)],
      entries: presentEveryDay(SEP26),
      allowanceTypes: [
        {
          effectiveFrom: '2000-01-01',
          value: {
            types: [
              {
                key: 'transport',
                name: 'Transportation',
                taxTreatment: 'taxable',
                deMinimisKey: null,
                basis: 'perCutOff',
                defaultAmountCentavos: pesos(11000),
                autoAssign: true,
                active: true,
              },
            ],
          },
        },
      ],
    });
    expect(result.taxableCompensationCentavos).toBe(pesos(11000));
    // 15% of (11,000 − 10,417) = ₱87.45.
    expect(result.taxCentavos).toBe(pesos(87.45));
  });
});

describe('contributions and the line', () => {
  it('with no mid-month run that month deducts only the end-of-month share of the estimate', () => {
    const result = run({
      period: OCT11,
      salaries: [salary(21750)],
      entries: presentEveryDay(OCT11),
    });
    expect(result.contributions.method).toBe('estimateOnly');
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(550));
    expect(amountOf(result, 'philhealthEmployee')).toBe(pesos(271.87));
  });

  it('refunds a negative remainder in the end-of-month cut-off', () => {
    // A mid-month run that paid nothing but deducted the estimate; then absent all of Oct 11 – 25.
    const midMonth: PayrollMidMonthFigures = {
      compensationForContributionsCentavos: 0,
      sss: { employeeCentavos: pesos(550), employerCentavos: pesos(1100), ecCentavos: pesos(15) },
      philhealth: { employeeCentavos: pesos(271.88), employerCentavos: pesos(271.88) },
      pagibig: { employeeCentavos: pesos(100), employerCentavos: pesos(100) },
    };
    const result = run({ period: OCT11, salaries: [salary(21750)], midMonth });
    // ₱10,875 basic less 10 absences of ₱1,000.
    expect(result.compensationForContributionsCentavos).toBe(pesos(875));
    // Month compensation ₱875 → MSC ₱5,000: ₱250 less the ₱550 deducted.
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(-300));
    // Pag-IBIG 1% of ₱875 = ₱8.75 less ₱100.
    expect(amountOf(result, 'pagibigEmployee')).toBe(pesos(-91.25));
    expect(amountOf(result, 'sssEc')).toBe(pesos(10 - 15));
  });

  it('keeps a negative net pay as computed and marks it', () => {
    const reversed: PayrollEarlierPeriodInput = {
      periodStart: SEP26.start,
      periodEnd: SEP26.end,
      now: [],
      paid: [
        {
          key: 'overtimeOrdinary',
          kind: 'overtimeOrdinary',
          side: 'earning',
          label: 'Overtime, ordinary day',
          quantity: '2400',
          unit: 'minutes',
          rateText: null,
          amountCentavos: pesos(6250),
          taxableCentavos: pesos(6250),
          deMinimisKey: null,
          typeKey: null,
        },
      ],
    };
    const result = run({ period: OCT11, salaries: [salary(21750)], earlierPeriods: [reversed] });
    expect(payEffectCentavos(lineOf(result, 'overtimeOrdinary', 'settlements'))).toBe(pesos(-6250));
    expect(result.totals.netPayCentavos).toBeLessThan(0);
    expect(result.negativeNet).toBe(true);
    // Taxable compensation never goes below 0.
    expect(result.taxableCompensationCentavos).toBe(0);
  });

  it('reads each contribution basis from the policy', () => {
    const p1 = run(P1);
    const result = run({
      period: OCT11,
      salaries: [salary(21750)],
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(p1),
      policy: {
        contributionBases: {
          sss: 'monthlyBasicSalary',
          philhealth: 'monthlyBasicSalary',
          pagibig: 'monthlyBasicSalary',
        },
      },
    });
    expect(result.contributions.sss.basis).toBe('monthlyBasicSalary');
    expect(amountOf(result, 'sssEmployee')).toBe(pesos(550));
  });

  it('gross less deductions is net pay; employer shares are outside both', () => {
    const result = run(P1);
    const sum = (side: PayrollLine['side']) =>
      result.lines
        .filter((line) => line.side === side)
        .reduce((s, line) => s + line.amountCentavos, 0);
    expect(sum('earning')).toBe(result.totals.grossCentavos);
    expect(sum('deduction')).toBe(result.totals.deductionsCentavos);
    expect(result.totals.grossCentavos - result.totals.deductionsCentavos).toBe(
      result.totals.netPayCentavos,
    );
    expect(groupPayrollLines(result.lines).map((group) => group.label)).toEqual([
      'Earnings',
      'Deductions',
      'Employer shares',
    ]);
  });
});

describe('the breakdown, cut-offs and membership', () => {
  it('serializes and parses the breakdown (version 2 from step 2.10)', () => {
    const result = run(P1);
    const json = serializePayrollBreakdown(result);
    expect(parsePayrollBreakdown(json)).toEqual(result);
    expect(() => parsePayrollBreakdown(JSON.stringify({ ...result, breakdownVersion: 3 }))).toThrow(
      'does not match version 1 or 2',
    );
    expect(() => parsePayrollBreakdown('{')).toThrow('not valid JSON');
  });

  it('finds the first payroll cut-off and the lookback', () => {
    const versions = V['talent.payrollSettings'];
    expect(firstPayrollCutOff(null, versions)).toBeNull();
    expect(firstPayrollCutOff('2026-09-26', versions)?.start).toBe('2026-09-26');
    expect(firstPayrollCutOff('2026-09-27', versions)?.start).toBe('2026-10-11');
    const lookback = settlementCutOffs(DEC11, 24, '2026-09-26', versions);
    expect(lookback.map((p) => p.start)).toEqual([
      '2026-11-26',
      '2026-11-11',
      '2026-10-26',
      '2026-10-11',
      '2026-09-26',
    ]);
    expect(settlementCutOffs(DEC11, 2, '2026-09-26', versions).map((p) => p.start)).toEqual([
      '2026-11-26',
      '2026-11-11',
    ]);
  });

  it('includes employment that overlaps the cut-off and leaves out no salary', () => {
    const period = { start: SEP26.start, end: SEP26.end };
    expect(
      payrollRunMembership(
        { dateHired: '2020-01-06', separationDate: null, salaries: [salary(21750)] },
        period,
      ),
    ).toEqual({ included: true });
    expect(
      payrollRunMembership({ dateHired: '2020-01-06', separationDate: null, salaries: [] }, period),
    ).toEqual({ included: false, reason: 'noSalary' });
    expect(
      payrollRunMembership(
        { dateHired: '2020-01-06', separationDate: '2026-09-25', salaries: [salary(21750)] },
        period,
      ),
    ).toEqual({ included: false, reason: 'notEmployed' });
  });

  it('words the notification without an amount', () => {
    expect(payrollDraftReadyText(SEP26.start, SEP26.end)).toBe(
      'Draft payroll for Sep 26 – Oct 10 is ready to review',
    );
  });
});

// --- Step 2.10: manual entries, flags, year-to-date and the payslip ---------------------------
// The pure parts of cases A1–A7 of docs/modules/talent.md#payroll-review-approval-and-payslips-
// build-step-210 (decisions 352–366), to the centavo, on step 2.9's P1 and P2.

function earning(
  id: string,
  label: string,
  amount: number,
  taxable = true,
  countsAsBasicSalary = false,
): PayrollManualEntryInput {
  return {
    id,
    kind: 'earning',
    targetLineKey: null,
    label,
    amountCentavos: pesos(amount),
    taxable,
    reducesTaxablePay: null,
    authorizedInWriting: null,
    countsAsBasicSalary,
  };
}
function deduction(
  id: string,
  label: string,
  amount: number,
  reducesTaxablePay: boolean,
  countsAsBasicSalary = false,
): PayrollManualEntryInput {
  return {
    id,
    kind: 'deduction',
    targetLineKey: null,
    label,
    amountCentavos: pesos(amount),
    taxable: null,
    reducesTaxablePay,
    authorizedInWriting: !reducesTaxablePay,
    countsAsBasicSalary,
  };
}
function override(id: string, targetLineKey: string, amount: number): PayrollManualEntryInput {
  return {
    id,
    kind: 'override',
    targetLineKey,
    label: targetLineKey,
    amountCentavos: pesos(amount),
    taxable: null,
    reducesTaxablePay: null,
    authorizedInWriting: null,
    countsAsBasicSalary: null,
  };
}
const withEntries = (c: Case, manualEntries: PayrollManualEntryInput[]): PayrollBreakdown =>
  computePayrollLine({ ...inputOf(c), manualEntries });

const BACK_PAY = earning('m1', 'Back pay: salary increase from Sep 15', 1000, true, true);
const P1_SNAPSHOT: PayslipSnapshotInput = {
  employeeName: 'Juan Dela Cruz',
  employeeNumber: 'XW-0001',
  departmentName: 'Engineering',
  positionTitle: 'Network Engineer',
  bank: { bank: 'unionbank', accountName: 'Juan Dela Cruz', accountNumberLastFour: '4321' },
};
const DONE = { states: { governmentIds: 'done', bankAccount: 'done' } } as const;

describe('manual entries (decisions 355–357)', () => {
  it('A2: a taxable back pay earning counting as basic salary', () => {
    const before = run(P1);
    const result = withEntries(P1, [BACK_PAY]);
    expect(lineOf(result, 'manual:m1')).toMatchObject({
      kind: 'manual',
      group: 'earnings',
      side: 'earning',
      label: 'Back pay: salary increase from Sep 15',
      amountCentavos: pesos(1000),
      taxable: true,
      taxableCentavos: pesos(1000),
      manual: { entryId: 'm1', countsAsBasicSalary: true },
    });
    expect(result.totals.grossCentavos).toBe(pesos(14637.5));
    // Contributions unchanged: the mid-month cut-off deducts the estimate.
    expect(result.totals.employeeContributionsCentavos).toBe(pesos(921.88));
    expect(result.compensationForContributionsCentavos).toBe(pesos(12725));
    expect(result.taxableCompensationCentavos).toBe(pesos(11803.12));
    expect(result.taxCentavos).toBe(pesos(207.92));
    expect(result.totals.deductionsCentavos).toBe(pesos(2192.3));
    expect(result.totals.netPayCentavos).toBe(pesos(12445.2));
    expect(result.basicSalaryEarnedCentavos - before.basicSalaryEarnedCentavos).toBe(pesos(1000));
    expect(result.manualEntries).toEqual([
      expect.objectContaining({ entryId: 'm1', kind: 'earning', staleReason: null }),
    ]);

    // Once finalized, the Oct 11 – 25 draft (P6) reads it in the month's compensation.
    const next = run({
      period: OCT11,
      salaries: P1.salaries,
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(result),
    });
    expect(next.contributions.monthCompensationCentavos).toBe(pesos(23600));
    expect(next.contributions.sss.mscCentavos).toBe(pesos(23500));
    expect(next.contributions.sss.month.employeeCentavos).toBe(pesos(1175));
    expect(amountOf(next, 'sssEmployee')).toBe(pesos(625));
  });

  it('a manual earning is never an attendance item, so it is never settled again', () => {
    const result = withEntries(P1, [BACK_PAY]);
    const items = attendanceItemsPaidFor(result, SEP26.start);
    expect(items.some((item) => item.key.startsWith('manual:'))).toBe(false);
    expect(result.attendanceItems).toEqual(run(P1).attendanceItems);
  });

  it('a non-taxable earning counts in neither compensation nor tax', () => {
    const result = withEntries(P1, [earning('m1', 'Correction', 500, false)]);
    expect(result.totals.grossCentavos).toBe(pesos(14137.5));
    expect(result.compensationForContributionsCentavos).toBe(pesos(11725));
    expect(result.taxCentavos).toBe(pesos(57.92));
    expect(result.totals.netPayCentavos).toBe(pesos(12095.2));
    expect(lineOf(result, 'manual:m1').taxable).toBe(false);
  });

  it('A3: an after-tax deduction lowers net pay only', () => {
    const result = withEntries(P2, [deduction('m2', 'Cash advance', 500, false)]);
    expect(lineOf(result, 'manual:m2')).toMatchObject({
      group: 'deductions',
      side: 'deduction',
      taxableCentavos: 0,
      manual: { reducesTaxablePay: false, authorizedInWriting: true },
    });
    expect(result.totals.netPayCentavos).toBe(pesos(10592.74));
    expect(result.taxCentavos).toBe(pesos(31.01));
    expect(result.compensationForContributionsCentavos).toBe(
      run(P2).compensationForContributionsCentavos,
    );
  });

  it('A3: the form refuses an after-tax deduction until it is authorized in writing', () => {
    const typed = {
      kind: 'deduction',
      label: 'Cash advance',
      amount: '500.00',
      reducesTaxablePay: false,
      countsAsBasicSalary: false,
      reason: 'Cash advance on Oct 1',
    };
    const refused = payrollManualEntryFormSchema.safeParse(typed);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({
      path: ['authorizedInWriting'],
      message: PAYROLL_AUTHORIZATION_REQUIRED_MESSAGE,
    });
    expect(payrollManualEntryFormSchema.parse({ ...typed, authorizedInWriting: true })).toEqual({
      kind: 'deduction',
      targetLineKey: null,
      label: 'Cash advance',
      amountCentavos: 50000,
      taxable: null,
      reducesTaxablePay: false,
      authorizedInWriting: true,
      countsAsBasicSalary: false,
      reason: 'Cash advance on Oct 1',
    });
  });

  it('a deduction that reduces taxable pay lowers compensation, tax and basic salary earned', () => {
    const result = withEntries(P1, [deduction('m3', 'Correction', 1000, true, true)]);
    expect(result.compensationForContributionsCentavos).toBe(pesos(10725));
    expect(result.taxableCompensationCentavos).toBe(pesos(9803.12));
    expect(result.taxCentavos).toBe(0);
    expect(result.totals.netPayCentavos).toBe(pesos(11595.2) + pesos(57.92) - pesos(1000));
    expect(run(P1).basicSalaryEarnedCentavos - result.basicSalaryEarnedCentavos).toBe(pesos(1000));
  });

  it('A4: overriding withholding tax to ₱0.00, and refusing an override of absences', () => {
    const result = withEntries(P1, [override('m4', 'withholdingTax', 0)]);
    expect(lineOf(result, 'withholdingTax')).toMatchObject({
      amountCentavos: 0,
      override: { entryId: 'm4', computedAmountCentavos: pesos(57.92) },
    });
    expect(payrollOverriddenText(pesos(57.92))).toBe('Overridden (computed ₱57.92)');
    expect(result.taxCentavos).toBe(0);
    expect(result.totals.taxWithheldCentavos).toBe(0);
    expect(result.taxableCompensationCentavos).toBe(pesos(10803.12));
    expect(result.totals.netPayCentavos).toBe(pesos(11653.12));
    expect(result.manualEntries[0]).toMatchObject({
      computedAmountCentavos: pesos(57.92),
      staleReason: null,
    });

    expect(overrideTargetRefusal('absence')).toBe(PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE);
    expect(
      payrollManualEntrySchema.safeParse({
        kind: 'override',
        targetLineKey: 'absence',
        amountCentavos: 0,
        reason: 'Excused',
      }).error?.issues[0]?.message,
    ).toBe(PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE);
    // Given anyway, the engine leaves the line as computed and marks the entry stale.
    const stale = withEntries(P1, [override('m5', 'absence', 0)]);
    expect(amountOf(stale, 'absence')).toBe(pesos(1000));
    expect(stale.manualEntries[0]?.staleReason).toBe('notOverridable');
    expect(stale.totals.netPayCentavos).toBe(pesos(11595.2));
  });

  it('refuses an override of every attendance item and allows the overridable lines', () => {
    for (const key of [
      'overtimeOrdinary',
      'restDayWork',
      'nightDifferential',
      'holidayPay:2026-11-30',
      'allowanceDay:meal',
      'reimbursement',
      'late',
      'undertime',
      'leaveWithoutPay',
    ]) {
      expect(overrideTargetRefusal(key)).toBe(PAYROLL_OVERRIDE_ATTENDANCE_MESSAGE);
    }
    for (const key of [
      'basicPay',
      'allowance:internet',
      'sssEmployee',
      'sssEc',
      'withholdingTax',
    ]) {
      expect(isOverridableLineKey(key)).toBe(true);
    }
    expect(overrideTargetRefusal('manual:m1')).toBe(PAYROLL_OVERRIDE_TARGET_MESSAGE);
  });

  it('overriding basic pay works contributions and tax out from the new figure', () => {
    const result = withEntries(P1, [override('m6', 'basicPay', 11000)]);
    expect(lineOf(result, 'basicPay')).toMatchObject({
      amountCentavos: pesos(11000),
      taxableCentavos: pesos(11000),
      override: { computedAmountCentavos: pesos(10875) },
    });
    expect(result.totals.grossCentavos).toBe(pesos(13762.5));
    expect(result.compensationForContributionsCentavos).toBe(pesos(11850));
    expect(result.taxableCompensationCentavos).toBe(pesos(10928.12));
    expect(result.taxCentavos).toBe(pesos(76.67));
    expect(result.basicSalaryEarnedCentavos).toBe(pesos(11000) - pesos(1062.5));
  });

  it('overriding a per cut-off allowance replaces its amount', () => {
    const result = withEntries(P1, [override('m7', 'allowance:internet', 800)]);
    expect(amountOf(result, 'allowance:internet')).toBe(pesos(800));
    expect(result.totals.grossCentavos).toBe(pesos(13937.5));
    expect(result.manualEntries[0]?.computedAmountCentavos).toBe(pesos(500));
  });

  it('overriding an employee share lowers what is deducted and raises the tax', () => {
    const result = withEntries(P1, [override('m8', 'sssEmployee', 0)]);
    expect(lineOf(result, 'sssEmployee')).toMatchObject({
      amountCentavos: 0,
      override: { computedAmountCentavos: pesos(550) },
    });
    expect(result.contributions.sss.thisCutOff.employeeCentavos).toBe(0);
    expect(midMonthFiguresOf(result).sss.employeeCentavos).toBe(0);
    expect(result.totals.employeeContributionsCentavos).toBe(pesos(371.88));
    expect(result.taxableCompensationCentavos).toBe(pesos(11353.12));
    expect(result.taxCentavos).toBe(pesos(140.42));
    expect(result.totals.netPayCentavos).toBe(pesos(12062.7));
  });

  it('an employer share override changes nothing on the employee’s pay', () => {
    const before = run(P1);
    const result = withEntries(P1, [override('m9', 'sssEmployer', 0)]);
    expect(result.totals.netPayCentavos).toBe(before.totals.netPayCentavos);
    expect(result.totals.employerContributionsCentavos).toBe(
      before.totals.employerContributionsCentavos - (amountOf(before, 'sssEmployer') ?? 0),
    );
    expect(lineOf(result, 'sssEmployer').override?.computedAmountCentavos).toBe(
      amountOf(before, 'sssEmployer'),
    );
  });

  it('marks an override whose line is gone, and an earlier override of the same line, stale', () => {
    const result = withEntries(P1, [
      override('a', 'allowance:meal', 100),
      override('b', 'withholdingTax', 10),
      override('c', 'withholdingTax', 20),
    ]);
    expect(result.manualEntries.map((entry) => entry.staleReason)).toEqual([
      'targetMissing',
      'duplicateTarget',
      null,
    ]);
    expect(result.taxCentavos).toBe(pesos(20));
  });

  it('A7: net pay below zero is flagged, can’t be acknowledged, and a manual entry clears it', () => {
    const reversed: PayrollEarlierPeriodInput = {
      periodStart: SEP26.start,
      periodEnd: SEP26.end,
      now: [],
      paid: [
        {
          key: 'overtimeOrdinary',
          kind: 'overtimeOrdinary',
          side: 'earning',
          label: 'Overtime, ordinary day',
          quantity: '2400',
          unit: 'minutes',
          rateText: null,
          amountCentavos: pesos(12000),
          taxableCentavos: pesos(12000),
          deMinimisKey: null,
          typeKey: null,
        },
      ],
    };
    const negative: Case = { period: OCT11, salaries: [salary(21750)], earlierPeriods: [reversed] };
    const result = run(negative);
    expect(result.negativeNet).toBe(true);
    const flags = derivePayrollLineFlags({
      breakdown: result,
      onboarding: DONE,
      daysBelowMinimumWage: [],
    });
    expect(flags.map((flag) => flag.kind)).toEqual(['netPayBelowZero']);
    expect(unresolvedPayrollFlags(flags, ['netPayBelowZero'])).toEqual(flags);
    expect(
      payrollFlagAcknowledgementSchema.safeParse({ flag: 'netPayBelowZero', reason: 'Seen' })
        .success,
    ).toBe(false);

    const shortfall = -result.totals.netPayCentavos;
    const fixed = withEntries(negative, [
      { ...earning('m10', 'Deduction moved to next cut-off', 0, false), amountCentavos: shortfall },
    ]);
    expect(fixed.totals.netPayCentavos).toBe(0);
    expect(fixed.negativeNet).toBe(false);
    expect(
      derivePayrollLineFlags({ breakdown: fixed, onboarding: DONE, daysBelowMinimumWage: [] }),
    ).toEqual([]);
  });
});

describe('review flags (decisions 352–354)', () => {
  it('A6: a bank account entered but not verified flags onboarding incomplete', () => {
    const flags = derivePayrollLineFlags({
      breakdown: run(P2),
      onboarding: { states: { governmentIds: 'done', bankAccount: 'waitingForVerification' } },
      daysBelowMinimumWage: [],
    });
    expect(flags).toEqual([
      { kind: 'onboardingIncomplete', items: ['bankAccount:waitingForVerification'] },
    ]);
    expect(payrollFlagText(flags[0] as PayrollLineFlag)).toBe(
      'Onboarding incomplete: payroll bank account not verified',
    );
    expect(unresolvedPayrollFlags(flags, [])).toHaveLength(1);
    expect(payrollFlaggedRefusal(1)).toBe('Resolve or acknowledge 1 flagged employee first.');
    expect(payrollFlaggedRefusal(2)).toBe('Resolve or acknowledge 2 flagged employees first.');
    // Acknowledged: nothing left in the way.
    expect(unresolvedPayrollFlags(flags, ['onboardingIncomplete'])).toEqual([]);
    expect(
      payrollAcknowledgementAuditReason('onboardingIncomplete', 'XW-0002', 'Paid by check'),
    ).toBe('Acknowledged onboarding incomplete for XW-0002: Paid by check');
    expect(payrollFlagText({ kind: 'onboardingIncomplete', items: ['governmentIds:todo'] })).toBe(
      'Onboarding incomplete: government IDs not entered',
    );
  });

  it('flags a timesheet not approved (P3) or missing, and nothing for P1 with everything done', () => {
    const p3 = derivePayrollLineFlags({
      breakdown: run({ ...P1, status: 'pendingHr' }),
      onboarding: DONE,
      daysBelowMinimumWage: [],
    });
    expect(p3).toEqual([{ kind: 'timesheetNotApproved', items: [] }]);
    const none = derivePayrollLineFlags({
      breakdown: run({ ...P1, status: null }),
      onboarding: DONE,
      daysBelowMinimumWage: [],
    });
    expect(none.map((flag) => flag.kind)).toEqual(['timesheetNotApproved']);
    expect(
      derivePayrollLineFlags({ breakdown: run(P1), onboarding: DONE, daysBelowMinimumWage: [] }),
    ).toEqual([]);
  });

  it('flags a daily rate below the day’s minimum wage, not one equal to it', () => {
    const input = inputOf(P1);
    const minimumOf = (dailyCentavos: Centavos | null) => ({
      employee: input.employee,
      calendar: input.calendar,
      dailyRateFactor: input.payrollSettings.dailyRateFactor,
      minimumWageByDay: Object.fromEntries(input.calendar.map((day) => [day.date, dailyCentavos])),
    });
    // ₱21,750 a month × 12 ÷ 261 = ₱1,000.00 a day.
    expect(daysBelowMinimumWage(minimumOf(pesos(1000)))).toEqual([]);
    expect(daysBelowMinimumWage(minimumOf(null))).toEqual([]);
    const below = daysBelowMinimumWage(minimumOf(pesos(1000.01)));
    expect(below).toHaveLength(input.calendar.length);
    const flags = derivePayrollLineFlags({
      breakdown: run(P1),
      onboarding: DONE,
      daysBelowMinimumWage: below,
    });
    expect(flags.map((flag) => [flag.kind, payrollFlagText(flag)])).toEqual([
      ['belowMinimumWage', 'Below minimum wage'],
    ]);
  });

  it('flags a stale manual entry, which can’t be acknowledged', () => {
    const flags = derivePayrollLineFlags({
      breakdown: withEntries(P1, [override('s1', 'allowance:meal', 100)]),
      onboarding: DONE,
      daysBelowMinimumWage: [],
    });
    expect(flags).toEqual([{ kind: 'manualEntryStale', items: ['s1'] }]);
    expect(isAcknowledgeableFlag('manualEntryStale')).toBe(false);
    expect(unresolvedPayrollFlags(flags, ['manualEntryStale'])).toEqual(flags);
  });

  it('counts each flag kind once per line', () => {
    expect(
      countPayrollFlags([
        { flags: [{ kind: 'timesheetNotApproved', items: [] }] },
        {
          flags: [
            { kind: 'timesheetNotApproved', items: [] },
            { kind: 'netPayBelowZero', items: [] },
          ],
        },
        { flags: [] },
      ]),
    ).toEqual({
      onboardingIncomplete: 0,
      timesheetNotApproved: 2,
      belowMinimumWage: 0,
      netPayBelowZero: 1,
      manualEntryStale: 0,
    });
  });

  it('takes an acknowledgement’s reason of 1–300 characters', () => {
    expect(
      payrollFlagAcknowledgementSchema.parse({
        flag: 'belowMinimumWage',
        reason: '  Raise in Nov ',
      }),
    ).toEqual({ flag: 'belowMinimumWage', reason: 'Raise in Nov' });
    expect(
      payrollFlagAcknowledgementSchema.safeParse({ flag: 'belowMinimumWage', reason: ' ' }).success,
    ).toBe(false);
    expect(
      payrollFlagAcknowledgementSchema.safeParse({
        flag: 'belowMinimumWage',
        reason: 'x'.repeat(301),
      }).success,
    ).toBe(false);
  });
});

describe('manual entry chains and the form (decision 358)', () => {
  const t = (minute: number) => new Date(`2026-10-19T08:${String(minute).padStart(2, '0')}:00Z`);
  it('keeps the latest of each chain that isn’t removed, oldest first', () => {
    const entries = [
      { id: 'a1', supersedesId: null, removed: false, createdAt: t(1) },
      { id: 'b1', supersedesId: null, removed: false, createdAt: t(2) },
      { id: 'a2', supersedesId: 'a1', removed: false, createdAt: t(3) },
      { id: 'c1', supersedesId: null, removed: false, createdAt: t(4) },
      { id: 'c2', supersedesId: 'c1', removed: true, createdAt: t(5) },
    ];
    expect(livePayrollManualEntries(entries).map((entry) => entry.id)).toEqual(['b1', 'a2']);
    expect(payrollManualEntryHistory(entries, 'a2').map((entry) => entry.id)).toEqual(['a2', 'a1']);
  });

  it('parses an earning and an override typed in pesos', () => {
    expect(
      payrollManualEntryFormSchema.parse({
        kind: 'earning',
        label: ' Back pay ',
        amount: '1,000.00',
        taxable: true,
        countsAsBasicSalary: true,
        reason: 'Salary increase from Sep 15',
      }),
    ).toMatchObject({ kind: 'earning', label: 'Back pay', amountCentavos: 100000, taxable: true });
    expect(
      payrollManualEntryFormSchema.parse({
        kind: 'override',
        targetLineKey: 'withholdingTax',
        amount: '0',
        reason: 'Exempt this cut-off',
      }),
    ).toMatchObject({ kind: 'override', targetLineKey: 'withholdingTax', amountCentavos: 0 });
    const zero = payrollManualEntryFormSchema.safeParse({
      kind: 'earning',
      label: 'Back pay',
      amount: '0',
      taxable: true,
      countsAsBasicSalary: false,
      reason: 'x',
    });
    expect(zero.error?.issues[0]?.path).toEqual(['amount']);
    expect(
      payrollManualEntrySchema.safeParse({
        kind: 'earning',
        label: 'x'.repeat(81),
        amountCentavos: 100,
        taxable: true,
        countsAsBasicSalary: false,
        reason: 'r',
      }).success,
    ).toBe(false);
  });
});

describe('breakdown version 2 (decision 372)', () => {
  it('writes version 2 with manual and overridden lines and reads it back', () => {
    const result = withEntries(P1, [BACK_PAY, override('m4', 'withholdingTax', 0)]);
    expect(result.breakdownVersion).toBe(2);
    expect(parsePayrollBreakdown(serializePayrollBreakdown(result))).toEqual(result);
  });

  it('still reads a version 1 breakdown, with no manual or overridden line', () => {
    const v2 = run(P1);
    const { manualEntries: _entries, ...rest } = v2;
    void _entries;
    const v1 = {
      ...rest,
      breakdownVersion: 1,
      lines: v2.lines.map((line) => {
        const { manual: _manual, override: _override, ...v1Line } = line;
        void _manual;
        void _override;
        return v1Line;
      }),
    };
    const parsed = parsePayrollBreakdown(JSON.stringify(v1));
    expect(parsed).toEqual({ ...v2, breakdownVersion: 1 });
    expect(parsed.manualEntries).toEqual([]);
    expect(parsed.lines.every((line) => line.manual === null && line.override === null)).toBe(true);
    // Read back and written again, it is version 2.
    expect(JSON.parse(serializePayrollBreakdown(parsed)).breakdownVersion).toBe(2);
    // A version 2 without its entries and line fields is refused.
    expect(() => parsePayrollBreakdown(JSON.stringify({ ...v1, breakdownVersion: 2 }))).toThrow(
      'does not match version 1 or 2',
    );
  });
});

describe('year-to-date and the payslip (decisions 363–366)', () => {
  const ytdOf = (breakdown: PayrollBreakdown, opening: PayrollYtdOpeningInput[] = []) =>
    payrollYearToDate({
      payDate: breakdown.cutOff.payDate,
      periodStart: breakdown.cutOff.periodStart,
      openingEntries: opening,
      lines: [
        {
          payDate: breakdown.cutOff.payDate,
          periodStart: breakdown.cutOff.periodStart,
          figures: payrollYtdFiguresOf(breakdown),
        },
      ],
    });

  it('A1: P1’s payslip', () => {
    const breakdown = run(P1);
    const ytd = ytdOf(breakdown);
    expect(ytd).toEqual({
      grossCentavos: pesos(13637.5),
      taxWithheldCentavos: pesos(57.92),
      sssEmployeeCentavos: pesos(550),
      philhealthEmployeeCentavos: pesos(271.88),
      pagibigEmployeeCentavos: pesos(100),
      contributionsCentavos: pesos(921.88),
    });
    const view = buildPayslipView({
      runNumber: 'PAY-2026-0001',
      breakdown,
      snapshot: P1_SNAPSHOT,
      yearToDate: ytd,
    });
    expect(view).toMatchObject({
      title: 'Payslip PAY-2026-0001',
      periodText: 'Sep 26 – Oct 10, 2026',
      payDate: '2026-10-15',
      payDateText: 'Oct 15, 2026',
      grossCentavos: pesos(13637.5),
      deductionsCentavos: pesos(2042.3),
      netPayCentavos: pesos(11595.2),
      creditedText: 'Credited to UnionBank ending 4321',
      employee: { name: 'Juan Dela Cruz', number: 'XW-0001' },
    });
    expect(view.earnings.map((line) => line.label)).toEqual(
      breakdown.lines.filter((line) => line.group === 'earnings').map((line) => line.label),
    );
    expect(view.deductions.map((line) => line.label)).toEqual([
      'Absences',
      'Late',
      'SSS',
      'PhilHealth',
      'Pag-IBIG',
      'Withholding tax',
    ]);
    // No employer share and no rate anywhere on it.
    const text = JSON.stringify(view);
    expect(text).not.toContain('employer');
    expect(text).not.toContain('EC,');
    expect(text).not.toContain('rateText');
    expect(text).not.toContain('a month');
  });

  it('A2 and A4 on the payslip: "Adjustment: <label>" and "Adjusted"', () => {
    const breakdown = withEntries(P1, [BACK_PAY, override('m4', 'withholdingTax', 0)]);
    const view = buildPayslipView({
      runNumber: 'PAY-2026-0001',
      breakdown,
      snapshot: { ...P1_SNAPSHOT, bank: null },
      yearToDate: ytdOf(breakdown),
    });
    expect(view.earnings.at(-1)).toEqual({
      label: 'Adjustment: Back pay: salary increase from Sep 15',
      amountCentavos: pesos(1000),
      manual: true,
      adjusted: false,
    });
    expect(view.deductions.find((line) => line.label === 'Withholding tax')).toEqual({
      label: 'Withholding tax',
      amountCentavos: 0,
      manual: false,
      adjusted: true,
    });
    expect(view.adjustedLabel).toBe('Adjusted');
    expect(view.creditedText).toBe('Paid by other means');
    expect(view.netPayCentavos).toBe(pesos(12445.2) + pesos(207.92));
  });

  it('A5: year-to-date with P1’s opening entry for 2026', () => {
    const opening: PayrollYtdOpeningInput = {
      year: 2026,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      figures: {
        grossCentavos: pesos(200000),
        taxWithheldCentavos: pesos(9000),
        sssEmployeeCentavos: pesos(5250),
        philhealthEmployeeCentavos: pesos(2500),
        pagibigEmployeeCentavos: pesos(900),
      },
    };
    const older: PayrollYtdOpeningInput = {
      ...opening,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      figures: { ...opening.figures, grossCentavos: 1 },
    };
    const lastYear: PayrollYtdOpeningInput = {
      ...opening,
      year: 2025,
      createdAt: new Date('2026-10-02T00:00:00Z'),
      figures: { ...opening.figures, grossCentavos: 2 },
    };
    const ytd = ytdOf(run(P1), [older, opening, lastYear]);
    expect(ytd.grossCentavos).toBe(pesos(213637.5));
    expect(ytd.taxWithheldCentavos).toBe(pesos(9057.92));
    expect(ytd.contributionsCentavos).toBe(pesos(9571.88));
  });

  it('counts only lines paid in the pay date’s year, up to this run', () => {
    const figures = payrollYtdFiguresOf(run(P1));
    const ytd = payrollYearToDate({
      payDate: '2026-10-15',
      periodStart: '2026-09-26',
      openingEntries: [],
      lines: [
        { payDate: '2025-12-15', periodStart: '2025-11-26', figures },
        { payDate: '2026-09-30', periodStart: '2026-09-11', figures },
        { payDate: '2026-10-15', periodStart: '2026-09-26', figures },
        { payDate: '2026-10-30', periodStart: '2026-10-11', figures },
      ],
    });
    expect(ytd.grossCentavos).toBe(2 * pesos(13637.5));
    expect(parsePayrollYearToDate(serializePayrollYearToDate(ytd))).toEqual(ytd);
    expect(() => parsePayrollYearToDate('{"ytdVersion":2}')).toThrow('do not match version 1');
  });

  it('settlements print as adjustments from earlier cut-offs, signed by their effect', () => {
    const p3 = run({ ...P1, status: 'pendingHr' });
    const now = computePeriodPay({
      ...inputOf(P1),
      periodStart: SEP26.start,
      periodEnd: SEP26.end,
    });
    const breakdown = run({
      period: OCT11,
      salaries: P1.salaries,
      entries: presentEveryDay(OCT11),
      midMonth: midMonthFiguresOf(p3),
      earlierPeriods: [
        {
          periodStart: SEP26.start,
          periodEnd: SEP26.end,
          now: now.attendanceItems,
          paid: attendanceItemsPaidFor(p3, SEP26.start),
        },
      ],
    });
    const view = buildPayslipView({
      runNumber: 'PAY-2026-0002',
      breakdown,
      snapshot: P1_SNAPSHOT,
      yearToDate: ytdOf(breakdown),
    });
    expect(view.adjustmentsLabel).toBe('Adjustments from earlier cut-offs');
    expect(
      view.adjustments.find((line) => line.label === 'Absences · Sep 26 – Oct 10')?.amountCentavos,
    ).toBe(pesos(-1000));
    expect(view.adjustments.find((line) => line.label.startsWith('Overtime'))?.amountCentavos).toBe(
      pesos(1250),
    );
  });

  it('words the approval, the summary and the notification without an amount', () => {
    expect(payrollApprovalTitle(SEP26.start, SEP26.end)).toBe('Payroll · Sep 26 – Oct 10, 2026');
    expect(
      payrollSubmitSummary({
        employeeCount: 2,
        manualEntryCount: 1,
        acknowledgedFlagCount: 1,
        payDate: SEP26.payDate,
      }),
    ).toBe('2 employees · 1 manual entry · 1 flag acknowledged · pay date Oct 15, 2026');
    expect(payslipReadyText(SEP26.start, SEP26.end)).toBe(
      'Your payslip for Sep 26 – Oct 10 is ready',
    );
    expect(payrollFinalizeFirstMessage(SEP26.start, SEP26.end, 'PAY-2026-0001')).toBe(
      'Finalize Sep 26 – Oct 10, 2026 (PAY-2026-0001) first.',
    );
    expect(payslipFileName('XW-0001', '2026-10-15')).toBe('Payslip XW-0001 2026-10-15.pdf');
    expect(accountNumberLastFour('1234-5678-9012')).toBe('9012');
    expect(isEditablePayrollRunStatus('returned')).toBe(true);
    expect(isEditablePayrollRunStatus('pendingApproval')).toBe(false);
  });
});
