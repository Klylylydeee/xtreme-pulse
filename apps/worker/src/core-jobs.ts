import {
  COMPANY_DETAILS_REMINDER_JOB,
  COMPANY_DETAILS_REMINDER_SCHEDULE,
  runCompanyDetailsReminder,
  type ScheduleDefinition,
} from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';

// Pulse Core's jobs and schedules (docs/ARCHITECTURE.md#background-jobs). Registered in every
// environment.

export const coreJobHandlers: JobHandler[] = [
  // Idempotent per Manila day: recipients who already got the reminder that day are skipped.
  handleJob(COMPANY_DETAILS_REMINDER_JOB, () => runCompanyDetailsReminder()),
];

export const coreJobSchedules: ScheduleDefinition[] = [COMPANY_DETAILS_REMINDER_SCHEDULE];
