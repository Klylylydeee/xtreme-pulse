import type { BusinessDate, TimesheetType } from '@pulse/core';
import type { CutOffKey } from '../payroll/schemas';
import type { DayHours, EntryHours, TimesheetTotals } from './compute';
import type { ScheduleOnDay } from './schedule';
import type {
  ExtraHoursTreatment,
  TimeEntrySource,
  TimesheetStatus,
  WorkSchedule,
} from './schemas';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Screens") and
// docs/DESIGN_SYSTEM.md#layout--components ("Timesheets on a phone") — what the timesheet and
// work schedule services send to the pages. Types and names only, safe in the browser. Hours are
// whole minutes; the page formats them with `formatHours` after adding them up.

/** A work schedule assignment's audit record type. */
export const WORK_SCHEDULE_ASSIGNMENT_TYPE = 'talent.workScheduleAssignment';
/** A time entry's audit record type. */
export const TIME_ENTRY_TYPE = 'talent.timeEntry';

/** The disabled pickers' notes (no project or ticket is stored until Phases 4 and 6). */
export const PROJECT_PICKER_NOTE = 'Available when Pulse Ops is set up';
export const TICKET_PICKER_NOTE = 'Available when Pulse Desk is set up';
/** The hint on extra minutes that aren't claimed. */
export const NOT_CLAIMED_HINT: Record<ExtraHoursTreatment, string> = {
  overtime: 'Mark it as overtime and give a reason',
  offset: 'Mark it as offset and give a reason',
};
/** The switch on the entry sheet. */
export const EXTRA_HOURS_SWITCH_LABEL: Record<ExtraHoursTreatment, string> = {
  overtime: 'Count extra hours as overtime',
  offset: 'Count extra hours as offset',
};
/** The header's type label: "Overtime timesheet" or "Standard timesheet". */
export const TIMESHEET_TYPE_TITLES: Record<TimesheetType, string> = {
  overtime: 'Overtime timesheet',
  standard: 'Standard timesheet',
};
/** The stale-save refusal. */
export const STALE_ENTRY_MESSAGE = 'Someone else changed this entry. Reload to see it.';

// ---------------------------------------------------------------------------------------------
// Work schedules

/** One `workScheduleAssignments` entry, for the history. */
export interface WorkScheduleAssignmentView {
  id: string;
  effectiveFrom: BusinessDate;
  /** Null: "back to the company default". */
  schedule: WorkSchedule | null;
  reason: string;
  createdAt: Date;
}

/** The Work schedule section of the inspector and `/talent/me`. */
export interface WorkScheduleSectionView {
  /** The day `current` is for (today, or the date hired when that is later). */
  asOf: BusinessDate;
  /** The schedule in effect on `asOf`, and where it comes from. */
  current: ScheduleOnDay;
  /** The schedule's scheduled minutes (span less break). */
  currentScheduledMinutes: number;
  /** Assignments taking effect after `asOf`, soonest first. */
  scheduled: WorkScheduleAssignmentView[];
  /** Every assignment, newest first. */
  history: WorkScheduleAssignmentView[];
  /** Talent Write and HR or the System Administrator, never on one's own record: "Set schedule". */
  canSet: boolean;
  /** The earliest and latest effective dates "Set schedule" accepts (date hired, a year ahead). */
  earliestEffectiveFrom?: BusinessDate;
  latestEffectiveFrom?: BusinessDate;
}

// ---------------------------------------------------------------------------------------------
// Timesheets

/** A timesheet's stored fields. */
export interface TimesheetRecordView {
  /** Null when the timesheet isn't created yet (another person's, shown read-only, no entries). */
  id: string | null;
  employeeId: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  payDate: BusinessDate;
  cutOffKey: CutOffKey;
  /** Read once when the timesheet was created; never changed. */
  timesheetType: TimesheetType;
  typeReadOn: BusinessDate;
  status: TimesheetStatus;
}

/** One time entry, with its computed hours. */
export interface TimeEntryView {
  id: string;
  /** The Manila day of its time in. */
  date: BusinessDate;
  timeIn: Date;
  timeOut: Date | null;
  timeInSource: TimeEntrySource;
  /** Null while open. "Manual" shows on each `manual` side. */
  timeOutSource: TimeEntrySource | null;
  /** Null only on an open entry that has none yet. */
  activity: string | null;
  client: { id: string; name: string } | null;
  extraHours: { reason: string } | null;
  /** True when the time out is on a later Manila day ("Next day"). */
  endsNextDay: boolean;
  /** Sent back with every save; a stale one is refused. */
  version: number;
  hours: EntryHours;
}

/** One day row of the day list. */
export interface TimesheetDayView {
  /** The day's hours (worked, extra, claimed, by kind, offset), without the per-entry hours. */
  hours: Omit<DayHours, 'entries'>;
  /** "Rest day", "Regular holiday on a rest day", … */
  kindLabel: string;
  /** The day's entries in time-in order, each with its hours. */
  entries: TimeEntryView[];
}

/** The Today card: only on today's cut-off. */
export interface TimesheetTodayView {
  date: BusinessDate;
  workedMinutes: number;
  scheduledMinutes: number;
  /** True on a work day of the schedule that isn't a holiday. */
  workDay: boolean;
  /** The open entry ("Timed in 7:58 AM"), or null: the button reads Time in or Time out. */
  openEntry: { id: string; timeIn: Date; hasActivity: boolean; version: number } | null;
}

/** A client option for the entry sheet (any live client, from Core). */
export interface TimesheetClientOption {
  id: string;
  name: string;
}

/** What Time in returns. */
export interface TimeInResult {
  entryId: string;
  timeIn: Date;
  version: number;
}

/**
 * What Time out returns: `timedOut`, or `activityRequired` when the open entry has no activity
 * and none was sent (the page opens the entry sheet, asks for it, and calls Time out again).
 */
export type TimeOutResult =
  | { status: 'timedOut'; entryId: string; timeOut: Date; version: number }
  | { status: 'activityRequired'; entryId: string; version: number };

/** A direct report on "My team", linking to their timesheet. */
export interface TeamMemberLink {
  employeeId: string;
  name: string;
  employeeNumber: string;
  /** `/talent/timesheets/<employeeId>`. */
  href: string;
}

/** `/talent/timesheet` and `/talent/timesheets/<employeeId>`. */
export interface TimesheetView {
  today: BusinessDate;
  timesheet: TimesheetRecordView;
  /** Directory fields only: a supervisor without Talent Read gets no more. */
  employee: { id: string; name: string; employeeNumber: string };
  /** True on the employee's own timesheet: clock, add, edit and delete. */
  own: boolean;
  /** The treatment in effect on the period start: "Overtime by kind" or "Offset". */
  treatment: ExtraHoursTreatment;
  hoursPerDay: number;
  /** One per day from the date hired (or the period start) up to today (or the period end). */
  days: TimesheetDayView[];
  totals: TimesheetTotals;
  /** Only on today's cut-off. */
  todayCard: TimesheetTodayView | null;
  /** Offset treatment only: the balance (0 until steps 2.7 and 2.8) and this cut-off's offset. */
  offset: { balanceMinutes: number; thisCutOffMinutes: number } | null;
  /** The previous and next cut-offs' start days, or null when out of range. */
  previousCutOff: BusinessDate | null;
  nextCutOff: BusinessDate | null;
  /** The schedule in effect today (or on the period's last listed day). */
  schedule: ScheduleOnDay | null;
  /** Own timesheet only: the entry sheet's client options. */
  clients?: TimesheetClientOption[];
  /** Own timesheet with direct reports only. */
  myTeam?: TeamMemberLink[];
}
