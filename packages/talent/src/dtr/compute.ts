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
  DTR_TIME_OFF_KINDS,
  DTR_TIME_OFF_PORTIONS,
  DTR_TIME_OFF_STATUSES,
  type DtrDayStatus,
  type DtrTimeOffKind,
  type DtrTimeOffPortion,
  type DtrTimeOffStatus,
} from './statuses';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record"), docs/COMPLIANCE.md#attendance-and-the-dtr-build-step-27 (decisions
// 288–291 in docs/BUILD_PLAN.md) — the Daily Time Record of one timesheet. Derived when read and
// never stored: it builds on step 2.4's `computeTimesheet` (worked minutes, extra hours, night
// differential, overtime by kind and offset) and adds each day's status, late and undertime
// minutes, and whether the day is final. No pay is computed here (step 2.9).
//
// Step 2.8 (docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28, "On
// the DTR"; decision 315) adds approved leave and offset time off. Holidays and rest days still
// come first. A day covered in full takes the time off's status; a day covered in part is
// `present` when worked, with late and undertime counted only against the scheduled intervals the
// time off doesn't cover, and otherwise the time off's status, with those uncovered minutes as
// `absentMinutes`. This refines HANDOFF item 138 for partly covered days.
//
// Units as in step 2.4: whole minutes on Manila time (UTC+8, no daylight saving), seconds dropped.
// Every rule marked *Assumption* in the spec is one of HANDOFF items 123–138 and 150–180.

// ---------------------------------------------------------------------------------------------
// Inputs

/** A covered window as clock times (`HH:MM`) on the day's schedule. */
export interface DtrClockInterval {
  fromTime: string;
  toTime: string;
}

/**
 * One day of an approved leave or offset time off request (step 2.8, decision 315). A request
 * over several days gives one per day; a day may carry more than one (two halves, one paid and one
 * unpaid, or leave on one half beside another request on the other). The server maps a request's
 * days to these; a pending request is never passed.
 */
export interface DtrTimeOffInput {
  date: BusinessDate;
  /** `onLeavePaid` or `leaveWithoutPay` for leave; `offsetPaid` for offset time off. */
  status: DtrTimeOffStatus;
  /** `part` is offset time off only, and needs `intervals`. */
  portion: DtrTimeOffPortion;
  /**
   * The covered windows on the day's schedule; they are clipped to its scheduled intervals, so
   * the break and time outside the schedule cover nothing. Required for `part`; for `whole` and
   * the halves they default to the whole schedule or its half. A clock time before the
   * schedule's start is on the next day (a night schedule), and so is a `toTime` at or before
   * its `fromTime`.
   */
  intervals?: readonly DtrClockInterval[];
  kind: DtrTimeOffKind;
  /** The type's short name ("VL"), or "Leave" for a confidential type to most viewers. */
  shortName: string;
  /** The `timeOffRequests` id. */
  requestId: string;
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
  /** Approved leave and offset time off (step 2.8), one per request per day. */
  timeOff?: readonly DtrTimeOffInput[];
}

// ---------------------------------------------------------------------------------------------
// Outputs

/** A covered scheduled interval, as instants on whole minutes. */
export interface DtrInterval {
  start: Date;
  end: Date;
}

/** One part of a DTR day's time off (step 2.8): one approved request on that day. */
export interface DtrTimeOffPart {
  requestId: string;
  kind: DtrTimeOffKind;
  status: DtrTimeOffStatus;
  portion: DtrTimeOffPortion;
  shortName: string;
  /** The scheduled intervals the part covers, in time order. */
  intervals: DtrInterval[];
  /** The scheduled minutes the part covers. */
  minutes: number;
}

/** A DTR day: step 2.4's hours of the day, with its status, late and undertime. */
export interface DtrDay extends TimesheetDayHours {
  status: DtrDayStatus;
  /**
   * The approved time off on the day, in input order. Empty on a holiday or rest day, which
   * time off never charges or overrides.
   */
  timeOff: DtrTimeOffPart[];
  /**
   * On a day time off covers in part and nothing was worked: the scheduled minutes it doesn't
   * cover (*Assumption*). Otherwise 0.
   */
  absentMinutes: number;
  /** 0, 0.5 or 1: the day's leave without pay, a half day counting 0.5. */
  leaveWithoutPayDays: number;
  /** The first counted time in (a closed entry's), or null when nothing was worked. */
  firstTimeIn: Date | null;
  /**
   * On a `present` day only: scheduled minutes before a first time in past the grace period,
   * counted from the first scheduled interval time off doesn't cover.
   */
  lateMinutes: number;
  /**
   * On a `present` day only: scheduled minutes after the first time in that neither an entry
   * nor time off covers.
   */
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
  /** Days of paid leave, a half day counting 0.5 (offset time off isn't leave). */
  paidLeaveDays: number;
  /** Days of leave without pay, a half day counting 0.5. */
  leaveWithoutPayDays: number;
  /** The scheduled minutes offset time off covers. */
  offsetMinutesUsed: number;
  absentMinutes: number;
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
// Intervals (epoch minutes)

interface Interval {
  start: number;
  end: number;
}

const MINUTES_PER_DAY = 24 * 60;

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function minutesIn(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, piece) => sum + piece.end - piece.start, 0);
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

/** The parts of `intervals` inside `window`. */
function clip(intervals: readonly Interval[], window: Interval): Interval[] {
  return intervals
    .map((piece) => ({
      start: Math.max(piece.start, window.start),
      end: Math.min(piece.end, window.end),
    }))
    .filter((piece) => piece.end > piece.start);
}

/** The schedule's span on a day, in epoch minutes. */
function spanOf(date: BusinessDate, schedule: WorkSchedule): Interval {
  const start = manilaDayStartMinute(date) + minutesOfClockTime(schedule.start);
  return { start, end: start + scheduleSpanMinutes(schedule) };
}

/** The schedule's working intervals on a day (its span less its break), in epoch minutes. */
function scheduledIntervals(date: BusinessDate, schedule: WorkSchedule): Interval[] {
  const span = spanOf(date, schedule);
  if (schedule.breakMinutes === 0) return [span];
  const breakStart = span.start + breakOffsetMinutes(schedule);
  return subtract(span, [{ start: breakStart, end: breakStart + schedule.breakMinutes }]);
}

/**
 * The halves of a scheduled day (decision 302; *Assumption*): the first runs from the scheduled
 * start to the break, the second from the end of the break to the scheduled end. With no break,
 * the span splits at its midpoint, rounded down to the minute.
 */
export function dtrDayHalves(
  date: BusinessDate,
  schedule: WorkSchedule,
): { firstHalf: DtrInterval; secondHalf: DtrInterval } {
  const span = spanOf(date, schedule);
  let firstEnd: number;
  let secondStart: number;
  if (schedule.breakMinutes === 0) {
    firstEnd = span.start + Math.floor((span.end - span.start) / 2);
    secondStart = firstEnd;
  } else {
    firstEnd = span.start + breakOffsetMinutes(schedule);
    secondStart = firstEnd + schedule.breakMinutes;
  }
  return {
    firstHalf: toInstants({ start: span.start, end: firstEnd }),
    secondHalf: toInstants({ start: secondStart, end: span.end }),
  };
}

function toInstants(interval: Interval): DtrInterval {
  return { start: new Date(interval.start * 60_000), end: new Date(interval.end * 60_000) };
}

/** A clock window on a day's schedule, in epoch minutes (times before the start: the next day). */
function clockWindow(
  date: BusinessDate,
  schedule: WorkSchedule,
  clock: DtrClockInterval,
): Interval {
  const dayStart = manilaDayStartMinute(date);
  const scheduleStart = minutesOfClockTime(schedule.start);
  const onSchedule = (time: string) => {
    const minute = minutesOfClockTime(time);
    return dayStart + minute + (minute < scheduleStart ? MINUTES_PER_DAY : 0);
  };
  const start = onSchedule(clock.fromTime);
  let end = onSchedule(clock.toTime);
  if (end <= start) end += MINUTES_PER_DAY;
  return { start, end };
}

/** The scheduled intervals one time off input covers on its day, in time order. */
function coveredIntervals(
  input: DtrTimeOffInput,
  schedule: WorkSchedule,
  scheduled: readonly Interval[],
): Interval[] {
  let windows: Interval[];
  if (input.intervals && input.intervals.length > 0) {
    windows = input.intervals.map((clock) => clockWindow(input.date, schedule, clock));
  } else if (input.portion === 'whole') {
    return [...scheduled];
  } else if (input.portion === 'firstHalf' || input.portion === 'secondHalf') {
    const half = dtrDayHalves(input.date, schedule)[input.portion];
    windows = [{ start: epochMinuteOf(half.start), end: epochMinuteOf(half.end) }];
  } else {
    throw new RangeError('Offset time off for part of a day needs its times.');
  }
  // Clip to the schedule, then merge overlapping windows so no minute counts twice.
  const pieces = windows
    .flatMap((window) => clip(scheduled, window))
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && piece.start <= last.end) last.end = Math.max(last.end, piece.end);
    else merged.push({ ...piece });
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Late and undertime

export interface LateAndUndertime {
  /** The first counted time in, or null when no closed entry has worked minutes. */
  firstTimeIn: Date | null;
  lateMinutes: number;
  undertimeMinutes: number;
}

/**
 * A day's late and undertime minutes against its schedule (decision 290; *Assumption*, HANDOFF
 * items 128, 129 and 138, refined by decision 315). Only closed entries count, as for worked
 * minutes.
 *
 * - **Late:** when the first time in is more than the grace period after the start of the first
 *   scheduled interval time off doesn't cover, the uncovered scheduled minutes from that start to
 *   the first time in (the break isn't late time); within the grace period, 0.
 * - **Undertime:** the uncovered scheduled minutes after the first time in that no entry covers,
 *   at the end or in the middle of the day.
 * - Work after the scheduled end makes up neither (Labor Code Art. 88).
 * - A day time off covers in full has neither.
 *
 * The caller applies these on `present` days only. `covered` is the time off on the day (step 2.8).
 */
export function lateAndUndertime(
  date: BusinessDate,
  schedule: WorkSchedule,
  entries: readonly TimeEntryHoursInput[],
  covered: readonly DtrInterval[] = [],
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

  const coveredMinutes = covered.map((piece) => ({
    start: epochMinuteOf(piece.start),
    end: epochMinuteOf(piece.end),
  }));
  const uncovered = scheduledIntervals(date, schedule).flatMap((piece) =>
    subtract(piece, coveredMinutes),
  );
  if (uncovered.length === 0) return { firstTimeIn: first.at, lateMinutes: 0, undertimeMinutes: 0 };

  const uncoveredStart = (uncovered[0] as Interval).start;
  const firstIn = first.minute;

  const lateMinutes =
    firstIn - uncoveredStart > schedule.graceMinutes
      ? uncovered.reduce(
          (sum, piece) => sum + overlap(piece, { start: uncoveredStart, end: firstIn }),
          0,
        )
      : 0;

  let undertimeMinutes = 0;
  for (const piece of uncovered) {
    if (piece.end <= firstIn) continue;
    const after = { start: Math.max(piece.start, firstIn), end: piece.end };
    undertimeMinutes += minutesIn(subtract(after, worked));
  }
  return { firstTimeIn: first.at, lateMinutes, undertimeMinutes };
}

// ---------------------------------------------------------------------------------------------
// The DTR

const TIME_OFF = new Set<string>(DTR_TIME_OFF_STATUSES);
const KINDS = new Set<string>(DTR_TIME_OFF_KINDS);
const PORTIONS = new Set<string>(DTR_TIME_OFF_PORTIONS);

function latest(...days: (BusinessDate | null | undefined)[]): BusinessDate {
  return days.filter((day): day is BusinessDate => !!day).reduce((a, b) => (b > a ? b : a));
}

function earliest(...days: (BusinessDate | null | undefined)[]): BusinessDate {
  return days.filter((day): day is BusinessDate => !!day).reduce((a, b) => (b < a ? b : a));
}

function assertTimeOff(input: DtrTimeOffInput): void {
  if (!TIME_OFF.has(input.status)) {
    throw new RangeError(`"${String(input.status)}" is not a time off status.`);
  }
  if (!KINDS.has(input.kind)) {
    throw new RangeError(`"${String(input.kind)}" is not a kind of time off.`);
  }
  if (!PORTIONS.has(input.portion)) {
    throw new RangeError(`"${String(input.portion)}" is not a portion of a day.`);
  }
  if ((input.kind === 'offset') !== (input.status === 'offsetPaid')) {
    throw new RangeError('Offset time off, and only offset time off, is "offsetPaid".');
  }
  if (input.portion === 'part' && input.kind !== 'offset') {
    throw new RangeError('Only offset time off covers part of a day.');
  }
}

/** Half days of a leave part: 2 for a whole day, 1 for a half (`part` is offset only). */
function halfDaysOf(portion: DtrTimeOffPortion): number {
  return portion === 'whole' ? 2 : portion === 'part' ? 0 : 1;
}

/** The time off status of a day with these parts: the first in `DTR_TIME_OFF_STATUSES` present. */
function timeOffStatusOf(parts: readonly DtrTimeOffPart[]): DtrTimeOffStatus {
  for (const status of DTR_TIME_OFF_STATUSES) {
    if (parts.some((part) => part.status === status)) return status;
  }
  throw new RangeError('A day with time off has at least one part.');
}

interface DayResult {
  day: DtrDay;
  paidLeaveHalfDays: number;
  unpaidHalfDays: number;
}

function dtrDayOf(
  hours: TimesheetDayHours,
  inputs: readonly DtrTimeOffInput[],
  entries: readonly TimeEntryHoursInput[],
  final: boolean,
): DayResult {
  const schedule = hours.schedule.schedule;
  const attendanceOf = (covered: readonly DtrInterval[]) =>
    lateAndUndertime(hours.date, schedule, entries, covered);
  const base = { ...hours, timeOff: [], absentMinutes: 0, leaveWithoutPayDays: 0, final };
  const unworked = (status: DtrDayStatus, firstTimeIn: Date | null): DayResult => ({
    day: { ...base, status, firstTimeIn, lateMinutes: 0, undertimeMinutes: 0 },
    paidLeaveHalfDays: 0,
    unpaidHalfDays: 0,
  });

  // Holidays and rest days come first (decision 289): time off never overrides or charges them.
  if (hours.kind === 'regularHoliday' || hours.kind === 'specialDay') {
    return unworked('holiday', attendanceOf([]).firstTimeIn);
  }
  if (hours.restDay) return unworked('restDay', attendanceOf([]).firstTimeIn);

  if (inputs.length === 0) {
    const attendance = attendanceOf([]);
    if (hours.workedMinutes === 0) return unworked('absentUnpaid', attendance.firstTimeIn);
    return {
      day: { ...base, status: 'present', ...attendance },
      paidLeaveHalfDays: 0,
      unpaidHalfDays: 0,
    };
  }

  const scheduled = scheduledIntervals(hours.date, schedule);
  const parts: DtrTimeOffPart[] = inputs.map((input) => {
    const intervals = coveredIntervals(input, schedule, scheduled);
    return {
      requestId: input.requestId,
      kind: input.kind,
      status: input.status,
      portion: input.portion,
      shortName: input.shortName,
      intervals: intervals.map(toInstants),
      minutes: minutesIn(intervals),
    };
  });
  const covered = parts.flatMap((part) => part.intervals);
  const coveredMinutes = covered.map((piece) => ({
    start: epochMinuteOf(piece.start),
    end: epochMinuteOf(piece.end),
  }));
  const uncoveredMinutes = minutesIn(scheduled.flatMap((piece) => subtract(piece, coveredMinutes)));

  const halvesOf = (status: DtrTimeOffStatus) =>
    Math.min(
      2,
      parts
        .filter((part) => part.status === status)
        .reduce((sum, part) => sum + halfDaysOf(part.portion), 0),
    );
  const paidLeaveHalfDays = halvesOf('onLeavePaid');
  const unpaidHalfDays = halvesOf('leaveWithoutPay');
  const attendance = attendanceOf(covered);
  const day = { ...base, timeOff: parts, leaveWithoutPayDays: unpaidHalfDays / 2 };

  // Covered in part and worked: present, late and undertime against the uncovered intervals.
  if (uncoveredMinutes > 0 && hours.workedMinutes > 0) {
    return {
      day: { ...day, status: 'present', ...attendance },
      paidLeaveHalfDays,
      unpaidHalfDays,
    };
  }
  // Covered in full (late and undertime 0), or in part with nothing worked (`absentMinutes`).
  return {
    day: {
      ...day,
      status: timeOffStatusOf(parts),
      firstTimeIn: attendance.firstTimeIn,
      lateMinutes: 0,
      undertimeMinutes: 0,
      absentMinutes: uncoveredMinutes,
    },
    paidLeaveHalfDays,
    unpaidHalfDays,
  };
}

/**
 * The Daily Time Record of one timesheet (decisions 288–291 and 315). Each day's hours are step
 * 2.4's (`computeTimesheet`); the DTR adds the day's status, its approved time off, late,
 * undertime and absent minutes, and `final` when the timesheet is approved. Night differential is
 * step 2.4's paid minutes in the night window (scheduled hours only under the offset treatment),
 * and the extra hours are step 2.4's overtime by kind or offset. A confirmed nationwide holiday is
 * never an absence; a special working day is a scheduled work day.
 */
export function computeDtr(input: DtrInput): Dtr {
  const from = latest(input.periodStart, input.dateHired, input.from);
  const to = earliest(input.periodEnd, input.separationDate, input.today, input.to);

  const timeOff = new Map<BusinessDate, DtrTimeOffInput[]>();
  for (const day of input.timeOff ?? []) {
    assertTimeOff(day);
    const list = timeOff.get(day.date);
    if (list) list.push(day);
    else timeOff.set(day.date, [day]);
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
    paidLeaveDays: 0,
    leaveWithoutPayDays: 0,
    offsetMinutesUsed: 0,
    absentMinutes: 0,
  };
  let paidLeaveHalfDays = 0;
  let unpaidHalfDays = 0;

  const days: DtrDay[] = hours.days.map((dayHours) => {
    const result = dtrDayOf(
      dayHours,
      timeOff.get(dayHours.date) ?? [],
      entriesByDate.get(dayHours.date) ?? [],
      final,
    );
    const day = result.day;
    counts[day.status] += 1;
    if (day.lateMinutes > 0) totals.lateDays += 1;
    totals.lateMinutes += day.lateMinutes;
    totals.undertimeMinutes += day.undertimeMinutes;
    totals.absentMinutes += day.absentMinutes;
    for (const part of day.timeOff) {
      if (part.kind === 'offset') totals.offsetMinutesUsed += part.minutes;
    }
    paidLeaveHalfDays += result.paidLeaveHalfDays;
    unpaidHalfDays += result.unpaidHalfDays;
    return day;
  });
  totals.paidLeaveDays = paidLeaveHalfDays / 2;
  totals.leaveWithoutPayDays = unpaidHalfDays / 2;

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
