import type { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { type BusinessDate, type Centavos } from '@pulse/core';
import { decryptSensitive, recordAudit } from '@pulse/core/server';
import { PAYROLL_BANK_LABELS, PAYROLL_BANKS, type PayrollBank } from '../../fixed-sets';
import {
  PAYROLL_NO_BANK_ACCOUNT_LABEL,
  PAYROLL_REGISTER_NOT_AVAILABLE_TEXT,
  PAYROLL_REGISTER_REVEAL_NOTE,
  payrollPeriodText,
  type PayrollRunStatus,
} from '../../payroll-run';
import {
  PAYROLL_RUN_RECORD_TYPE,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import { assertCanSeePayrollRegister, type TalentActor } from '../policy';
import { auditLabelOf, dayOf, objectIdOf } from '../shared';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("The payroll
// register"), SECURITY.md#sensitive-data ("The payroll register") and decision 369 in
// docs/BUILD_PLAN.md — `/talent/payroll/<runId>/register`, for a finalized run only, to Talent
// Read and HR, Accounting or the System Administrator.
//
// - Before "Show register": the bank groups (UnionBank, RCBC, then "No bank account on file") with
//   the count in each, and nothing else.
// - "Show register" writes and commits a `reveal` on the run (field `register`) first, then sends
//   each employee's name and number, bank, account name, full account number and net pay from the
//   finalize snapshot, each bank's total and the run's total net pay. If the entry can't be
//   written, nothing is sent. Shown values last one page view, as the run's amounts do.
// - A run not finalized: "The register is available once the run is finalized.", no reveal.

/** The reveal's field name. */
export const PAYROLL_REGISTER_FIELD = 'register';

/** A bank group's key: a payroll bank, or `none` ("No bank account on file"). */
export type PayrollRegisterGroupKey = PayrollBank | 'none';

/** One employee in the register, sent only after "Show register". */
export interface PayrollRegisterRow {
  lineId: string;
  employeeId: string;
  name: string;
  employeeNumber: string;
  /** "UnionBank", or null with no account. */
  bankLabel: string | null;
  accountName: string | null;
  /** The full account number from the finalize snapshot, or null with no account. */
  accountNumber: string | null;
  netPayCentavos: Centavos;
}

export interface PayrollRegisterGroup {
  key: PayrollRegisterGroupKey;
  label: string;
  count: number;
  /** Null until "Show register". */
  totalNetPayCentavos: Centavos | null;
  /** Empty until "Show register"; by name. */
  rows: PayrollRegisterRow[];
}

export interface PayrollRegisterView {
  runId: string;
  runNumber: string;
  status: PayrollRunStatus;
  periodText: string;
  payDate: BusinessDate;
  /** True for a finalized run. */
  available: boolean;
  /** "The register is available once the run is finalized.", or null when available. */
  unavailableMessage: string | null;
  /** "Viewing account numbers is recorded in the audit log." */
  revealNote: string;
  employeeCount: number;
  /** True after "Show register" (the reveal written first). */
  shown: boolean;
  /** UnionBank, RCBC, then no account; empty groups left out. */
  groups: PayrollRegisterGroup[];
  /** Null until "Show register". */
  totalNetPayCentavos: Centavos | null;
}

type RegisterLine = Pick<PayrollRunEmployeeDocument, '_id' | 'employeeId' | 'payslip'> & {
  netPayCentavos?: unknown;
};

const GROUP_ORDER: readonly PayrollRegisterGroupKey[] = [...PAYROLL_BANKS, 'none'];
const groupLabel = (key: PayrollRegisterGroupKey) =>
  key === 'none' ? PAYROLL_NO_BANK_ACCOUNT_LABEL : PAYROLL_BANK_LABELS[key];

async function decryptCentavos(value: unknown): Promise<Centavos> {
  const decrypted = await decryptSensitive(value);
  if (typeof decrypted !== 'number' || !Number.isSafeInteger(decrypted)) {
    throw new Error('A stored payroll amount is not whole centavos.');
  }
  return decrypted;
}

/**
 * The payroll register of run `runId` (see the header). With `show` on a finalized run, the
 * `reveal` (field `register`) is written and committed before anything is decrypted. Null when
 * there is no such run.
 */
export async function getPayrollRegister(
  actor: TalentActor,
  runId: string,
  { show = false }: { show?: boolean } = {},
): Promise<PayrollRegisterView | null> {
  assertCanSeePayrollRegister(actor);
  const id = objectIdOf(runId);
  if (!id) return null;
  await connectDb();
  const run = await PayrollRunModel.findById(id).lean<PayrollRunDocument>();
  if (!run) return null;
  const periodText = payrollPeriodText(dayOf(run.periodStart), dayOf(run.periodEnd));
  const base = {
    runId: id.toHexString(),
    runNumber: run.number,
    status: run.status,
    periodText,
    payDate: dayOf(run.payDate),
    revealNote: PAYROLL_REGISTER_REVEAL_NOTE,
    employeeCount: run.employeeCount,
  };
  if (run.status !== 'finalized') {
    return {
      ...base,
      available: false,
      unavailableMessage: PAYROLL_REGISTER_NOT_AVAILABLE_TEXT,
      shown: false,
      groups: [],
      totalNetPayCentavos: null,
    };
  }

  if (show) {
    await recordAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      module: 'talent',
      action: 'reveal',
      record: { type: PAYROLL_RUN_RECORD_TYPE, id, label: auditLabelOf(run.number, periodText) },
      before: null,
      after: null,
      fields: [PAYROLL_REGISTER_FIELD],
    });
  }
  // Only the bank is read before "Show register"; the account number and net pay only after.
  const query = PayrollRunEmployeeModel.find(
    { runId: id },
    show
      ? {
          employeeId: 1,
          'payslip.employeeName': 1,
          'payslip.employeeNumber': 1,
          'payslip.bank.bank': 1,
          'payslip.bank.accountName': 1,
        }
      : { employeeId: 1, 'payslip.bank.bank': 1 },
  );
  if (show) query.select('+payslip.bank.accountNumber +netPayCentavos');
  const lines = await query.lean<RegisterLine[]>();

  const groups = new Map<PayrollRegisterGroupKey, PayrollRegisterGroup>();
  for (const line of lines) {
    const key: PayrollRegisterGroupKey = line.payslip?.bank?.bank ?? 'none';
    const group = groups.get(key) ?? {
      key,
      label: groupLabel(key),
      count: 0,
      totalNetPayCentavos: show ? 0 : null,
      rows: [],
    };
    group.count += 1;
    if (show) {
      const netPayCentavos = await decryptCentavos(line.netPayCentavos);
      const bank = line.payslip?.bank ?? null;
      const accountNumber = bank ? await decryptSensitive(bank.accountNumber) : null;
      group.totalNetPayCentavos = (group.totalNetPayCentavos ?? 0) + netPayCentavos;
      group.rows.push({
        lineId: line._id.toHexString(),
        employeeId: (line.employeeId as Types.ObjectId).toHexString(),
        name: line.payslip?.employeeName ?? 'Unknown employee',
        employeeNumber: line.payslip?.employeeNumber ?? '',
        bankLabel: bank ? PAYROLL_BANK_LABELS[bank.bank] : null,
        accountName: bank?.accountName ?? null,
        accountNumber: typeof accountNumber === 'string' ? accountNumber : null,
        netPayCentavos,
      });
    }
    groups.set(key, group);
  }
  const ordered = GROUP_ORDER.flatMap((key) => {
    const group = groups.get(key);
    if (!group) return [];
    group.rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return [group];
  });
  return {
    ...base,
    available: true,
    unavailableMessage: null,
    shown: show,
    groups: ordered,
    totalNetPayCentavos: show
      ? ordered.reduce((sum, group) => sum + (group.totalNetPayCentavos ?? 0), 0)
      : null,
  };
}
