import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { now } from '@pulse/core';
import {
  type ApprovalHookContext,
  type ApprovalStepApprovedContext,
  type ApprovalStepSpec,
  employeeAuditLabel,
  recordAudit,
  registerApprovalType,
  snapshotsForAudit,
} from '@pulse/core/server';
import {
  nextTimesheetStatus,
  TIMESHEET_APPROVAL_STEP_LABELS,
  TIMESHEET_APPROVAL_TYPE,
  TIMESHEET_AUDIT_REASONS,
  timesheetAuditLabel,
  type TimesheetMove,
} from '../../timesheets/submission';
import { writeOffsetCredit } from '../offset/service';
import { dayOf, objectIdOf } from '../shared';
import { type TimesheetDocument, TimesheetModel } from './model';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Approval"), docs/modules/core.md#approvals and decisions 282–284 in docs/BUILD_PLAN.md — the
// approval type `talent.timesheet`, registered by `registerTalentApprovalTypes()` beside
// `talent.changeRequest`, so `apps/web/lib/approval-types.ts` needs no change.
//
// - Steps: (1) `reportingTo` "Supervisor", skipped when empty; (2) any one HR user, "HR", the
//   System Administrators when empty. The engine leaves out inactive supervisors and the
//   requester, so an HR employee's own timesheet goes to the other HR users. Approvers are fixed
//   at submit.
// - Decisions: approve and return (a return needs remarks). No reject.
// - The hooks run in the decision's transaction; throwing rolls the decision back:
//   - `onStepApproved` for the Supervisor step: `pendingHr`, with `supervisorApprovedAt` and
//     `supervisorApprovedBy`, and an `update` entry ("Approved by supervisor").
//   - `onSettled` approve (HR's): `approved`, `approvedAt` and `approvedBy`, the offset credit,
//     and an `update` entry ("Approved"). From then on the timesheet is locked.
//   - `onSettled` return (either step): `returned`, with `returnedAt`, `returnedBy` and
//     `returnRemarks`, and an `update` entry whose reason is the remarks.
// - Notifications are the engine's (`core.approvalRequested`, `core.approvalSettled`,
//   `core.approvalApproved`, `core.approvalReturned`); Talent sends none of its own.

/** The approval type's label in the Approvals list. */
export const TIMESHEET_APPROVAL_TYPE_LABEL = 'Timesheet';

/** The type's two steps (decision 282). */
export const TIMESHEET_APPROVAL_STEPS: readonly ApprovalStepSpec[] = [
  { kind: 'reportingTo', label: TIMESHEET_APPROVAL_STEP_LABELS.supervisor, whenEmpty: 'skip' },
  {
    kind: 'anyOf',
    label: TIMESHEET_APPROVAL_STEP_LABELS.hr,
    approvers: { set: 'hr' },
    whenEmpty: 'systemAdministrator',
  },
];

/** The index of the Supervisor step. */
const SUPERVISOR_STEP = 0;

let registered = false;

/** Registers `talent.timesheet` with Core's approvals engine. Safe to call on every request. */
export function registerTimesheetApprovalType(): void {
  if (registered) return;
  registerApprovalType(TIMESHEET_APPROVAL_TYPE, {
    module: 'talent',
    label: TIMESHEET_APPROVAL_TYPE_LABEL,
    allowedDecisions: ['approve', 'return'],
    steps: TIMESHEET_APPROVAL_STEPS,
    whenEmpty: 'systemAdministrator',
    onStepApproved: onTimesheetStepApproved,
    onSettled: onTimesheetSettled,
  });
  registered = true;
}

/** The timesheet of the request, pending on this very request; anything else is a bug. */
async function pendingTimesheetOf(
  context: ApprovalHookContext,
  session: ClientSession,
): Promise<TimesheetDocument> {
  const id = objectIdOf(context.request.record.id);
  const timesheet = id
    ? await TimesheetModel.findById(id).session(session).lean<TimesheetDocument>()
    : null;
  if (
    !timesheet ||
    (timesheet.status !== 'pendingSupervisor' && timesheet.status !== 'pendingHr') ||
    timesheet.approvalRequestId?.toHexString() !== context.request.id
  ) {
    throw new Error('The timesheet for this approval is missing or no longer waiting for it.');
  }
  return timesheet;
}

/** Moves the timesheet and writes its `update` entry, in the decision's transaction. */
async function moveTimesheet(
  context: ApprovalHookContext,
  before: TimesheetDocument,
  move: TimesheetMove,
  set: Record<string, unknown>,
  reason: string | null,
): Promise<TimesheetDocument> {
  const { decision, session } = context;
  const status = nextTimesheetStatus(before.status, move);
  if (!status) throw new Error(`A timesheet can't move from ${before.status} by ${move}.`);
  const after = await TimesheetModel.findOneAndUpdate(
    { _id: before._id, status: before.status },
    { $set: { ...set, status, updatedBy: new Types.ObjectId(decision.userId) } },
    { session, returnDocument: 'after', runValidators: true },
  ).lean<TimesheetDocument>();
  if (!after) throw new Error('The timesheet changed while the decision was being saved.');
  const employee = await employeeAuditLabel(before.employeeId, { session });
  await recordAudit(
    {
      actorId: decision.userId,
      actorEmail: decision.email,
      module: 'talent',
      action: 'update',
      record: {
        type: TIMESHEET_APPROVAL_TYPE,
        id: before._id,
        label: timesheetAuditLabel(
          employee?.employeeNumber ?? 'Unknown employee',
          dayOf(before.periodStart),
        ),
      },
      ...snapshotsForAudit(TimesheetModel, before, after),
      reason,
    },
    { session },
  );
  return after;
}

/** The Supervisor step was approved: `pendingHr` (the HR step's own approve is `onSettled`'s). */
async function onTimesheetStepApproved(context: ApprovalStepApprovedContext): Promise<void> {
  if (context.stepIndex !== SUPERVISOR_STEP) return;
  const before = await pendingTimesheetOf(context, context.session);
  await moveTimesheet(
    context,
    before,
    'supervisorApprove',
    {
      supervisorApprovedAt: now(),
      supervisorApprovedBy: new Types.ObjectId(context.decision.userId),
    },
    TIMESHEET_AUDIT_REASONS.supervisorApproved,
  );
}

/** HR approved (locked, and the offset credit) or an approver returned it with remarks. */
async function onTimesheetSettled(context: ApprovalHookContext): Promise<void> {
  const { decision, session } = context;
  const before = await pendingTimesheetOf(context, session);
  const at = now();
  const by = new Types.ObjectId(decision.userId);
  if (decision.decision === 'approve') {
    const after = await moveTimesheet(
      context,
      before,
      'approve',
      { approvedAt: at, approvedBy: by },
      TIMESHEET_AUDIT_REASONS.approved,
    );
    await writeOffsetCredit(after, { userId: decision.userId, email: decision.email }, session);
    return;
  }
  if (decision.decision === 'return') {
    const remarks = decision.remarks?.trim();
    if (!remarks) throw new Error('A timesheet is returned with remarks.');
    await moveTimesheet(
      context,
      before,
      'return',
      { returnedAt: at, returnedBy: by, returnRemarks: remarks },
      remarks,
    );
    return;
  }
  throw new Error('A timesheet is approved or returned, never rejected.');
}
