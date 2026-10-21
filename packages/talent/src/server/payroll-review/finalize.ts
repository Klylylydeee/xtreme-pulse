import { type ClientSession, Types } from 'mongoose';
import { ActionError, type BusinessDate, now, startOfBusinessDate } from '@pulse/core';
import {
  type ApprovalHookContext,
  decryptSensitive,
  type EmployeeIdentity,
  encryptSensitive,
  listEmployeeIdentities,
  notify,
  recordAudit,
  snapshotsForAudit,
} from '@pulse/core/server';
import {
  parsePayrollBreakdown,
  payrollPeriodText,
  payrollYearToDate,
  payrollYtdFiguresOf,
  type PayrollYtdFigures,
  type PayrollYtdLineInput,
  type PayrollYtdOpeningInput,
  payslipReadyText,
  serializePayrollYearToDate,
} from '../../payroll-run';
import { type EmployeeRecordDocument, EmployeeRecordModel } from '../employee-records/model';
import {
  type PayrollOpeningEntryDocument,
  PayrollOpeningEntryModel,
} from '../opening-balances/model';
import { loadPayrollRunVersions, PAYROLL_READER } from '../payroll-runs/compute';
import {
  PAYROLL_RUN_RECORD_TYPE,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
  type PayslipSnapshot,
} from '../payroll-runs/model';
import { auditLabelOf, dayOf, objectIdOf } from '../shared';
import { earlierCutOffRefusal } from './order';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Approved",
// "Year-to-date", "Locked"; decisions 363, 364 and 373 in docs/BUILD_PLAN.md) — the approve half of
// `talent.payrollRun`'s `onSettled`, in the Board member's decision transaction (a throw rolls the
// decision back):
//
// - Checks the run is still `pendingApproval` on this very request, and that every earlier regular
//   cut-off is finalized.
// - Freezes each line's payslip snapshot (one `bulkWrite` of `updateOne`s filtered on
//   `payslip: null`, while the run is still pending in the session): the employee's name, number,
//   department and position as they are now; the payroll bank account on file (bank, account name
//   and the number re-encrypted), or none; and the year-to-date figures (encrypted JSON).
// - Finalizes the run (`finalized`, `finalizedAt`, `finalizedBy`, `fiscalPosting: notPosted`,
//   `payslipsPending`, `version` raised) and writes `update` ("Finalized") with the Board member as
//   the actor.
// - Sends `talent.payslipReady` to each employee with an active account (no amount; once per line).
//
// Everything is loaded in batches before the writes (the decision's transaction has MongoDB's
// 60-second limit): the lines, the identities, the employee records, the opening entries and the
// year's earlier finalized lines, each one query. Nothing here logs or audits an amount or an
// account number.

/** The new notification (decision 373). */
export const PAYSLIP_READY_EVENT = 'talent.payslipReady';
/** Once per payslip (`notify()`'s `dedupeKey`). */
export const payslipReadyDedupeKey = (lineId: string) => `${PAYSLIP_READY_EVENT}:${lineId}`;
/** Where the notification links: the Payslips section of the employee's own record. */
export const PAYSLIPS_HREF = '/talent/me#payslips';
/** The finalize audit entry's reason. */
export const PAYROLL_FINALIZED_REASON = 'Finalized';

/** The figures of an opening entry the year-to-date sum reads. */
const OPENING_FIGURE_PATHS = [
  'grossCentavos',
  'taxWithheldCentavos',
  'sssEmployeeCentavos',
  'philhealthEmployeeCentavos',
  'pagibigEmployeeCentavos',
] as const satisfies readonly (keyof PayrollYtdFigures)[];

type LineWithBreakdown = Pick<PayrollRunEmployeeDocument, '_id' | 'employeeId' | 'payslip'> & {
  breakdown?: unknown;
};

/** The run of the request, pending on this very request; anything else is a bug. */
export async function pendingRunOf(
  context: ApprovalHookContext,
  session: ClientSession,
): Promise<PayrollRunDocument> {
  const id = objectIdOf(context.request.record.id);
  const run = id
    ? await PayrollRunModel.findById(id).session(session).lean<PayrollRunDocument>()
    : null;
  if (
    !run ||
    run.status !== 'pendingApproval' ||
    run.approvalRequestId?.toHexString() !== context.request.id
  ) {
    throw new Error('The payroll run for this approval is missing or no longer waiting for it.');
  }
  return run;
}

async function decryptWhole(value: unknown): Promise<number> {
  const decrypted = await decryptSensitive(value);
  if (typeof decrypted !== 'number' || !Number.isSafeInteger(decrypted)) {
    // Never put the value in the message.
    throw new Error('A stored opening figure is not whole centavos.');
  }
  return decrypted;
}

/** Each employee's latest opening entry for `year`, its figures decrypted. */
async function loadOpeningEntries(
  employeeIds: readonly Types.ObjectId[],
  year: number,
  session: ClientSession,
): Promise<Map<string, PayrollYtdOpeningInput>> {
  const rows = await PayrollOpeningEntryModel.find(
    { employeeId: { $in: employeeIds }, year },
    { employeeId: 1, year: 1, createdAt: 1 },
  )
    .select(OPENING_FIGURE_PATHS.map((path) => `+${path}`).join(' '))
    .sort({ createdAt: -1, _id: -1 })
    .session(session)
    .lean<PayrollOpeningEntryDocument[]>();
  const latest = new Map<string, PayrollOpeningEntryDocument>();
  for (const row of rows) {
    const key = row.employeeId.toHexString();
    if (!latest.has(key)) latest.set(key, row);
  }
  const result = new Map<string, PayrollYtdOpeningInput>();
  await Promise.all(
    [...latest].map(async ([employeeId, row]) => {
      const figures = Object.fromEntries(
        await Promise.all(
          OPENING_FIGURE_PATHS.map(async (path) => [path, await decryptWhole(row[path])] as const),
        ),
      ) as unknown as PayrollYtdFigures;
      result.set(employeeId, { year: row.year, createdAt: row.createdAt, figures });
    }),
  );
  return result;
}

/**
 * The year's earlier finalized regular runs' lines of `employeeIds` (pay date in `year`, period
 * before the run's), each as the year-to-date sum reads it, by employee.
 */
async function loadEarlierLines(
  run: PayrollRunDocument,
  employeeIds: readonly Types.ObjectId[],
  year: number,
  session: ClientSession,
): Promise<Map<string, PayrollYtdLineInput[]>> {
  const result = new Map<string, PayrollYtdLineInput[]>();
  const runs = await PayrollRunModel.find(
    {
      kind: 'regular',
      status: 'finalized',
      payDate: {
        $gte: startOfBusinessDate(`${year}-01-01`),
        $lt: startOfBusinessDate(`${year + 1}-01-01`),
      },
      periodStart: { $lt: run.periodStart },
    },
    { payDate: 1, periodStart: 1 },
  )
    .session(session)
    .lean<Pick<PayrollRunDocument, '_id' | 'payDate' | 'periodStart'>[]>();
  if (runs.length === 0 || employeeIds.length === 0) return result;
  const runOf = new Map(runs.map((row) => [row._id.toHexString(), row]));
  const lines = await PayrollRunEmployeeModel.find(
    { runId: { $in: runs.map((row) => row._id) }, employeeId: { $in: employeeIds } },
    { runId: 1, employeeId: 1 },
  )
    .select('+breakdown')
    .session(session)
    .lean<(Pick<PayrollRunEmployeeDocument, 'runId' | 'employeeId'> & { breakdown?: unknown })[]>();
  await Promise.all(
    lines.map(async (line) => {
      const of = runOf.get(line.runId.toHexString());
      if (!of || !line.breakdown) return;
      const breakdown = parsePayrollBreakdown(String(await decryptSensitive(line.breakdown)));
      const key = line.employeeId.toHexString();
      const list = result.get(key) ?? [];
      list.push({
        payDate: dayOf(of.payDate),
        periodStart: dayOf(of.periodStart),
        figures: payrollYtdFiguresOf(breakdown),
      });
      result.set(key, list);
    }),
  );
  return result;
}

/** The payroll bank account on file re-encrypted for the snapshot, or null with none. */
async function bankSnapshotOf(
  record: Pick<EmployeeRecordDocument, 'bankAccount'> | undefined,
): Promise<PayslipSnapshot['bank']> {
  const account = record?.bankAccount;
  if (!account?.bank || !account.accountNumber) return null;
  const number = await decryptSensitive(account.accountNumber);
  if (typeof number !== 'string' || number.length === 0) return null;
  return {
    bank: account.bank,
    accountName: account.accountName ?? null,
    accountNumber: (await encryptSensitive(number)) as unknown as Buffer,
  };
}

const nameOf = (identity: EmployeeIdentity | undefined) =>
  identity ? `${identity.firstName} ${identity.lastName}` : 'Unknown employee';

/**
 * Approve: freezes every line's payslip snapshot, finalizes the run, audits it and notifies each
 * employee, in the decision's transaction. Returns how many lines were frozen.
 */
export async function finalizePayrollRun(context: ApprovalHookContext): Promise<{ lines: number }> {
  const { decision, session } = context;
  const run = await pendingRunOf(context, session);
  const versions = await loadPayrollRunVersions();
  const refusal = await earlierCutOffRefusal(run, { versions, session });
  if (refusal) throw new ActionError(refusal);

  const payDate: BusinessDate = dayOf(run.payDate);
  const periodStart: BusinessDate = dayOf(run.periodStart);
  const year = Number(payDate.slice(0, 4));

  const lines = await PayrollRunEmployeeModel.find(
    { runId: run._id },
    { employeeId: 1, payslip: 1 },
  )
    .select('+breakdown')
    .session(session)
    .lean<LineWithBreakdown[]>();
  const employeeIds = lines.map((line) => line.employeeId);
  const [identities, records, openings, earlier] = await Promise.all([
    listEmployeeIdentities(PAYROLL_READER, { separated: true, session }),
    EmployeeRecordModel.find({ employeeId: { $in: employeeIds } })
      .select('+bankAccount.accountNumber')
      .session(session)
      .lean<EmployeeRecordDocument[]>(),
    loadOpeningEntries(employeeIds, year, session),
    loadEarlierLines(run, employeeIds, year, session),
  ]);
  const identityOf = new Map(identities.map((identity) => [identity.employeeId, identity]));
  const recordOf = new Map(records.map((record) => [record.employeeId.toHexString(), record]));

  const by = new Types.ObjectId(decision.userId);
  const ops = await Promise.all(
    lines.map(async (line) => {
      if (line.payslip) throw new Error('A pending run’s line already has a payslip.');
      if (!line.breakdown) throw new Error('A payroll run line has no breakdown.');
      const employeeId = line.employeeId.toHexString();
      const identity = identityOf.get(employeeId);
      const breakdown = parsePayrollBreakdown(String(await decryptSensitive(line.breakdown)));
      const opening = openings.get(employeeId);
      const ytd = payrollYearToDate({
        payDate,
        periodStart,
        openingEntries: opening ? [opening] : [],
        lines: [
          ...(earlier.get(employeeId) ?? []),
          { payDate, periodStart, figures: payrollYtdFiguresOf(breakdown) },
        ],
      });
      const payslip: Omit<PayslipSnapshot, 'ytd'> & { ytd: unknown } = {
        employeeName: nameOf(identity),
        employeeNumber: identity?.employeeNumber || employeeId,
        departmentName: identity?.department?.name ?? null,
        positionTitle: identity?.position?.name ?? null,
        bank: await bankSnapshotOf(recordOf.get(employeeId)),
        ytd: await encryptSensitive(serializePayrollYearToDate(ytd)),
        fileId: null,
        generatedAt: null,
      };
      return {
        updateOne: {
          filter: { _id: line._id, runId: run._id, payslip: null },
          update: { $set: { payslip, updatedBy: by } },
        },
      };
    }),
  );
  if (ops.length > 0) {
    const result = await PayrollRunEmployeeModel.bulkWrite(
      ops as unknown as Parameters<typeof PayrollRunEmployeeModel.bulkWrite>[0],
      { session, ordered: true },
    );
    if (result.matchedCount !== ops.length) {
      throw new Error('A payroll run line changed while the run was being finalized.');
    }
  }

  const finalizedAt = now();
  const after = await PayrollRunModel.findOneAndUpdate(
    { _id: run._id, status: 'pendingApproval', version: run.version },
    {
      $set: {
        status: 'finalized',
        finalizedAt,
        finalizedBy: by,
        fiscalPosting: { status: 'notPosted' },
        payslipsPending: true,
        updatedBy: by,
      },
      $inc: { version: 1 },
    },
    { session, returnDocument: 'after' },
  ).lean<PayrollRunDocument>();
  if (!after) throw new Error('The payroll run changed while it was being finalized.');
  const periodEnd = dayOf(run.periodEnd);
  await recordAudit(
    {
      actorId: decision.userId,
      actorEmail: decision.email,
      module: 'talent',
      action: 'update',
      record: {
        type: PAYROLL_RUN_RECORD_TYPE,
        id: run._id,
        label: auditLabelOf(run.number, payrollPeriodText(periodStart, periodEnd)),
      },
      ...snapshotsForAudit(PayrollRunModel, run, after),
      reason: PAYROLL_FINALIZED_REASON,
    },
    { session },
  );

  const title = payslipReadyText(periodStart, periodEnd);
  for (const line of lines) {
    const identity = identityOf.get(line.employeeId.toHexString());
    if (!identity?.active || !identity.userId) continue;
    const lineId = line._id.toHexString();
    await notify(
      {
        recipients: [identity.userId],
        module: 'talent',
        event: PAYSLIP_READY_EVENT,
        title,
        href: PAYSLIPS_HREF,
        record: { type: PAYROLL_RUN_RECORD_TYPE, id: run._id },
        dedupeKey: payslipReadyDedupeKey(lineId),
      },
      { session },
    );
  }
  return { lines: lines.length };
}
