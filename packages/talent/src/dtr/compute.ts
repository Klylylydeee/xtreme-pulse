import type { BusinessDate } from '@pulse/core';
import {
  computeTimesheet,
  epochMinuteOf,
  manilaDateOf,
  manilaDayStartMinute,
  type TimeEntryHoursInput,
  type TimesheetDayHours,
  type TimesheetHoursInput,
  type TimesheetTotals,
} from '../timesheets/compute';
import {
  breakOffsetMinutes,
  minutesOfClockTime,
  scheduleSpanMinutes,
  type WorkSchedule,
} from '../timesheets/schemas';
import {
  DTR_DAY_STATUSES,
  DTR_TIME_OFF_STATUSES,
  type DtrDayStatus,
  type DtrTimeOffStatus,
} from './statuses';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record"), docs/COMPLIANCE.md#attendance-and-the-dtr-build-step-27 (decisions
// 288–291 in docs/BUILD_PLAN.md) — the Daily Time Record of one timesheet. Derived when read and
// never stored: it builds on step 2.4's `computeTimesheet` (worked minutes, extra hours, night
// differential, overtime by kind and offset) and adds each day's status, late and undertime
// minutes, and whether the day is final. No pay is computed here: whether an unworked regular
// holiday is paid, the daily-rate deductions and half days are steps 2.8 and 2.9.
//
// Units as in step 2.4: whole minutes on Manila time (UTC+8, no daylight saving), seconds dropped.
// Every rule marked *Assumption* in the spec is one of HANDOFF items 123–137 (and 138).

// ---------------------------------------------------------------------------------------------
// Inputs

/** A day covered by approved leave or offset time off (step 2.8; left empty in step 2.7). */
export interface DtrTimeOffInput {
  date: BusinessDate;
  status: DtrTimeOffStatus;
}

/**
 * The DTR of one timesheet: step 2.4's hours input, plus what the DTR adds. The days listed run
 * from the latest of the period start, the date hired and `from` to the earliest of the period
 * end, the separation date, today and `to`.
 */
export interface DtrInput extends TimesheetHoursInput {
  /** True when the timesheet is `approved`: its days are final, the others a preview. */
  approved: boolean;
  dateHired: BusinessDate;
  /** The separation date, when the employee has one. */
  separationDate?: BusinessDate | null;
  /** Today's Manila day: later days aren't listed. */
  today: BusinessDate;
  /** Approved leave and offset time off (step 2.8). Empty in step 2.7. */
  timeOff?: readonly DtrTimeOffInput[];
}

// ---------------------------------------------------------------------------------------------
// Outputs

/** A DTR day: step 2.4's hours of the day, with its status, late and undertime. */
export interface DtrDay extends TimesheetDayHours {
  status: DtrDayStatus;
  /** The first counted time in (a closed entry's), or null when nothing was worked. */
  firstTimeIn: Date | null;
  /** On a `present` day only: scheduled minutes before a first time in past the grace period. */
  lateMinutes: number;
  /** On a `present` day only: scheduled minutes after the first time in that no entry covers. */
  undertimeMinutes: number;
  /** True on an approved timesheet; otherwise a preview ("Not approved yet"). */
  final: boolean;
}

export interface DtrTotals extends TimesheetTotals {
  /** The number of days of each status. */
  days: Record<DtrDayStatus, number>;
  /** The number of `present` days with late minutes. */
  lateDays: number;
  lateMinutes: number;
  undertimeMinutes: number;
}

export interface Dtr {
  timesheetType: TimesheetHoursInput['timesheetType'];
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** The first and last days listed; `from` > `to` when no day is (then `days` is empty). */
  from: BusinessDate;
  to: BusinessDate;
  /** The treatment in effect on the period start: overtime by kind, or offset. */
  treatment: TimesheetDayHours['treatment'];
  hoursPerDay: number;
  /** True when the timesheet is approved. */
  final: boolean;
  /** One per day listed, in date order. */
  days: DtrDay[];
  totals: DtrTotals;
}

// ---------------------------------------------------------------------------------------------
// Late and undertime

interface Interval {
  start: number;
  end: number;
}

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** `interval` less every window in `windows`, as pieces. */
function subtract(interval: Interval, windows: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [interval];
  for (const window of windows) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (window.end <= piece.start || window.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (piece.start < window.start) next.push({ start: piece.start, end: window.start });
      if (window.end < piece.end) next.push({ start: window.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((piece) => piece.end > piece.start);
}

/** The schedule's working intervals on a day (its span less its break), in epoch minutes. */
function scheduledIntervals(date: BusinessDate, schedule: WorkSchedule): Interval[] {
  const start = manilaDayStartMinute(date) + minutesOfClockTime(schedule.start);
  const span = { start, end: start + scheduleSpanMinutes(schedule) };
  if (schedule.breakMinutes === 0) return [span];
  const breakStart = start + breakOffsetMinutes(schedule);
  return subtract(span, [{ start: breakStart, end: breakStart + schedule.breakMinutes }]);
}

export interface LateAndUndertime {
  /** The first counted time in, or null when no closed entry has worked minutes. */
  firstTimeIn: Date | null;
  lateMinutes: number;
  undertimeMinutes: number;
}

/**
 * A day's late and undertime minutes against its schedule (decision 290; *Assumption*, HANDOFF
 * items 128, 129 and 138). Only closed entries count, as for worked minutes.
 *
 * - **Late:** when the first time in is more than the grace period after the scheduled start, the
 *   scheduled minutes from the scheduled start to the first time in (the break isn't late time);
 *   within the grace period, 0.
 * - **Undertime:** the scheduled minutes after the first time in that no entry covers, at the end
 *   or in the middle of the day.
 * - Work after the scheduled end makes up neither (Labor Code Art. 88).
 *
 * The caller applies these on `present` days only.
 */
export function lateAndUndertime(
  date: BusinessDate,
  schedule: WorkSchedule,
  entries: readonly TimeEntryHoursInput[],
): LateAndUndertime {
  const worked: Interval[] = [];
  let first: { minute: number; at: Date } | null = null;
  for (const entry of entries) {
    if (!entry.timeOut) continue;
    const start = epochMinuteOf(entry.timeIn);
    const end = epochMinuteOf(entry.timeOut);
    if (end <= start) continue;
    worked.push({ start, end });
    if (!first || start < first.minute) first = { minute: start, at: entry.timeIn };
  }
  if (!first) return { firstTimeIn: null, lateMinutes: 0, undertimeMinutes: 0 };

  const scheduled = scheduledIntervals(date, schedule);
  const scheduledStart = (scheduled[0] as Interval).start;
  const firstIn = first.minute;

  const lateMinutes =
    firstIn - scheduledStart > schedule.graceMinutes
      ? scheduled.reduce(
          (sum, piece) => sum + overlap(piece, { start: scheduledStart, end: firstIn }),
          0,
        )
      : 0;

  let undertimeMinutes = 0;
  for (const piece of scheduled) {
    if (piece.end <= firstIn) continue;
    const after = { start: Math.max(piece.start, firstIn), end: piece.end };
    for (const gap of subtract(after, worked)) undertimeMinutes += gap.end - gap.start;
  }
  return { firstTimeIn: first.at, lateMinutes, undertimeMinutes };
}

// ---------------------------------------------------------------------------------------------
// The DTR

const TIME_OFF = new Set<string>(DTR_TIME_OFF_STATUSES);

function latest(...days: (BusinessDate | null | undefined)[]): BusinessDate {
  return days.filter((day): day is BusinessDate => !!day).reduce((a, b) => (b > a ? b : a));
}

function earliest(...days: (BusinessDate | null | undefined)[]): BusinessDate {
  return days.filter((day): day is BusinessDate => !!day).reduce((a, b) => (b < a ? b : a));
}

/** A day's status (decision 289): the first that applies wins. */
function statusOf(hours: TimesheetDayHours, timeOff: DtrTimeOffStatus | undefined): DtrDayStatus {
  if (hours.kind === 'regularHoliday' || hours.kind === 'specialDay') return 'holiday';
  if (hours.restDay) return 'restDay';
  if (timeOff) return timeOff;
  return hours.workedMinutes > 0 ? 'present' : 'absentUnpaid';
}

/**
 * The Daily Time Record of one timesheet (decisions 288–291). Each day's hours are step 2.4's
 * (`computeTimesheet`); the DTR adds the day's status, late and undertime minutes on a `present`
 * day, and `final` when the timesheet is approved. Night differential is step 2.4's paid minutes
 * in the night window (scheduled hours only under the offset treatment), and the extra hours are
 * step 2.4's overtime by kind or offset. A confirmed nationwide holiday is never an absence; a
 * special working day is a scheduled work day.
 */
export function computeDtr(input: DtrInput): Dtr {
  const from = latest(input.periodStart, input.dateHired, input.from);
  const to = earliest(input.periodEnd, input.separationDate, input.today, input.to);

  const timeOff = new Map<BusinessDate, DtrTimeOffStatus>();
  for (const day of input.timeOff ?? []) {
    if (!TIME_OFF.has(day.status)) {
      throw new RangeError(`"${String(day.status)}" is not a time off status.`);
    }
    if (!timeOff.has(day.date)) timeOff.set(day.date, day.status);
  }

  const entriesByDate = new Map<BusinessDate, TimeEntryHoursInput[]>();
  for (const entry of input.entries) {
    const date = manilaDateOf(entry.timeIn);
    const list = entriesByDate.get(date);
    if (list) list.push(entry);
    else entriesByDate.set(date, [entry]);
  }

  const hours = computeTimesheet({ ...input, from, to });
  const final = input.approved;

  const days: DtrDay[] = hours.days.map((day) => {
    const status = statusOf(day, timeOff.get(day.date));
    const attendance = lateAndUndertime(
      day.date,
      day.schedule.schedule,
      entriesByDate.get(day.date) ?? [],
    );
    const present = status === 'present';
    return {
      ...day,
      status,
      firstTimeIn: attendance.firstTimeIn,
      lateMinutes: present ? attendance.lateMinutes : 0,
      undertimeMinutes: present ? attendance.undertimeMinutes : 0,
      final,
    };
  });

  const counts = Object.fromEntries(DTR_DAY_STATUSES.map((status) => [status, 0])) as Record<
    DtrDayStatus,
    number
  >;
  const totals: DtrTotals = {
    ...hours.totals,
    days: counts,
    lateDays: 0,
    lateMinutes: 0,
    undertimeMinutes: 0,
  };
  for (const day of days) {
    counts[day.status] += 1;
    if (day.lateMinutes > 0) totals.lateDays += 1;
    totals.lateMinutes += day.lateMinutes;
    totals.undertimeMinutes += day.undertimeMinutes;
  }

  return {
    timesheetType: hours.timesheetType,
    periodStart: hours.periodStart,
    periodEnd: hours.periodEnd,
    from,
    to,
    treatment: hours.treatment,
    hoursPerDay: hours.hoursPerDay,
    final,
    days,
    totals,
  };
}
