import type { ClientSession, Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import type { BusinessDate } from '@pulse/core';
import { type ConfigVersion, listConfigVersions } from '@pulse/core/server';
import type { CutOffPeriod } from '../../payroll/lookups';
import {
  firstIncompleteCutOff,
  firstRemittanceMonth,
  remittanceComputeFirstMessage,
  remittanceFinalizeFirstMessage,
  remittanceMonthCutOffs,
  type RemittanceMonth,
  type RemittanceSettings,
  remittanceSettingsDayFor,
  SEED_REMITTANCE_SETTINGS,
} from '../../remittance';
import { versionOn } from '../../timesheets/schedule';
import { REMITTANCE_SETTINGS_SETTING } from '../payroll-settings/settings';
import {
  loadFirstPayrollCutOff,
  loadPayrollRunVersions,
  type PayrollRunVersions,
} from '../payroll-runs/compute';
import { type PayrollRunDocument, PayrollRunModel } from '../payroll-runs/model';
import { dayOf, instantOf } from '../shared';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The
// remittance month", "Complete", "Remittance settings"; decisions 378 and 383 in
// docs/BUILD_PLAN.md) — what every remittance service reads first: the setting versions, the first
// payroll cut-off, and each month's cut-offs with their regular runs. Actorless and read-only;
// the callers check access. No amount is read here.

/** Everything the remittance services read once per request or job run. */
export interface RemittanceContext {
  today: BusinessDate;
  versions: PayrollRunVersions;
  /** The first payroll cut-off, or null while the go-live date is null. */
  firstCutOff: CutOffPeriod | null;
  /** The first remittance month, or null while the go-live date is null. */
  firstMonth: RemittanceMonth | null;
  remittanceVersions: ConfigVersion<RemittanceSettings>[];
}

export async function loadRemittanceContext(today: BusinessDate): Promise<RemittanceContext> {
  await connectDb();
  const [versions, remittanceVersions] = await Promise.all([
    loadPayrollRunVersions(),
    listConfigVersions(REMITTANCE_SETTINGS_SETTING),
  ]);
  const firstCutOff = await loadFirstPayrollCutOff(versions, today);
  return {
    today,
    versions,
    firstCutOff,
    firstMonth: firstRemittanceMonth(firstCutOff),
    remittanceVersions,
  };
}

/**
 * `talent.remittanceSettings` for `month`'s due dates: the version in effect on the first day of
 * the month after it, or the seeded value (null date) before any version exists.
 */
export function remittanceSettingsFor(
  context: Pick<RemittanceContext, 'remittanceVersions'>,
  month: RemittanceMonth,
): { value: RemittanceSettings; effectiveFrom: BusinessDate | null } {
  const found = versionOn(context.remittanceVersions, remittanceSettingsDayFor(month));
  return found
    ? { value: found.value, effectiveFrom: found.effectiveFrom }
    : { value: structuredClone(SEED_REMITTANCE_SETTINGS), effectiveFrom: null };
}

/** A stored regular run as the remittance services read it (no amount). */
export type RemittanceRunRow = Pick<
  PayrollRunDocument,
  | '_id'
  | 'number'
  | 'status'
  | 'periodStart'
  | 'periodEnd'
  | 'payDate'
  | 'contributionMonth'
  | 'settingVersions'
>;

/** One month's cut-offs, their runs and why the month isn't complete. */
export interface RemittanceMonthSources {
  month: RemittanceMonth;
  cutOffs: CutOffPeriod[];
  paidBeforeGoLive: CutOffPeriod[];
  /** Each cut-off's regular run, by its start (missing when there is none). */
  runs: Map<BusinessDate, RemittanceRunRow>;
  /** Why the reports can't be generated, or null when every cut-off is finalized. */
  incompleteMessage: string | null;
  /** The finalized source runs, in cut-off order (empty while incomplete). */
  sourceRuns: RemittanceRunRow[];
}

/**
 * The cut-offs and regular runs of each of `months`, read in one query (in `session` when
 * given). A month with no cut-off at all (before the first remittance month) is incomplete.
 */
export async function loadMonthSources(
  context: RemittanceContext,
  months: readonly RemittanceMonth[],
  { session = null }: { session?: ClientSession | null } = {},
): Promise<Map<RemittanceMonth, RemittanceMonthSources>> {
  const result = new Map<RemittanceMonth, RemittanceMonthSources>();
  const first = context.firstCutOff;
  if (!first) return result;
  const perMonth = months.map((month) => ({
    month,
    ...remittanceMonthCutOffs(month, first, context.versions.payroll),
  }));
  const starts = perMonth.flatMap((entry) => entry.cutOffs.map((cutOff) => cutOff.start));
  const rows =
    starts.length === 0
      ? []
      : await PayrollRunModel.find(
          { kind: 'regular', periodStart: { $in: starts.map((start) => instantOf(start)) } },
          {
            number: 1,
            status: 1,
            periodStart: 1,
            periodEnd: 1,
            payDate: 1,
            contributionMonth: 1,
            settingVersions: 1,
          },
        )
          .session(session)
          .lean<RemittanceRunRow[]>();
  const byStart = new Map(rows.map((row) => [dayOf(row.periodStart), row]));
  for (const entry of perMonth) {
    const runs = new Map<BusinessDate, RemittanceRunRow>();
    for (const cutOff of entry.cutOffs) {
      const run = byStart.get(cutOff.start);
      if (run) runs.set(cutOff.start, run);
    }
    const incomplete = firstIncompleteCutOff(
      entry.cutOffs.map((cutOff) => ({ cutOff, run: runs.get(cutOff.start) ?? null })),
    );
    let incompleteMessage: string | null = null;
    if (entry.cutOffs.length === 0) {
      incompleteMessage = 'No payroll cut-off is paid in this month.';
    } else if (incomplete?.reason === 'noRun') {
      incompleteMessage = remittanceComputeFirstMessage(
        incomplete.cutOff.start,
        incomplete.cutOff.end,
      );
    } else if (incomplete) {
      incompleteMessage = remittanceFinalizeFirstMessage(
        incomplete.cutOff.start,
        incomplete.cutOff.end,
        entry.month,
      );
    }
    result.set(entry.month, {
      month: entry.month,
      cutOffs: entry.cutOffs,
      paidBeforeGoLive: entry.paidBeforeGoLive,
      runs,
      incompleteMessage,
      sourceRuns: incompleteMessage
        ? []
        : entry.cutOffs.flatMap((cutOff) => {
            const run = runs.get(cutOff.start);
            return run ? [run] : [];
          }),
    });
  }
  return result;
}

/** The ids of runs, for queries. */
export const runIdsOf = (runs: readonly RemittanceRunRow[]): Types.ObjectId[] =>
  runs.map((run) => run._id);
