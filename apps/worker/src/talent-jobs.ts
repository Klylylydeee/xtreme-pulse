import type { ScheduleDefinition } from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';
import {
  EXPIRY_ALERTS_JOB,
  EXPIRY_ALERTS_SCHEDULE,
  OPEN_TIMESHEETS_JOB,
  OPEN_TIMESHEETS_SCHEDULE,
  registerTalentHolidaysChangedListener,
  runExpiryAlerts,
  runOpenTimesheets,
  runTimesheetReminders,
  TIMESHEET_REMINDERS_JOB,
  TIMESHEET_REMINDERS_SCHEDULE,
} from '@pulse/talent/server';

// Pulse Talent's jobs, schedules and listeners (docs/ARCHITECTURE.md#background-jobs). Registered
// in every environment.

export const talentJobHandlers: JobHandler[] = [
  // The 201 document and certification expiry alerts (build step 2.2). Idempotent per item,
  // phase and expiry date through notify()'s dedupeKey.
  handleJob(EXPIRY_ALERTS_JOB, () => runExpiryAlerts()),
  // The current cut-off's timesheets (build step 2.4, decision 218). Idempotent through the
  // unique (employee, period start) index; runs every day so a missed run is made up.
  handleJob(OPEN_TIMESHEETS_JOB, () => runOpenTimesheets()),
  // The timesheet reminders and HR's missing count (build step 2.7, decision 293). Idempotent
  // per timesheet and Manila day, and per period for HR, through notify()'s dedupeKey.
  handleJob(TIMESHEET_REMINDERS_JOB, () => runTimesheetReminders()),
];

export const talentJobSchedules: ScheduleDefinition[] = [
  EXPIRY_ALERTS_SCHEDULE,
  OPEN_TIMESHEETS_SCHEDULE,
  TIMESHEET_REMINDERS_SCHEDULE,
];

/**
 * Registers Talent's listeners with Core, at worker start-up before any job runs (build step 2.7,
 * decision 292): `talent.recomputeDtr`, which Core's `core.holidaysChanged` handler runs.
 * Safe to call more than once.
 */
export function registerTalentListeners(): void {
  registerTalentHolidaysChangedListener();
}
