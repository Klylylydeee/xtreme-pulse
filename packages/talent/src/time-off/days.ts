import { addDays, type BusinessDate, isBusinessDate } from '@pulse/core';
import {
  dayKindOf,
  epochMinuteOf,
  manilaDateOf,
  manilaDayStartMinute,
  type TimesheetHoliday,
} from '../timesheets/compute';
import {
  type EffectiveVersion,
  scheduleOn,
  type WorkScheduleAssignmentInput,
} from '../timesheets/schedule';
import {
  breakOffsetMinutes,
  MINUTES_PER_DAY,
  minutesOfClockTime,
  scheduleSpanMinutes,
  type WorkSchedule,
} from '../timesheets/schemas';
import type { TimeOffPortion } from './kinds';
import type { LeaveCountDays } from './settings';
import { HALF_DAYS_PER_DAY } from './units';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Units
// and counting", "Time off requests"; decisions 302 and 312 in docs/BUILD_PLAN.md) — a request's
// days: which count (chargeable days, `workDays` or `calendarDays`), the halves of a day, the part
// of a day offset time off covers, and the scheduled intervals and minutes each day covers.
//
// Intervals are whole minutes counted from the Manila day's 00:00; an overnight schedule runs past
// 1,440. A day's `TimeOffRequestDay` is this module's own type: the DTR has its own input
// (`DtrTimeOffInput`), and the server maps one to the other.

/** A half-open range of minutes `[from, to)` from the Manila day's 00:00. */
export interface MinuteInterval {
  from: number;
  to: number;
}

function intervalLength(interval: MinuteInterval): number {
  return Math.max(0, interval.to - interval.from);
}

/** The total minutes of non-overlapping intervals. */
export function intervalsMinutes(intervals: readonly MinuteInterval[]): number {
  return intervals.reduce((total, interval) => total + intervalLength(interval), 0);
}

function intersect(a: MinuteInterval, b: MinuteInterval): MinuteInterval | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return to > from ? { from, to } : null;
}

/** True when any interval of `a` meets any of `b`. */
export function intervalsOverlap(
  a: readonly MinuteInterval[],
  b: readonly MinuteInterval[],
): boolean {
  return a.some((x) => b.some((y) => intersect(x, y) !== null));
}

/** `intervals` cut to `within`. */
function clip(
  intervals: readonly MinuteInterval[],
  within: readonly MinuteInterval[],
): MinuteInterval[] {
  const out: MinuteInterval[] = [];
  for (const interval of intervals) {
    for (const bound of within) {
      const part = intersect(interval, bound);
      if (part) out.push(part);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One day's schedule

/** The schedule's working intervals: start to break, and break end to end (one with no break). */
export function scheduledIntervals(schedule: WorkSchedule): MinuteInterval[] {
  const start = minutesOfClockTime(schedule.start);
  const end = start + scheduleSpanMinutes(schedule);
  if (schedule.breakMinutes === 0) return [{ from: start, to: end }];
  const breakFrom = start + breakOffsetMinutes(schedule);
  const breakTo = breakFrom + schedule.breakMinutes;
  return [
    { from: start, to: breakFrom },
    { from: breakTo, to: end },
  ].filter((interval) => interval.to > interval.from);
}

/**
 * The halves of a day (*Assumption*, item 161): the first from the scheduled start to the break,
 * the second from the break's end to the scheduled end. With no break the span splits at its
 * midpoint, rounded down to the minute.
 */
export function halvesOfDay(schedule: WorkSchedule): {
  firstHalf: MinuteInterval;
  secondHalf: MinuteInterval;
} {
  const start = minutesOfClockTime(schedule.start);
  const span = scheduleSpanMinutes(schedule);
  const end = start + span;
  if (schedule.breakMinutes === 0) {
    const middle = start + Math.floor(span / 2);
    return { firstHalf: { from: start, to: middle }, secondHalf: { from: middle, to: end } };
  }
  const breakFrom = start + breakOffsetMinutes(schedule);
  return {
    firstHalf: { from: start, to: breakFrom },
    secondHalf: { from: breakFrom + schedule.breakMinutes, to: end },
  };
}

/**
 * A part of the day from `fromTime` to `toTime` (`HH:MM`) on the schedule's clock: a time before
 * the scheduled start is the next day's (an overnight schedule). Null when it doesn't lie inside
 * the scheduled span or doesn't end after it starts.
 */
export function partOfDay(
  schedule: WorkSchedule,
  fromTime: string,
  toTime: string,
): MinuteInterval | null {
  const start = minutesOfClockTime(schedule.start);
  const end = start + scheduleSpanMinutes(schedule);
  const onClock = (time: string) => {
    const minute = minutesOfClockTime(time);
    return minute < start ? minute + MINUTES_PER_DAY : minute;
  };
  const from = onClock(fromTime);
  let to = onClock(toTime);
  // An end equal to the start time is the span's end on a 24-hour schedule.
  if (to === start && end === start + MINUTES_PER_DAY) to = end;
  if (to <= from || from < start || to > end) return null;
  return { from, to };
}

/** The scheduled intervals a portion covers: the whole day, a half, or a part (break excluded). */
export function coveredIntervals(
  schedule: WorkSchedule,
  portion: TimeOffPortion,
  part?: { fromTime: string; toTime: string } | null,
): MinuteInterval[] {
  const scheduled = scheduledIntervals(schedule);
  switch (portion) {
    case 'whole':
      return scheduled;
    case 'firstHalf':
    case 'secondHalf':
      return clip([halvesOfDay(schedule)[portion]], scheduled);
    case 'part': {
      const interval = part ? partOfDay(schedule, part.fromTime, part.toTime) : null;
      return interval ? clip([interval], scheduled) : [];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A request's days

/** Where the schedule of each day comes from: `scheduleOn`'s inputs. */
export interface ScheduleSource {
  defaultVersions: readonly EffectiveVersion<WorkSchedule>[];
  assignments?: readonly WorkScheduleAssignmentInput[];
}

/** What every day of a request is read against. */
export interface TimeOffDayContext {
  schedules: ScheduleSource;
  /** Core's confirmed holidays over the range (a draft is ignored). */
  holidays: readonly TimesheetHoliday[];
  dateHired: BusinessDate;
  separationDate?: BusinessDate | null;
}

/** The days and portion of a request. */
export interface TimeOffSpan {
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  /** `part` only. */
  fromTime?: string | null;
  toTime?: string | null;
}

/** Why a day of a request doesn't count. */
export const TIME_OFF_DAY_EXCLUSIONS = [
  'beforeHired',
  'afterSeparation',
  'noSchedule',
  'holiday',
  'restDay',
] as const;
export type TimeOffDayExclusion = (typeof TIME_OFF_DAY_EXCLUSIONS)[number];

/** One day of a request. */
export interface TimeOffRequestDay {
  date: BusinessDate;
  portion: TimeOffPortion;
  /** The schedule in effect lists the weekday as a rest day (or no schedule is in effect). */
  restDay: boolean;
  /** A confirmed nationwide holiday applies (a special working day doesn't). */
  holiday: boolean;
  /** The day counts under the type's `countDays`. */
  chargeable: boolean;
  /** Why it doesn't count, or null when it does. */
  excluded: TimeOffDayExclusion | null;
  /** The scheduled intervals covered on a chargeable day (none on a rest day). */
  intervals: MinuteInterval[];
  /** Their minutes: what offset time off charges. */
  minutes: number;
  /** Leave: 2 for a whole chargeable day, 1 for a half, 0 otherwise. */
  halfDays: number;
  /** Leave: of `halfDays`, the paid and the unpaid ones (filled by `splitLeaveDays`). */
  paidHalfDays: number;
  unpaidHalfDays: number;
}

/** Every Manila day from `startDate` to `endDate`, both included. */
export function daysOfRange(startDate: BusinessDate, endDate: BusinessDate): BusinessDate[] {
  if (!isBusinessDate(startDate) || !isBusinessDate(endDate)) {
    throw new RangeError('Enter real dates.');
  }
  const days: BusinessDate[] = [];
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * The request's days. For `workDays` a day counts when the schedule in effect lists it as a work
 * day and no confirmed nationwide holiday applies; for `calendarDays` every day counts (a rest day
 * or holiday then has no scheduled intervals). Days before the date hired or after the
 * separation date never count. Offset time off counts work days.
 */
export function timeOffRequestDays(
  span: TimeOffSpan,
  countDays: LeaveCountDays,
  context: TimeOffDayContext,
): TimeOffRequestDay[] {
  const part =
    span.portion === 'part' && span.fromTime && span.toTime
      ? { fromTime: span.fromTime, toTime: span.toTime }
      : null;
  return daysOfRange(span.startDate, span.endDate).map((date) => {
    const schedule = scheduleOn(
      date,
      context.schedules.defaultVersions,
      context.schedules.assignments,
    )?.schedule;
    const kind = schedule ? dayKindOf(date, schedule, context.holidays) : null;
    const restDay = kind?.restDay ?? true;
    const holiday = kind?.kind === 'regularHoliday' || kind?.kind === 'specialDay';
    let excluded: TimeOffDayExclusion | null = null;
    if (date < context.dateHired) excluded = 'beforeHired';
    else if (context.separationDate && date > context.separationDate) excluded = 'afterSeparation';
    else if (countDays === 'workDays') {
      if (!schedule) excluded = 'noSchedule';
      else if (holiday) excluded = 'holiday';
      else if (restDay) excluded = 'restDay';
    }
    const chargeable = excluded === null;
    const intervals =
      chargeable && schedule && !restDay ? coveredIntervals(schedule, span.portion, part) : [];
    let halfDays = 0;
    if (chargeable && span.portion !== 'part') {
      halfDays = span.portion === 'whole' ? HALF_DAYS_PER_DAY : 1;
    }
    return {
      date,
      portion: span.portion,
      restDay,
      holiday,
      chargeable,
      excluded,
      intervals,
      minutes: intervalsMinutes(intervals),
      halfDays,
      paidHalfDays: 0,
      unpaidHalfDays: 0,
    };
  });
}

/** The chargeable half days of a request's days. */
export function chargeableHalfDaysOf(days: readonly TimeOffRequestDay[]): number {
  return days.reduce((total, day) => total + day.halfDays, 0);
}

/** The scheduled minutes a request's days cover (offset time off). */
export function chargeableMinutesOf(days: readonly TimeOffRequestDay[]): number {
  return days.reduce((total, day) => total + (day.chargeable ? day.minutes : 0), 0);
}

/** The chargeable half days by calendar year, for `perYear` limits. */
export function halfDaysByYear(days: readonly TimeOffRequestDay[]): Map<number, number> {
  const byYear = new Map<number, number>();
  for (const day of days) {
    if (day.halfDays === 0) continue;
    const year = Number(day.date.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? 0) + day.halfDays);
  }
  return byYear;
}

/** The days left out of a request, for the sheet's "rest days and holidays left out". */
export function excludedDays(days: readonly TimeOffRequestDay[]): TimeOffRequestDay[] {
  return days.filter((day) => !day.chargeable);
}

/** The last day of a `calendarDays` request of `days` whole days from `startDate` (L13). */
export function endDateForCalendarDays(startDate: BusinessDate, days: number): BusinessDate {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('Days must be 1 or more.');
  return addDays(startDate, days - 1);
}

// ---------------------------------------------------------------------------------------------
// Overlap and worked time

/** A day of another request, as the overlap check reads it. */
export type TimeOffCoverageDay = Pick<TimeOffRequestDay, 'date' | 'portion' | 'intervals'>;

/**
 * The first day `days` overlaps any of `others` (the employee's pending and approved time off),
 * or null. A whole-day request covers its whole day; a half or a part covers its intervals, so
 * the two halves of one day may sit side by side.
 */
export function firstOverlapDay(
  days: readonly TimeOffCoverageDay[],
  others: readonly TimeOffCoverageDay[],
): BusinessDate | null {
  for (const day of days) {
    for (const other of others) {
      if (other.date !== day.date) continue;
      if (day.portion === 'whole' || other.portion === 'whole') return day.date;
      if (intervalsOverlap(day.intervals, other.intervals)) return day.date;
    }
  }
  return null;
}

/** A time entry, as the worked-time check reads it. An open entry counts from its time in. */
export interface WorkedEntryInput {
  timeIn: Date;
  timeOut: Date | null;
}

/**
 * The first chargeable day of leave with worked time in its portion, or null (*Assumption*, item
 * 160): a whole day with any entry that day; a half with an entry inside its half.
 */
export function firstWorkedLeaveDay(
  days: readonly TimeOffRequestDay[],
  entries: readonly WorkedEntryInput[],
): BusinessDate | null {
  for (const day of days) {
    if (!day.chargeable) continue;
    for (const entry of entries) {
      if (day.portion === 'whole') {
        if (manilaDateOf(entry.timeIn) === day.date) return day.date;
        continue;
      }
      const dayStart = manilaDayStartMinute(day.date);
      const from = epochMinuteOf(entry.timeIn) - dayStart;
      const to = entry.timeOut ? epochMinuteOf(entry.timeOut) - dayStart : from + 1;
      if (intervalsOverlap(day.intervals, [{ from, to: Math.max(to, from + 1) }])) return day.date;
    }
  }
  return null;
}
