import type { ScheduleDefinition } from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';
import { EXPIRY_ALERTS_JOB, EXPIRY_ALERTS_SCHEDULE, runExpiryAlerts } from '@pulse/talent/server';

// Pulse Talent's jobs and schedules (docs/ARCHITECTURE.md#background-jobs). Registered in every
// environment.

export const talentJobHandlers: JobHandler[] = [
  // The 201 document and certification expiry alerts (build step 2.2). Idempotent per item,
  // phase and expiry date through notify()'s dedupeKey.
  handleJob(EXPIRY_ALERTS_JOB, () => runExpiryAlerts()),
];

export const talentJobSchedules: ScheduleDefinition[] = [EXPIRY_ALERTS_SCHEDULE];
