import type { BusinessDate, Centavos, TimesheetType } from '@pulse/core';
import type { DtrDay, DtrTotals } from '../dtr/compute';
import type { OffsetCreditView } from '../offset/views';
import type { CutOffKey } from '../payroll/schemas';
import type { ReimbursementsSectionView } from '../reimbursements/views';
import type { DayHours, EntryHours, TimesheetTotals } from './compute';
import type { ScheduleOnDay } from './schedule';
import type {
  ExtraHoursTreatment,
  TimeEntrySource,
  TimesheetStatus,
  WorkSchedule,
} from './schemas';
import type { TimesheetListFilter, TimesheetSubmitProblem } from './submission';

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
  /** Step 2.7: their timesheet's status for the latest ended cut-off. */
  status?: TeamMemberTimesheetStatus;
}

/** A direct report's timesheet status on My team (step 2.7). */
export interface TeamMemberTimesheetStatus {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** Null when the timesheet isn't created yet ("Not submitted"). */
  status: TimesheetStatus | null;
  /** "Not submitted", "Overdue", "Waiting for supervisor", … (`timesheetStatusText`). */
  label: string;
  /** Not submitted and past the deadline (`isTimesheetOverdue`): the badge's destructive tone. */
  overdue: boolean;
  submittedLate: boolean;
}

// ---------------------------------------------------------------------------------------------
// Step 2.7: submission and approval
// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Screens"). Built by the timesheet service; `submission.ts` holds the wording.

/**
 * The status banner at the top of the timesheet. `open` (before the cut-off ends) shows none.
 * `timesheetBannerText` gives its main line.
 */
export type TimesheetStatusBannerView =
  | { kind: 'open' }
  | { kind: 'notSubmitted'; deadline: BusinessDate; overdue: boolean }
  | {
      kind: 'pendingSupervisor';
      submittedAt: Date;
      submittedLate: boolean;
      /** The Supervisor step's approvers, fixed at submit. */
      approverNames: string[];
    }
  | { kind: 'pendingHr'; submittedAt: Date; submittedLate: boolean }
  | {
      kind: 'returned';
      returnedAt: Date;
      /** Null when the name can't be shown (an inactive or deleted account). */
      returnedByName: string | null;
      remarks: string;
      submittedLate: boolean;
    }
  | { kind: 'approved'; approvedAt: Date; approvedByName: string | null; submittedLate: boolean };

/** One blocking problem on the confirmation sheet, named with its message and a link. */
export interface TimesheetSubmitProblemView {
  problem: TimesheetSubmitProblem;
  message: string;
  /** Where to fix it: the day, the onboarding item, the reimbursement line. */
  href: string | null;
}

/** The "Submit timesheet" confirmation sheet. */
export interface TimesheetSubmitSummaryView {
  /** "Submit timesheet", or "Resubmit" when returned. */
  buttonLabel: string;
  resubmit: boolean;
  daysPresent: number;
  daysAbsent: number;
  daysLate: number;
  treatment: ExtraHoursTreatment;
  /** The total overtime or offset minutes. */
  extraMinutes: number;
  reimbursementCount: number;
  reimbursementTotalCentavos: Centavos;
  manualTimeCount: number;
  /** True with no entries: the sheet warns that every scheduled day will show as absent. */
  empty: boolean;
  /** Empty when the submit may go ahead. */
  problems: TimesheetSubmitProblemView[];
}

/** The timesheet's step 2.7 part: status, deadline, submit and approver links. */
export interface TimesheetApprovalView {
  /** The status as it reads today ("Not submitted", "Overdue", "Waiting for HR", …). */
  statusText: string;
  banner: TimesheetStatusBannerView;
  deadline: BusinessDate;
  submittedLate: boolean;
  /** Own `open` or `returned` timesheet after the cut-off ends: the footer's submit button. */
  submit: TimesheetSubmitSummaryView | null;
  /** The viewer is an approver of the current request's pending step: "Open in Approvals". */
  approverLink: { requestId: string; href: string } | null;
  /** Why entries and lines can't change, or null while `open` or `returned`. */
  lockedMessage: string | null;
}

/** The DTR segment: one row per day, newest first, with totals for the sticky footer. */
export interface TimesheetDtrSegmentView {
  /** True on an approved timesheet; otherwise every row shows "Not approved yet". */
  final: boolean;
  /** Newest first. */
  days: DtrDay[];
  totals: DtrTotals;
  treatment: ExtraHoursTreatment;
}

// ---------------------------------------------------------------------------------------------
// Step 2.7: the timesheets list (`/talent/timesheets`, Talent Read)

/** One employee's row. */
export interface TimesheetListRowView {
  employeeId: string;
  name: string;
  employeeNumber: string;
  department: string | null;
  timesheetType: TimesheetType;
  /** Null when no timesheet is created yet ("Not submitted"). */
  status: TimesheetStatus | null;
  filter: TimesheetListFilter;
  statusText: string;
  /** Not submitted and past the deadline (`isTimesheetOverdue`): the row's destructive tone. */
  overdue: boolean;
  submittedLate: boolean;
  /** `/talent/timesheets/<employeeId>?cutOff=<period start>`. */
  href: string;
}

/** A cut-off the picker offers. */
export interface TimesheetListCutOffOption {
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** "Sep 11 – 25, 2026". */
  label: string;
}

export interface TimesheetListView {
  cutOff: TimesheetListCutOffOption;
  deadline: BusinessDate;
  /** Ended cut-offs, newest first; the latest ended one is the default. */
  cutOffs: TimesheetListCutOffOption[];
  /** The tiles' counts, over every row whatever the filter. */
  counts: Record<TimesheetListFilter, number>;
  /** The filter in effect, or null for every row. */
  filter: TimesheetListFilter | null;
  rows: TimesheetListRowView[];
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
  /**
   * Offset treatment only: the balance (the sum of `offsetEntries` from step 2.7) and this
   * cut-off's offset; from step 2.7, the credit once HR approved ("Credited +X h on Sep 28").
   */
  offset: {
    balanceMinutes: number;
    thisCutOffMinutes: number;
    credited?: OffsetCreditView | null;
  } | null;
  /** Step 2.7: the status, banner, submit and approver link. */
  approval?: TimesheetApprovalView;
  /** Step 2.7: the DTR segment. */
  dtr?: TimesheetDtrSegmentView;
  /** The previous and next cut-offs' start days, or null when out of range. */
  previousCutOff: BusinessDate | null;
  nextCutOff: BusinessDate | null;
  /** The schedule in effect today (or on the period's last listed day). */
  schedule: ScheduleOnDay | null;
  /** The Reimbursements segment (build step 2.5): the timesheet's lines, read-only unless own. */
  reimbursements: ReimbursementsSectionView;
  /** Own timesheet only: the entry and reimbursement sheets' client options. */
  clients?: TimesheetClientOption[];
  /** Own timesheet with direct reports only. */
  myTeam?: TeamMemberLink[];
}
