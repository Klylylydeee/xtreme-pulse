import {
  ACCESS_REMINDER_JOB,
  ACCESS_REMINDER_SCHEDULE,
  COMPANY_DETAILS_REMINDER_JOB,
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  runAccessReminder,
  runCompanyDetailsReminder,
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
];

export const coreJobSchedules: ScheduleDefinition[] = [
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  ACCESS_REMINDER_SCHEDULE,
];
