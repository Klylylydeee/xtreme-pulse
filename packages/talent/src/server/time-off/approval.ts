import { type ClientSession, Types } from 'mongoose';
import { ActionError, businessToday, now } from '@pulse/core';
import {
  type ApprovalHookContext,
  type ApprovalStepSpec,
  type EmployeeIdentity,
  recordAudit,
  registerApprovalType,
  ROLE_DEPARTMENT_CODES,
  snapshotsForAudit,
} from '@pulse/core/server';
import { splitLeaveDays } from '../../time-off/balance';
import { chargeableMinutesOf } from '../../time-off/days';
import {
  LEAVE_APPROVAL_TYPE,
  OFFSET_TIME_OFF_APPROVAL_TYPE,
  TIME_OFF_APPROVAL_STEP_LABELS,
  TIME_OFF_APPROVAL_TYPE_LABELS,
  TIME_OFF_REQUEST_TYPE,
  type TimeOffStatus,
} from '../../time-off/kinds';
import { nextTimeOffStatus, OFFSET_NO_LONGER_COVERED_MESSAGE } from '../../time-off/rules';
import { formatShortDay } from '../../timesheets/submission';
import type { LeaveType } from '../../time-off/settings';
import { availableLeaveHalfDaysOf, writeLeaveUsage } from '../leave/service';
import { availableOffsetMinutesOf, writeOffsetUsage } from '../offset/service';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { objectIdOf } from '../shared';
import { serviceIdentity } from '../timesheets/access';
import { approvedOverlapOf, recountStoredRequest } from './checks';
import { touchTimeOffLock } from './lock';
import { type TimeOffRequestDocument, TimeOffRequestModel } from './model';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Approval"), docs/modules/core.md#approvals and decisions 313 and 314 in docs/BUILD_PLAN.md —
// the approval types `talent.leave` ("Leave") and `talent.offsetTimeOff` ("Offset time off"),
// registered by `registerTalentApprovalTypes()`.
//
// - One step, passed at submit (`timeOffApprovalSteps`): `reportingTo`, "Supervisor", any one
//   active supervisor; when empty, any one other active HR user (`whenEmpty: 'hr'`), or the
//   System Administrator for a requester in the HR department (`'systemAdministrator'`, decision
//   2). A confidential type (VAWC) skips the supervisors: `anyOf` HR ("HR"), or for an HR
//   requester a step with no approvers that goes to the System Administrator. Core supports both
//   as they are (per-step `whenEmpty`, an `anyOf` step's `{ set: 'hr' }` or `{ userIds: [] }`).
// - Decisions: approve, return and reject; a return or rejection needs remarks (the engine asks).
// - `onSettled`, in the decision's transaction (throwing rolls the decision back):
//   - approve: the request is counted again against the holidays and balances now; an overlap
//     with time off approved since is refused, and so is offset time off the available balance no
//     longer covers ("…Return or reject it."); a leave split is fixed against the available
//     balance then; the `usage` entry is written (leave: minus the paid half days of a `credited`
//     type; offset: minus the minutes), `approved`, and an `update` entry.
//   - return or reject: the status, the remarks, and an `update` entry whose reason is them.

/** The request's audit label: its number (never the type, so a confidential one stays hidden). */
export function timeOffAuditLabel(request: Pick<TimeOffRequestDocument, 'number'>): string {
  return request.number;
}

/** True when the requester is in the HR department at submit (decision 313). */
export function isHrRequester(identity: Pick<EmployeeIdentity, 'department'>): boolean {
  return identity.department?.code === ROLE_DEPARTMENT_CODES.hr;
}

/**
 * The one approval step of a request (decision 313): the supervisors, or HR alone for a
 * confidential type; the empty-step rule sends an HR requester's to the System Administrator.
 */
export function timeOffApprovalSteps(input: {
  hrRequester: boolean;
  confidential: boolean;
}): ApprovalStepSpec[] {
  const whenEmpty = input.hrRequester ? 'systemAdministrator' : 'hr';
  if (input.confidential) {
    return [
      {
        kind: 'anyOf',
        label: TIME_OFF_APPROVAL_STEP_LABELS.hr,
        // An HR requester's confidential leave never goes to the other HR users.
        approvers: input.hrRequester ? { userIds: [] } : { set: 'hr' },
        whenEmpty: 'systemAdministrator',
      },
    ];
  }
  return [{ kind: 'reportingTo', label: TIME_OFF_APPROVAL_STEP_LABELS.supervisor, whenEmpty }];
}

let registered = false;

/** Registers `talent.leave` and `talent.offsetTimeOff`. Safe to call on every request. */
export function registerTimeOffApprovalTypes(): void {
  if (registered) return;
  for (const [type, label] of [
    [LEAVE_APPROVAL_TYPE, TIME_OFF_APPROVAL_TYPE_LABELS.leave],
    [OFFSET_TIME_OFF_APPROVAL_TYPE, TIME_OFF_APPROVAL_TYPE_LABELS.offset],
  ] as const) {
    registerApprovalType(type, {
      module: 'talent',
      label,
      allowedDecisions: ['approve', 'return', 'reject'],
      onSettled: onTimeOffSettled,
    });
  }
  registered = true;
}

/** The request of the approval, pending on this very approval request; anything else is a bug. */
async function pendingRequestOf(
  context: ApprovalHookContext,
  session: ClientSession,
): Promise<TimeOffRequestDocument> {
  const id = objectIdOf(context.request.record.id);
  const request = id
    ? await TimeOffRequestModel.findById(id).session(session).lean<TimeOffRequestDocument>()
    : null;
  if (
    !request ||
    request.status !== 'pending' ||
    request.approvalRequestId?.toHexString() !== context.request.id
  ) {
    throw new Error('The time off request for this approval is missing or no longer pending.');
  }
  return request;
}

/** Moves the request with its `update` entry, in the decision's transaction. */
async function moveRequest(
  context: ApprovalHookContext,
  before: TimeOffRequestDocument,
  status: TimeOffStatus,
  set: Record<string, unknown>,
): Promise<TimeOffRequestDocument> {
  const { decision, session } = context;
  const by = new Types.ObjectId(decision.userId);
  const after = await TimeOffRequestModel.findOneAndUpdate(
    { _id: before._id, version: before.version, status: before.status },
    {
      $set: {
        ...set,
        status,
        decidedAt: now(),
        decidedBy: by,
        remarks: decision.remarks,
        updatedBy: by,
      },
      $inc: { version: 1 },
    },
    { session, returnDocument: 'after', runValidators: true },
  ).lean<TimeOffRequestDocument>();
  if (!after) throw new Error('The time off request changed while the decision was being saved.');
  await recordAudit(
    {
      actorId: decision.userId,
      actorEmail: decision.email,
      module: 'talent',
      action: 'update',
      record: { type: TIME_OFF_REQUEST_TYPE, id: before._id, label: timeOffAuditLabel(before) },
      ...snapshotsForAudit(TimeOffRequestModel, before, after),
      reason: decision.remarks,
    },
    { session },
  );
  return after;
}

/** The leave's split fixed against the available balance now (decision 311). */
function fixedLeaveSplit(
  type: LeaveType | null,
  days: Parameters<typeof splitLeaveDays>[0],
  available: number,
) {
  const pay = { balance: type?.balance ?? 'perEvent', paid: type?.paid ?? true } as const;
  return splitLeaveDays(days, pay, available).split;
}

async function onTimeOffSettled(context: ApprovalHookContext): Promise<void> {
  const { decision, session } = context;
  const before = await pendingRequestOf(context, session);

  if (decision.decision === 'return' || decision.decision === 'reject') {
    const status = nextTimeOffStatus(before.status, decision.decision);
    if (!status) throw new Error(`A time off request can't be ${decision.decision}ed now.`);
    await moveRequest(context, before, status, {});
    return;
  }
  if (decision.decision !== 'approve') throw new Error('Unknown decision.');

  await touchTimeOffLock(before.employeeId, session);
  const employeeId = before.employeeId.toHexString();
  const identity = await serviceIdentity(employeeId, { session });
  if (!identity) throw new ActionError('This employee no longer exists. Return or reject it.');
  const today = businessToday();
  const settings = await leaveSettingsOn(today, { session });
  const { type, days } = await recountStoredRequest(before, identity, settings, session);

  const overlap = await approvedOverlapOf(before, days, identity, settings, session);
  if (overlap) {
    throw new ActionError(
      `This request overlaps time off approved on ${formatShortDay(overlap)} since it was filed. Return or reject it.`,
    );
  }

  const author = { userId: decision.userId, email: decision.email };
  if (before.kind === 'offset') {
    const minutes = chargeableMinutesOf(days);
    const available = await availableOffsetMinutesOf(before.employeeId, {
      exceptRequestId: before._id,
      session,
    });
    if (minutes > available) throw new ActionError(OFFSET_NO_LONGER_COVERED_MESSAGE);
    const after = await moveRequest(context, before, 'approved', { minutes });
    await writeOffsetUsage(
      { employeeId, minutes: -minutes, effectiveOn: today, requestId: after._id },
      author,
      session,
    );
    return;
  }

  const available =
    type?.balance === 'credited'
      ? await availableLeaveHalfDaysOf(before.employeeId, type.key, {
          today,
          exceptRequestId: before._id,
          session,
        })
      : 0;
  const split = fixedLeaveSplit(type, days, available);
  const after = await moveRequest(context, before, 'approved', {
    chargeableHalfDays: split.chargeableHalfDays,
    paidHalfDays: split.paidHalfDays,
    unpaidHalfDays: split.unpaidHalfDays,
  });
  if (type?.balance === 'credited' && split.paidHalfDays) {
    await writeLeaveUsage(
      {
        employeeId,
        typeKey: type.key,
        halfDays: -split.paidHalfDays,
        effectiveOn: today,
        requestId: after._id,
      },
      author,
      session,
    );
  }
}
