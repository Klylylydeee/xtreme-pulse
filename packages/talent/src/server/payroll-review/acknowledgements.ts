import { type ClientSession, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError } from '@pulse/core';
import {
  listEmployeeIdentities,
  recordAudit,
  reloadActorAccess,
  snapshotForAudit,
} from '@pulse/core/server';
import {
  isEditablePayrollRunStatus,
  livePayrollManualEntries,
  isAcknowledgeableFlag,
  type PayrollAcknowledgeableFlag,
  payrollAcknowledgementAuditReason,
  payrollFlagAcknowledgementSchema,
  payrollPeriodText,
} from '../../payroll-run';
import { inputError } from '../input';
import { loadPayrollManualEntries, PAYROLL_READER } from '../payroll-runs/compute';
import {
  type PayrollLineFlag,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PAYROLL_RUN_RECORD_TYPE,
  PayrollRunModel,
} from '../payroll-runs/model';
import {
  loadPayrollFlagAcknowledgements,
  PAYROLL_RUN_GONE,
  PAYROLL_RUN_NOT_EDITABLE,
  unresolvedFlaggedEmployeesOf,
} from '../payroll-runs/service';
import { assertCanAcknowledgePayrollFlags, type TalentActor } from '../policy';
import { auditLabelOf, dayOf, isDuplicateKey, objectIdOf } from '../shared';
import { PayrollFlagAcknowledgementModel } from './model';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Review
// flags": acknowledging; "Submitting" step 3) and SECURITY.md#audit-logging (decisions 352–354 and
// 361 in docs/BUILD_PLAN.md; HANDOFF items 296–298).
//
// - "Acknowledge" (one person's flag) and "Acknowledge all" (every line carrying a flag), on an
//   editable (`draft` or `returned`) run, with a required reason (1–300). Only onboarding
//   incomplete, timesheet not approved and below minimum wage are acknowledgeable; net pay below
//   zero and a stale manual entry are resolved by manual entries.
// - Who: Talent Write and HR or the System Administrator, for every line, HR staff's included
//   (acknowledging changes no pay); checked first and again in the transaction.
// - One acknowledgement per run, employee and flag (insert-only, unique). It counts while the flag
//   is on the line, even one that cleared and came back. The run doesn't change (no version
//   raised); the submit reads the acknowledgements in its own transaction.
// - Each acknowledgement writes `update` on `talent.payrollRun` with the reason "Acknowledged
//   <flag> for <employee number>: <reason>", in the same transaction. No amount anywhere.

export const PAYROLL_FLAG_NOT_ON_LINE = 'This flag is no longer on the line. Reload the page.';
export const PAYROLL_FLAG_ALREADY_ACKNOWLEDGED = 'This flag is already acknowledged.';
export const PAYROLL_NOTHING_TO_ACKNOWLEDGE =
  'No employee has this flag left to acknowledge. Reload the page.';

export interface AcknowledgePayrollFlagInput {
  runId: string;
  employeeId: string;
  flag: string;
  reason: string;
}

export interface AcknowledgeAllPayrollFlagInput {
  runId: string;
  flag: string;
  reason: string;
}

function parse(input: { flag?: unknown; reason?: unknown } | null | undefined) {
  const parsed = payrollFlagAcknowledgementSchema.safeParse({
    flag: input?.flag,
    reason: input?.reason,
  });
  if (!parsed.success) throw inputError(parsed.error.issues);
  return parsed.data;
}

/** "Acknowledge" one person's flag. Returns how many were acknowledged (1). */
export async function acknowledgePayrollFlag(
  actor: TalentActor,
  input: AcknowledgePayrollFlagInput,
): Promise<{ acknowledged: number }> {
  assertCanAcknowledgePayrollFlags(actor);
  const { flag, reason } = parse(input);
  const runId = objectIdOf(input?.runId);
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);
  const employeeId = objectIdOf(input?.employeeId);
  if (!employeeId) throw new ActionError(PAYROLL_FLAG_NOT_ON_LINE);
  return acknowledge(actor, runId, flag, reason, employeeId);
}

/** "Acknowledge all" on a flag's tile: every line carrying it not yet acknowledged. */
export async function acknowledgeAllPayrollFlag(
  actor: TalentActor,
  input: AcknowledgeAllPayrollFlagInput,
): Promise<{ acknowledged: number }> {
  assertCanAcknowledgePayrollFlags(actor);
  const { flag, reason } = parse(input);
  const runId = objectIdOf(input?.runId);
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);
  return acknowledge(actor, runId, flag, reason, null);
}

async function acknowledge(
  actor: TalentActor,
  runId: Types.ObjectId,
  flag: PayrollAcknowledgeableFlag,
  reason: string,
  employeeId: Types.ObjectId | null,
): Promise<{ acknowledged: number }> {
  await connectDb();
  const identities = await listEmployeeIdentities(PAYROLL_READER, { separated: true });
  const numberOf = new Map(identities.map((row) => [row.employeeId, row.employeeNumber]));
  try {
    return await withTransaction(async (session) => {
      assertCanAcknowledgePayrollFlags(await reloadActorAccess({ id: actor.id }, session));
      const run = await PayrollRunModel.findById(runId).session(session).lean<PayrollRunDocument>();
      if (!run) throw new ActionError(PAYROLL_RUN_GONE);
      if (!isEditablePayrollRunStatus(run.status)) {
        throw new ActionError(PAYROLL_RUN_NOT_EDITABLE);
      }
      const lineFilter: Record<string, unknown> = { runId, 'flags.kind': flag };
      if (employeeId) lineFilter.employeeId = employeeId;
      const lines = await PayrollRunEmployeeModel.find(lineFilter, { employeeId: 1 })
        .session(session)
        .lean<Pick<PayrollRunEmployeeDocument, 'employeeId'>[]>();
      if (employeeId && lines.length === 0) throw new ActionError(PAYROLL_FLAG_NOT_ON_LINE);
      const done = new Set(
        (
          await PayrollFlagAcknowledgementModel.find(
            { runId, flag, employeeId: { $in: lines.map((line) => line.employeeId) } },
            { employeeId: 1 },
          )
            .session(session)
            .lean<{ employeeId: Types.ObjectId }[]>()
        ).map((row) => row.employeeId.toHexString()),
      );
      const open = lines.filter((line) => !done.has(line.employeeId.toHexString()));
      if (open.length === 0) {
        throw new ActionError(
          employeeId ? PAYROLL_FLAG_ALREADY_ACKNOWLEDGED : PAYROLL_NOTHING_TO_ACKNOWLEDGE,
        );
      }
      const by = new Types.ObjectId(actor.id);
      const created = await PayrollFlagAcknowledgementModel.create(
        open.map((line) => ({
          runId,
          employeeId: line.employeeId,
          flag,
          reason,
          createdBy: by,
          updatedBy: by,
        })),
        { session, ordered: true },
      );
      const label = auditLabelOf(
        run.number,
        payrollPeriodText(dayOf(run.periodStart), dayOf(run.periodEnd)),
      );
      for (const row of created) {
        const employee = row.employeeId.toHexString();
        await recordAudit(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            module: 'talent',
            action: 'update',
            record: { type: PAYROLL_RUN_RECORD_TYPE, id: runId, label },
            before: null,
            after: snapshotForAudit(PayrollFlagAcknowledgementModel, row.toObject()),
            reason: payrollAcknowledgementAuditReason(
              flag,
              numberOf.get(employee) ?? employee,
              reason,
            ),
          },
          { session },
        );
      }
      return { acknowledged: created.length };
    });
  } catch (error) {
    // Acknowledged by someone else at the same moment (the unique index).
    if (isDuplicateKey(error)) throw new ActionError(PAYROLL_FLAG_ALREADY_ACKNOWLEDGED);
    throw error;
  }
}

/** One employee still in the way of a submit, and which flags. */
export interface PayrollUnresolvedEmployee {
  employeeId: string;
  /** The flags not resolved (the line's), or `manualEntryStale` for an employee with no line. */
  flags: PayrollLineFlag['kind'][];
}

/**
 * Server-only, for the submit (chunk C2) and the run page: the employees whose flags still block
 * a submit (decision 361): any line with net pay below zero or a stale manual entry, any other
 * flag not acknowledged, and each employee with a live manual entry but no line. Read in
 * `session` when given. No access check.
 */
export async function payrollRunUnresolvedFlags(
  runIdInput: Types.ObjectId | string,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<{ count: number; employees: PayrollUnresolvedEmployee[] }> {
  const runId = typeof runIdInput === 'string' ? objectIdOf(runIdInput) : runIdInput;
  if (!runId) throw new ActionError(PAYROLL_RUN_GONE);
  await connectDb();
  const [lines, acknowledgements, entries] = await Promise.all([
    PayrollRunEmployeeModel.find({ runId }, { employeeId: 1, flags: 1 })
      .session(session)
      .lean<Pick<PayrollRunEmployeeDocument, 'employeeId' | 'flags'>[]>(),
    loadPayrollFlagAcknowledgements(runId, { session }),
    loadPayrollManualEntries(runId, { session }),
  ]);
  const liveEmployees = livePayrollManualEntries(entries).map((entry) => entry.employeeId);
  const ids = unresolvedFlaggedEmployeesOf(
    lines.map((line) => ({ employeeId: line.employeeId, flags: line.flags ?? [] })),
    acknowledgements.map((row) => ({ employeeId: row.employeeId, flag: row.flag })),
    liveEmployees,
  );
  const lineOf = new Map(lines.map((line) => [line.employeeId.toHexString(), line]));
  const acknowledged = new Set(
    acknowledgements.map((row) => `${row.employeeId.toHexString()}:${row.flag}`),
  );
  const employees = ids.map((id) => {
    const line = lineOf.get(id);
    if (!line) return { employeeId: id, flags: ['manualEntryStale' as const] };
    return {
      employeeId: id,
      flags: (line.flags ?? [])
        .filter(
          (flag) => !isAcknowledgeableFlag(flag.kind) || !acknowledged.has(`${id}:${flag.kind}`),
        )
        .map((flag) => flag.kind),
    };
  });
  return { count: employees.length, employees };
}
