import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { BusinessDate } from '@pulse/core';
import { decryptSensitive } from '@pulse/core/server';
import type { PayrollBank } from '../../fixed-sets';
import {
  accountNumberLastFour,
  buildPayslipView,
  parsePayrollBreakdown,
  parsePayrollYearToDate,
  type PayrollBreakdown,
  type PayrollYearToDate,
  type PayslipView,
} from '../../payroll-run';
import {
  PAYSLIP_SNAPSHOT_SELECT,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import { dayOf, objectIdOf } from '../shared';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips",
// "Cross-module and services": `getPayslip`; decisions 363, 364 and 366 in docs/BUILD_PLAN.md) —
// a finalized line's frozen payslip: the snapshot, the year-to-date figures, the breakdown and the
// payslip's view model the PDF is rendered from. Server-only, with no access check and no audit
// entry, like `getPayrollRunLine`: the payslip service (rendering, the file route's `auditView`,
// self-service) and steps 2.12 and 2.14 check access (`canOpenPayslip`) and audit themselves. The
// account number comes back as its last 4 digits only.

/** A finalized line's payslip, decrypted. Never log it. */
export interface PayslipRecord {
  lineId: string;
  runId: string;
  runNumber: string;
  employeeId: string;
  periodStart: BusinessDate;
  periodEnd: BusinessDate;
  payDate: BusinessDate;
  snapshot: {
    employeeName: string;
    employeeNumber: string;
    departmentName: string | null;
    positionTitle: string | null;
    /** The payroll bank account frozen at finalizing, last 4 digits only; null with none. */
    bank: { bank: PayrollBank; accountName: string | null; accountNumberLastFour: string } | null;
  };
  yearToDate: PayrollYearToDate;
  breakdown: PayrollBreakdown;
  /** What the PDF prints, except the company header. */
  view: PayslipView;
  /** The rendered PDF's file id, or null until rendered. */
  fileId: string | null;
  generatedAt: Date | null;
}

/** Which payslip: a line id, or a run and an employee. */
export type PayslipRef = string | { runId: string; employeeId: string };

type StoredPayslipLine = Pick<
  PayrollRunEmployeeDocument,
  '_id' | 'runId' | 'employeeId' | 'payslip'
> & { breakdown?: unknown };

/**
 * The payslip of a finalized run's line (see the header), read in `session` when given. Null when
 * there is no such line, or its run isn't finalized (no snapshot yet).
 */
export async function getPayslip(
  ref: PayslipRef,
  { session = null }: { session?: ClientSession | null } = {},
): Promise<PayslipRecord | null> {
  let filter: Record<string, Types.ObjectId>;
  if (typeof ref === 'string') {
    const id = objectIdOf(ref);
    if (!id) return null;
    filter = { _id: id };
  } else {
    const runId = objectIdOf(ref?.runId);
    const employeeId = objectIdOf(ref?.employeeId);
    if (!runId || !employeeId) return null;
    filter = { runId, employeeId };
  }
  await connectDb();
  // No projection: the snapshot's encrypted paths and the breakdown are added to the default.
  const line = await PayrollRunEmployeeModel.findOne(filter)
    .select(`+breakdown ${PAYSLIP_SNAPSHOT_SELECT}`)
    .session(session)
    .lean<StoredPayslipLine>();
  if (!line?.payslip || !line.breakdown) return null;
  const run = await PayrollRunModel.findById(line.runId, {
    number: 1,
    status: 1,
    periodStart: 1,
    periodEnd: 1,
    payDate: 1,
  })
    .session(session)
    .lean<
      Pick<
        PayrollRunDocument,
        '_id' | 'number' | 'status' | 'periodStart' | 'periodEnd' | 'payDate'
      >
    >();
  if (!run || run.status !== 'finalized') return null;

  const { payslip } = line;
  const [breakdownJson, ytdJson, accountNumber] = await Promise.all([
    decryptSensitive(line.breakdown),
    decryptSensitive(payslip.ytd),
    payslip.bank ? decryptSensitive(payslip.bank.accountNumber) : Promise.resolve(null),
  ]);
  const breakdown = parsePayrollBreakdown(String(breakdownJson));
  const yearToDate = parsePayrollYearToDate(String(ytdJson));
  const bank = payslip.bank
    ? {
        bank: payslip.bank.bank,
        accountName: payslip.bank.accountName ?? null,
        accountNumberLastFour: accountNumberLastFour(String(accountNumber ?? '')),
      }
    : null;
  const snapshot = {
    employeeName: payslip.employeeName,
    employeeNumber: payslip.employeeNumber,
    departmentName: payslip.departmentName ?? null,
    positionTitle: payslip.positionTitle ?? null,
    bank,
  };
  return {
    lineId: line._id.toHexString(),
    runId: run._id.toHexString(),
    runNumber: run.number,
    employeeId: line.employeeId.toHexString(),
    periodStart: dayOf(run.periodStart),
    periodEnd: dayOf(run.periodEnd),
    payDate: dayOf(run.payDate),
    snapshot,
    yearToDate,
    breakdown,
    view: buildPayslipView({ runNumber: run.number, breakdown, snapshot, yearToDate }),
    fileId: payslip.fileId ? payslip.fileId.toHexString() : null,
    generatedAt: payslip.generatedAt ?? null,
  };
}
