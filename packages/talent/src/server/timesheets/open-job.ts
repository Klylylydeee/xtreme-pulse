import { z } from 'zod';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type BusinessDate, now, toBusinessDate } from '@pulse/core';
import {
  defineJob,
  defineSchedule,
  type IdentityActor,
  listEmployeeIdentities,
  resolveModuleAccess,
} from '@pulse/core/server';
import { instantOf } from '../shared';
import { TimesheetModel } from './model';
import { ensureTimesheet, loadPayrollVersions, periodFor } from './periods';

// Spec: docs/ARCHITECTURE.md#background-jobs ("Current cut-off timesheets opened") and
// docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("The type at cut-off
// start"; decision 218 in docs/BUILD_PLAN.md) — the daily job `talent.openTimesheets`, at 00:05
// Manila, weekends included. It creates today's cut-off timesheet for every active (not
// separated) employee hired on or before today who has none, storing their position's timesheet
// type as it is then. Idempotent through the unique (employee, period start) index, and it runs
// every day, so a missed run is made up. An employee whose position record is missing is skipped
// (their first use refuses with "Your position can't be found").

/** The job: no data, everything is read when it runs. */
export const OPEN_TIMESHEETS_JOB = defineJob('talent.openTimesheets', { schema: z.object({}) });

/** Every day at 00:05 Manila, weekends included. */
export const OPEN_TIMESHEETS_SCHEDULE = defineSchedule({
  id: 'talent.openTimesheets',
  job: OPEN_TIMESHEETS_JOB,
  data: {},
  pattern: '5 0 * * *',
});

export interface OpenTimesheetsResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  /** Today's cut-off. */
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  /** Timesheets created in this run. */
  created: number;
  /** Employees who already had one. */
  existing: number;
  /** Employees skipped: hired after today, or with no position record. */
  skipped: number;
}

/**
 * The job reads Core's identities with Talent Read and no employee: it has no user, and sends
 * nothing anywhere. Only the employee id, date hired and position type are used.
 */
const JOB_READER: IdentityActor = {
  employee: null,
  moduleAccess: resolveModuleAccess({
    isSystemAdministrator: false,
    moduleAccess: { talent: 'read' },
  }),
};

/** Opens today's cut-off timesheets (the Manila day of `at`). Safe to run again. */
export async function runOpenTimesheets(at: Date = now()): Promise<OpenTimesheetsResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const payrollVersions = await loadPayrollVersions();
  const period = periodFor(date, payrollVersions);
  const identities = await listEmployeeIdentities(JOB_READER);

  const existingIds = new Set(
    (
      await TimesheetModel.find(
        {
          periodStart: instantOf(period.start),
          employeeId: {
            $in: identities.map((identity) => new Types.ObjectId(identity.employeeId)),
          },
        },
        { employeeId: 1 },
      ).lean<{ employeeId: Types.ObjectId }[]>()
    ).map((row) => row.employeeId.toHexString()),
  );

  let created = 0;
  let existing = 0;
  let skipped = 0;
  for (const identity of identities) {
    if (identity.separated) continue;
    if (existingIds.has(identity.employeeId)) {
      existing += 1;
      continue;
    }
    if (identity.dateHired > date || !identity.position) {
      skipped += 1;
      continue;
    }
    const result = await ensureTimesheet(identity, date, { payrollVersions });
    // A concurrent run (or a first use) may have created it between the read and the insert.
    if (result.created) created += 1;
    else existing += 1;
  }
  return { date, periodStart: period.start, periodEnd: period.end, created, existing, skipped };
}
