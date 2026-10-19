import { addDays, type BusinessDate } from '@pulse/core';
import type { CutOffPeriod } from '../payroll/lookups';
import type { PayrollSettings } from '../payroll/schemas';
import { dayKindOf, type TimesheetHoliday } from '../timesheets/compute';
import {
  type EffectiveVersion,
  scheduleOn,
  timesheetPeriodFor,
  type WorkScheduleAssignmentInput,
} from '../timesheets/schedule';
import type { WorkSchedule } from '../timesheets/schemas';
import type { PayrollLeftOutReason } from './kinds';
import { isEmployedOn, salaryOn } from './period';
import type { PayrollCalendarDay, PayrollEmployeeInput } from './types';

// Spec: docs/modules/talent.md#payroll-run-computation-build-step-29 ("Payroll runs", "Settling
// earlier cut-offs"; decisions 327 and 339 in docs/BUILD_PLAN.md; HANDOFF items 242, 246 and 247)
// — which cut-offs and employees a run covers, and the calendar the engine reads. Pure code.

type PayrollVersions = readonly EffectiveVersion<Pick<PayrollSettings, 'cutOffs'>>[];

/** The contribution month of a pay date: `YYYY-MM`. */
export function contributionMonthOf(payDate: BusinessDate): string {
  return payDate.slice(0, 7);
}

/**
 * The first payroll cut-off: the first that starts on or after the go-live date (decision 327;
 * *Assumption*, HANDOFF item 247). Null while the go-live date is null.
 */
export function firstPayrollCutOff(
  goLiveDate: BusinessDate | null,
  payrollVersions: PayrollVersions,
): CutOffPeriod | null {
  if (!goLiveDate) return null;
  const containing = timesheetPeriodFor(goLiveDate, payrollVersions);
  if (containing.start === goLiveDate) return containing;
  return timesheetPeriodFor(addDays(containing.end, 1), payrollVersions);
}

/** The cut-off right before `period` (the one holding the day before its start). */
export function previousCutOff(
  period: Pick<CutOffPeriod, 'start'>,
  payrollVersions: PayrollVersions,
): CutOffPeriod {
  return timesheetPeriodFor(addDays(period.start, -1), payrollVersions);
}

/**
 * The earlier cut-offs a run reconciles (decision 339; *Assumption*, HANDOFF item 242): up to
 * `lookback` cut-offs before the run's, newest first, none starting before the first payroll
 * cut-off.
 */
export function settlementCutOffs(
  period: Pick<CutOffPeriod, 'start'>,
  lookback: number,
  firstCutOffStart: BusinessDate,
  payrollVersions: PayrollVersions,
): CutOffPeriod[] {
  const result: CutOffPeriod[] = [];
  let current: Pick<CutOffPeriod, 'start'> = period;
  while (result.length < lookback && current.start > firstCutOffStart) {
    const earlier = previousCutOff(current, payrollVersions);
    if (earlier.start < firstCutOffStart) break;
    result.push(earlier);
    current = earlier;
  }
  return result;
}

/**
 * Whether an employee belongs in a run (decision 327; *Assumption*, HANDOFF item 246): employment
 * overlaps the cut-off (date hired on or before its end, no separation or one on or after its
 * start). One with no salary on any employed day is left out (`noSalary`); one not employed in
 * the cut-off is outside the run (`notEmployed`, not listed).
 */
export function payrollRunMembership(
  employee: Pick<PayrollEmployeeInput, 'dateHired' | 'separationDate' | 'salaries'>,
  period: { start: BusinessDate; end: BusinessDate },
):
  | { included: true }
  | { included: false; reason: PayrollLeftOutReason }
  | { included: false; reason: 'notEmployed' } {
  if (employee.dateHired > period.end) return { included: false, reason: 'notEmployed' };
  if (employee.separationDate && employee.separationDate < period.start) {
    return { included: false, reason: 'notEmployed' };
  }
  for (let day = period.start; day <= period.end; day = addDays(day, 1)) {
    if (isEmployedOn(employee, day) && salaryOn(employee.salaries, day)) return { included: true };
  }
  return { included: false, reason: 'noSalary' };
}

/**
 * The engine's calendar from `from` to `to`: each day's rest day (the schedule in effect) and
 * confirmed nationwide holiday, as the DTR reads them (`scheduleOn`, `dayKindOf`).
 */
export function payrollCalendar(input: {
  from: BusinessDate;
  to: BusinessDate;
  workSchedules: readonly EffectiveVersion<WorkSchedule>[];
  assignments: readonly WorkScheduleAssignmentInput[];
  holidays: readonly TimesheetHoliday[];
}): PayrollCalendarDay[] {
  const days: PayrollCalendarDay[] = [];
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const schedule = scheduleOn(date, input.workSchedules, input.assignments);
    if (!schedule) throw new RangeError(`No work schedule is in effect on ${date}.`);
    const { kind, restDay } = dayKindOf(date, schedule.schedule, input.holidays);
    days.push({ date, restDay, kind });
  }
  return days;
}
