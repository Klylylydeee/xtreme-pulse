import {
  ACCESS_REMINDER_JOB,
  ACCESS_REMINDER_SCHEDULE,
  COMPANY_DETAILS_REMINDER_JOB,
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  HOLIDAY_AUTO_DRAFT_JOB,
  HOLIDAY_AUTO_DRAFT_SCHEDULE,
  HOLIDAY_REMINDER_JOB,
  HOLIDAY_REMINDER_SCHEDULES,
  HOLIDAYS_CHANGED_JOB,
  runAccessReminder,
  runCompanyDetailsReminder,
  runHolidayReminder,
  runHolidaysChangedListeners,
  runScheduledHolidayAutoDraft,
  type ScheduleDefinition,
} from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';

// Pulse Core's jobs and schedules (docs/ARCHITECTURE.md#background-jobs). Registered in every
// environment.

export const coreJobHandlers: JobHandler[] = [
  // Idempotent per Manila day: recipients who already got the reminder that day are skipped.
  handleJob(COMPANY_DETAILS_REMINDER_JOB, () => runCompanyDetailsReminder()),
  // Idempotent per Manila day through notify()'s dedupeKey (`core.accessReminder:<Manila date>`).
  handleJob(ACCESS_REMINDER_JOB, () => runAccessReminder()),
  // Drafts next year's holidays. Idempotent: a rule's draft is added only when no holiday of that
  // year (deleted ones included) has its `sourceKey`.
  handleJob(HOLIDAY_AUTO_DRAFT_JOB, () => runScheduledHolidayAutoDraft()),
  // Idempotent per recipient, year and Manila day through notify()'s dedupeKey.
  handleJob(HOLIDAY_REMINDER_JOB, () => runHolidayReminder()),
  // Enqueued by the holiday service after a change to confirmed holidays commits; never scheduled.
  // The dates are checked against the job's schema by handleJob. Listeners must be idempotent.
  handleJob(HOLIDAYS_CHANGED_JOB, ({ dates }) => runHolidaysChangedListeners({ dates })),
];

export const coreJobSchedules: ScheduleDefinition[] = [
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  ACCESS_REMINDER_SCHEDULE,
  HOLIDAY_AUTO_DRAFT_SCHEDULE,
  ...HOLIDAY_REMINDER_SCHEDULES,
];
