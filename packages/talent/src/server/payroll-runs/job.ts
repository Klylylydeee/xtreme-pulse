import { z } from 'zod';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { ActionError, addDays, type BusinessDate, now, toBusinessDate } from '@pulse/core';
import { defineJob, defineSchedule } from '@pulse/core/server';
import type { CutOffPeriod } from '../../payroll/lookups';
import { isPastDeadline } from '../../timesheets/submission';
import { leaveSettingsOn } from '../payroll-settings/settings';
import { instantOf } from '../shared';
import { periodOrNull } from '../timesheets/periods';
import { deadlineOf, latestEndedCutOff } from '../timesheets/status';
import {
  loadFirstPayrollCutOff,
  loadPayrollRunVersions,
  payrollRunMembers,
  payrollRunWindow,
  type PayrollRunVersions,
} from './compute';
import { PAYROLL_RUN_EDITABLE_STATUSES, type PayrollRunDocument, PayrollRunModel } from './model';
import {
  PAYROLL_RUN_EXISTS,
  PAYROLL_RUN_GONE,
  PAYROLL_RUN_NOT_EDITABLE,
  recomputePayrollDraft,
  storePayrollDraft,
} from './service';

// Spec: docs/ARCHITECTURE.md#background-jobs and
// docs/modules/talent.md#payroll-run-computation-build-step-29 ("The draft job"; decision 342 in
// docs/BUILD_PLAN.md) — the daily job `talent.payrollDraftRuns`, at 05:00 Manila (cron
// `0 5 * * *`). From step 2.10 (decision 351) a `returned` run is recomputed like a draft, and a
// run waiting for Board approval or finalized is skipped; "drafts" below means both.
//
// - While `talent.leaveSettings.goLiveDate` is set: creates the draft of the latest ended cut-off
//   on or after the first payroll cut-off when it has no run and either every included
//   employee's timesheet is approved or the cut-off's submission deadline has passed, notifying
//   HR in the same transaction (`talent.payrollDraftReady`, once per run); then recomputes every
//   draft, in cut-off order. Earlier ended cut-offs are created by HR.
// - Idempotent: the unique `{ kind, periodStart }` index refuses a second run for a cut-off, and
//   a recompute of unchanged sources stores the same figures.
// - No actor. The result holds counts, dates and the run number only, never an amount or a name.
//
// `recomputeDraftsForDates` is the holidays-changed listener's part (server/dtr/listener.ts).

/** The job: no data, everything is read when it runs. */
export const PAYROLL_DRAFTS_JOB = defineJob('talent.payrollDraftRuns', { schema: z.object({}) });

/** Every day at 05:00 Manila. */
export const PAYROLL_DRAFTS_SCHEDULE = defineSchedule({
  id: 'talent.payrollDraftRuns',
  job: PAYROLL_DRAFTS_JOB,
  data: {},
  pattern: '0 5 * * *',
});

export interface PayrollDraftsResult {
  /** The Manila day the run was for. */
  date: BusinessDate;
  /** `talent.leaveSettings.goLiveDate` that day; null means nothing was done. */
  goLiveDate: BusinessDate | null;
  /** The latest ended cut-off's start, when it is on or after the first payroll cut-off. */
  latestPeriodStart: BusinessDate | null;
  /** The draft created in this run (its number), or null. */
  created: string | null;
  /** Why the latest cut-off's draft wasn't created, when it wasn't. */
  waiting: 'exists' | 'timesheets' | null;
  /** Drafts recomputed in this run. */
  recomputed: number;
}

async function draftsInOrder(): Promise<
  Pick<PayrollRunDocument, '_id' | 'periodStart' | 'periodEnd'>[]
> {
  return PayrollRunModel.find(
    { status: { $in: [...PAYROLL_RUN_EDITABLE_STATUSES] } },
    { periodStart: 1, periodEnd: 1 },
  )
    .sort({ periodStart: 1, _id: 1 })
    .lean();
}

/** Creates the latest ended cut-off's draft when it is due, and recomputes every draft. */
export async function runPayrollDrafts(at: Date = now()): Promise<PayrollDraftsResult> {
  await connectDb();
  const date = toBusinessDate(at);
  const versions = await loadPayrollRunVersions();
  const first = await loadFirstPayrollCutOff(versions, date);
  const result: PayrollDraftsResult = {
    date,
    goLiveDate: null,
    latestPeriodStart: null,
    created: null,
    waiting: null,
    recomputed: 0,
  };
  if (!first) return result;
  result.goLiveDate = (await leaveSettingsOn(date)).goLiveDate;

  const ended = latestEndedCutOff(date, versions.payroll);
  const latest: CutOffPeriod | null = ended ? periodOrNull(ended.start, versions.payroll) : null;
  let createdId: string | null = null;
  if (latest && latest.start >= first.start) {
    result.latestPeriodStart = latest.start;
    if (await PayrollRunModel.exists({ kind: 'regular', periodStart: instantOf(latest.start) })) {
      result.waiting = 'exists';
    } else if (await isDue(latest, date, versions)) {
      try {
        const created = await storePayrollDraft(latest, first, {
          actor: null,
          today: date,
          versions,
          notifyHr: true,
        });
        result.created = created.number;
        createdId = created.id;
      } catch (error) {
        // Another run (or HR) created it at the same moment.
        if (!(error instanceof ActionError && error.message === PAYROLL_RUN_EXISTS)) throw error;
        result.waiting = 'exists';
      }
    } else {
      result.waiting = 'timesheets';
    }
  }

  for (const draft of await draftsInOrder()) {
    if (draft._id.toHexString() === createdId) continue;
    try {
      await recomputePayrollDraft(draft._id, { actor: null, today: date, versions });
      result.recomputed += 1;
    } catch (error) {
      if (!isLeftDraft(error)) throw error;
    }
  }
  return result;
}

/** Every included employee's timesheet approved, or the submission deadline passed. */
async function isDue(
  cutOff: CutOffPeriod,
  today: BusinessDate,
  versions: PayrollRunVersions,
): Promise<boolean> {
  if (isPastDeadline(today, deadlineOf(cutOff.end, versions.timesheetSettings))) return true;
  const members = await payrollRunMembers(cutOff);
  return members.every((member) => member.timesheetApproved);
}

/**
 * The holidays-changed listener's part (decision 341): recomputes every draft whose cut-off or
 * lookback (and the cut-off before it, for the workday-before rule) holds one of `dates`, in
 * cut-off order, each in its own transaction, with no actor. Returns how many it recomputed.
 */
export async function recomputeDraftsForDates(dates: readonly BusinessDate[]): Promise<number> {
  if (dates.length === 0) return 0;
  await connectDb();
  const drafts = await draftsInOrder();
  if (drafts.length === 0) return 0;
  const today = toBusinessDate(now());
  const versions = await loadPayrollRunVersions();
  const first = await loadFirstPayrollCutOff(versions, today);
  if (!first) return 0;
  let count = 0;
  for (const draft of drafts) {
    const cutOff = periodOrNull(toBusinessDate(draft.periodStart), versions.payroll);
    if (!cutOff) continue;
    const window = payrollRunWindow(cutOff, first, versions);
    const from = window.from < cutOff.start ? window.from : addDays(cutOff.start, -1);
    if (!dates.some((day) => day >= from && day <= window.to)) continue;
    try {
      await recomputePayrollDraft(new Types.ObjectId(draft._id), { actor: null, today, versions });
      count += 1;
    } catch (error) {
      if (!isLeftDraft(error)) throw error;
    }
  }
  return count;
}

/** A run submitted or finalized (step 2.10), or gone, since it was listed is left as it is. */
function isLeftDraft(error: unknown): boolean {
  return (
    error instanceof ActionError &&
    (error.message === PAYROLL_RUN_NOT_EDITABLE || error.message === PAYROLL_RUN_GONE)
  );
}
