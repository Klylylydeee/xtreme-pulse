import { type BusinessDate, type Centavos, ratio } from '@pulse/core';
import {
  deMinimisLimitCentavos,
  pagibigShares,
  philhealthShares,
  semiMonthlyWithholding,
  splitContribution,
  sssRowFor,
} from '../payroll/lookups';
import type { ContributionAgency } from '../payroll/schemas';
import { addRatio, decimalText, roundCentavos } from './exact';
import {
  ATTENDANCE_DEDUCTION_KINDS,
  PAYROLL_LINE_KIND_LABELS,
  PAYROLL_LINE_KIND_SIDES,
  type PayrollLineKind,
  settlementLabel,
} from './kinds';
import { computePeriodPay, isEmployedOn, salaryOn, workingBaseDays } from './period';
import type {
  AgencyContribution,
  PayrollAttendanceItem,
  PayrollBreakdown,
  PayrollContributionBasis,
  PayrollContributions,
  PayrollDeMinimis,
  PayrollLine,
  PayrollLineInput,
  PayrollMidMonthFigures,
  PayrollPeriodItems,
  PayrollSalaryEntry,
  PayrollTotals,
} from './types';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Government
// contributions", "Withholding tax", "Settling earlier cut-offs", "The employee line"; decisions
// 334, 336, 337, 339 and 340 in docs/BUILD_PLAN.md; HANDOFF items 225–231, 242, 245 and 254) — a
// run's employee line: the cut-off's own pay, the settlements of earlier cut-offs, the de minimis
// limits, the contributions with the employer shares, the withholding tax, the totals and basic
// salary earned. Every rule here is an *Assumption, to be confirmed by the accountant*.

// ---------------------------------------------------------------------------------------------
// Attendance items: sums and differences

function sameQuantity(a: PayrollAttendanceItem, b: PayrollAttendanceItem): boolean {
  return a.unit === b.unit && a.quantity !== null && b.quantity !== null;
}

function addQuantity(a: string, b: string): string {
  return decimalText(addRatio(ratio(a), ratio(b)));
}

/**
 * Attendance items summed by key: what finalized runs paid for one period, from each finalized
 * line's items for it. The first item's label and words are kept.
 */
export function sumAttendanceItems(
  lists: readonly (readonly PayrollAttendanceItem[])[],
): PayrollAttendanceItem[] {
  const sums = new Map<string, PayrollAttendanceItem>();
  for (const list of lists) {
    for (const item of list) {
      const found = sums.get(item.key);
      if (!found) {
        sums.set(item.key, { ...item });
        continue;
      }
      found.amountCentavos += item.amountCentavos;
      found.taxableCentavos += item.taxableCentavos;
      found.quantity =
        sameQuantity(found, item) && found.quantity !== null && item.quantity !== null
          ? addQuantity(found.quantity, item.quantity)
          : null;
    }
  }
  return [...sums.values()];
}

/**
 * The difference of a period's attendance items now less what finalized runs paid, item by item
 * (decision 339). A difference of 0 is left out.
 */
export function diffAttendanceItems(
  now: readonly PayrollAttendanceItem[],
  paid: readonly PayrollAttendanceItem[],
): PayrollAttendanceItem[] {
  const paidByKey = new Map(sumAttendanceItems([paid]).map((item) => [item.key, item]));
  const result: PayrollAttendanceItem[] = [];
  const seen = new Set<string>();
  for (const item of sumAttendanceItems([now])) {
    seen.add(item.key);
    const before = paidByKey.get(item.key);
    const amount = item.amountCentavos - (before?.amountCentavos ?? 0);
    if (amount === 0) continue;
    result.push({
      ...item,
      amountCentavos: amount,
      taxableCentavos: item.taxableCentavos - (before?.taxableCentavos ?? 0),
      quantity: before ? null : item.quantity,
      rateText: before ? null : item.rateText,
    });
  }
  for (const item of paidByKey.values()) {
    if (seen.has(item.key) || item.amountCentavos === 0) continue;
    result.push({
      ...item,
      amountCentavos: -item.amountCentavos,
      taxableCentavos: -item.taxableCentavos,
      quantity: null,
      rateText: null,
    });
  }
  return result;
}

/** How a line changes net pay: an earning as it is, a deduction negated ("absences −₱1,000.00"). */
export function payEffectCentavos(line: Pick<PayrollLine, 'side' | 'amountCentavos'>): Centavos {
  if (line.side === 'earning') return line.amountCentavos;
  if (line.side === 'deduction') return -line.amountCentavos || 0;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Contributions (decision 336)

interface MonthShares {
  employeeCentavos: Centavos;
  employerCentavos: Centavos;
  ecCentavos: Centavos;
}

const subtractShares = (a: MonthShares, b: MonthShares): MonthShares => ({
  employeeCentavos: a.employeeCentavos - b.employeeCentavos,
  employerCentavos: a.employerCentavos - b.employerCentavos,
  ecCentavos: a.ecCentavos - b.ecCentavos,
});

/**
 * The monthly basic salary basis: the monthly salary in effect on the first day of the
 * contribution month (on the date hired, if later); a daily rate counts as daily × the factor ÷
 * 12, rounded half-up. With no salary on that day, the first salary on an employed day of the
 * cut-off.
 */
export function monthlyBasicSalaryCentavos(
  salaries: readonly PayrollSalaryEntry[],
  contributionMonth: string,
  dateHired: BusinessDate,
  dailyRateFactor: number,
  fallbackDays: readonly BusinessDate[] = [],
): Centavos {
  const firstDay = `${contributionMonth}-01`;
  const reference = dateHired > firstDay ? dateHired : firstDay;
  let salary = salaryOn(salaries, reference);
  for (const day of fallbackDays) {
    if (salary) break;
    salary = salaryOn(salaries, day);
  }
  if (!salary) return 0;
  if (salary.rateType === 'monthly') return salary.amountCentavos;
  return roundCentavos(ratio(BigInt(salary.amountCentavos) * BigInt(dailyRateFactor), 12n));
}

function sharesOn(
  agency: ContributionAgency,
  basisCentavos: Centavos,
  input: Pick<PayrollLineInput, 'sss' | 'philhealth' | 'pagibig'>,
) {
  const basis = Math.max(0, basisCentavos);
  if (agency === 'sss') {
    const row = sssRowFor(basis, input.sss);
    return {
      shares: {
        employeeCentavos: row.employee.totalCentavos,
        employerCentavos: row.employer.totalCentavos,
        ecCentavos: row.ecCentavos,
      },
      basisCentavos: basis,
      row,
    };
  }
  const shares =
    agency === 'philhealth'
      ? philhealthShares(basis, input.philhealth)
      : pagibigShares(basis, input.pagibig);
  return {
    shares: {
      employeeCentavos: shares.employeeCentavos,
      employerCentavos: shares.employerCentavos,
      ecCentavos: 0,
    },
    basisCentavos: shares.basisCentavos,
    row: null,
  };
}

/**
 * The cut-off's contributions (decision 336; *Assumption*, HANDOFF items 225–227): the mid-month
 * cut-off deducts its split share of the month on the monthly basic salary (an estimate); the
 * end-of-month cut-off computes the month on the real bases and deducts it less what the
 * mid-month run deducted (possibly negative); with no mid-month run it deducts its own split
 * share of the estimate. The employer shares and EC follow the same way.
 */
export function computeContributions(input: {
  cutOffKey: PayrollLineInput['cutOff']['key'];
  contributionMonth: string;
  monthlyBasicSalaryCentavos: Centavos;
  compensationForContributionsCentavos: Centavos;
  midMonth: PayrollMidMonthFigures | null;
  bases: PayrollLineInput['policy']['contributionBases'];
  split: PayrollLineInput['payrollSettings'];
  sss: PayrollLineInput['sss'];
  philhealth: PayrollLineInput['philhealth'];
  pagibig: PayrollLineInput['pagibig'];
}): PayrollContributions {
  const method: PayrollContributions['method'] =
    input.cutOffKey === 'midMonth' ? 'estimate' : input.midMonth ? 'remainder' : 'estimateOnly';
  const monthCompensation =
    method === 'remainder' && input.midMonth
      ? input.midMonth.compensationForContributionsCentavos +
        input.compensationForContributionsCentavos
      : null;

  const agency = (key: ContributionAgency) => {
    const basis: PayrollContributionBasis =
      method === 'remainder' ? input.bases[key] : 'monthlyBasicSalary';
    const amount =
      basis === 'monthCompensation' && monthCompensation !== null
        ? monthCompensation
        : input.monthlyBasicSalaryCentavos;
    const month = sharesOn(key, amount, input);
    let midMonthDeducted: MonthShares | null = null;
    let thisCutOff: MonthShares;
    if (method === 'remainder' && input.midMonth) {
      const mid = input.midMonth[key];
      midMonthDeducted = {
        employeeCentavos: mid.employeeCentavos,
        employerCentavos: mid.employerCentavos,
        ecCentavos: 'ecCentavos' in mid ? mid.ecCentavos : 0,
      };
      thisCutOff = subtractShares(month.shares, midMonthDeducted);
    } else {
      const part = method === 'estimate' ? 'midMonth' : 'endOfMonth';
      thisCutOff = {
        employeeCentavos: splitContribution(month.shares.employeeCentavos, key, input.split)[part],
        employerCentavos: splitContribution(month.shares.employerCentavos, key, input.split)[part],
        ecCentavos: splitContribution(month.shares.ecCentavos, key, input.split)[part],
      };
    }
    const result: AgencyContribution = {
      basis,
      basisCentavos: month.basisCentavos,
      month: month.shares,
      midMonthDeducted,
      thisCutOff,
    };
    return { result, row: month.row };
  };

  const sss = agency('sss');
  const row = sss.row;
  return {
    method,
    contributionMonth: input.contributionMonth,
    monthlyBasicSalaryCentavos: input.monthlyBasicSalaryCentavos,
    monthCompensationCentavos: monthCompensation,
    sss: {
      ...sss.result,
      mscCentavos: row?.mscCentavos ?? 0,
      employeeRegularCentavos: row?.employee.regularCentavos ?? 0,
      employeeMpfCentavos: row?.employee.mpfCentavos ?? 0,
    },
    philhealth: agency('philhealth').result,
    pagibig: agency('pagibig').result,
  };
}

/** What a mid-month line deducted, for the same month's end-of-month line (decision 336). */
export function midMonthFiguresOf(
  breakdown: Pick<PayrollBreakdown, 'compensationForContributionsCentavos' | 'contributions'>,
): PayrollMidMonthFigures {
  const { sss, philhealth, pagibig } = breakdown.contributions;
  return {
    compensationForContributionsCentavos: breakdown.compensationForContributionsCentavos,
    sss: { ...sss.thisCutOff },
    philhealth: {
      employeeCentavos: philhealth.thisCutOff.employeeCentavos,
      employerCentavos: philhealth.thisCutOff.employerCentavos,
    },
    pagibig: {
      employeeCentavos: pagibig.thisCutOff.employeeCentavos,
      employerCentavos: pagibig.thisCutOff.employerCentavos,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The line

const COMPENSATION_DEDUCTIONS = new Set<PayrollLineKind>(ATTENDANCE_DEDUCTION_KINDS);

function contributionLine(
  kind: PayrollLineKind,
  amount: Centavos,
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  rateText: string | null = null,
): PayrollLine {
  const side = PAYROLL_LINE_KIND_SIDES[kind];
  return {
    key: kind,
    kind,
    group: side === 'employer' ? 'employerShares' : 'deductions',
    side,
    label: PAYROLL_LINE_KIND_LABELS[kind],
    periodStart,
    periodEnd,
    quantity: null,
    unit: null,
    rateText,
    amountCentavos: amount,
    taxable: false,
    taxableCentavos: 0,
    deMinimisKey: null,
    typeKey: null,
  };
}

/** The de minimis limits (decision 334): each key's lines non-taxable up to its limit. */
function applyDeMinimis(
  lines: PayrollLine[],
  input: PayrollLineInput,
  presentDays: number,
): PayrollDeMinimis[] {
  const keys = [
    ...new Set(lines.flatMap((line) => (line.deMinimisKey ? [line.deMinimisKey] : []))),
  ];
  const result: PayrollDeMinimis[] = [];
  for (const key of keys) {
    const own = lines.filter((line) => line.deMinimisKey === key);
    const item = input.deMinimisLimits.items.find((candidate) => candidate.key === key);
    const amount = own.reduce((sum, line) => sum + line.amountCentavos, 0);
    // A limit missing from the version on the pay date: nothing is non-taxable (*Assumption*).
    const unit = item ? deMinimisLimitCentavos(item, input.minimumWageDailyCentavos ?? 0) : 0;
    const daily = item?.period === 'day';
    const limit = daily ? unit * presentDays : unit;
    const alreadyPaid = daily ? 0 : (input.deMinimisPaidCentavos[key] ?? 0);
    const room = Math.max(0, limit - alreadyPaid);
    const excess = Math.max(0, amount - room);
    // The excess is taxed on the latest lines first.
    let remaining = excess;
    for (let index = own.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const line = own[index] as PayrollLine;
      const take = Math.min(remaining, Math.max(0, line.amountCentavos));
      line.taxableCentavos = take;
      remaining -= take;
    }
    result.push({
      key,
      label: item?.label ?? key,
      period: item?.period ?? 'month',
      limitCentavos: limit,
      alreadyPaidCentavos: alreadyPaid,
      amountCentavos: amount,
      nonTaxableCentavos: amount - excess,
      excessCentavos: excess,
    });
  }
  return result;
}

/**
 * A run's employee line (decisions 328–340): the cut-off's own pay (`computePeriodPay`), the
 * differences settled for earlier cut-offs, the de minimis limits, the contributions with the
 * employer shares, the withholding tax, the totals and basic salary earned. Net pay below zero is
 * kept as computed and marked.
 */
export function computePayrollLine(input: PayrollLineInput): PayrollBreakdown {
  const { cutOff } = input;
  const contributionMonth = cutOff.payDate.slice(0, 7);
  const own = computePeriodPay({ ...input, periodStart: cutOff.start, periodEnd: cutOff.end });

  // Settlements of earlier cut-offs, item by item against finalized runs (decision 339).
  const settled: PayrollPeriodItems[] = [];
  const settlementLines: PayrollLine[] = [];
  for (const period of [...input.earlierPeriods].sort((a, b) =>
    a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0,
  )) {
    const items = diffAttendanceItems(period.now, period.paid);
    if (items.length === 0) continue;
    settled.push({ periodStart: period.periodStart, periodEnd: period.periodEnd, items });
    for (const item of items) {
      settlementLines.push({
        ...item,
        group: 'settlements',
        label: settlementLabel(item.label, period.periodStart, period.periodEnd),
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        taxable: false,
      });
    }
  }

  const payLines = [...own.lines, ...settlementLines];
  const presentDays = own.facts.timesheetApproved
    ? own.facts.presentDays
    : workingBaseDays({ calendar: input.calendar, employee: input.employee });
  const deMinimis = applyDeMinimis(payLines, input, presentDays);

  // Compensation for contributions: pay, taxable allowances and de minimis excess, less
  // attendance and holiday deductions, settlements included (decision 336).
  let compensation = 0;
  for (const line of payLines) {
    if (line.side === 'earning') compensation += line.taxableCentavos;
    else if (line.side === 'deduction' && COMPENSATION_DEDUCTIONS.has(line.kind)) {
      compensation -= line.taxableCentavos;
    }
  }

  const employedDays = input.calendar
    .filter((day) => isEmployedOn(input.employee, day.date))
    .map((day) => day.date)
    .sort();
  const contributions = computeContributions({
    cutOffKey: cutOff.key,
    contributionMonth,
    monthlyBasicSalaryCentavos: monthlyBasicSalaryCentavos(
      input.employee.salaries,
      contributionMonth,
      input.employee.dateHired,
      input.payrollSettings.dailyRateFactor,
      employedDays,
    ),
    compensationForContributionsCentavos: compensation,
    midMonth: cutOff.key === 'endOfMonth' ? input.midMonth : null,
    bases: input.policy.contributionBases,
    split: input.payrollSettings,
    sss: input.sss,
    philhealth: input.philhealth,
    pagibig: input.pagibig,
  });
  const employeeShares =
    contributions.sss.thisCutOff.employeeCentavos +
    contributions.philhealth.thisCutOff.employeeCentavos +
    contributions.pagibig.thisCutOff.employeeCentavos;

  // Withholding (decision 337): the semi-monthly table, no annualization. A minimum wage earner
  // (the flag on the salary in effect on the pay date) is taxed only on taxable allowances and de
  // minimis excess, with no contribution subtracted.
  const mwe = salaryOn(input.employee.salaries, cutOff.payDate)?.minimumWageEarner ?? false;
  const taxable = mwe
    ? Math.max(
        0,
        payLines
          .filter((line) => line.kind === 'allowance')
          .reduce((sum, line) => sum + line.taxableCentavos, 0),
      )
    : Math.max(0, compensation - employeeShares);
  const tax = semiMonthlyWithholding(taxable, input.withholding);

  for (const line of payLines) {
    line.taxable = line.taxableCentavos !== 0 && (!mwe || line.kind === 'allowance');
  }

  const { start, end } = cutOff;
  const contributionLines = [
    contributionLine('sssEmployee', contributions.sss.thisCutOff.employeeCentavos, start, end),
    contributionLine(
      'philhealthEmployee',
      contributions.philhealth.thisCutOff.employeeCentavos,
      start,
      end,
    ),
    contributionLine(
      'pagibigEmployee',
      contributions.pagibig.thisCutOff.employeeCentavos,
      start,
      end,
    ),
    contributionLine('withholdingTax', tax, start, end),
  ].filter((line) => line.amountCentavos !== 0);
  const employerLines = [
    contributionLine('sssEmployer', contributions.sss.thisCutOff.employerCentavos, start, end),
    contributionLine('sssEc', contributions.sss.thisCutOff.ecCentavos, start, end),
    contributionLine(
      'philhealthEmployer',
      contributions.philhealth.thisCutOff.employerCentavos,
      start,
      end,
    ),
    contributionLine(
      'pagibigEmployer',
      contributions.pagibig.thisCutOff.employerCentavos,
      start,
      end,
    ),
  ].filter((line) => line.amountCentavos !== 0);

  const earnings = own.lines.filter((line) => line.side === 'earning');
  const deductions = [
    ...own.lines.filter((line) => line.side === 'deduction'),
    ...contributionLines,
  ];
  const lines = [...earnings, ...deductions, ...settlementLines, ...employerLines];

  const sumOf = (filter: (line: PayrollLine) => boolean) =>
    lines.filter(filter).reduce((sum, line) => sum + line.amountCentavos, 0);
  const gross = sumOf((line) => line.side === 'earning');
  const totalDeductions = sumOf((line) => line.side === 'deduction');
  const totals: PayrollTotals = {
    grossCentavos: gross,
    deductionsCentavos: totalDeductions,
    netPayCentavos: gross - totalDeductions,
    reimbursementsCentavos: sumOf((line) => line.kind === 'reimbursement'),
    taxWithheldCentavos: tax,
    employeeContributionsCentavos: employeeShares,
    employerContributionsCentavos:
      contributions.sss.thisCutOff.employerCentavos +
      contributions.sss.thisCutOff.ecCentavos +
      contributions.philhealth.thisCutOff.employerCentavos +
      contributions.pagibig.thisCutOff.employerCentavos,
  };

  // Basic salary earned (decision 340): basic pay less attendance and holiday deductions.
  const basicSalaryEarned =
    sumOf((line) => line.kind === 'basicPay') -
    sumOf((line) => COMPENSATION_DEDUCTIONS.has(line.kind));

  return {
    breakdownVersion: 1,
    cutOff: {
      key: cutOff.key,
      periodStart: cutOff.start,
      periodEnd: cutOff.end,
      payDate: cutOff.payDate,
      contributionMonth,
    },
    facts: { ...own.facts, minimumWageEarner: mwe },
    lines,
    attendanceItems: [
      { periodStart: own.periodStart, periodEnd: own.periodEnd, items: own.attendanceItems },
      ...settled,
    ],
    settledPeriods: settled.map((period) => period.periodStart),
    compensationForContributionsCentavos: compensation,
    contributions,
    taxableCompensationCentavos: taxable,
    taxCentavos: tax,
    deMinimis,
    basicSalaryEarnedCentavos: basicSalaryEarned,
    totals,
    negativeNet: totals.netPayCentavos < 0,
  };
}

/** The items a line paid for one period (its own, or a settlement's differences). */
export function attendanceItemsPaidFor(
  breakdown: Pick<PayrollBreakdown, 'attendanceItems'>,
  periodStart: BusinessDate,
): PayrollAttendanceItem[] {
  return breakdown.attendanceItems
    .filter((period) => period.periodStart === periodStart)
    .flatMap((period) => period.items);
}
