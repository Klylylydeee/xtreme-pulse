import type { ScheduleDefinition } from '@pulse/core/server';
import { handleJob, type JobHandler } from '@pulse/core/server/worker';
import {
  EXPIRY_ALERTS_JOB,
  EXPIRY_ALERTS_SCHEDULE,
  LEAVE_CREDITS_JOB,
  LEAVE_CREDITS_SCHEDULE,
  OPEN_TIMESHEETS_JOB,
  OPEN_TIMESHEETS_SCHEDULE,
  PAYROLL_DRAFTS_JOB,
  PAYROLL_DRAFTS_SCHEDULE,
  PAYSLIP_PDFS_JOB,
  PAYSLIP_PDFS_SCHEDULE,
  registerTalentHolidaysChangedListener,
  runExpiryAlerts,
  runLeaveCredits,
  runOpenTimesheets,
  runPayrollDrafts,
  runPayslipPdfs,
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
  // The leave credits and carry-overs (build step 2.8, decisions 304 and 323). Idempotent through
  // the unique index per employee, type, kind and year; runs every day so a missed run catches up.
  handleJob(LEAVE_CREDITS_JOB, () => runLeaveCredits()),
  // The draft payroll runs (build step 2.9). Creates the latest ended cut-off's draft once (one
  // run per cut-off) and recomputes every draft; runs every day, so a missed run is made up the
  // next morning.
  handleJob(PAYROLL_DRAFTS_JOB, () => runPayrollDrafts()),
  // The payslip PDFs of finalized runs (build step 2.10, decision 366). Renders each missing PDF
  // (idempotent through the file's key and the line's `payslip.fileId: null` filter), then clears
  // the run's `payslipsPending`. Counts only; when a line fails it throws (counts only) after the
  // other lines, so BullMQ retries it and the next 10-minute run tries again.
  handleJob(PAYSLIP_PDFS_JOB, () => runPayslipPdfs()),
];

export const talentJobSchedules: ScheduleDefinition[] = [
  EXPIRY_ALERTS_SCHEDULE,
  OPEN_TIMESHEETS_SCHEDULE,
  TIMESHEET_REMINDERS_SCHEDULE,
  LEAVE_CREDITS_SCHEDULE,
  PAYROLL_DRAFTS_SCHEDULE,
  PAYSLIP_PDFS_SCHEDULE,
];

/**
 * Registers Talent's listeners with Core, at worker start-up before any job runs (build step 2.7,
 * decision 292): `talent.recomputeDtr`, which Core's `core.holidaysChanged` handler runs.
 * Safe to call more than once.
 */
export function registerTalentListeners(): void {
  registerTalentHolidaysChangedListener();
}
