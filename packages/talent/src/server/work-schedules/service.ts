import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, businessToday, toBusinessDate } from '@pulse/core';
import {
  type ConfigVersion,
  getEmployeeIdentity,
  listConfigVersions,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import { latestEffectiveDate } from '../../compensation';
import { type SetWorkScheduleInput, setWorkScheduleSchema } from '../../timesheets/inputs';
import { scheduleOn, type WorkScheduleAssignmentInput } from '../../timesheets/schedule';
import { scheduledMinutes, type WorkSchedule } from '../../timesheets/schemas';
import {
  WORK_SCHEDULE_ASSIGNMENT_TYPE,
  type WorkScheduleAssignmentView,
  type WorkScheduleSectionView,
} from '../../timesheets/views';
import { inputError } from '../input';
import { WORK_SCHEDULE_SETTING } from '../payroll-settings/settings';
import {
  assertCanEditEmployeeRecord,
  assertCanSetWorkSchedule,
  assertCanViewTimesheet,
  canReadEmployeeRecords,
  canSetWorkSchedule,
  type TalentActor,
} from '../policy';
import { auditLabelOf, EMPLOYEE_GONE, instantOf, targetOf } from '../shared';
import { WorkScheduleAssignmentModel } from './model';

// Spec: docs/modules/talent.md#work-schedules-and-daily-time-entries-build-step-24 ("Work
// schedules"), docs/DATA_MODEL.md#collection-ownership (decisions 214 and 215 in
// docs/BUILD_PLAN.md).
//
// - The company default is the versioned setting `talent.workSchedule` (Payroll settings page).
// - An employee's own schedule is an insert-only `workScheduleAssignments` entry, set by Talent
//   Write and HR or the System Administrator, never on one's own record; the effective date is on
//   or after the date hired and at most a year ahead. One transaction with its `create` audit
//   entry on `talent.workScheduleAssignment`, labelled `<employee number> · <YYYY-MM-DD>`.
// - The section is for the employee, Talent Read, or the employee's supervisors (Core's
//   `getEmployeeIdentity` answers the supervisor check; it refuses anyone else).

/** The refusal when no company default schedule is in effect (the seed adds one). */
export const NO_COMPANY_SCHEDULE =
  'No company work schedule is set. Ask HR or the System Administrator to set one in Payroll settings.';

interface AssignmentRow {
  _id: Types.ObjectId;
  effectiveFrom: Date;
  schedule: WorkSchedule | null;
  reason: string;
  createdAt: Date;
}

/** One assignment, for the schedule lookup and the history. */
export interface LoadedAssignment extends WorkScheduleAssignmentInput {
  id: string;
  reason: string;
}

function plainSchedule(schedule: WorkSchedule | null | undefined): WorkSchedule | null {
  if (!schedule) return null;
  return {
    workDays: [...schedule.workDays],
    start: schedule.start,
    end: schedule.end,
    breakStart: schedule.breakStart,
    breakMinutes: schedule.breakMinutes,
    graceMinutes: schedule.graceMinutes,
  };
}

/** The employee's assignments, in the order they were saved (server-only). */
export async function loadWorkScheduleAssignments(
  employeeId: string,
  { session }: { session?: ClientSession } = {},
): Promise<LoadedAssignment[]> {
  await connectDb();
  const rows = (await WorkScheduleAssignmentModel.find(
    { employeeId: new Types.ObjectId(employeeId) },
    { effectiveFrom: 1, schedule: 1, reason: 1, createdAt: 1 },
  )
    .sort({ createdAt: 1, _id: 1 })
    .session(session ?? null)
    .lean()) as AssignmentRow[];
  return rows.map((row) => ({
    id: row._id.toHexString(),
    effectiveFrom: toBusinessDate(row.effectiveFrom),
    schedule: plainSchedule(row.schedule),
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}

/** The company default's versions (`talent.workSchedule`). */
export async function listCompanyScheduleVersions({
  session,
}: { session?: ClientSession } = {}): Promise<ConfigVersion<WorkSchedule>[]> {
  await connectDb();
  return listConfigVersions(WORK_SCHEDULE_SETTING, { session });
}

function assignmentView(assignment: LoadedAssignment): WorkScheduleAssignmentView {
  return {
    id: assignment.id,
    effectiveFrom: assignment.effectiveFrom,
    schedule: assignment.schedule,
    reason: assignment.reason,
    createdAt: assignment.createdAt,
  };
}

/** Newest first: by effective date, then by when it was saved. */
function newestFirst(a: LoadedAssignment, b: LoadedAssignment): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * The Work schedule section of the inspector, `/talent/me` and the timesheet: the schedule in
 * effect, the scheduled ones and the history. For the employee, Talent Read, or one of the
 * employee's supervisors; anyone else gets {@link AccessDeniedError}. Null when there is no such
 * employee. A supervisor without Talent Read isn't sent the date hired: their `asOf` is today and
 * the "Set schedule" limits are left out.
 */
export async function getWorkScheduleSection(
  viewer: TalentActor,
  employeeId: string,
): Promise<WorkScheduleSectionView | null> {
  await connectDb();
  const identity = await getEmployeeIdentity(viewer, employeeId, { separated: true });
  if (!identity) return null;
  assertCanViewTimesheet(viewer, identity);

  const today = businessToday();
  const own = viewer.employee?.id === identity.employeeId;
  const mayKnowDateHired = own || canReadEmployeeRecords(viewer);
  const asOf = mayKnowDateHired && identity.dateHired > today ? identity.dateHired : today;

  const [assignments, defaults] = await Promise.all([
    loadWorkScheduleAssignments(identity.employeeId),
    listCompanyScheduleVersions(),
  ]);
  const current = scheduleOn(asOf, defaults, assignments);
  if (!current) throw new ActionError(NO_COMPANY_SCHEDULE);

  const sorted = [...assignments].sort(newestFirst);
  const canSet = canSetWorkSchedule(viewer, targetOf(identity));
  return {
    asOf,
    current,
    currentScheduledMinutes: scheduledMinutes(current.schedule),
    scheduled: sorted
      .filter((assignment) => assignment.effectiveFrom > asOf)
      .reverse()
      .map(assignmentView),
    history: sorted.map(assignmentView),
    canSet,
    ...(canSet
      ? {
          earliestEffectiveFrom: identity.dateHired,
          latestEffectiveFrom: latestEffectiveDate(today),
        }
      : {}),
  };
}

/**
 * "Set schedule": a new insert-only assignment from `effectiveFrom`, with the employee's own
 * schedule or null ("back to the company default") and a required reason. Talent Write and HR or
 * the System Administrator, never on one's own record, checked again in the transaction against
 * the actor and the employee as they are then.
 */
export async function setWorkSchedule(
  actor: TalentActor,
  input: SetWorkScheduleInput,
): Promise<{ id: string }> {
  const parsed = setWorkScheduleSchema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error.issues);
  const values = parsed.data;

  assertCanEditEmployeeRecord(actor, { employeeId: values.employeeId, departmentCode: null });
  await connectDb();
  const known = await getEmployeeIdentity(actor, values.employeeId, { separated: true });
  if (!known) throw new ActionError(EMPLOYEE_GONE);
  assertCanSetWorkSchedule(actor, targetOf(known));

  return withTransaction(async (session) => {
    const current = await reloadActorAccess({ id: actor.id }, session);
    const identity = await getEmployeeIdentity(current, values.employeeId, {
      separated: true,
      session,
    });
    if (!identity) throw new ActionError(EMPLOYEE_GONE);
    assertCanSetWorkSchedule(current, targetOf(identity));

    if (values.effectiveFrom < identity.dateHired) {
      throw new ActionError('The effective date can’t be before the date hired.', {
        field: 'effectiveFrom',
      });
    }
    if (values.effectiveFrom > latestEffectiveDate(businessToday())) {
      throw new ActionError('The effective date can be at most a year from today.', {
        field: 'effectiveFrom',
      });
    }

    const entry = new WorkScheduleAssignmentModel({
      employeeId: new Types.ObjectId(identity.employeeId),
      effectiveFrom: instantOf(values.effectiveFrom),
      schedule: values.schedule,
      reason: values.reason,
      createdBy: current.id,
      updatedBy: current.id,
    });
    await entry.save({ session });
    await recordAudit(
      {
        actorId: current.id,
        actorEmail: current.email,
        module: 'talent',
        action: 'create',
        record: {
          type: WORK_SCHEDULE_ASSIGNMENT_TYPE,
          id: entry._id,
          label: auditLabelOf(identity.employeeNumber, values.effectiveFrom),
        },
        before: null,
        after: snapshotForAudit(WorkScheduleAssignmentModel, entry),
        reason: values.reason,
      },
      { session },
    );
    return { id: entry._id.toHexString() };
  });
}
