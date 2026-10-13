import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, type BusinessDate, businessToday, type TimesheetType } from '@pulse/core';
import { type ConfigVersion, listConfigVersions } from '@pulse/core/server';
import type { CutOffPeriod } from '../../payroll/lookups';
import type { PayrollSettings } from '../../payroll/schemas';
import { timesheetPeriodFor } from '../../timesheets/schedule';
import { PAYROLL_SETTINGS_SETTING } from '../payroll-settings/settings';
import { instantOf, isDuplicateKey } from '../shared';
import { type TimesheetDocument, TimesheetModel } from './model';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Timesheets";
// decisions 217 and 218 in docs/BUILD_PLAN.md) — the cut-off a day falls in, and the one timesheet
// per employee per cut-off, created once with the position's timesheet type of that moment.

/** The refusal when the employee's position record can't be found (the type is read from it). */
export const POSITION_MISSING =
  'Your position can’t be found. Ask HR to check your employee record.';
/** The same, on another person's timesheet. */
export const OTHER_POSITION_MISSING =
  'This employee’s position can’t be found. Ask HR to check their employee record.';
/** The refusal when no pay schedule covers a day. */
export const NO_PAY_SCHEDULE =
  'No pay schedule is in effect on that day. Ask HR to check the payroll settings.';

export type PayrollVersions = ConfigVersion<PayrollSettings>[];

/** Every `talent.payrollSettings` version (the cut-offs and `hoursPerDay`). */
export async function loadPayrollVersions({
  session,
}: { session?: ClientSession } = {}): Promise<PayrollVersions> {
  await connectDb();
  return listConfigVersions(PAYROLL_SETTINGS_SETTING, { session });
}

/** The cut-off `day` falls in, or null when no pay schedule covers it. */
export function periodOrNull(day: BusinessDate, versions: PayrollVersions): CutOffPeriod | null {
  try {
    return timesheetPeriodFor(day, versions);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The cut-off `day` falls in; refuses when no pay schedule covers it. */
export function periodFor(day: BusinessDate, versions: PayrollVersions): CutOffPeriod {
  const period = periodOrNull(day, versions);
  if (!period) throw new ActionError(NO_PAY_SCHEDULE);
  return period;
}

/** The employee a timesheet is for, as Core's identity gives it. */
export interface TimesheetEmployee {
  employeeId: string;
  /** Null when the position record is missing. */
  position: { timesheetType: TimesheetType } | null;
}

export interface EnsureTimesheetOptions {
  /** Inside this transaction (a time entry save). */
  session?: ClientSession;
  /** Every `talent.payrollSettings` version, when the caller has them. */
  payrollVersions?: PayrollVersions;
  /** The user whose save creates it; null for the job. */
  actorId?: string | null;
  /** The message when the position is missing. */
  positionMissing?: string;
}

/**
 * The employee's timesheet for the cut-off `day` falls in, created when there is none yet with
 * the position's timesheet type as it is now (`typeReadOn` is today). Idempotent: the pair
 * (employee, period start) is unique, and an existing timesheet is never changed.
 */
export async function ensureTimesheet(
  employee: TimesheetEmployee,
  day: BusinessDate,
  {
    session,
    payrollVersions,
    actorId = null,
    positionMissing = POSITION_MISSING,
  }: EnsureTimesheetOptions = {},
): Promise<{ timesheet: TimesheetDocument; created: boolean }> {
  await connectDb();
  const versions = payrollVersions ?? (await loadPayrollVersions({ session }));
  const period = periodFor(day, versions);
  const employeeId = new Types.ObjectId(employee.employeeId);
  const filter = { employeeId, periodStart: instantOf(period.start) };
  const existing = await TimesheetModel.findOne(filter)
    .session(session ?? null)
    .lean<TimesheetDocument>();
  if (existing) return { timesheet: existing, created: false };
  if (!employee.position) throw new ActionError(positionMissing);

  const created = new TimesheetModel({
    employeeId,
    periodStart: instantOf(period.start),
    periodEnd: instantOf(period.end),
    payDate: instantOf(period.payDate),
    cutOffKey: period.key,
    timesheetType: employee.position.timesheetType,
    typeReadOn: instantOf(businessToday()),
    status: 'open',
    createdBy: actorId,
    updatedBy: actorId,
  });
  if (session) {
    // In a transaction a concurrent insert is a write conflict, which the transaction retries.
    await created.save({ session });
    return { timesheet: created.toObject() as TimesheetDocument, created: true };
  }
  try {
    await created.save();
    return { timesheet: created.toObject() as TimesheetDocument, created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = await TimesheetModel.findOne(filter).lean<TimesheetDocument>();
    if (!winner) throw error;
    return { timesheet: winner, created: false };
  }
}
