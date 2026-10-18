import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { addDays, type BusinessDate, businessToday } from '@pulse/core';
import { type ConfigVersion, listConfigVersions } from '@pulse/core/server';
import { versionOn } from '../../timesheets/schedule';
import {
  DEFAULT_SUBMISSION_DEADLINE_DAYS,
  submissionDeadlineDaysOf,
  type TimesheetSettings,
} from '../../timesheets/schemas';
import {
  isSubmittedLate,
  isTimesheetOverdue,
  submissionDeadline,
  timesheetStatusText,
} from '../../timesheets/submission';
import type { TeamMemberTimesheetStatus } from '../../timesheets/views';
import { TIMESHEET_SETTINGS_SETTING } from '../payroll-settings/settings';
import { dayOf, instantOf } from '../shared';
import { type TimesheetDocument, TimesheetModel } from './model';
import { loadPayrollVersions, type PayrollVersions, periodOrNull } from './periods';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The submission deadline", "Screens"; decisions 279, 280 and 295 in docs/BUILD_PLAN.md) — the
// deadline of a stored timesheet, "Submitted late", and the latest ended cut-off's status that My
// team shows. Server-only helpers; the rules themselves are pure, in `timesheets/submission.ts`.

export type TimesheetSettingsVersions = ConfigVersion<TimesheetSettings>[];

/** Every `talent.timesheetSettings` version. */
export function loadTimesheetSettings(
  session: ClientSession | null = null,
): Promise<TimesheetSettingsVersions> {
  return listConfigVersions(TIMESHEET_SETTINGS_SETTING, session ? { session } : {});
}

/**
 * The deadline of a cut-off ending `periodEnd`: `submissionDeadlineDays` of the version in effect
 * on the period end (read through `submissionDeadlineDaysOf`, 1 when absent).
 */
export function deadlineOf(
  periodEnd: BusinessDate,
  settings: readonly ConfigVersion<TimesheetSettings>[],
): BusinessDate {
  const version = versionOn(settings, periodEnd);
  const days = version ? submissionDeadlineDaysOf(version.value) : DEFAULT_SUBMISSION_DEADLINE_DAYS;
  return submissionDeadline(periodEnd, days);
}

/** `submissionDeadlineDays` in effect on `periodEnd`. */
export function deadlineDaysOn(
  periodEnd: BusinessDate,
  settings: readonly ConfigVersion<TimesheetSettings>[],
): number {
  const version = versionOn(settings, periodEnd);
  return version ? submissionDeadlineDaysOf(version.value) : DEFAULT_SUBMISSION_DEADLINE_DAYS;
}

/** "Submitted late": the latest submit fell on a day after the deadline. */
export function submittedLateOf(
  timesheet: Pick<TimesheetDocument, 'submittedAt'>,
  deadline: BusinessDate,
): boolean {
  return timesheet.submittedAt ? isSubmittedLate(timesheet.submittedAt, deadline) : false;
}

/** The latest cut-off that has ended by `today`, or null when no pay schedule covers it. */
export function latestEndedCutOff(
  today: BusinessDate,
  payrollVersions: PayrollVersions,
): { start: BusinessDate; end: BusinessDate } | null {
  const current = periodOrNull(today, payrollVersions);
  if (!current) return null;
  const previous = periodOrNull(addDays(current.start, -1), payrollVersions);
  return previous ? { start: previous.start, end: previous.end } : null;
}

/**
 * My team's statuses (decision 295): each employee's timesheet for the latest ended cut-off, by
 * employee id. An employee with no timesheet for it reads "Not submitted" (null status).
 */
export async function latestCutOffStatuses(
  employeeIds: readonly string[],
  {
    today = businessToday(),
    payrollVersions,
  }: { today?: BusinessDate; payrollVersions?: PayrollVersions } = {},
): Promise<Map<string, TeamMemberTimesheetStatus>> {
  const result = new Map<string, TeamMemberTimesheetStatus>();
  if (employeeIds.length === 0) return result;
  await connectDb();
  const payroll = payrollVersions ?? (await loadPayrollVersions());
  const period = latestEndedCutOff(today, payroll);
  if (!period) return result;
  const [stored, settings] = await Promise.all([
    TimesheetModel.find(
      {
        periodStart: instantOf(period.start),
        employeeId: { $in: employeeIds.map((id) => new Types.ObjectId(id)) },
      },
      { employeeId: 1, status: 1, submittedAt: 1, periodEnd: 1 },
    ).lean<Pick<TimesheetDocument, 'employeeId' | 'status' | 'submittedAt' | 'periodEnd'>[]>(),
    loadTimesheetSettings(),
  ]);
  const byEmployee = new Map(stored.map((row) => [row.employeeId.toHexString(), row]));
  for (const employeeId of employeeIds) {
    const timesheet = byEmployee.get(employeeId);
    const periodEnd = timesheet ? dayOf(timesheet.periodEnd) : period.end;
    const deadline = deadlineOf(periodEnd, settings);
    const status = timesheet?.status ?? null;
    const onDay = { status: status ?? 'open', periodEnd, deadline, today } as const;
    result.set(employeeId, {
      periodStart: period.start,
      periodEnd,
      status,
      label: timesheetStatusText(onDay),
      overdue: isTimesheetOverdue(onDay),
      submittedLate: timesheet ? submittedLateOf(timesheet, deadline) : false,
    });
  }
  return result;
}
