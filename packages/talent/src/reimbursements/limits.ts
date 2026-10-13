import type { BusinessDate } from '@pulse/core';
import { type EffectiveVersion, versionOn } from '../timesheets/schedule';
import {
  type ReimbursementLimitPer,
  type ReimbursementSettings,
  reimbursementTypeOf,
} from './schemas';

// Spec: docs/modules/talent.md#reimbursements-build-step-25 ("Limits"; decisions 237 and 250 in
// docs/BUILD_PLAN.md) — which lines are over their type's limit. Over-limit lines are highlighted,
// never refused. Pure code: the callers load the versions and the employee's live lines, these
// compare them. Whole centavos only.

/** A reimbursement line, as the limit check needs it. */
export interface LimitLine {
  id: string;
  typeKey: string;
  /** The Manila day on the receipt. */
  receiptDate: BusinessDate;
  amountCentavos: number;
  /** A deleted line counts toward nothing. */
  deletedAt?: Date | null;
}

/** How far a line is over its limit. */
export interface OverLimit {
  limitCentavos: number;
  per: ReimbursementLimitPer;
  /** The line's amount (per line) or the day's total (per day) less the limit, above zero. */
  excessCentavos: number;
}

function assertCentavos(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be whole centavos.`);
}

const live = (line: LimitLine) => !line.deletedAt;

/**
 * Whether `line` is over its type's limit, with the version of `talent.reimbursementSettings` in
 * effect on its receipt date. Per line: the line's amount over the limit. Per day: the employee's
 * live lines of that type dated that day (`employeeLines`, across every timesheet; `line` counts
 * once, whether or not it is in the list) adding up to more than the limit; each of them gets the
 * same excess. Null when it isn't over, has no limit, or its type isn't in that version.
 */
export function overLimit(
  line: LimitLine,
  versions: readonly EffectiveVersion<ReimbursementSettings>[],
  employeeLines: readonly LimitLine[] = [],
): OverLimit | null {
  if (!live(line)) return null;
  assertCentavos(line.amountCentavos, 'The amount');
  const type = reimbursementTypeOf(versionOn(versions, line.receiptDate)?.value, line.typeKey);
  const limit = type?.limit;
  if (!limit) return null;
  assertCentavos(limit.amountCentavos, 'The limit');

  let total = line.amountCentavos;
  if (limit.per === 'day') {
    for (const other of employeeLines) {
      if (
        other.id === line.id ||
        !live(other) ||
        other.typeKey !== line.typeKey ||
        other.receiptDate !== line.receiptDate
      ) {
        continue;
      }
      assertCentavos(other.amountCentavos, 'The amount');
      total += other.amountCentavos;
    }
    assertCentavos(total, 'The day’s total');
  }
  if (total <= limit.amountCentavos) return null;
  return {
    limitCentavos: limit.amountCentavos,
    per: limit.per,
    excessCentavos: total - limit.amountCentavos,
  };
}

/**
 * `overLimit` for each of `lines` (a timesheet's lines), by line id. `employeeLines` holds the
 * employee's live lines on the same receipt dates across every timesheet; `lines` are added to it.
 * Lines that aren't over are left out.
 */
export function overLimitByLine(
  lines: readonly LimitLine[],
  versions: readonly EffectiveVersion<ReimbursementSettings>[],
  employeeLines: readonly LimitLine[] = [],
): Map<string, OverLimit> {
  const all = new Map<string, LimitLine>();
  for (const line of [...employeeLines, ...lines]) all.set(line.id, line);
  const pool = [...all.values()];
  const result = new Map<string, OverLimit>();
  for (const line of lines) {
    const over = overLimit(line, versions, pool);
    if (over) result.set(line.id, over);
  }
  return result;
}
