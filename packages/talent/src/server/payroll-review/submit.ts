import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, businessToday, type Centavos } from '@pulse/core';
import {
  activeBoardApprovers,
  decryptSensitive,
  getCompanyDetailsStatus,
  recordAudit,
  reloadActorAccess,
  snapshotsForAudit,
  submitApproval,
} from '@pulse/core/server';
import {
  isEditablePayrollRunStatus,
  livePayrollManualEntries,
  PAYROLL_COMPANY_PLACEHOLDER_WARNING,
  PAYROLL_NO_BOARD_MESSAGE,
  PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE,
  PAYROLL_RUN_CHANGED_MESSAGE,
  payrollApprovalTitle,
  payrollFlaggedRefusal,
  payrollPeriodText,
  payrollSubmitSummary,
  parsePayrollBreakdown,
  serializePayrollBreakdown,
} from '../../payroll-run';
import {
  type ComputedPayrollRun,
  loadPayrollManualEntries,
  loadPayrollRunVersions,
} from '../payroll-runs/compute';
import {
  PAYROLL_RUN_RECORD_TYPE,
  PAYROLL_RUN_TOTAL_PATHS,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import {
  computeStoredPayrollRun,
  loadPayrollFlagAcknowledgements,
  PAYROLL_RUN_GONE,
  PAYROLL_RUN_NOT_EDITABLE,
  payrollRunHref,
  recomputeEditablePayrollRun,
} from '../payroll-runs/service';
import { assertCanSubmitPayrollRuns, type TalentActor } from '../policy';
import { auditLabelOf, dayOf, objectIdOf } from '../shared';
import { payrollRunUnresolvedFlags } from './acknowledgements';
import { PAYROLL_RUN_APPROVAL_TYPE, registerPayrollRunApprovalType } from './approval';
import { earlierCutOffRefusal } from './order';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Submitting")
// and decisions 360–362 in docs/BUILD_PLAN.md — "Submit for approval" on a `draft` or `returned`
// run: Talent Write and HR or the System Administrator. In order, refusing with the first message
// that applies:
//
// 1. Cut-off order: every earlier regular cut-off on or after the first payroll cut-off has a
//    finalized run.
// 2. The page's version is current; then the run is computed from its sources as they are now and
//    compared with what is stored (every line's breakdown, flags, manual entry count, timesheet and
//    settled periods; the totals, the flag counts and the people left out). If anything differs,
//    the recompute is saved (version raised) and the submit refused.
// 3. No line has net pay below zero or a stale manual entry, and every other flag is acknowledged
//    (read in the submit's transaction, since acknowledgements don't raise the run's version).
// 4. At least one employee line, and at least one active Board member other than the requester.
//
// In one transaction, checked against the version compared: the request is sent with
// `submitApproval()` (title "Payroll · <period>", the run number as the record label, a summary in
// counts only; a returned run's new request names the previous one), then the run moves to
// `pendingApproval` (`submittedAt`, `submittedBy`, `approvalRequestId`, `version` raised), and
// `update` ("Submitted for approval") is written. No amount anywhere.

/** The audit reason of a submit. */
export const PAYROLL_SUBMITTED_REASON = 'Submitted for approval';
/** A run with no employee line has nothing to submit. */
export const PAYROLL_NO_EMPLOYEES_MESSAGE =
  'This run has no employees to pay, so there is nothing to submit.';

export interface SubmitPayrollRunInput {
  runId: string;
  /** The run version the page shows. */
  version: number;
}

export interface SubmittedPayrollRun {
  id: string;
  version: number;
  approvalRequestId: string;
}

type StoredLineRow = Pick<
  PayrollRunEmployeeDocument,
  | 'employeeId'
  | 'timesheetId'
  | 'timesheetStatus'
  | 'timesheetApproved'
  | 'settledPeriods'
  | 'negativeNet'
  | 'flags'
  | 'manualEntryCount'
> & { breakdown?: unknown };

const flagsKey = (flags: readonly { kind: string; items: readonly string[] }[]) =>
  JSON.stringify(flags.map((flag) => [flag.kind, [...flag.items]]));

/**
 * True when the stored run `run` holds exactly what `computed` would store: every line (its
 * breakdown, flags, manual entry count, timesheet and settled periods), the totals, the flag
 * counts and the people left out. Decrypts the stored breakdowns and totals to compare; nothing is
 * sent or logged.
 */
export async function storedPayrollRunMatches(
  run: PayrollRunDocument,
  computed: ComputedPayrollRun,
): Promise<boolean> {
  if (run.employeeCount !== computed.lines.length) return false;
  const leftOutKey = (rows: readonly { employeeId: string; reason: string }[]) =>
    rows
      .map((row) => `${row.employeeId}:${row.reason}`)
      .sort()
      .join(',');
  if (
    leftOutKey(
      run.leftOut.map((row) => ({ employeeId: row.employeeId.toHexString(), reason: row.reason })),
    ) !== leftOutKey(computed.leftOut)
  ) {
    return false;
  }
  for (const [kind, count] of Object.entries(computed.flagCounts)) {
    if ((run.flagCounts?.[kind as keyof typeof run.flagCounts] ?? 0) !== count) return false;
  }
  const [stored, withTotals] = await Promise.all([
    PayrollRunEmployeeModel.find(
      { runId: run._id },
      {
        employeeId: 1,
        timesheetId: 1,
        timesheetStatus: 1,
        timesheetApproved: 1,
        settledPeriods: 1,
        negativeNet: 1,
        flags: 1,
        manualEntryCount: 1,
      },
    )
      .select('+breakdown')
      .lean<StoredLineRow[]>(),
    PayrollRunModel.findById(run._id)
      .select(PAYROLL_RUN_TOTAL_PATHS.map((path) => `+totals.${path}`).join(' '))
      .lean<Pick<PayrollRunDocument, 'totals'>>(),
  ]);
  if (stored.length !== computed.lines.length || !withTotals) return false;
  for (const path of PAYROLL_RUN_TOTAL_PATHS) {
    const value = (await decryptSensitive(withTotals.totals[path])) as Centavos;
    if (value !== computed.totals[path]) return false;
  }
  const storedOf = new Map(stored.map((line) => [line.employeeId.toHexString(), line]));
  for (const line of computed.lines) {
    const found = storedOf.get(line.employeeId);
    if (!found || !found.breakdown) return false;
    if (
      (found.timesheetId?.toHexString() ?? null) !== line.timesheetId ||
      (found.timesheetStatus ?? null) !== line.timesheetStatus ||
      found.timesheetApproved !== line.timesheetApproved ||
      found.negativeNet !== line.breakdown.negativeNet ||
      (found.manualEntryCount ?? 0) !== line.manualEntryCount ||
      flagsKey(found.flags ?? []) !== flagsKey(line.flags) ||
      found.settledPeriods.map(dayOf).join(',') !== line.settledPeriods.join(',')
    ) {
      return false;
    }
    const breakdown = parsePayrollBreakdown(String(await decryptSensitive(found.breakdown)));
    if (serializePayrollBreakdown(breakdown) !== serializePayrollBreakdown(line.breakdown)) {
      return false;
    }
  }
  return true;
}

/**
 * "Submit for approval" (decisions 361 and 362): see the header. Refuses with the first message
 * that applies; when the recompute at submit changes the run, the recompute is saved and
 * {@link PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE} thrown.
 */
export async function submitPayrollRun(
  actor: TalentActor,
  input: SubmitPayrollRunInput,
): Promise<SubmittedPayrollRun> {
  assertCanSubmitPayrollRuns(actor);
  const runId = objectIdOf(input?.runId);
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);
  const expectedVersion = input?.version;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion)) {
    throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
  }
  await connectDb();
  registerPayrollRunApprovalType();
  const today = businessToday();
  const versions = await loadPayrollRunVersions();

  const run = await PayrollRunModel.findById(runId).lean<PayrollRunDocument>();
  if (!run) throw new ActionError(PAYROLL_RUN_GONE);
  if (!isEditablePayrollRunStatus(run.status)) throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);

  // 1. Cut-off order.
  const order = await earlierCutOffRefusal(run, { versions, today });
  if (order) throw new ActionError(order);

  // 2. The page's version, then the recompute at submit.
  if (run.version !== expectedVersion) throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
  const computed = await computeStoredPayrollRun(run, { today, versions });
  if (!(await storedPayrollRunMatches(run, computed))) {
    await recomputeEditablePayrollRun(runId, {
      actor: { id: actor.id, email: actor.email },
      today,
      versions,
      expectedVersion,
      recheck: async (session) => {
        assertCanSubmitPayrollRuns(await reloadActorAccess({ id: actor.id }, session));
      },
      auditReason: 'Recomputed at submit',
    });
    throw new ActionError(PAYROLL_RECOMPUTED_AT_SUBMIT_MESSAGE);
  }

  return withTransaction(async (session) => {
    assertCanSubmitPayrollRuns(await reloadActorAccess({ id: actor.id }, session));
    const before = await PayrollRunModel.findById(runId)
      .session(session)
      .lean<PayrollRunDocument>();
    if (!before) throw new ActionError(PAYROLL_RUN_GONE);
    if (!isEditablePayrollRunStatus(before.status)) {
      throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);
    }
    if (before.version !== expectedVersion) throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
    const orderNow = await earlierCutOffRefusal(before, { versions, today, session });
    if (orderNow) throw new ActionError(orderNow);

    // 3. Flags, read in this transaction.
    const unresolved = await payrollRunUnresolvedFlags(runId, { session });
    if (unresolved.count > 0) throw new ActionError(payrollFlaggedRefusal(unresolved.count));

    // 4. At least one line, and a Board member other than the requester.
    const lines = await PayrollRunEmployeeModel.find({ runId }, { employeeId: 1, flags: 1 })
      .session(session)
      .lean<Pick<PayrollRunEmployeeDocument, 'employeeId' | 'flags'>[]>();
    if (lines.length === 0) throw new ActionError(PAYROLL_NO_EMPLOYEES_MESSAGE);
    const board = await activeBoardApprovers(session);
    if (!board.some((member) => member.userId.toHexString() !== actor.id)) {
      throw new ActionError(PAYROLL_NO_BOARD_MESSAGE);
    }

    const [acknowledgements, entries] = await Promise.all([
      loadPayrollFlagAcknowledgements(runId, { session }),
      loadPayrollManualEntries(runId, { session }),
    ]);
    const flagsOf = new Map(
      lines.map((line) => [
        line.employeeId.toHexString(),
        new Set((line.flags ?? []).map((flag) => flag.kind)),
      ]),
    );
    const acknowledgedFlagCount = acknowledgements.filter((row) =>
      flagsOf.get(row.employeeId.toHexString())?.has(row.flag),
    ).length;
    const periodStart = dayOf(before.periodStart);
    const periodEnd = dayOf(before.periodEnd);
    const submitted = await submitApproval(
      {
        type: PAYROLL_RUN_APPROVAL_TYPE,
        record: { type: PAYROLL_RUN_RECORD_TYPE, id: runId, label: before.number },
        title: payrollApprovalTitle(periodStart, periodEnd),
        summary: payrollSubmitSummary({
          employeeCount: lines.length,
          manualEntryCount: livePayrollManualEntries(entries).length,
          acknowledgedFlagCount,
          payDate: dayOf(before.payDate),
        }),
        href: payrollRunHref(runId.toHexString()),
        requesterUserId: actor.id,
        previousRequestId: before.status === 'returned' ? before.approvalRequestId : null,
      },
      { session },
    );
    if (submitted.status !== 'pending') {
      // The step has no `whenEmpty`, so it is never skipped; anything else is a bug.
      throw new Error('A payroll run’s approval request was not left waiting for the Board.');
    }

    const by = new Types.ObjectId(actor.id);
    const after = await PayrollRunModel.findOneAndUpdate(
      { _id: runId, status: before.status, version: before.version },
      {
        $set: {
          status: 'pendingApproval',
          submittedAt: new Date(),
          submittedBy: by,
          approvalRequestId: new Types.ObjectId(submitted.id),
          updatedBy: by,
        },
        $inc: { version: 1 },
      },
      { session, returnDocument: 'after' },
    ).lean<PayrollRunDocument>();
    if (!after) throw new ActionError(PAYROLL_RUN_CHANGED_MESSAGE);
    await recordAudit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        module: 'talent',
        action: 'update',
        record: {
          type: PAYROLL_RUN_RECORD_TYPE,
          id: runId,
          label: auditLabelOf(before.number, payrollPeriodText(periodStart, periodEnd)),
        },
        ...snapshotsForAudit(PayrollRunModel, before, after),
        reason: PAYROLL_SUBMITTED_REASON,
      },
      { session },
    );
    return { id: runId.toHexString(), version: after.version, approvalRequestId: submitted.id };
  });
}

/**
 * The submit sheet's warning (decision 366): "Company details are still placeholders, so
 * payslips will print them." while any company detail is a placeholder, else null.
 */
export async function payrollCompanyDetailsWarning(): Promise<string | null> {
  await connectDb();
  const status = await getCompanyDetailsStatus();
  return status.complete ? null : PAYROLL_COMPANY_PLACEHOLDER_WARNING;
}
