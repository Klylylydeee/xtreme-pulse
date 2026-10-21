import { z } from 'zod';
import { connectDb } from '@pulse/db';
import { now } from '@pulse/core';
import { defineJob, defineSchedule } from '@pulse/core/server';
import {
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import { loadPayslipCompany, renderPayslipFile } from './service';

// Spec: docs/ARCHITECTURE.md#background-jobs and
// docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips": the
// job; decision 366 in docs/BUILD_PLAN.md) — `talent.payslipPdfs`, every 10 minutes (cron
// `*/10 * * * *`, Asia/Manila). For every finalized run with `payslipsPending`, it renders each
// line's missing payslip PDF (`renderPayslipFile`, idempotent through the file's key and the line's
// `payslip.fileId: null` filter), then clears `payslipsPending` once every line has its file.
//
// - The company header is read once per run of the job, as it is then.
// - A line that fails to render is counted and the run stays pending, so the next run tries again;
//   the job then throws (counts only) after finishing the other lines, so the failure shows in the
//   worker's log and BullMQ retries it.
// - No actor. The result holds counts only, never an amount, a name or an account number.

/** The job: no data, everything is read when it runs. */
export const PAYSLIP_PDFS_JOB = defineJob('talent.payslipPdfs', { schema: z.object({}) });

/** Every 10 minutes, on Asia/Manila time. */
export const PAYSLIP_PDFS_SCHEDULE = defineSchedule({
  id: 'talent.payslipPdfs',
  job: PAYSLIP_PDFS_JOB,
  data: {},
  pattern: '*/10 * * * *',
});

export interface PayslipPdfsResult {
  /** When the job ran (ISO). */
  ranAt: string;
  /** Finalized runs with `payslipsPending` seen. */
  runs: number;
  /** PDFs rendered and set in this run. */
  rendered: number;
  /** Lines that failed to render (their run stays pending). */
  failed: number;
  /** Runs whose `payslipsPending` was cleared. */
  cleared: number;
}

/** Renders the missing payslip PDFs of every pending finalized run, then clears the flag. */
export async function runPayslipPdfs(at: Date = now()): Promise<PayslipPdfsResult> {
  await connectDb();
  const result: PayslipPdfsResult = {
    ranAt: at.toISOString(),
    runs: 0,
    rendered: 0,
    failed: 0,
    cleared: 0,
  };
  const runs = await PayrollRunModel.find(
    { status: 'finalized', payslipsPending: true },
    { _id: 1 },
  )
    .sort({ periodStart: 1, _id: 1 })
    .lean<Pick<PayrollRunDocument, '_id'>[]>();
  if (runs.length === 0) return result;
  const company = await loadPayslipCompany();

  for (const run of runs) {
    result.runs += 1;
    const missing = await PayrollRunEmployeeModel.find(
      { runId: run._id, payslip: { $type: 'object' }, 'payslip.fileId': null },
      { _id: 1 },
    )
      .sort({ _id: 1 })
      .lean<Pick<PayrollRunEmployeeDocument, '_id'>[]>();
    let failed = 0;
    for (const line of missing) {
      try {
        const rendered = await renderPayslipFile(line._id.toHexString(), { company });
        if (rendered?.rendered) result.rendered += 1;
      } catch {
        // Nothing about the line is logged; the count is enough to look into it.
        failed += 1;
      }
    }
    result.failed += failed;
    if (failed > 0) continue;
    // Every line of a finalized run has its snapshot, so none left without a file means done.
    const left = await PayrollRunEmployeeModel.countDocuments({
      runId: run._id,
      'payslip.fileId': null,
    });
    if (left > 0) continue;
    const cleared = await PayrollRunModel.updateOne(
      { _id: run._id, status: 'finalized' },
      { $set: { payslipsPending: false } },
    );
    if (cleared.modifiedCount === 1) result.cleared += 1;
  }

  if (result.failed > 0) {
    throw new Error(
      `${result.failed} payslip PDF(s) failed to render (${result.rendered} rendered, ${result.cleared} run(s) cleared); the next run tries again.`,
    );
  }
  return result;
}
