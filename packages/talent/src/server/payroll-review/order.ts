import type { ClientSession } from 'mongoose';
import { type BusinessDate, businessToday } from '@pulse/core';
import {
  PAYROLL_GO_LIVE_REQUIRED_MESSAGE,
  payrollComputeFirstMessage,
  payrollFinalizeFirstMessage,
  previousCutOff,
} from '../../payroll-run';
import type { CutOffPeriod } from '../../payroll/lookups';
import { loadFirstPayrollCutOff, type PayrollRunVersions } from '../payroll-runs/compute';
import { type PayrollRunDocument, PayrollRunModel } from '../payroll-runs/model';
import { dayOf, instantOf } from '../shared';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Submitting"
// step 1, "Approved"; decisions 361 and 363 in docs/BUILD_PLAN.md) — runs are finalized in cut-off
// order: a run is submitted, and finalized, only once every earlier regular cut-off on or after
// the first payroll cut-off has a finalized run. Shared by the submit and the approve hook.

/** The cut-off of a stored run. */
export function cutOffOfRun(
  run: Pick<PayrollRunDocument, 'cutOffKey' | 'periodStart' | 'periodEnd' | 'payDate'>,
): CutOffPeriod {
  return {
    key: run.cutOffKey,
    start: dayOf(run.periodStart),
    end: dayOf(run.periodEnd),
    payDate: dayOf(run.payDate),
  };
}

/**
 * Why `run` can't be submitted or finalized yet, or null: the oldest earlier regular cut-off on
 * or after the first payroll cut-off with no run ("Compute and finalize the run for <period>
 * first.") or with a run not finalized ("Finalize <period> (<number>) first."). Read in `session`
 * when given. The go-live date's message when it is null.
 */
export async function earlierCutOffRefusal(
  run: Pick<PayrollRunDocument, 'cutOffKey' | 'periodStart' | 'periodEnd' | 'payDate'>,
  {
    versions,
    today = businessToday(),
    session = null,
  }: {
    versions: Pick<PayrollRunVersions, 'payroll'>;
    today?: BusinessDate;
    session?: ClientSession | null;
  },
): Promise<string | null> {
  const first = await loadFirstPayrollCutOff(versions, today);
  if (!first) return PAYROLL_GO_LIVE_REQUIRED_MESSAGE;
  const earlier: CutOffPeriod[] = [];
  let period = previousCutOff(cutOffOfRun(run), versions.payroll);
  while (period.start >= first.start) {
    earlier.unshift(period);
    if (period.start === first.start) break;
    period = previousCutOff(period, versions.payroll);
  }
  if (earlier.length === 0) return null;
  const runs = await PayrollRunModel.find(
    { kind: 'regular', periodStart: { $in: earlier.map((cutOff) => instantOf(cutOff.start)) } },
    { number: 1, status: 1, periodStart: 1 },
  )
    .session(session)
    .lean<Pick<PayrollRunDocument, 'number' | 'status' | 'periodStart'>[]>();
  const byStart = new Map(runs.map((row) => [dayOf(row.periodStart), row]));
  for (const cutOff of earlier) {
    const found = byStart.get(cutOff.start);
    if (!found) return payrollComputeFirstMessage(cutOff.start, cutOff.end);
    if (found.status !== 'finalized') {
      return payrollFinalizeFirstMessage(cutOff.start, cutOff.end, found.number);
    }
  }
  return null;
}
