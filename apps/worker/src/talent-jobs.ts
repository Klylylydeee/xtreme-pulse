import type { ScheduleDefinition } from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';
import {
  EXPIRY_ALERTS_JOB,
  EXPIRY_ALERTS_SCHEDULE,
  OPEN_TIMESHEETS_JOB,
  OPEN_TIMESHEETS_SCHEDULE,
  runExpiryAlerts,
  runOpenTimesheets,
} from '@pulse/talent/server';

// Pulse Talent's jobs and schedules (docs/ARCHITECTURE.md#background-jobs). Registered in every
// environment.

export const talentJobHandlers: JobHandler[] = [
  // The 201 document and certification expiry alerts (build step 2.2). Idempotent per item,
  // phase and expiry date through notify()'s dedupeKey.
  handleJob(EXPIRY_ALERTS_JOB, () => runExpiryAlerts()),
  // The current cut-off's timesheets (build step 2.4, decision 218). Idempotent through the
  // unique (employee, period start) index; runs every day so a missed run is made up.
  handleJob(OPEN_TIMESHEETS_JOB, () => runOpenTimesheets()),
];

export const talentJobSchedules: ScheduleDefinition[] = [
  EXPIRY_ALERTS_SCHEDULE,
  OPEN_TIMESHEETS_SCHEDULE,
];
