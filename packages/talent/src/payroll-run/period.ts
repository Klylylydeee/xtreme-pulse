import { type BusinessDate, formatPeso, multiplyRatios, type Ratio, ratio } from '@pulse/core';
import { compareCompensationEntries } from '../compensation';
import type { DtrDayStatus } from '../dtr/statuses';
import { resolveAllowances } from '../payroll/allowances';
import { dailyRateRatio } from '../payroll/lookups';
import type { AllowanceTaxTreatment, PremiumRates } from '../payroll/schemas';
import { versionOn } from '../timesheets/schedule';
import { formatShortDay } from '../timesheets/submission';
import { addRatio, decimalText, multiplierText, ONE, roundCentavos, subtractRatio } from './exact';
import {
  PAYROLL_LINE_KIND_LABELS,
  PAYROLL_LINE_KIND_SIDES,
  PAYROLL_LINE_KINDS,
  type PayrollLineKind,
  type PayrollQuantityUnit,
} from './kinds';
import type {
  PayrollAttendanceItem,
  PayrollCalendarDay,
  PayrollDtrDay,
  PayrollFacts,
  PayrollLine,
  PayrollPeriodInput,
  PayrollSalaryEntry,
  PeriodPay,
} from './types';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Rates", "Basic pay",
// "Holidays", "Overtime and premiums", "Night differential", "Attendance deductions",
// "Allowances", "Reimbursements", "A timesheet not fully approved"; decisions 328–335 and 338 in
// docs/BUILD_PLAN.md; HANDOFF items 232–240) — one cut-off's own pay, before contributions, tax
// and settlements. Every rule here is an *Assumption, to be confirmed by the accountant*.
//
// - The salary of a day is the compensation entry in effect that day; the daily rate is
//   `dailyRateRatio` with the factor of the `payrollSettings` version in effect on the cut-off's
//   start; a minute is the daily rate ÷ `hoursPerDay` ÷ 60.
// - Base days are the scheduled work days (holidays included); employed base days leave out the
//   days before the date hired and after the separation date.
// - Each line is an exact sum of ratios, rounded half-up to the centavo once.
// - An unapproved timesheet (or none) gives the provisional set: basic pay, per cut-off
//   allowances and holiday pay with the workday-before rule counted as met.

const HOLIDAY_KINDS = new Set(['regularHoliday', 'specialDay']);
/** The DTR statuses that meet the workday-before rule: present, paid leave, paid offset. */
const MEETS_RULE = new Set<DtrDayStatus>(['present', 'onLeavePaid', 'offsetPaid']);
const KIND_ORDER = new Map(PAYROLL_LINE_KINDS.map((kind, index) => [kind, index]));

/** The attendance items: what waits for an approved timesheet, plus holiday pay (decision 339). */
const ATTENDANCE_ITEM_KINDS = new Set<PayrollLineKind>([
  'holidayPay',
  'overtimeOrdinary',
  'restDayWork',
  'holidayWork',
  'restDayHolidayOvertime',
  'nightDifferential',
  'reimbursement',
  'absence',
  'leaveWithoutPay',
  'late',
  'undertime',
  'partialAbsence',
  'holidayNotPaid',
]);

// ---------------------------------------------------------------------------------------------
// Days, salaries and rates

/** The salary in effect on `day`: the latest entry on or before it (on a tie, the newest). */
export function salaryOn(
  salaries: readonly PayrollSalaryEntry[],
  day: BusinessDate,
): PayrollSalaryEntry | null {
  let found: PayrollSalaryEntry | null = null;
  for (const entry of salaries) {
    if (entry.effectiveDate > day) continue;
    if (!found || compareCompensationEntries(entry, found) < 0) found = entry;
  }
  return found;
}

/** True when the employee is employed on `day`: on or after the date hired, to the separation. */
export function isEmployedOn(
  employee: { dateHired: BusinessDate; separationDate: BusinessDate | null },
  day: BusinessDate,
): boolean {
  return day >= employee.dateHired && (!employee.separationDate || day <= employee.separationDate);
}

function isHoliday(day: Pick<PayrollCalendarDay, 'kind'>): boolean {
  return HOLIDAY_KINDS.has(day.kind);
}

/** The exact daily rate (centavos) of a salary. */
function dailyOf(salary: PayrollSalaryEntry, factor: number): Ratio {
  return dailyRateRatio(salary.amountCentavos, salary.rateType, factor);
}

const peso = (value: Ratio) => formatPeso(roundCentavos(value));

// ---------------------------------------------------------------------------------------------
// Line accumulation

interface LineSpec {
  key: string;
  kind: PayrollLineKind;
  label: string;
  unit: PayrollQuantityUnit | null;
  /** Counted as compensation in principle (before a de minimis limit or an exemption). */
  compensation: boolean;
  deMinimisKey?: string | null;
  typeKey?: string | null;
}

interface Accumulated extends LineSpec {
  exact: Ratio;
  quantity: Ratio;
  rateText: string | null;
  order: number;
}

class LineAccumulator {
  private readonly lines = new Map<string, Accumulated>();

  add(spec: LineSpec, amount: Ratio, quantity: Ratio, rateText: string | null): void {
    const found = this.lines.get(spec.key);
    if (found) {
      found.exact = addRatio(found.exact, amount);
      found.quantity = addRatio(found.quantity, quantity);
      found.rateText = rateText ?? found.rateText;
      return;
    }
    this.lines.set(spec.key, {
      ...spec,
      exact: amount,
      quantity,
      rateText,
      order: this.lines.size,
    });
  }

  /** The rounded lines (a line of 0.00 is dropped), in kind order then first-added order. */
  finish(periodStart: BusinessDate, periodEnd: BusinessDate): PayrollLine[] {
    return [...this.lines.values()]
      .sort(
        (a, b) =>
          (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) || a.order - b.order,
      )
      .map((line): PayrollLine => {
        const amount = roundCentavos(line.exact);
        const side = PAYROLL_LINE_KIND_SIDES[line.kind];
        return {
          key: line.key,
          kind: line.kind,
          group: side === 'deduction' ? 'deductions' : 'earnings',
          side,
          label: line.label,
          periodStart,
          periodEnd,
          quantity: line.unit ? decimalText(line.quantity) : null,
          unit: line.unit,
          rateText: line.rateText,
          amountCentavos: amount,
          taxable: line.compensation && !line.deMinimisKey && amount !== 0,
          taxableCentavos: line.compensation && !line.deMinimisKey ? amount : 0,
          deMinimisKey: line.deMinimisKey ?? null,
          typeKey: line.typeKey ?? null,
          manual: null,
          override: null,
        };
      })
      .filter((line) => line.amountCentavos !== 0);
  }
}

const simple = (kind: PayrollLineKind, unit: PayrollQuantityUnit | null): LineSpec => ({
  key: kind,
  kind,
  label: PAYROLL_LINE_KIND_LABELS[kind],
  unit,
  compensation: true,
});

/** An allowance's tax treatment: one missing from the day's version counts as taxable. */
function allowanceCompensation(treatment: AllowanceTaxTreatment | null): boolean {
  return treatment === null || treatment === 'taxable' || treatment === 'deMinimis';
}

/** The attendance item of a line (`side` is earning or deduction). */
export function attendanceItemOf(line: PayrollLine): PayrollAttendanceItem {
  return {
    key: line.key,
    kind: line.kind,
    side: line.side === 'deduction' ? 'deduction' : 'earning',
    label: line.label,
    quantity: line.quantity,
    unit: line.unit,
    rateText: line.rateText,
    amountCentavos: line.amountCentavos,
    taxableCentavos: line.taxableCentavos,
    deMinimisKey: line.deMinimisKey,
    typeKey: line.typeKey,
  };
}

// ---------------------------------------------------------------------------------------------
// The workday-before rule

interface RuleDay {
  date: BusinessDate;
  restDay: boolean;
  kind: PayrollCalendarDay['kind'];
  status: DtrDayStatus | null;
  approved: boolean;
}

interface RuleResult {
  met: boolean;
  /** The workday before, when one was found. */
  workdayBefore: BusinessDate | null;
}

/**
 * The workday-before rule for an unworked regular holiday (decision 330; *Assumption*, HANDOFF
 * item 234): the last scheduled work day before it that isn't itself a holiday, rest days
 * skipped. Present, paid leave or paid offset meets it; an absence, leave without pay or a day
 * before the date hired doesn't. While that day's timesheet isn't approved the rule counts as met.
 */
function workdayBeforeRule(
  holiday: BusinessDate,
  days: readonly RuleDay[],
  dateHired: BusinessDate,
): RuleResult {
  for (const day of days) {
    if (day.date >= holiday || day.restDay || HOLIDAY_KINDS.has(day.kind)) continue;
    if (day.date < dateHired) return { met: false, workdayBefore: day.date };
    if (!day.approved || day.status === null) return { met: true, workdayBefore: day.date };
    return { met: MEETS_RULE.has(day.status), workdayBefore: day.date };
  }
  // No workday before in the data: met unless the holiday is on or before the date hired.
  return { met: holiday > dateHired, workdayBefore: null };
}

// ---------------------------------------------------------------------------------------------
// Premiums

/** The day's rate (decision 331): 1, rest day, or the holiday's (on a rest day or not). */
function dayRateOf(day: PayrollCalendarDay, rates: PremiumRates): Ratio {
  if (day.kind === 'regularHoliday') {
    return ratio(day.restDay ? rates.regularHolidayOnRestDay : rates.regularHolidayWorked);
  }
  if (day.kind === 'specialDay') {
    return ratio(day.restDay ? rates.specialDayOnRestDay : rates.specialDayWorked);
  }
  if (day.restDay) return ratio(rates.restDayWorked);
  return ONE;
}

/**
 * The base already paid for a holiday (decision 331): a monthly salary covers a holiday on a work
 * day (1); otherwise the holiday pay line paid `regularHolidayUnworked` or `specialDayUnworked`.
 */
function holidayBaseOf(day: PayrollCalendarDay, monthly: boolean, rates: PremiumRates): Ratio {
  if (monthly && !day.restDay) return ONE;
  return ratio(
    day.kind === 'regularHoliday' ? rates.regularHolidayUnworked : rates.specialDayUnworked,
  );
}

// ---------------------------------------------------------------------------------------------
// The period

function requireVersion<T>(value: T | null, what: string, day: BusinessDate): T {
  if (value === null) throw new RangeError(`No ${what} is in effect on ${day}.`);
  return value;
}

/**
 * One cut-off's own pay (decisions 328–335 and 338): basic pay with prorating, holiday pay and
 * holiday deductions, overtime and premiums, night differential, attendance deductions,
 * allowances and reimbursements, with the attendance items among them. With a timesheet that
 * isn't approved, only the provisional set: basic pay, per cut-off allowances and holiday pay
 * with the workday-before rule counted as met.
 */
export function computePeriodPay(input: PayrollPeriodInput): PeriodPay {
  const { periodStart, periodEnd, employee, payrollSettings, policy } = input;
  const factor = payrollSettings.dailyRateFactor;
  const hoursPerDay = payrollSettings.hoursPerDay;
  const perMinute = ratio(1, hoursPerDay * 60);
  const timesheet = input.timesheet;
  const approved = timesheet?.status === 'approved';

  const calendar = [...input.calendar]
    .filter((day) => day.date >= periodStart && day.date <= periodEnd)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const baseDays = calendar.filter((day) => !day.restDay);
  const baseCount = baseDays.length;
  const employedDays = calendar.filter((day) => isEmployedOn(employee, day.date));
  const employedBaseDays = employedDays.filter((day) => !day.restDay);
  const fullCutOff =
    employee.dateHired <= periodStart &&
    (!employee.separationDate || employee.separationDate >= periodEnd);

  const dtrByDate = new Map<BusinessDate, PayrollDtrDay>();
  if (approved) for (const day of timesheet.days) dtrByDate.set(day.date, day);

  // Every day the workday-before rule may look at, newest first.
  const ruleDays: RuleDay[] = [
    ...input.previousDays.filter((day) => day.date < periodStart),
    ...calendar.map((day) => ({
      ...day,
      status: dtrByDate.get(day.date)?.status ?? null,
      approved,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const lines = new LineAccumulator();

  // --- Basic pay (decision 329) -------------------------------------------------------------
  const basic = simple('basicPay', 'days');
  for (const day of employedBaseDays) {
    const salary = salaryOn(employee.salaries, day.date);
    if (!salary) continue;
    const daily = dailyOf(salary, factor);
    if (salary.rateType === 'monthly' && fullCutOff) {
      lines.add(
        basic,
        ratio(salary.amountCentavos, 2 * baseCount),
        ONE,
        `${formatPeso(salary.amountCentavos)} a month ÷ 2`,
      );
    } else if (salary.rateType === 'monthly' || !isHoliday(day)) {
      lines.add(basic, daily, ONE, `${peso(daily)} a day`);
    }
  }

  // --- Holidays (decision 330) --------------------------------------------------------------
  for (const day of employedDays) {
    if (!isHoliday(day)) continue;
    const salary = salaryOn(employee.salaries, day.date);
    if (!salary) continue;
    const rates = requireVersion(
      versionOn(input.premiumRates, day.date),
      'premium rate',
      day.date,
    ).value;
    const daily = dailyOf(salary, factor);
    const monthly = salary.rateType === 'monthly';
    const worked = (dtrByDate.get(day.date)?.workedMinutes ?? 0) > 0;
    const holidayPay = (share: string) => {
      const amount = multiplyRatios(daily, share);
      lines.add(
        {
          key: `holidayPay:${day.date}`,
          kind: 'holidayPay',
          label: `${PAYROLL_LINE_KIND_LABELS.holidayPay} · ${formatShortDay(day.date)}`,
          unit: 'days',
          compensation: true,
        },
        amount,
        ONE,
        `${peso(daily)} a day × ${multiplierText(ratio(share))}`,
      );
    };
    if (day.kind === 'regularHoliday') {
      const rule = approved
        ? worked
          ? { met: true, workdayBefore: null }
          : workdayBeforeRule(day.date, ruleDays, employee.dateHired)
        : { met: true, workdayBefore: null };
      if (monthly && !day.restDay) {
        if (!rule.met) {
          const when = rule.workdayBefore
            ? formatShortDay(rule.workdayBefore)
            : 'the workday before';
          lines.add(
            {
              key: `holidayNotPaid:${day.date}`,
              kind: 'holidayNotPaid',
              label: `${PAYROLL_LINE_KIND_LABELS.holidayNotPaid} (absent on ${when})`,
              unit: 'days',
              compensation: true,
            },
            multiplyRatios(daily, rates.regularHolidayUnworked),
            ONE,
            `${peso(daily)} a day × ${multiplierText(ratio(rates.regularHolidayUnworked))}`,
          );
        }
      } else if (rule.met) {
        holidayPay(rates.regularHolidayUnworked);
      }
    } else if (monthly && !day.restDay) {
      // A monthly salary covers the special day unless the policy deducts an unworked one.
      if (approved && !worked && policy.monthlyRatedUnworkedSpecialDay === 'deducted') {
        const share = subtractRatio(ONE, ratio(rates.specialDayUnworked));
        lines.add(
          {
            key: `holidayNotPaid:${day.date}`,
            kind: 'holidayNotPaid',
            label: `Special day not worked (${formatShortDay(day.date)})`,
            unit: 'days',
            compensation: true,
          },
          multiplyRatios(daily, share),
          ONE,
          `${peso(daily)} a day × ${multiplierText(share)}`,
        );
      }
    } else if (!day.restDay || (approved && worked)) {
      // Daily-rated on a work day, or either rate type working a special day on a rest day.
      holidayPay(rates.specialDayUnworked);
    }
  }

  // --- Allowances (decision 334) ------------------------------------------------------------
  for (const day of employedDays) {
    const types = versionOn(input.allowanceTypes, day.date)?.value.types ?? [];
    const allowances = resolveAllowances({
      day: day.date,
      dateHired: employee.dateHired,
      types,
      entries: employee.allowanceEntries,
    });
    for (const allowance of allowances) {
      if (allowance.amountCentavos === null) continue;
      const deMinimisKey =
        allowance.taxTreatment === 'deMinimis' ? (allowance.deMinimisKey ?? null) : null;
      const compensation = allowanceCompensation(allowance.taxTreatment);
      if (allowance.basis === 'perDayPresent') {
        if (!approved || dtrByDate.get(day.date)?.status !== 'present') continue;
        lines.add(
          {
            key: `allowanceDay:${allowance.typeKey}`,
            kind: 'allowance',
            label: allowance.name,
            unit: 'days',
            compensation,
            deMinimisKey,
            typeKey: allowance.typeKey,
          },
          ratio(allowance.amountCentavos),
          ONE,
          `${formatPeso(allowance.amountCentavos)} a day present`,
        );
      } else if (!day.restDay && baseCount > 0) {
        lines.add(
          {
            key: `allowance:${allowance.typeKey}`,
            kind: 'allowance',
            label: allowance.name,
            unit: 'days',
            compensation,
            deMinimisKey,
            typeKey: allowance.typeKey,
          },
          ratio(allowance.amountCentavos, baseCount),
          ONE,
          `${formatPeso(allowance.amountCentavos)} per cut-off`,
        );
      }
    }
  }

  // --- Approved timesheet only --------------------------------------------------------------
  let presentDays = 0;
  let offsetEarnedMinutes = 0;
  if (approved) {
    for (const day of employedDays) {
      const dtr = dtrByDate.get(day.date);
      if (!dtr) continue;
      if (dtr.status === 'present') presentDays += 1;
      offsetEarnedMinutes += dtr.offsetMinutes;
      const salary = salaryOn(employee.salaries, day.date);
      if (!salary) continue;
      const rates = requireVersion(
        versionOn(input.premiumRates, day.date),
        'premium rate',
        day.date,
      ).value;
      const daily = dailyOf(salary, factor);
      const minute = multiplyRatios(daily, perMinute);
      const hourly = peso(multiplyRatios(daily, ratio(1, hoursPerDay)));
      const dayRate = dayRateOf(day, rates);
      const overtime = dtr.overtime;

      // Overtime and premiums (decision 331): the DTR's claimed minutes by kind, which step 2.4
      // gives only under the Overtime treatment.
      if (overtime.ordinaryMinutes > 0) {
        const multiplier = addRatio(ONE, ratio(rates.overtimeOrdinaryAddOn));
        lines.add(
          simple('overtimeOrdinary', 'minutes'),
          multiplyRatios(minute, multiplier, overtime.ordinaryMinutes),
          ratio(overtime.ordinaryMinutes),
          `${hourly} an hour × ${multiplierText(multiplier)}`,
        );
      }
      if (overtime.restDayMinutes > 0 || overtime.holidayMinutes > 0) {
        const holiday = overtime.holidayMinutes > 0;
        const firstRate = holiday
          ? subtractRatio(dayRate, holidayBaseOf(day, salary.rateType === 'monthly', rates))
          : dayRate;
        if (overtime.firstHoursMinutes > 0) {
          lines.add(
            simple(holiday ? 'holidayWork' : 'restDayWork', 'minutes'),
            multiplyRatios(minute, firstRate, overtime.firstHoursMinutes),
            ratio(overtime.firstHoursMinutes),
            `${hourly} an hour × ${multiplierText(firstRate)}`,
          );
        }
        if (overtime.beyondHoursMinutes > 0) {
          const multiplier = multiplyRatios(
            dayRate,
            addRatio(ONE, ratio(rates.overtimeRestDayHolidayAddOn)),
          );
          lines.add(
            simple('restDayHolidayOvertime', 'minutes'),
            multiplyRatios(minute, multiplier, overtime.beyondHoursMinutes),
            ratio(overtime.beyondHoursMinutes),
            `${hourly} an hour × ${multiplierText(multiplier)}`,
          );
        }
      }

      // Night differential (decision 332): paid night minutes × the day's rate × the add-on.
      if (dtr.nightDifferentialMinutes > 0) {
        const multiplier = multiplyRatios(dayRate, rates.nightDifferentialAddOn);
        lines.add(
          simple('nightDifferential', 'minutes'),
          multiplyRatios(minute, multiplier, dtr.nightDifferentialMinutes),
          ratio(dtr.nightDifferentialMinutes),
          `${hourly} an hour × ${multiplierText(multiplier)}`,
        );
      }

      // Attendance deductions (decision 333).
      if (dtr.status === 'absentUnpaid') {
        lines.add(simple('absence', 'days'), daily, ONE, `${peso(daily)} a day`);
      }
      if (dtr.leaveWithoutPayDays > 0) {
        const days = ratio(Math.round(dtr.leaveWithoutPayDays * 2), 2);
        lines.add(
          simple('leaveWithoutPay', 'days'),
          multiplyRatios(daily, days),
          days,
          `${peso(daily)} a day`,
        );
      }
      const byMinute: [PayrollLineKind, number][] = [
        ['late', dtr.lateMinutes],
        ['undertime', dtr.undertimeMinutes],
        ['partialAbsence', dtr.absentMinutes],
      ];
      for (const [kind, minutes] of byMinute) {
        if (minutes <= 0) continue;
        lines.add(
          simple(kind, 'minutes'),
          multiplyRatios(minute, minutes),
          ratio(minutes),
          `${hourly} an hour`,
        );
      }
    }

    // Reimbursements (decision 335): one non-taxable line, outside every contribution basis.
    const { receipts, totalCentavos } = timesheet.reimbursements;
    if (totalCentavos !== 0) {
      lines.add(
        {
          key: 'reimbursement',
          kind: 'reimbursement',
          label: `${PAYROLL_LINE_KIND_LABELS.reimbursement} (${receipts} ${receipts === 1 ? 'receipt' : 'receipts'})`,
          unit: 'receipts',
          compensation: false,
        },
        ratio(totalCentavos),
        ratio(receipts),
        null,
      );
    }
  }

  const finished = lines.finish(periodStart, periodEnd);

  // The facts: the salary on the last salaried employed day.
  let lastSalary: PayrollSalaryEntry | null = null;
  for (const day of employedDays) lastSalary = salaryOn(employee.salaries, day.date) ?? lastSalary;
  const lastDaily = lastSalary ? dailyOf(lastSalary, factor) : null;
  const facts: PayrollFacts = {
    rateType: lastSalary?.rateType ?? null,
    salaryCentavos: lastSalary?.amountCentavos ?? null,
    dailyRateCentavos: lastDaily ? roundCentavos(lastDaily) : null,
    hourlyRateCentavos: lastDaily
      ? roundCentavos(multiplyRatios(lastDaily, ratio(1, hoursPerDay)))
      : null,
    dailyRateFactor: factor,
    hoursPerDay,
    timesheetType: timesheet?.type ?? null,
    timesheetStatus: timesheet?.status ?? null,
    timesheetApproved: approved,
    provisional: !approved,
    baseDays: baseCount,
    employedBaseDays: employedBaseDays.length,
    presentDays,
    offsetEarnedMinutes,
    minimumWageEarner: lastSalary?.minimumWageEarner ?? false,
  };

  return {
    periodStart,
    periodEnd,
    facts,
    lines: finished,
    attendanceItems: finished.filter(isAttendanceItem).map(attendanceItemOf),
  };
}

/** True when a line kind or key is an attendance item (decision 339). */
export function isAttendanceItem(line: Pick<PayrollLine, 'kind' | 'key'>): boolean {
  return ATTENDANCE_ITEM_KINDS.has(line.kind) || line.key.startsWith('allowanceDay:');
}

/** The employed base days of a cut-off that aren't holidays (a daily de minimis limit's days). */
export function workingBaseDays(input: Pick<PayrollPeriodInput, 'calendar' | 'employee'>): number {
  return input.calendar.filter(
    (day) => !day.restDay && !isHoliday(day) && isEmployedOn(input.employee, day.date),
  ).length;
}
