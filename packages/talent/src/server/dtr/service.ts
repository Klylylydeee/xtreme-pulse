import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import {
  ActionError,
  addDays,
  type BusinessDate,
  businessToday,
  type TimesheetType,
} from '@pulse/core';
import {
  type ConfigVersion,
  type ConfirmedHoliday,
  type EmployeeIdentity,
  listConfigVersions,
  listConfirmedHolidays,
} from '@pulse/core/server';
import { computeDtr, type Dtr } from '../../dtr/compute';
import type { CutOffPeriod } from '../../payroll/lookups';
import type { NightWindow, TimeEntryHoursInput } from '../../timesheets/compute';
import type { TimesheetSettings, WorkSchedule } from '../../timesheets/schemas';
import { PREMIUM_RATES_SETTING, TIMESHEET_SETTINGS_SETTING } from '../payroll-settings/settings';
import type { TalentActor } from '../policy';
import { dayOf, instantOf } from '../shared';
import { isTimesheetApprover, timesheetViewerIdentity } from '../timesheets/access';
import {
  type TimeEntryDocument,
  type TimesheetDocument,
  TimeEntryModel,
  TimesheetModel,
} from '../timesheets/model';
import { loadPayrollVersions, type PayrollVersions, periodOrNull } from '../timesheets/periods';
import {
  listCompanyScheduleVersions,
  type LoadedAssignment,
  loadWorkScheduleAssignments,
} from '../work-schedules/service';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record"), docs/DATA_MODEL.md#derived-values and decisions 288–291 and 296 in
// docs/BUILD_PLAN.md — the DTR is derived when read and never stored. This file loads the inputs
// of the pure `computeDtr` (`packages/talent/src/dtr/`): the employee's live entries, the confirmed
// holidays, the company schedule versions and the employee's own schedules, the night window, the
// timesheet settings and the payroll settings. Every period not yet finalized is therefore always
// current. A timesheet's days are `final` once it is approved.
//
// - `timesheetDtr` computes one stored timesheet's DTR, inside a transaction when given one: the
//   timesheet view, the submit summary, HR's offset credit and the holidays-changed listener use it.
// - `getDtr(actor, employeeId, from, to)` is the service steps 2.8, 2.9 and 2.13 (and Pulse Ops'
//   approved overtime in Phase 4) read, under the timesheet's viewing rule.

/** The longest range `getDtr` returns, in days. */
export const DTR_MAX_DAYS = 93;
export const DTR_RANGE_INVALID = `Choose a range of up to ${DTR_MAX_DAYS} days, the first day on or before the last.`;

/** What `computeDtr` reads besides the entries. */
export interface DtrSources {
  holidays: ConfirmedHoliday[];
  workSchedules: ConfigVersion<WorkSchedule>[];
  assignments: LoadedAssignment[];
  premiumRates: ConfigVersion<NightWindow>[];
  timesheetSettings: ConfigVersion<TimesheetSettings>[];
  payrollVersions: PayrollVersions;
}

interface LoadOptions {
  session?: ClientSession | null;
  payrollVersions?: PayrollVersions;
}

/** Loads the DTR's sources for `employeeId` from `from` to `to` (the holidays' range). */
export async function loadDtrSources(
  employeeId: string,
  { from, to }: { from: BusinessDate; to: BusinessDate },
  { session = null, payrollVersions }: LoadOptions = {},
): Promise<DtrSources> {
  await connectDb();
  const options = session ? { session } : {};
  const [holidays, workSchedules, assignments, premiumRates, timesheetSettings, payroll] =
    await Promise.all([
      listConfirmedHolidays({ from, to }, options),
      listCompanyScheduleVersions(options),
      loadWorkScheduleAssignments(employeeId, options),
      listConfigVersions(PREMIUM_RATES_SETTING, options),
      listConfigVersions(TIMESHEET_SETTINGS_SETTING, options),
      payrollVersions ? Promise.resolve(payrollVersions) : loadPayrollVersions(options),
    ]);
  return {
    holidays,
    workSchedules,
    assignments,
    premiumRates,
    timesheetSettings,
    payrollVersions: payroll,
  };
}

/** The employee's live time entries dated `from` to `to` (each by the Manila day of its time in). */
export async function loadTimeEntries(
  employeeId: string,
  { from, to }: { from: BusinessDate; to: BusinessDate },
  session: ClientSession | null = null,
): Promise<TimeEntryDocument[]> {
  await connectDb();
  return TimeEntryModel.find({
    employeeId: new Types.ObjectId(employeeId),
    date: { $gte: instantOf(from), $lte: instantOf(to) },
  })
    .sort({ timeIn: 1, _id: 1 })
    .session(session)
    .lean<TimeEntryDocument[]>();
}

/** The entries as the hours computation reads them. */
export function entryHoursInputs(entries: readonly TimeEntryDocument[]): TimeEntryHoursInput[] {
  return entries.map((entry) => ({
    id: entry._id.toHexString(),
    timeIn: entry.timeIn,
    timeOut: entry.timeOut,
    extraHours: entry.extraHours ? { reason: entry.extraHours.reason } : null,
  }));
}

/** The employee fields the DTR's range reads. */
export interface DtrSubject {
  dateHired: BusinessDate;
  separationDate: BusinessDate | null;
}

export interface DtrOfInput {
  subject: DtrSubject;
  period: { start: BusinessDate; end: BusinessDate };
  timesheetType: TimesheetType;
  approved: boolean;
  sources: DtrSources;
  entries: readonly TimeEntryDocument[];
  today: BusinessDate;
  /** Narrows the days listed (getDtr's range). */
  from?: BusinessDate;
  to?: BusinessDate;
}

/** One cut-off's DTR from loaded sources (pure apart from the inputs). */
export function dtrOf(input: DtrOfInput): Dtr {
  const { sources } = input;
  return computeDtr({
    timesheetType: input.timesheetType,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    entries: entryHoursInputs(input.entries),
    holidays: sources.holidays,
    workSchedules: sources.workSchedules,
    assignments: sources.assignments,
    premiumRates: sources.premiumRates,
    timesheetSettings: sources.timesheetSettings,
    payrollSettings: sources.payrollVersions,
    approved: input.approved,
    dateHired: input.subject.dateHired,
    separationDate: input.subject.separationDate,
    today: input.today,
    timeOff: [],
  });
}

/**
 * A stored timesheet's DTR as it is now (or in `session`), with the entries it was computed from.
 * `today` defaults to today's Manila day; after the cut-off ends every day of it is listed.
 */
export async function timesheetDtr(
  timesheet: Pick<
    TimesheetDocument,
    'employeeId' | 'periodStart' | 'periodEnd' | 'timesheetType' | 'status'
  >,
  subject: DtrSubject,
  {
    session = null,
    today = businessToday(),
    payrollVersions,
  }: LoadOptions & { today?: BusinessDate } = {},
): Promise<{ dtr: Dtr; entries: TimeEntryDocument[]; sources: DtrSources }> {
  const employeeId = timesheet.employeeId.toHexString();
  const period = { start: dayOf(timesheet.periodStart), end: dayOf(timesheet.periodEnd) };
  const [sources, entries] = await Promise.all([
    loadDtrSources(
      employeeId,
      { from: period.start, to: period.end },
      { session, payrollVersions },
    ),
    loadTimeEntries(employeeId, { from: period.start, to: period.end }, session),
  ]);
  const dtr = dtrOf({
    subject,
    period,
    timesheetType: timesheet.timesheetType,
    approved: timesheet.status === 'approved',
    sources,
    entries,
    today,
  });
  return { dtr, entries, sources };
}

// ---------------------------------------------------------------------------------------------
// getDtr

/** An employee's DTR over a range of days: one DTR per cut-off the range touches. */
export interface EmployeeDtr {
  employeeId: string;
  from: BusinessDate;
  to: BusinessDate;
  /** One per cut-off, oldest first, each listing only the days of the range. */
  periods: Dtr[];
}

/** The cut-offs that `from` to `to` touches, oldest first. */
function periodsBetween(
  from: BusinessDate,
  to: BusinessDate,
  payrollVersions: PayrollVersions,
): CutOffPeriod[] {
  const periods: CutOffPeriod[] = [];
  let day = from;
  while (day <= to) {
    const period = periodOrNull(day, payrollVersions);
    if (!period) {
      day = addDays(day, 1);
      continue;
    }
    periods.push(period);
    day = addDays(period.end, 1);
  }
  return periods;
}

/**
 * The Daily Time Record of `employeeId` from `from` to `to` (Manila days, at most
 * {@link DTR_MAX_DAYS}), under the timesheet's viewing rule: the employee, Talent Read, a
 * `reportingTo` supervisor, or an approver of every timesheet in the range (read-only). Anyone else
 * gets AccessDeniedError. Null when there is no such employee. Days before the date hired, after
 * the separation date or after today aren't listed. Derived when read; nothing is stored.
 */
export async function getDtr(
  actor: TalentActor,
  employeeId: string,
  from: BusinessDate,
  to: BusinessDate,
): Promise<EmployeeDtr | null> {
  if (to < from || addDays(from, DTR_MAX_DAYS - 1) < to) throw new ActionError(DTR_RANGE_INVALID);
  await connectDb();
  const payrollVersions = await loadPayrollVersions();
  const periods = periodsBetween(from, to, payrollVersions);
  const employeeObjectId = Types.ObjectId.isValid(employeeId)
    ? new Types.ObjectId(employeeId)
    : null;
  const stored = employeeObjectId
    ? await TimesheetModel.find({
        employeeId: employeeObjectId,
        periodStart: { $in: periods.map((period) => instantOf(period.start)) },
      }).lean<TimesheetDocument[]>()
    : [];
  const byStart = new Map(stored.map((timesheet) => [dayOf(timesheet.periodStart), timesheet]));

  const viewer = await timesheetViewerIdentity(actor, employeeId, async () => {
    // An approver sees only the timesheets they are or were asked to decide: every cut-off of the
    // range must have one.
    if (periods.length === 0) return false;
    for (const period of periods) {
      const timesheet = byStart.get(period.start);
      if (!timesheet || !(await isTimesheetApprover(actor.id, timesheet._id.toHexString()))) {
        return false;
      }
    }
    return true;
  });
  if (!viewer) return null;
  const { identity } = viewer;

  const today = businessToday();
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) return { employeeId, from, to, periods: [] };
  const [sources, entries] = await Promise.all([
    loadDtrSources(employeeId, { from: first.start, to: last.end }, { payrollVersions }),
    loadTimeEntries(employeeId, { from, to }),
  ]);
  const result: Dtr[] = [];
  for (const period of periods) {
    const timesheet = byStart.get(period.start);
    const timesheetType = timesheet?.timesheetType ?? positionType(identity);
    if (!timesheetType) continue;
    result.push(
      dtrOf({
        subject: identity,
        period,
        timesheetType,
        approved: timesheet?.status === 'approved',
        sources,
        entries: entries.filter((entry) => {
          const day = dayOf(entry.date);
          return day >= period.start && day <= period.end;
        }),
        today,
        from,
        to,
      }),
    );
  }
  return { employeeId, from, to, periods: result };
}

function positionType(identity: EmployeeIdentity): TimesheetType | null {
  return identity.position?.timesheetType ?? null;
}
