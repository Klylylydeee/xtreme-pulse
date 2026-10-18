import { connectDb } from '@pulse/db';
import { addDays, type BusinessDate, businessToday, isBusinessDate } from '@pulse/core';
import { listEmployeeIdentities } from '@pulse/core/server';
import {
  formatPeriodRange,
  isTimesheetOverdue,
  TIMESHEET_LIST_FILTERS,
  type TimesheetListFilter,
  timesheetHref,
  timesheetListFilterOf,
  timesheetStatusText,
} from '../../timesheets/submission';
import type {
  TimesheetListCutOffOption,
  TimesheetListRowView,
  TimesheetListView,
} from '../../timesheets/views';
import { assertCanSeeTimesheetsList, type TalentActor } from '../policy';
import { dayOf, instantOf } from '../shared';
import { type TimesheetDocument, TimesheetModel } from './model';
import { loadPayrollVersions, type PayrollVersions, periodOrNull } from './periods';
import { deadlineOf, latestEndedCutOff, loadTimesheetSettings, submittedLateOf } from './status';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Screens": `/talent/timesheets`) and decision 294 in docs/BUILD_PLAN.md — the timesheets list
// for Talent Read (*Assumption*, HANDOFF item 135): a cut-off picker (ended cut-offs, the latest by
// default), the tiles' counts by status, and one row per employee employed during the cut-off,
// with "Submitted late". An employee whose timesheet isn't created yet is "Not submitted". The
// on-screen form of the HR report "Timesheet status per cut-off"; its exports come in step 2.16.
// Directory fields only, plus the timesheet's type and status, which aren't sensitive.

/** How many ended cut-offs the picker offers, newest first. */
export const TIMESHEET_LIST_CUT_OFFS = 24;

export interface TimesheetsListOptions {
  /** A cut-off's period start (`?cutOff=`); the latest ended cut-off when absent. */
  cutOff?: string | null;
  /** A tile's filter (`?status=`); every row when absent or unknown. */
  status?: string | null;
}

function cutOffOption(start: BusinessDate, end: BusinessDate): TimesheetListCutOffOption {
  return { periodStart: start, periodEnd: end, label: formatPeriodRange(start, end) };
}

/** The ended cut-offs, newest first, starting from the latest. */
function endedCutOffs(
  today: BusinessDate,
  payrollVersions: PayrollVersions,
): TimesheetListCutOffOption[] {
  const options: TimesheetListCutOffOption[] = [];
  let period = latestEndedCutOff(today, payrollVersions);
  while (period && options.length < TIMESHEET_LIST_CUT_OFFS) {
    options.push(cutOffOption(period.start, period.end));
    period = periodOrNull(addDays(period.start, -1), payrollVersions);
  }
  return options;
}

function isListFilter(value: string | null | undefined): value is TimesheetListFilter {
  return (TIMESHEET_LIST_FILTERS as readonly string[]).includes(value ?? '');
}

/**
 * `/talent/timesheets`: Talent Read only (AccessDeniedError otherwise). Null when `cutOff` isn't
 * an ended cut-off's start, or no cut-off has ended yet.
 */
export async function getTimesheetsList(
  actor: TalentActor,
  options: TimesheetsListOptions = {},
): Promise<TimesheetListView | null> {
  assertCanSeeTimesheetsList(actor);
  await connectDb();
  const today = businessToday();
  const payrollVersions = await loadPayrollVersions();
  const cutOffs = endedCutOffs(today, payrollVersions);
  let cutOff = cutOffs[0];
  if (options.cutOff) {
    if (!isBusinessDate(options.cutOff)) return null;
    const asked = periodOrNull(options.cutOff, payrollVersions);
    if (!asked || asked.start !== options.cutOff || asked.end >= today) return null;
    cutOff = cutOffOption(asked.start, asked.end);
  }
  if (!cutOff) return null;
  const { periodStart, periodEnd } = cutOff;

  const [identities, stored, settings] = await Promise.all([
    listEmployeeIdentities(actor, { separated: true }),
    TimesheetModel.find(
      { periodStart: instantOf(periodStart) },
      { employeeId: 1, status: 1, submittedAt: 1, timesheetType: 1, periodEnd: 1 },
    ).lean<
      Pick<
        TimesheetDocument,
        '_id' | 'employeeId' | 'status' | 'submittedAt' | 'timesheetType' | 'periodEnd'
      >[]
    >(),
    loadTimesheetSettings(),
  ]);
  const deadline = deadlineOf(periodEnd, settings);
  const byEmployee = new Map(stored.map((row) => [row.employeeId.toHexString(), row]));

  const counts = Object.fromEntries(TIMESHEET_LIST_FILTERS.map((key) => [key, 0])) as Record<
    TimesheetListFilter,
    number
  >;
  const rows: TimesheetListRowView[] = [];
  for (const identity of identities) {
    const timesheet = byEmployee.get(identity.employeeId);
    // Employed during the cut-off: hired by its end, not separated before its start.
    if (!timesheet) {
      if (identity.dateHired > periodEnd) continue;
      if (identity.separationDate && identity.separationDate < periodStart) continue;
    }
    const timesheetType = timesheet?.timesheetType ?? identity.position?.timesheetType;
    if (!timesheetType) continue;
    const status = timesheet?.status ?? null;
    const filter = timesheetListFilterOf(status);
    counts[filter] += 1;
    const onDay = {
      status: status ?? 'open',
      periodEnd: timesheet ? dayOf(timesheet.periodEnd) : periodEnd,
      deadline,
      today,
    } as const;
    rows.push({
      employeeId: identity.employeeId,
      name: `${identity.firstName} ${identity.lastName}`,
      employeeNumber: identity.employeeNumber,
      department: identity.department?.name ?? null,
      timesheetType,
      status,
      filter,
      statusText: timesheetStatusText(onDay),
      overdue: isTimesheetOverdue(onDay),
      submittedLate: timesheet ? submittedLateOf(timesheet, deadline) : false,
      href: timesheetHref(identity.employeeId, periodStart),
    });
  }
  rows.sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.employeeNumber.localeCompare(b.employeeNumber),
  );

  const filter = isListFilter(options.status) ? options.status : null;
  return {
    cutOff,
    deadline,
    cutOffs: cutOffs.some((option) => option.periodStart === periodStart)
      ? cutOffs
      : [cutOff, ...cutOffs],
    counts,
    filter,
    rows: filter ? rows.filter((row) => row.filter === filter) : rows,
  };
}
