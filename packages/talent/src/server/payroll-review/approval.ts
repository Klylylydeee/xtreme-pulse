import { Types } from 'mongoose';
import { now } from '@pulse/core';
import {
  activeHrUserIds,
  type ApprovalHookContext,
  type ApprovalStepSpec,
  recordAudit,
  registerApprovalType,
  snapshotsForAudit,
} from '@pulse/core/server';
import { payrollPeriodText } from '../../payroll-run';
import {
  PAYROLL_RUN_RECORD_TYPE,
  PAYROLL_RUN_RETURN_REMARKS_MAX_LENGTH,
  type PayrollRunDocument,
  PayrollRunModel,
} from '../payroll-runs/model';
import { auditLabelOf, dayOf } from '../shared';
import { finalizePayrollRun, pendingRunOf } from './finalize';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("The approval
// type `talent.payrollRun`", "Approved", "Returned"), docs/modules/core.md#approvals and decisions
// 362 and 363 in docs/BUILD_PLAN.md — the approval type `talent.payrollRun`, registered by
// `registerTalentApprovalTypes()` beside the other Talent types.
//
// - One `anyOf` step, "Board of Directors" (`{ set: 'board' }`): any one active Board member. No
//   `whenEmpty`, so with no active Board member (the requester left out) the submit is refused;
//   the submit checks that first with its own message. The engine fixes the approvers at submit,
//   and an approve applies the Board member's own e-signature (the signer gate refuses one without).
// - Decisions: approve and return (a return needs remarks). No reject.
// - `onSettled`, in the decision's transaction (throwing rolls it back): approve finalizes the run
//   (./finalize.ts); return moves it to `returned` with `returnedAt`, `returnedBy` and the remarks,
//   and writes `update` on the run with the remarks as its reason.
// - `outcomeRecipients`: the requester and every active HR user (Accounting hears from HR).
// - Notifications of waiting, settled and the outcome are the engine's; finalizing adds
//   `talent.payslipReady`.

/** The approval type, also the run's record type. */
export const PAYROLL_RUN_APPROVAL_TYPE = PAYROLL_RUN_RECORD_TYPE;
/** The type's label in the Approvals list. */
export const PAYROLL_RUN_APPROVAL_TYPE_LABEL = 'Payroll run';
/** The step's label. */
export const PAYROLL_RUN_APPROVAL_STEP_LABEL = 'Board of Directors';

/** The type's one step (decision 362). */
export const PAYROLL_RUN_APPROVAL_STEPS: readonly ApprovalStepSpec[] = [
  { kind: 'anyOf', label: PAYROLL_RUN_APPROVAL_STEP_LABEL, approvers: { set: 'board' } },
];

let registered = false;

/** Registers `talent.payrollRun` with Core's approvals engine. Safe to call on every request. */
export function registerPayrollRunApprovalType(): void {
  if (registered) return;
  registerApprovalType(PAYROLL_RUN_APPROVAL_TYPE, {
    module: 'talent',
    label: PAYROLL_RUN_APPROVAL_TYPE_LABEL,
    allowedDecisions: ['approve', 'return'],
    steps: PAYROLL_RUN_APPROVAL_STEPS,
    onSettled: onPayrollRunSettled,
    outcomeRecipients: payrollRunOutcomeRecipients,
  });
  registered = true;
}

/** The requester and every active HR user. */
async function payrollRunOutcomeRecipients({
  request,
  session,
}: ApprovalHookContext): Promise<string[]> {
  const hr = await activeHrUserIds({ session });
  return [...new Set([request.requesterUserId, ...hr])];
}

/** Approve (finalize) or return with remarks. */
async function onPayrollRunSettled(context: ApprovalHookContext): Promise<void> {
  const { decision } = context;
  if (decision.decision === 'approve') {
    await finalizePayrollRun(context);
    return;
  }
  if (decision.decision === 'return') {
    await returnPayrollRun(context);
    return;
  }
  throw new Error('A payroll run is approved or returned, never rejected.');
}

/** Return: `returned` with the remarks, and `update` on the run with the remarks as its reason. */
async function returnPayrollRun(context: ApprovalHookContext): Promise<void> {
  const { decision, session } = context;
  const remarks = decision.remarks?.trim() ?? '';
  if (!remarks) throw new Error('A payroll run is returned with remarks.');
  const before = await pendingRunOf(context, session);
  const by = new Types.ObjectId(decision.userId);
  const after = await PayrollRunModel.findOneAndUpdate(
    { _id: before._id, status: 'pendingApproval', version: before.version },
    {
      $set: {
        status: 'returned',
        returnedAt: now(),
        returnedBy: by,
        returnRemarks: remarks.slice(0, PAYROLL_RUN_RETURN_REMARKS_MAX_LENGTH),
        updatedBy: by,
      },
      $inc: { version: 1 },
    },
    { session, returnDocument: 'after', runValidators: true },
  ).lean<PayrollRunDocument>();
  if (!after) throw new Error('The payroll run changed while the decision was being saved.');
  await recordAudit(
    {
      actorId: decision.userId,
      actorEmail: decision.email,
      module: 'talent',
      action: 'update',
      record: {
        type: PAYROLL_RUN_RECORD_TYPE,
        id: before._id,
        label: auditLabelOf(
          before.number,
          payrollPeriodText(dayOf(before.periodStart), dayOf(before.periodEnd)),
        ),
      },
      ...snapshotsForAudit(PayrollRunModel, before, after),
      reason: remarks,
    },
    { session },
  );
}
