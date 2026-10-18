import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { type BusinessDate, now, toBusinessDate } from '@pulse/core';
import {
  activeHrUserIds,
  activeSystemAdministrators,
  defineJob,
  defineSchedule,
  employeeNotificationContacts,
  notify,
} from '@pulse/core/server';
import { isTimesheetEditable } from '../../timesheets/schemas';
import {
  isTimesheetsMissingDay,
  ownTimesheetHref,
  submissionDeadline,
  TIMESHEET_APPROVAL_TYPE,
  timesheetDueDedupeKey,
  timesheetDueMessage,
  timesheetReminderKind,
  timesheetReminderPeriodEnds,
  timesheetsListHref,
  timesheetsMissingDedupeKey,
  timesheetsMissingMessage,
} from '../../timesheets/submission';
import { dayOf, instantOf } from '../shared';
import { type TimesheetDocument, TimesheetModel } from './model';
import { deadlineDaysOn, loadTimesheetSettings } from './status';

// Spec: docs/ARCHITECTURE.md#background-jobs and
// docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Reminders and the missing list"; decision 293 in docs/BUILD_PLAN.md) — the daily job
// `talent.timesheetReminders`, at 08:00 Manila (cron `0 8 * * *`).
//
// - Reads only the timesheets whose cut-off ended in the last 11 days, then keeps those with a
//   reminder day today (HANDOFF item 139), so an old cut-off reminds no one.
// - `talent.timesheetDue` to the employee of an `open` or `returned` timesheet with an active
//   account: on the day submission opens, the deadline day and the day after, at most once per
//   timesheet per Manila day (`notify()`'s `dedupeKey`).
// - `talent.timesheetsMissing` to every active HR user (the System Administrators when none is
//   active) on the day after the deadline, when any timesheet of that period is still `open` or
//   `returned`, once per period, with the count.
// - Separated employees and inactive accounts get no reminder. A separated employee's timesheet
//   isn't counted as missing either: it is left for HR's separation step (step 2.14; HANDOFF item
//   136). An inactive account's is counted, since it can't be submitted until HR acts.
// - It has no actor and writes only notifications; none carries a sensitive field.

export const TIMESHEET_DUE_EVENT = 'talent.timesheetDue';
export const TIMESHEETS_MISSING_EVENT = 'talent.timesheetsMissing';

/** The job: no data, everything is read when it runs. */
export const TIMESHEET_REMINDERS_JOB = defineJob('talent.timesheetReminders', {
  schema: z.object({}),
});

/** Every day at 08:00 Manila, weekends included. */
export const TIMESHEET_REMINDERS_SCHEDULE = defineSchedule({
  id: 'talent.timesheetReminders',
  job: TIMESHEET_REMINDERS_JOB,
  data: {},
  pattern: '0 8 * * *',
});

export interface TimesheetRemindersResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  /** `open` or `returned` timesheets read (cut-offs ended in the last 11 days). */
  timesheets: number;
  /** Employees reminded in this run (`talent.timesheetDue` written). */
  employeesReminded: number;
  /** Periods HR was told about in this run (`talent.timesheetsMissing` written). */
  periodsMissing: number;
  /** Notifications written in this run. */
  notified: number;
}

type ReminderRow = Pick<
  TimesheetDocument,
  '_id' | 'employeeId' | 'periodStart' | 'periodEnd' | 'status'
>;

/**
 * Sends the timesheet reminders for the Manila day of `at`. Safe to run again: each employee gets
 * each day's reminder once, and HR each period's missing count once.
 */
export async function runTimesheetReminders(at: Date = now()): Promise<TimesheetRemindersResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const ends = timesheetReminderPeriodEnds(date);
  const [rows, settings] = await Promise.all([
    TimesheetModel.find(
      {
        status: { $in: ['open', 'returned'] },
        periodEnd: { $gte: instantOf(ends.from), $lte: instantOf(ends.to) },
      },
      { employeeId: 1, periodStart: 1, periodEnd: 1, status: 1 },
    ).lean<ReminderRow[]>(),
    loadTimesheetSettings(),
  ]);
  const editable = rows.filter((row) => isTimesheetEditable(row.status));
  const contacts = new Map(
    (await employeeNotificationContacts(editable.map((row) => row.employeeId))).map((contact) => [
      contact.employeeId,
      contact,
    ]),
  );

  let notified = 0;
  let employeesReminded = 0;
  // Per period start: its end, deadline days and the count of missing timesheets.
  const missing = new Map<BusinessDate, { end: BusinessDate; days: number; count: number }>();
  for (const row of editable) {
    const contact = contacts.get(row.employeeId.toHexString());
    if (!contact || contact.separated) continue;
    const periodStart = dayOf(row.periodStart);
    const periodEnd = dayOf(row.periodEnd);
    const days = deadlineDaysOn(periodEnd, settings);

    if (isTimesheetsMissingDay(periodEnd, days, date)) {
      const entry = missing.get(periodStart) ?? { end: periodEnd, days, count: 0 };
      entry.count += 1;
      missing.set(periodStart, entry);
    }

    const kind = timesheetReminderKind(periodEnd, days, date);
    if (!kind || !contact.userId) continue;
    const sent = await notify({
      recipients: [contact.userId],
      module: 'talent',
      event: TIMESHEET_DUE_EVENT,
      title: timesheetDueMessage(kind, periodStart, periodEnd, submissionDeadline(periodEnd, days)),
      href: ownTimesheetHref(periodStart),
      record: { type: TIMESHEET_APPROVAL_TYPE, id: row._id },
      dedupeKey: timesheetDueDedupeKey(row._id.toHexString(), date),
    });
    if (sent > 0) employeesReminded += 1;
    notified += sent;
  }

  let periodsMissing = 0;
  if (missing.size > 0) {
    let hr = await activeHrUserIds();
    if (hr.length === 0) {
      hr = (await activeSystemAdministrators()).map((admin) => admin.userId.toHexString());
    }
    for (const [periodStart, { end, count }] of missing) {
      const sent = await notify({
        recipients: hr,
        module: 'talent',
        event: TIMESHEETS_MISSING_EVENT,
        title: timesheetsMissingMessage(count, periodStart, end),
        href: timesheetsListHref(periodStart, 'notSubmitted'),
        record: null,
        dedupeKey: timesheetsMissingDedupeKey(periodStart),
      });
      if (sent > 0) periodsMissing += 1;
      notified += sent;
    }
  }
  return { date, timesheets: editable.length, employeesReminded, periodsMissing, notified };
}
