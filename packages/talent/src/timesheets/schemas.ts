import { z } from 'zod';
import { ratio, TIMESHEET_TYPES, type TimesheetType } from '@pulse/core';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 and
// docs/DATA_MODEL.md#versioned-configuration (`talent.workSchedule`, `talent.timesheetSettings`;
// decisions 214–216 in docs/BUILD_PLAN.md). Pure code, safe in the browser: the Work schedule
// segment, the "Set schedule" sheet and the services parse with the same schemas.
//
// Self-contained on purpose: `payroll/schemas.ts` registers these two schemas under its setting
// keys, so this file must not import from it.

/** Minutes in a day. */
export const MINUTES_PER_DAY = 1440;

/** The ISO weekdays, Monday (1) to Sunday (7). */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoWeekday = (typeof ISO_WEEKDAYS)[number];
export const ISO_WEEKDAY_LABELS: Record<IsoWeekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};
export const ISO_WEEKDAY_SHORT_LABELS: Record<IsoWeekday, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

/** The break's length runs from 0 to 180 minutes. */
export const BREAK_MINUTES_MAX = 180;
/** The grace period for lates runs from 0 to 60 minutes (the DTR uses it from step 2.7). */
export const GRACE_MINUTES_MAX = 60;
/** Scheduled minutes (span less break) run from 60 to 1,440. */
export const SCHEDULED_MINUTES_MIN = 60;
export const SCHEDULED_MINUTES_MAX = MINUTES_PER_DAY;

/** A schedule assignment's reason: required, up to 300 characters. */
export const SCHEDULE_REASON_MAX_LENGTH = 300;
/** A time entry's activity: required once it has a time out, 1 to 500 characters. */
export const TIME_ENTRY_ACTIVITY_MAX_LENGTH = 500;
/** The extra-hours mark's reason: 1 to 300 characters. */
export const EXTRA_HOURS_REASON_MAX_LENGTH = 300;

/** Where a time came from: the server's clock (Time in, Time out) or typed by hand. */
export const TIME_ENTRY_SOURCES = ['clock', 'manual'] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

/**
 * A timesheet's status (step 2.7, decision 278; docs/modules/talent.md#timesheet-approval-the-dtr-
 * and-the-offset-balance-build-step-27). `open` and `returned` are filled in by the employee; the
 * two pending statuses wait for an approver; `approved` is final and locked for good.
 */
export const TIMESHEET_STATUSES = [
  'open',
  'pendingSupervisor',
  'pendingHr',
  'returned',
  'approved',
] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

/**
 * Each status's label. `open` reads "Open" only until the cut-off ends; after it, "Not submitted"
 * ("Overdue" after the deadline): see `timesheetStatusText` in `submission.ts`.
 */
export const TIMESHEET_STATUS_LABELS: Record<TimesheetStatus, string> = {
  open: 'Open',
  pendingSupervisor: 'Waiting for supervisor',
  pendingHr: 'Waiting for HR',
  returned: 'Returned',
  approved: 'Approved',
};

/** The statuses whose time entries and reimbursement lines may change, and that may be submitted. */
export const TIMESHEET_EDITABLE_STATUSES = [
  'open',
  'returned',
] as const satisfies readonly TimesheetStatus[];
export type TimesheetEditableStatus = (typeof TIMESHEET_EDITABLE_STATUSES)[number];

/** The statuses waiting for an approver's decision. */
export const TIMESHEET_PENDING_STATUSES = [
  'pendingSupervisor',
  'pendingHr',
] as const satisfies readonly TimesheetStatus[];
export type TimesheetPendingStatus = (typeof TIMESHEET_PENDING_STATUSES)[number];

/** True while the timesheet's entries and lines may change: `open` or `returned`. */
export function isTimesheetEditable(status: TimesheetStatus): status is TimesheetEditableStatus {
  return (TIMESHEET_EDITABLE_STATUSES as readonly TimesheetStatus[]).includes(status);
}

/** True while the timesheet waits for the supervisor or HR. */
export function isTimesheetPending(status: TimesheetStatus): status is TimesheetPendingStatus {
  return (TIMESHEET_PENDING_STATUSES as readonly TimesheetStatus[]).includes(status);
}

/** The refusal of a change to a pending timesheet's entries or lines. */
export const TIMESHEET_PENDING_MESSAGE =
  "This timesheet is waiting for approval, so it can't change. Ask your approver to return it if something needs fixing.";
/** The refusal of a change to an approved timesheet's entries or lines. */
export const TIMESHEET_APPROVED_MESSAGE = 'This timesheet is approved and locked.';

/** Why the timesheet's entries and lines can't change, or null while `open` or `returned`. */
export function timesheetLockedMessage(status: TimesheetStatus): string | null {
  if (isTimesheetEditable(status)) return null;
  return status === 'approved' ? TIMESHEET_APPROVED_MESSAGE : TIMESHEET_PENDING_MESSAGE;
}

/** A return's remarks: required, up to 1,000 characters. */
export const RETURN_REMARKS_MAX_LENGTH = 1000;

// ---------------------------------------------------------------------------------------------
// Clock times

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** A clock time `HH:MM` (00:00 to 23:59). */
export const clockTimeField = z
  .string({ error: 'Enter a time, like 08:00.' })
  .trim()
  .regex(TIME, 'Enter a time as HH:MM, like 08:00.');

/** The minutes after midnight of an `HH:MM` time (`"08:30"` → 510). */
export function minutesOfClockTime(time: string): number {
  if (!TIME.test(time)) throw new RangeError(`"${time}" is not a time in HH:MM form.`);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

// ---------------------------------------------------------------------------------------------
// talent.workSchedule (and an employee's own schedule)

const wholeMinutes = (max: number, what: string) =>
  z
    .number({ error: `Enter the ${what} in minutes.` })
    .int(`Enter the ${what} in whole minutes.`)
    .min(0, `The ${what} runs from 0 to ${max} minutes.`)
    .max(max, `The ${what} runs from 0 to ${max} minutes.`);

const workScheduleFields = z.object({
  workDays: z
    .array(
      z
        .number({ error: 'Choose the work days.' })
        .int('Choose the work days.')
        .min(1, 'Choose the work days from Monday to Sunday.')
        .max(7, 'Choose the work days from Monday to Sunday.'),
      { error: 'Choose the work days.' },
    )
    .min(1, 'Choose at least one work day.'),
  start: clockTimeField,
  end: clockTimeField,
  breakStart: clockTimeField,
  breakMinutes: wholeMinutes(BREAK_MINUTES_MAX, 'break'),
  graceMinutes: wholeMinutes(GRACE_MINUTES_MAX, 'grace period'),
});

/** The schedule's span from start to end, in minutes: an end at or before the start is the next day. */
export function scheduleSpanMinutes(schedule: Pick<WorkSchedule, 'start' | 'end'>): number {
  const start = minutesOfClockTime(schedule.start);
  const end = minutesOfClockTime(schedule.end);
  return end > start ? end - start : end + MINUTES_PER_DAY - start;
}

/** Minutes from the schedule's start to its break's start (the break may be after midnight). */
export function breakOffsetMinutes(schedule: Pick<WorkSchedule, 'start' | 'breakStart'>): number {
  const start = minutesOfClockTime(schedule.start);
  const breakStart = minutesOfClockTime(schedule.breakStart);
  return (breakStart - start + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** The schedule's scheduled minutes: its span less its break. */
export function scheduledMinutes(
  schedule: Pick<WorkSchedule, 'start' | 'end' | 'breakMinutes'>,
): number {
  return scheduleSpanMinutes(schedule) - schedule.breakMinutes;
}

/** True when the schedule ends the next day (its end is at or before its start). */
export function isOvernightSchedule(schedule: Pick<WorkSchedule, 'start' | 'end'>): boolean {
  return minutesOfClockTime(schedule.end) <= minutesOfClockTime(schedule.start);
}

/**
 * A work schedule: the company default (`talent.workSchedule`) or an employee's own. Work days are
 * ISO weekdays (1 Monday to 7 Sunday), unique; an end at or before the start ends the next day;
 * the break lies inside the span; the scheduled minutes (span less break) run from 60 to 1,440.
 */
export const workScheduleSchema = workScheduleFields.superRefine((value, ctx) => {
  if (new Set(value.workDays).size !== value.workDays.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['workDays'],
      message: 'Each work day can appear only once.',
    });
  }
  if (!TIME.test(value.start) || !TIME.test(value.end) || !TIME.test(value.breakStart)) return;
  const span = scheduleSpanMinutes(value);
  if (breakOffsetMinutes(value) + value.breakMinutes > span) {
    ctx.addIssue({
      code: 'custom',
      path: ['breakStart'],
      message: 'The break must fall inside the schedule, between its start and end.',
    });
    return;
  }
  const scheduled = span - value.breakMinutes;
  if (scheduled < SCHEDULED_MINUTES_MIN || scheduled > SCHEDULED_MINUTES_MAX) {
    ctx.addIssue({
      code: 'custom',
      path: ['end'],
      message: 'The schedule must have 1 to 24 hours of work after the break.',
    });
  }
});
export type WorkSchedule = z.output<typeof workScheduleSchema>;
export type WorkScheduleInput = z.input<typeof workScheduleSchema>;

// ---------------------------------------------------------------------------------------------
// talent.timesheetSettings

/** How a timesheet type treats claimed extra hours. */
export const EXTRA_HOURS_TREATMENTS = ['overtime', 'offset'] as const;
export type ExtraHoursTreatment = (typeof EXTRA_HOURS_TREATMENTS)[number];
export const EXTRA_HOURS_TREATMENT_LABELS: Record<ExtraHoursTreatment, string> = {
  overtime: 'Overtime',
  offset: 'Offset hours',
};

const DECIMAL = /^\d{1,6}(?:\.\d{1,6})?$/;

const treatmentField = z.enum(EXTRA_HOURS_TREATMENTS, { error: 'Choose overtime or offset.' });

/** The submission deadline runs from 1 to 10 days after the cut-off (step 2.7, decision 279). */
export const SUBMISSION_DEADLINE_DAYS_MIN = 1;
export const SUBMISSION_DEADLINE_DAYS_MAX = 10;
/**
 * The spec's default deadline, read when a stored version has no `submissionDeadlineDays` (the
 * seeded 2000-01-01 version included), so no new version is seeded. *Assumption, to be confirmed
 * by HR* (HANDOFF item 123).
 */
export const DEFAULT_SUBMISSION_DEADLINE_DAYS = 1;

const deadlineDaysMessage = `Enter ${SUBMISSION_DEADLINE_DAYS_MIN} to ${SUBMISSION_DEADLINE_DAYS_MAX} days.`;

export const timesheetSettingsSchema = z.object({
  /** Offset hours per hour of claimed extra work, a decimal string above 0 ("1", "1.5"). */
  offsetRatio: z
    .string({ error: 'Enter the offset ratio, like 1.' })
    .trim()
    .regex(DECIMAL, 'Enter the offset ratio as a decimal number, like 1 or 1.5.')
    .refine((value) => !DECIMAL.test(value) || ratio(value).numerator > 0n, {
      message: 'Enter an offset ratio above 0.',
    }),
  /** The treatment of claimed extra hours, for each timesheet type. */
  extraHours: z.object(
    Object.fromEntries(TIMESHEET_TYPES.map((type) => [type, treatmentField])) as Record<
      TimesheetType,
      typeof treatmentField
    >,
  ),
  /**
   * Step 2.7: the submission deadline, in days after the cut-off ends (1 to 10). Optional: a
   * version stored without it reads as {@link DEFAULT_SUBMISSION_DEADLINE_DAYS} through
   * `submissionDeadlineDaysOf`. Never read the field directly.
   */
  submissionDeadlineDays: z
    .number({ error: 'Enter the submission deadline in days.' })
    .int('Enter the submission deadline in whole days.')
    .min(SUBMISSION_DEADLINE_DAYS_MIN, deadlineDaysMessage)
    .max(SUBMISSION_DEADLINE_DAYS_MAX, deadlineDaysMessage)
    .optional(),
});
export type TimesheetSettings = z.output<typeof timesheetSettingsSchema>;

/** The submission deadline in days after the cut-off: the stored value, or 1 when absent. */
export function submissionDeadlineDaysOf(
  settings: Pick<TimesheetSettings, 'submissionDeadlineDays'>,
): number {
  return settings.submissionDeadlineDays ?? DEFAULT_SUBMISSION_DEADLINE_DAYS;
}
