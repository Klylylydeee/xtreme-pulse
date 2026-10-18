import { addDays, type BusinessDate, type EmploymentStatus, formatDate } from '@pulse/core';
import { addMonths, daysBetween } from '../derived';
import { type Sex, SEX_LABELS } from '../fixed-sets';
import type { PayrollSettings } from '../payroll/schemas';
import { epochMinuteOf, manilaDayStartMinute } from '../timesheets/compute';
import { type EffectiveVersion, timesheetPeriodFor } from '../timesheets/schedule';
import { formatShortDay, submissionDeadline } from '../timesheets/submission';
import {
  firstOverlapDay,
  firstWorkedLeaveDay,
  halfDaysByYear,
  type TimeOffCoverageDay,
  type TimeOffRequestDay,
  type WorkedEntryInput,
} from './days';
import {
  isHalfDayPortion,
  MY_RECORD_HREF,
  TIME_OFF_MAX_SPAN_DAYS,
  type TimeOffKind,
  type TimeOffPortion,
  type TimeOffStatus,
} from './kinds';
import type { LeaveSettings, LeaveType } from './settings';
import { formatDayCount, formatOffsetHours, halfDaysOf } from './units';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Filing
// a leave request", "Filing offset time off", "Approval", "Cancelling"; decisions 310, 312 and 314
// in docs/BUILD_PLAN.md) — what refuses a request, in the order the service checks it, and the
// words of each refusal. Pure: the service gathers the facts (the gate and the account are its
// own checks) and throws the first problem's message; the sheet shows the same words.

// ---------------------------------------------------------------------------------------------
// Problems

/** One reason a time off request is refused. */
export type TimeOffProblem =
  | { kind: 'typeInactive'; typeName: string }
  | { kind: 'status'; typeName: string; closedShortNames: string[]; status: EmploymentStatus }
  | { kind: 'sexMissing'; typeName: string; href: string }
  | { kind: 'sex'; typeName: string; sex: Sex }
  | { kind: 'serviceMonths'; typeName: string; months: number; eligibleOn: BusinessDate }
  | { kind: 'maxRequests'; typeName: string; maxRequests: number }
  | { kind: 'endBeforeStart' }
  | { kind: 'tooLong' }
  | { kind: 'portion'; portion: TimeOffPortion; timeOffKind: TimeOffKind }
  | {
      kind: 'notice';
      typeName: string;
      days: number;
      fileBy: BusinessDate;
      startDate: BusinessDate;
    }
  | { kind: 'future'; typeName: string }
  | { kind: 'past'; typeName: string }
  | { kind: 'deadlinePassed'; deadline: BusinessDate }
  | { kind: 'noChargeableDay' }
  | { kind: 'perEvent'; typeName: string; halfDays: number }
  | { kind: 'perYear'; typeName: string; halfDays: number; year: number; leftHalfDays: number }
  | { kind: 'overlap'; date: BusinessDate }
  | { kind: 'worked'; date: BusinessDate }
  | { kind: 'attachment'; label: string }
  | { kind: 'partOutsideSchedule' }
  | { kind: 'offsetStep'; stepMinutes: number }
  | { kind: 'offsetMinimum'; minimumMinutes: number }
  | { kind: 'offsetStarted' }
  | { kind: 'offsetBalance'; minutes: number; availableMinutes: number };

/** "Sick leave is filed on or after the sick day." for a type named "<x> leave". */
function dayWord(typeName: string): string {
  const base = typeName.replace(/\s+leave$/i, '').trim();
  return base === typeName ? 'day it covers' : `${base.toLowerCase()} day`;
}

/** The refusal of one problem, as the service throws it and the sheet shows it. */
export function timeOffProblemMessage(problem: TimeOffProblem): string {
  switch (problem.kind) {
    case 'typeInactive':
      return `${problem.typeName} is no longer offered. Choose another type.`;
    case 'status':
      if (problem.status === 'Probationary') {
        return `Probationary employees can’t use ${problem.closedShortNames.join(' or ')}. Any absence during probation is unpaid.`;
      }
      return `${problem.typeName} isn’t open to ${problem.status} employees.`;
    case 'sexMissing':
      return `Add your sex on My record first: ${problem.typeName.toLowerCase()} depends on it.`;
    case 'sex':
      return `${problem.typeName} is for ${SEX_LABELS[problem.sex].toLowerCase()} employees.`;
    case 'serviceMonths':
      return `${problem.typeName} needs ${problem.months} months of service since your date hired, so from ${formatDate(problem.eligibleOn)}.`;
    case 'maxRequests':
      return `${problem.typeName} can be approved at most ${problem.maxRequests} times. Ask HR.`;
    case 'endBeforeStart':
      return 'The last day can’t be before the first day.';
    case 'tooLong':
      return `A request covers at most ${TIME_OFF_MAX_SPAN_DAYS + 1} days. File it in parts.`;
    case 'portion':
      if (problem.portion === 'part') return 'Only offset time off can cover part of a day.';
      if (isHalfDayPortion(problem.portion)) {
        return problem.timeOffKind === 'offset'
          ? 'Offset time off covers whole days or part of a day.'
          : 'This leave type can’t be filed as a half day, and a half day is a single day.';
      }
      return 'Choose the part of the day.';
    case 'notice':
      return `${problem.typeName} must be filed at least ${problem.days} days before the first day, so by ${formatShortDay(problem.fileBy)} for ${formatShortDay(problem.startDate)}.`;
    case 'future':
      return `${problem.typeName} is filed on or after the ${dayWord(problem.typeName)}.`;
    case 'past':
      return `${problem.typeName} can’t be filed for a past day.`;
    case 'deadlinePassed':
      return 'The timesheet deadline for that cut-off has passed. Ask HR.';
    case 'noChargeableDay':
      return 'These days are all rest days or holidays.';
    case 'perEvent':
      return `${problem.typeName} covers up to ${formatDayCount(problem.halfDays)} per request.`;
    case 'perYear':
      return `${problem.typeName} covers up to ${formatDayCount(problem.halfDays)} a year. You have ${formatDayCount(problem.leftHalfDays)} left for ${problem.year}.`;
    case 'overlap':
      return `You already have time off on ${formatShortDay(problem.date)}.`;
    case 'worked':
      return `You worked on ${formatShortDay(problem.date)}. Leave can’t cover a day with time entries.`;
    case 'attachment':
      return `Attach the ${problem.label.charAt(0).toLowerCase()}${problem.label.slice(1)}.`;
    case 'partOutsideSchedule':
      return 'Choose times inside your schedule, the end after the start.';
    case 'offsetStep':
      return `Offset time off is taken in ${problem.stepMinutes}-minute steps.`;
    case 'offsetMinimum':
      return `Offset time off is at least ${formatOffsetHours(problem.minimumMinutes)}.`;
    case 'offsetStarted':
      return 'Offset time off must start after you file it. It can’t cover an absence, a late or undertime.';
    case 'offsetBalance':
      return problem.availableMinutes <= 0
        ? 'You have no offset hours available.'
        : `This needs ${formatOffsetHours(problem.minutes)}, more than your available offset balance of ${formatOffsetHours(problem.availableMinutes)}.`;
  }
}

/** The link a problem offers: My record for a missing sex. */
export function timeOffProblemHref(problem: TimeOffProblem): string | null {
  return problem.kind === 'sexMissing' ? problem.href : null;
}

// ---------------------------------------------------------------------------------------------
// Eligibility

/** True when `months` whole months since the date hired have passed on `today`. */
export function serviceMonthsMet(
  dateHired: BusinessDate,
  today: BusinessDate,
  months: number,
): boolean {
  return today >= addMonths(dateHired, months);
}

/** What eligibility reads. */
export interface LeaveEligibilityFacts {
  type: LeaveType;
  /** The employment status today. */
  employmentStatus: EmploymentStatus;
  /** The employee record's sex, or null when empty. */
  sex: Sex | null;
  dateHired: BusinessDate;
  today: BusinessDate;
  /** The employee's approved requests of this type ever with the company (for `maxRequests`). */
  approvedRequestCount: number;
  /**
   * The version's types, so a Probationary refusal names every type closed to probation ("VL or
   * SL"); without it, only this type.
   */
  allTypes?: readonly LeaveType[];
}

/** True when the type is open to the employment status. */
export function isOpenTo(type: Pick<LeaveType, 'eligibility'>, status: EmploymentStatus): boolean {
  return (type.eligibility.employmentStatuses as readonly string[]).includes(status);
}

/** The type is active, and the status, sex, service months and `maxRequests` are met. */
export function leaveEligibilityProblems(facts: LeaveEligibilityFacts): TimeOffProblem[] {
  const { type } = facts;
  const problems: TimeOffProblem[] = [];
  if (!type.active) problems.push({ kind: 'typeInactive', typeName: type.name });
  if (!isOpenTo(type, facts.employmentStatus)) {
    const closed = (facts.allTypes ?? [type])
      .filter((other) => other.active && !isOpenTo(other, facts.employmentStatus))
      .map((other) => other.shortName);
    problems.push({
      kind: 'status',
      typeName: type.name,
      closedShortNames: closed.includes(type.shortName) ? closed : [type.shortName],
      status: facts.employmentStatus,
    });
  }
  if (type.eligibility.sex !== null) {
    if (facts.sex === null) {
      problems.push({ kind: 'sexMissing', typeName: type.name, href: MY_RECORD_HREF });
    } else if (facts.sex !== type.eligibility.sex) {
      problems.push({ kind: 'sex', typeName: type.name, sex: type.eligibility.sex });
    }
  }
  const months = type.eligibility.minServiceMonths;
  if (months !== null && !serviceMonthsMet(facts.dateHired, facts.today, months)) {
    problems.push({
      kind: 'serviceMonths',
      typeName: type.name,
      months,
      eligibleOn: addMonths(facts.dateHired, months),
    });
  }
  const max = type.eligibility.maxRequests;
  if (max !== null && facts.approvedRequestCount >= max) {
    problems.push({ kind: 'maxRequests', typeName: type.name, maxRequests: max });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The days and the portion

/** A multi-day request is whole days; a half is a single day of a type with half days; a part is offset's. */
export function timeOffSpanProblems(input: {
  kind: TimeOffKind;
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  /** Leave: the type's `halfDays`. */
  halfDaysAllowed?: boolean;
}): TimeOffProblem[] {
  const problems: TimeOffProblem[] = [];
  if (input.endDate < input.startDate) problems.push({ kind: 'endBeforeStart' });
  else if (daysBetween(input.startDate, input.endDate) > TIME_OFF_MAX_SPAN_DAYS) {
    problems.push({ kind: 'tooLong' });
  }
  const single = input.startDate === input.endDate;
  const allowed =
    input.portion === 'whole' ||
    (input.portion === 'part' && input.kind === 'offset' && single) ||
    (isHalfDayPortion(input.portion) &&
      input.kind === 'leave' &&
      single &&
      input.halfDaysAllowed === true);
  if (!allowed) problems.push({ kind: 'portion', portion: input.portion, timeOffKind: input.kind });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The filing window

/**
 * The timesheet deadline of the cut-off holding `startDate` (*Assumption*, item 156): a past day
 * may be filed until the end of that day. `deadlineDays` is the timesheet settings' deadline on the
 * period end, as step 2.7 reads it.
 */
export function firstDayFilingDeadline(
  startDate: BusinessDate,
  payrollVersions: readonly EffectiveVersion<Pick<PayrollSettings, 'cutOffs'>>[],
  deadlineDays: number,
): BusinessDate {
  return submissionDeadline(timesheetPeriodFor(startDate, payrollVersions).end, deadlineDays);
}

/** The last day VL may be filed for `startDate`: `startDate − minNoticeDays`, or null without notice. */
export function leaveFileByDate(
  type: Pick<LeaveType, 'filing'>,
  startDate: BusinessDate,
): BusinessDate | null {
  const notice = type.filing.minNoticeDays;
  return notice === null ? null : addDays(startDate, -notice);
}

/**
 * The filing window in Manila days from today (decision 310; checked again on each resend): the
 * notice, no future day without `allowFuture`, no past day without `allowPast`, and a past day
 * only until the deadline of its first day's cut-off (`firstDayDeadline`, needed only then).
 */
export function leaveFilingWindowProblems(input: {
  type: Pick<LeaveType, 'name' | 'filing'>;
  startDate: BusinessDate;
  endDate: BusinessDate;
  today: BusinessDate;
  firstDayDeadline: BusinessDate | null;
}): TimeOffProblem[] {
  const { type, startDate, endDate, today } = input;
  const problems: TimeOffProblem[] = [];
  const notice = type.filing.minNoticeDays;
  if (notice !== null && daysBetween(today, startDate) < notice) {
    problems.push({
      kind: 'notice',
      typeName: type.name,
      days: notice,
      fileBy: addDays(startDate, -notice),
      startDate,
    });
  }
  if (!type.filing.allowFuture && endDate > today) {
    problems.push({ kind: 'future', typeName: type.name });
  }
  if (startDate < today) {
    if (!type.filing.allowPast) {
      problems.push({ kind: 'past', typeName: type.name });
    } else if (input.firstDayDeadline === null || today > input.firstDayDeadline) {
      problems.push({ kind: 'deadlinePassed', deadline: input.firstDayDeadline ?? today });
    }
  }
  return problems;
}

/**
 * The window under the date inputs: "File VL by Oct 15 for Oct 29", "File SL on or after the sick
 * day", or null when the type has no rule worth showing.
 */
export function leaveFilingWindowText(
  type: Pick<LeaveType, 'name' | 'shortName' | 'filing'>,
  startDate: BusinessDate | null,
): string | null {
  const notice = type.filing.minNoticeDays;
  if (notice !== null) {
    if (!startDate) return `File ${type.shortName} at least ${notice} days ahead`;
    return `File ${type.shortName} by ${formatShortDay(addDays(startDate, -notice))} for ${formatShortDay(startDate)}`;
  }
  if (!type.filing.allowFuture) {
    return `File ${type.shortName} on or after the ${dayWord(type.name)}, by its cut-off’s timesheet deadline`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Chargeable days and limits

/**
 * At least one chargeable day, and within a `perEvent` type's days per request or a `perYear`
 * type's days in each calendar year (approved and pending requests, *Assumption*, item 179).
 * Over a limit is refused, never unpaid.
 */
export function leaveLimitProblems(input: {
  type: Pick<LeaveType, 'name' | 'balance' | 'days'>;
  days: readonly TimeOffRequestDay[];
  /** `perYear`: the employee's other approved and pending requests' half days by year. */
  otherHalfDaysByYear?: ReadonlyMap<number, number>;
}): TimeOffProblem[] {
  const { type, days } = input;
  const byYear = halfDaysByYear(days);
  let total = 0;
  for (const halfDays of byYear.values()) total += halfDays;
  if (total === 0) return [{ kind: 'noChargeableDay' }];
  const limit = halfDaysOf(type.days);
  if (type.balance === 'perEvent' && total > limit) {
    return [{ kind: 'perEvent', typeName: type.name, halfDays: limit }];
  }
  if (type.balance === 'perYear') {
    for (const [year, halfDays] of [...byYear].sort(([a], [b]) => a - b)) {
      const used = input.otherHalfDaysByYear?.get(year) ?? 0;
      if (used + halfDays > limit) {
        return [
          {
            kind: 'perYear',
            typeName: type.name,
            halfDays: limit,
            year,
            leftHalfDays: Math.max(0, limit - used),
          },
        ];
      }
    }
  }
  return [];
}

/** At least one chargeable day (offset time off). */
export function noChargeableDayProblems(days: readonly TimeOffRequestDay[]): TimeOffProblem[] {
  return days.some((day) => day.chargeable) ? [] : [{ kind: 'noChargeableDay' }];
}

// ---------------------------------------------------------------------------------------------
// Overlap, worked time and the attachment

/** No overlap with the employee's pending or approved time off. */
export function timeOffOverlapProblems(
  days: readonly TimeOffCoverageDay[],
  others: readonly TimeOffCoverageDay[],
): TimeOffProblem[] {
  const date = firstOverlapDay(days, others);
  return date ? [{ kind: 'overlap', date }] : [];
}

/** No leave over a portion of a day with worked time entries (*Assumption*, item 160). */
export function workedLeaveProblems(
  days: readonly TimeOffRequestDay[],
  entries: readonly WorkedEntryInput[],
): TimeOffProblem[] {
  const date = firstWorkedLeaveDay(days, entries);
  return date ? [{ kind: 'worked', date }] : [];
}

/** The attachment when the type requires one. */
export function leaveAttachmentProblems(
  type: Pick<LeaveType, 'attachment'>,
  hasAttachment: boolean,
): TimeOffProblem[] {
  return type.attachment?.required && !hasAttachment
    ? [{ kind: 'attachment', label: type.attachment.label }]
    : [];
}

// ---------------------------------------------------------------------------------------------
// Offset time off

/** What the offset time off checks read. */
export interface OffsetTimeOffFacts {
  settings: Pick<LeaveSettings, 'offsetTimeOff'>;
  portion: TimeOffPortion;
  /** The request's days (`timeOffRequestDays` with `workDays`). */
  days: readonly TimeOffRequestDay[];
  /** `part` only: the start of the part, `HH:MM`. */
  fromTime?: string | null;
  /** The moment of filing (or of sending again). */
  filedAt: Date;
  /** The available offset balance: the balance less other pending offset time off. */
  availableMinutes: number;
}

/**
 * Offset time off (decision 312; *Assumption*, item 162): a part lies in the schedule, in
 * `stepMinutes` steps; the minutes are at least `minimumMinutes`; it starts after the moment of
 * filing (whole days from tomorrow, a part later today); and it fits the available balance. Whole
 * days use each day's scheduled minutes, so the step applies to a part only (*Assumption*).
 */
export function offsetTimeOffProblems(facts: OffsetTimeOffFacts): TimeOffProblem[] {
  const { days, settings } = facts;
  const { minimumMinutes, stepMinutes } = settings.offsetTimeOff;
  const problems: TimeOffProblem[] = [];
  if (!days.some((day) => day.chargeable)) return [{ kind: 'noChargeableDay' }];
  const minutes = days.reduce((total, day) => total + (day.chargeable ? day.minutes : 0), 0);
  if (facts.portion === 'part') {
    if (minutes === 0) return [{ kind: 'partOutsideSchedule' }];
    if (minutes % stepMinutes !== 0) problems.push({ kind: 'offsetStep', stepMinutes });
  }
  if (minutes < minimumMinutes) problems.push({ kind: 'offsetMinimum', minimumMinutes });
  const filedMinute = epochMinuteOf(facts.filedAt);
  const first = days[0];
  if (first) {
    const startMinute =
      manilaDayStartMinute(first.date) +
      (facts.portion === 'part' ? (first.intervals[0]?.from ?? 0) : 0);
    // A whole day starts at its 00:00 (so only from tomorrow); a part at its first covered minute.
    if (startMinute <= filedMinute) problems.push({ kind: 'offsetStarted' });
  }
  if (minutes > facts.availableMinutes) {
    problems.push({ kind: 'offsetBalance', minutes, availableMinutes: facts.availableMinutes });
  }
  return problems;
}

/** The approval hook's refusal when the offset balance no longer covers the request. */
export const OFFSET_NO_LONGER_COVERED_MESSAGE =
  'The offset balance no longer covers this request. Return or reject it.';

// ---------------------------------------------------------------------------------------------
// Status moves and cancelling

/** What moves a request's status. A pending request can't be withdrawn (the engine has none). */
export const TIME_OFF_MOVES = ['approve', 'return', 'reject', 'resend', 'cancel'] as const;
export type TimeOffMove = (typeof TIME_OFF_MOVES)[number];

/** The status after `move` from `from`, or null when it isn't allowed. */
export function nextTimeOffStatus(from: TimeOffStatus, move: TimeOffMove): TimeOffStatus | null {
  switch (move) {
    case 'approve':
      return from === 'pending' ? 'approved' : null;
    case 'return':
      return from === 'pending' ? 'returned' : null;
    case 'reject':
      return from === 'pending' ? 'rejected' : null;
    case 'resend':
      return from === 'returned' ? 'pending' : null;
    case 'cancel':
      return from === 'returned' || from === 'approved' ? 'cancelled' : null;
  }
}

/**
 * The employee may cancel a returned request, or an approved one before its first day
 * (*Assumption*, item 166).
 */
export function canCancelTimeOff(
  request: { status: TimeOffStatus; startDate: BusinessDate },
  today: BusinessDate,
): boolean {
  if (request.status === 'returned') return true;
  return request.status === 'approved' && today < request.startDate;
}

/** The refusal of a cancel from the first day on. */
export const TIME_OFF_CANCEL_STARTED_MESSAGE =
  'This time off has started, so it can’t be cancelled. Ask HR.';
