import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { type BusinessDate, now, toBusinessDate } from '@pulse/core';
import {
  activeHrUserIds,
  activeSystemAdministrators,
  defineJob,
  defineSchedule,
  notify,
} from '@pulse/core/server';
import {
  addRemittanceMonths,
  monthOfDay,
  REMITTANCE_AGENCIES,
  type RemittanceAgency,
  type RemittanceMonth,
  remittanceMonthsThrough,
  remittanceReminderKindOn,
  type RemittanceReminderKind,
  remittanceReminderText,
  remittanceSoonFrom,
} from '../../remittance';
import { REMITTANCE_REPORT_RECORD_TYPE } from './model';
import { loadRemittanceStatuses, remittanceReportHref, remittanceStatusKey } from './service';
import { loadRemittanceContext, remittanceSettingsFor } from './sources';

// Spec: docs/ARCHITECTURE.md#background-jobs and
// docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The reminder
// job"; decision 393 in docs/BUILD_PLAN.md) — the daily job `talent.remittanceReminders`, at
// 08:00 Manila (cron `0 8 * * *`).
//
// - While the go-live date is set, for each remittance month from the first one through last
//   month and each agency not `paid` for it, it computes the due date (today's setting) and sends
//   to every active HR user (the System Administrators when none is active), each at most once
//   (`notify()`'s `dedupeKey` `talent.remittanceDue:<agency>:<month>:<kind>`):
//   `talent.remittanceDue` kind `soon` from `reminderLeadDays` before the due date (or the first
//   run after), kind `today` on it, and `talent.remittanceOverdue` from the day after.
// - Each links to the agency's month and carries no amount. Recording the payment stops the rest.
// - It has no actor, writes only notifications, and returns counts only. Accounting isn't
//   notified (*Assumption*, HANDOFF).

export const REMITTANCE_DUE_EVENT = 'talent.remittanceDue';
export const REMITTANCE_OVERDUE_EVENT = 'talent.remittanceOverdue';

/** `talent.remittanceDue:<agency>:<month>:<kind>` (decision 393). */
export function remittanceReminderDedupeKey(
  agency: RemittanceAgency,
  month: RemittanceMonth,
  kind: RemittanceReminderKind,
): string {
  return `${REMITTANCE_DUE_EVENT}:${agency}:${month}:${kind}`;
}

/** The job: no data, everything is read when it runs. */
export const REMITTANCE_REMINDERS_JOB = defineJob('talent.remittanceReminders', {
  schema: z.object({}),
});

/** Every day at 08:00 Manila, weekends included. */
export const REMITTANCE_REMINDERS_SCHEDULE = defineSchedule({
  id: 'talent.remittanceReminders',
  job: REMITTANCE_REMINDERS_JOB,
  data: {},
  pattern: '0 8 * * *',
});

export interface RemittanceRemindersResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  /** Remittance months checked (the first one through last month). */
  months: number;
  /** Agency months not paid. */
  unpaid: number;
  /** Reminders due today (each agency month and kind), sent now or already sent. */
  remindersDue: number;
  /** Notifications written in this run. */
  notified: number;
}

/**
 * Sends the remittance reminders for the Manila day of `at`. Safe to run again: each agency
 * month's reminder of each kind goes once to each recipient.
 */
export async function runRemittanceReminders(at: Date = now()): Promise<RemittanceRemindersResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const context = await loadRemittanceContext(date);
  const lastMonth = addRemittanceMonths(monthOfDay(date), -1);
  const months = context.firstCutOff ? remittanceMonthsThrough(context.firstCutOff, lastMonth) : [];
  const result: RemittanceRemindersResult = {
    date,
    months: months.length,
    unpaid: 0,
    remindersDue: 0,
    notified: 0,
  };
  if (months.length === 0) return result;

  const statuses = await loadRemittanceStatuses(context, months);
  let recipients: string[] | null = null;
  for (const month of months) {
    const settings = remittanceSettingsFor(context, month).value;
    for (const agency of REMITTANCE_AGENCIES) {
      const status = statuses.get(remittanceStatusKey(month, agency));
      if (!status || status.status === 'paid') continue;
      result.unpaid += 1;
      const kind = remittanceReminderKindOn(
        date,
        status.dueDate,
        remittanceSoonFrom(status.dueDate, settings),
      );
      if (!kind) continue;
      result.remindersDue += 1;
      if (recipients === null) {
        recipients = await activeHrUserIds();
        if (recipients.length === 0) {
          recipients = (await activeSystemAdministrators()).map((admin) =>
            admin.userId.toHexString(),
          );
        }
      }
      result.notified += await notify({
        recipients,
        module: 'talent',
        event: kind === 'overdue' ? REMITTANCE_OVERDUE_EVENT : REMITTANCE_DUE_EVENT,
        title: remittanceReminderText(kind, agency, month, status.dueDate),
        href: remittanceReportHref(month, agency),
        record: status.reportId
          ? { type: REMITTANCE_REPORT_RECORD_TYPE, id: status.reportId }
          : null,
        dedupeKey: remittanceReminderDedupeKey(agency, month, kind),
      });
    }
  }
  return result;
}
