import { addDays, type BusinessDate, isBusinessDate } from '@pulse/core';
import { type CutOffPeriod, cutOffFor } from '../payroll/lookups';
import type { PayrollSettings } from '../payroll/schemas';
import type { WorkSchedule } from './schemas';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Work
// schedules", "Timesheets"; decisions 214, 215, 217 and 232 in docs/BUILD_PLAN.md) — which
// version, schedule and cut-off apply on a day. Pure code: the callers load the versions and
// assignments, these pick from them.

/** A version of a setting: a `ConfigVersion` from Core's store fits. */
export interface EffectiveVersion<T> {
  /** The Manila day it takes effect. */
  effectiveFrom: BusinessDate;
  value: T;
}

function assertDay(day: BusinessDate): void {
  if (!isBusinessDate(day)) throw new RangeError(`"${day}" is not a date in YYYY-MM-DD form.`);
}

/**
 * The version in effect on `day`: the one with the latest effective date on or before it, or
 * null when none is. On a tie the later one in the list wins. The list may be in any order.
 */
export function versionOn<V extends EffectiveVersion<unknown>>(
  versions: readonly V[],
  day: BusinessDate,
): V | null {
  assertDay(day);
  let found: V | null = null;
  for (const version of versions) {
    if (version.effectiveFrom > day) continue;
    if (!found || version.effectiveFrom >= found.effectiveFrom) found = version;
  }
  return found;
}

/** One entry of `workScheduleAssignments`, as the schedule lookup needs it. */
export interface WorkScheduleAssignmentInput {
  /** The Manila day it takes effect. */
  effectiveFrom: BusinessDate;
  /** The employee's own schedule, or null for "back to the company default". */
  schedule: WorkSchedule | null;
  /** When it was saved: a tie on the effective date goes to the newest. */
  createdAt: Date;
}

/** The schedule in effect on a day, and where it comes from. */
export interface ScheduleOnDay {
  schedule: WorkSchedule;
  /** `own`: the employee's assignment; `company`: the company default. */
  origin: 'own' | 'company';
  /** The effective date of the assignment or default version that applies. */
  effectiveFrom: BusinessDate;
}

/**
 * The schedule in effect on `day`: the employee's latest assignment on or before it (on a tie,
 * the newest by `createdAt`, then the later in the list). An assignment with no schedule, or no
 * assignment, means the company default version in effect that day. Null only when no default
 * version is in effect (the seed adds one from 2000-01-01).
 */
export function scheduleOn(
  day: BusinessDate,
  defaultVersions: readonly EffectiveVersion<WorkSchedule>[],
  assignments: readonly WorkScheduleAssignmentInput[] = [],
): ScheduleOnDay | null {
  assertDay(day);
  let latest: WorkScheduleAssignmentInput | null = null;
  for (const assignment of assignments) {
    if (assignment.effectiveFrom > day) continue;
    if (
      !latest ||
      assignment.effectiveFrom > latest.effectiveFrom ||
      (assignment.effectiveFrom === latest.effectiveFrom &&
        assignment.createdAt.getTime() >= latest.createdAt.getTime())
    ) {
      latest = assignment;
    }
  }
  if (latest?.schedule) {
    return { schedule: latest.schedule, origin: 'own', effectiveFrom: latest.effectiveFrom };
  }
  const company = versionOn(defaultVersions, day);
  if (!company) return null;
  return { schedule: company.value, origin: 'company', effectiveFrom: company.effectiveFrom };
}

/**
 * The timesheet period (cut-off) `day` falls in: `cutOffFor` with the `talent.payrollSettings`
 * version in effect on `day`. When a later version takes effect inside that period, the period
 * ends the day before it; it never starts before the version it uses took effect. Throws when no
 * version is in effect on `day`.
 */
export function timesheetPeriodFor(
  day: BusinessDate,
  payrollVersions: readonly EffectiveVersion<Pick<PayrollSettings, 'cutOffs'>>[],
): CutOffPeriod {
  const version = versionOn(payrollVersions, day);
  if (!version) throw new RangeError(`No pay schedule is in effect on ${day}.`);
  const period = cutOffFor(day, version.value);
  let { start, end } = period;
  if (start < version.effectiveFrom) start = version.effectiveFrom;
  for (const later of payrollVersions) {
    if (later.effectiveFrom > day && later.effectiveFrom <= end)
      end = addDays(later.effectiveFrom, -1);
  }
  return { ...period, start, end };
}
