import { addDays } from '@pulse/core';
import type { CutOffPeriod } from '../payroll/lookups';
import type { PayrollSettings } from '../payroll/schemas';
import { contributionMonthOf } from '../payroll-run/periods';
import { type EffectiveVersion, timesheetPeriodFor, versionOn } from '../timesheets/schedule';
import { formatPeriodRange } from '../timesheets/submission';
import { firstDayOfMonth, lastDayOfMonth, monthsFrom, type RemittanceMonth } from './agencies';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("The
// remittance month", "Complete", "The go-live month"; decision 378 in docs/BUILD_PLAN.md) — which
// months have remittances and which cut-offs each month's reports need. Pure code.
//
// - A month's cut-offs are the regular cut-offs whose pay date falls in it, per the
//   `talent.payrollSettings` version in effect on each cut-off's start.
// - The remittance months start with the first payroll cut-off's contribution month (its pay
//   date's month); while the go-live date is null there is none.
// - In the go-live month, a cut-off paid in the month but starting before the first payroll
//   cut-off was paid by the old system: the report holds only the rest, with a note.

type PayrollVersions = readonly EffectiveVersion<Pick<PayrollSettings, 'cutOffs'>>[];

/** The first remittance month: the first payroll cut-off's contribution month. */
export function firstRemittanceMonth(firstCutOff: CutOffPeriod | null): RemittanceMonth | null {
  return firstCutOff ? contributionMonthOf(firstCutOff.payDate) : null;
}

/** The remittance months from the first one through `last`, newest first. */
export function remittanceMonthsThrough(
  firstCutOff: CutOffPeriod | null,
  last: RemittanceMonth,
): RemittanceMonth[] {
  const first = firstRemittanceMonth(firstCutOff);
  return first ? monthsFrom(first, last).reverse() : [];
}

export interface RemittanceMonthCutOffs {
  /** The regular cut-offs paid in the month, on or after the first payroll cut-off, in order. */
  cutOffs: CutOffPeriod[];
  /** The go-live month's cut-offs paid in it before the first payroll cut-off (the old system). */
  paidBeforeGoLive: CutOffPeriod[];
}

/**
 * The cut-offs whose pay date falls in `month` (see the header). Empty lists for a month before
 * the first payroll cut-off's.
 */
export function remittanceMonthCutOffs(
  month: RemittanceMonth,
  firstCutOff: CutOffPeriod,
  payrollVersions: PayrollVersions,
): RemittanceMonthCutOffs {
  const result: RemittanceMonthCutOffs = { cutOffs: [], paidBeforeGoLive: [] };
  const first = firstRemittanceMonth(firstCutOff);
  if (!first || month < first) return result;
  const last = lastDayOfMonth(month);
  // A cut-off paid in the month ends in it (its pay date is in the month it ends), so it starts
  // at most a cut-off before the month: start a month back, at the earliest pay schedule.
  let day = addDays(firstDayOfMonth(month), -40);
  if (!versionOn(payrollVersions, day)) {
    const earliest = [...payrollVersions].sort((a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom),
    )[0];
    if (!earliest) return result;
    day = earliest.effectiveFrom;
  }
  for (let guard = 0; guard < 12; guard += 1) {
    const period = timesheetPeriodFor(day, payrollVersions);
    if (period.start > last) break;
    if (contributionMonthOf(period.payDate) === month) {
      if (period.start >= firstCutOff.start) result.cutOffs.push(period);
      else result.paidBeforeGoLive.push(period);
    }
    day = addDays(period.end, 1);
  }
  return result;
}

/** "Sep 26 – Oct 10, 2026" (or two joined by "and"), for the go-live month's note; null for none. */
export function goLivePeriodsText(periods: readonly CutOffPeriod[]): string | null {
  if (periods.length === 0) return null;
  return periods.map((period) => formatPeriodRange(period.start, period.end)).join(' and ');
}

/** The source of a month's completeness: each cut-off and its regular run, if any. */
export interface RemittanceCutOffRun {
  cutOff: CutOffPeriod;
  run: { number: string; status: string } | null;
}

/**
 * The first cut-off that keeps the month from being complete: one with no run, or with a run not
 * finalized; null when every one is finalized.
 */
export function firstIncompleteCutOff(
  runs: readonly RemittanceCutOffRun[],
): { cutOff: CutOffPeriod; reason: 'noRun' | 'notFinalized' } | null {
  for (const { cutOff, run } of runs) {
    if (!run) return { cutOff, reason: 'noRun' };
    if (run.status !== 'finalized') return { cutOff, reason: 'notFinalized' };
  }
  return null;
}
