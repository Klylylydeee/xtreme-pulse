import { connectDb } from '@pulse/db';
import { AccessDeniedError, approvalHref } from '@pulse/core';
import { isApproverFor, listApprovalsForRecord } from '@pulse/core/server';
import { PAYROLL_APPROVE_IN_APPROVALS_LABEL } from '../../payroll-run';
import {
  PAYROLL_RUN_RECORD_TYPE,
  type PayrollRunDocument,
  PayrollRunModel,
} from '../payroll-runs/model';
import {
  buildPayrollRunView,
  type PayrollRunView,
  recordPayrollRunAmountsReveal,
} from '../payroll-runs/service';
import type { TalentActor } from '../policy';
import { objectIdOf } from '../shared';
import { registerPayrollRunApprovalType } from './approval';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("The Board's
// view while approving"), SECURITY.md#sensitive-data and SECURITY.md#exceptions-to-module-access
// (decision 365 in docs/BUILD_PLAN.md; HANDOFF item 284, closed this way) — a Board member opens a
// run from the approval under the approver exception, with no module access:
//
// - Anyone who is or was an approver of a request for the run (Core's `isApproverFor`) sees the
//   run page read-only: the period, pay date, counts, flag tiles, the people with their flags and
//   acknowledgements, and the manual entries (labels, reasons, who), with no control at all.
// - While they are a pending approver of the run's pending request (the engine's
//   `allowedDecisions` for them isn't empty), "Show amounts" writes and commits a `reveal` on the run
//   (field `amounts`) first, then shows the run totals, each person's net pay and each manual
//   entry's amount (and an override's computed amount). Never a breakdown, a bank account, the
//   register or a payslip: none is on this view, and those services refuse an approver.
// - Afterwards (decided, or settled by someone else) the run opens read-only, with no amounts.
// - Nothing is decided here: the page links to the request in Approvals.

export const PAYROLL_RUN_APPROVER_DENIED =
  'You don’t have access to this payroll run. Board members open it from Approvals while it waits for them.';
export const PAYROLL_AMOUNTS_APPROVER_DENIED =
  'Amounts are shown only while the run is waiting for your approval.';

/** The Board's view of a run: the run page's view, read-only, plus where to decide. */
export interface PayrollRunApproverView extends PayrollRunView {
  approver: {
    /** True while the viewer is a pending approver of the run's pending request. */
    pending: boolean;
    /** "Show amounts" is offered (only while pending). */
    canShowAmounts: boolean;
    /** The pending request, or the latest one the viewer may open; null when none. */
    requestId: string | null;
    /** `/approvals?request=<id>`, or null. */
    approvalHref: string | null;
    /** "Approve or return in Approvals" (shown only while pending). */
    approveInApprovalsLabel: string;
  };
}

/**
 * True when `actor` may open run `runId` as an approver (they are or were an approver of one of
 * its requests). The page uses it to pick this view over the payroll one.
 */
export async function canViewPayrollRunAsApprover(
  actor: Pick<TalentActor, 'id'>,
  runId: string,
): Promise<boolean> {
  if (!objectIdOf(runId)) return false;
  return isApproverFor(actor.id, PAYROLL_RUN_RECORD_TYPE, runId);
}

/**
 * The run page for a Board member under the approver exception (see the header). Null when there
 * is no such run; {@link AccessDeniedError} for anyone who isn't and wasn't an approver of it, and
 * for "Show amounts" from anyone not a pending approver now (refused before any `reveal`).
 */
export async function getPayrollRunApproverView(
  actor: TalentActor,
  runId: string,
  { showAmounts = false }: { showAmounts?: boolean } = {},
): Promise<PayrollRunApproverView | null> {
  const id = objectIdOf(runId);
  if (!id) return null;
  await connectDb();
  registerPayrollRunApprovalType();
  const run = await PayrollRunModel.findById(id).lean<PayrollRunDocument>();
  if (!run) return null;
  if (!(await isApproverFor(actor.id, PAYROLL_RUN_RECORD_TYPE, id.toHexString()))) {
    throw new AccessDeniedError(PAYROLL_RUN_APPROVER_DENIED);
  }
  const requests = await listApprovalsForRecord(actor, PAYROLL_RUN_RECORD_TYPE, id.toHexString());
  const pendingRequest = requests.find(
    (request) => request.status === 'pending' && request.allowedDecisions.length > 0,
  );
  const pending = run.status === 'pendingApproval' && pendingRequest !== undefined;
  if (showAmounts) {
    if (!pending) throw new AccessDeniedError(PAYROLL_AMOUNTS_APPROVER_DENIED);
    await recordPayrollRunAmountsReveal(actor, run);
  }
  const view = await buildPayrollRunView(run, {
    viewer: actor,
    showAmounts: showAmounts && pending,
    readOnly: true,
  });
  const request = pendingRequest ?? requests[0] ?? null;
  return {
    ...view,
    // Nothing on this view is a control.
    canRecompute: false,
    canAcknowledge: false,
    people: view.people.map((person) => ({ ...person, canEnterManualEntries: false })),
    approver: {
      pending,
      canShowAmounts: pending,
      requestId: request?.id ?? null,
      approvalHref: request ? approvalHref(request.id) : null,
      approveInApprovalsLabel: PAYROLL_APPROVE_IN_APPROVALS_LABEL,
    },
  };
}
