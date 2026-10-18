import type { BusinessDate } from '@pulse/core';
import { formatHours } from '../timesheets/compute';
import type { ExtraHoursTreatment } from '../timesheets/schemas';
import { formatShortDay, timesheetHref } from '../timesheets/submission';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The offset balance", "The holidays-changed listener"; decisions 286, 287 and 292 in
// docs/BUILD_PLAN.md) and docs/DATA_MODEL.md (`offsetEntries`) — the offset entry kinds, the
// balance sum, whether HR's approval writes a credit, and the listener's reconcile difference.
// Pure code with no database, safe in the browser. Minutes are signed whole numbers; the balance
// is never stored.

/**
 * An offset entry's kind. Step 2.7 writes `credit` (HR approves a timesheet) and `adjustment` (a
 * holiday change alters an approved timesheet's offset); step 2.8 writes `opening` and `usage`.
 */
export const OFFSET_ENTRY_KINDS = ['opening', 'credit', 'adjustment', 'usage'] as const;
export type OffsetEntryKind = (typeof OFFSET_ENTRY_KINDS)[number];

export const OFFSET_ENTRY_KIND_LABELS: Record<OffsetEntryKind, string> = {
  opening: 'Opening balance',
  credit: 'Credit',
  adjustment: 'Adjustment',
  usage: 'Offset time off',
};

/** The kinds tied to a timesheet: what the listener counts as already credited for it. */
export const TIMESHEET_OFFSET_ENTRY_KINDS = [
  'credit',
  'adjustment',
] as const satisfies readonly OffsetEntryKind[];

/** An offset entry's audit record type. */
export const OFFSET_ENTRY_TYPE = 'talent.offsetEntry';
/** An entry's reason: up to 300 characters, or null. */
export const OFFSET_ENTRY_REASON_MAX_LENGTH = 300;
/** The notification sent when the listener adjusts an employee's balance (*Assumption*, item 133). */
export const OFFSET_ADJUSTED_EVENT = 'talent.offsetAdjusted';

/** What the sums read from an entry. */
export interface OffsetEntryMinutes {
  kind: OffsetEntryKind;
  minutes: number;
}

function assertWholeMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes)) {
    throw new RangeError('Offset minutes must be a whole number.');
  }
}

/** The offset balance: the sum of the employee's entries' minutes. It may be below zero. */
export function offsetBalanceMinutes(
  entries: Iterable<Pick<OffsetEntryMinutes, 'minutes'>>,
): number {
  let total = 0;
  for (const entry of entries) {
    assertWholeMinutes(entry.minutes);
    total += entry.minutes;
  }
  return total;
}

/** What a timesheet has been credited so far: its `credit` and `adjustment` entries' sum. */
export function creditedOffsetMinutes(timesheetEntries: Iterable<OffsetEntryMinutes>): number {
  let total = 0;
  for (const entry of timesheetEntries) {
    if (!(TIMESHEET_OFFSET_ENTRY_KINDS as readonly OffsetEntryKind[]).includes(entry.kind))
      continue;
    assertWholeMinutes(entry.minutes);
    total += entry.minutes;
  }
  return total;
}

/**
 * Whether HR's approval writes a credit: when the timesheet's DTR offset total is above 0, or its
 * extra hours are treated as offset (a 0-minute credit then records that it was credited). An
 * Overtime timesheet whose extra hours are overtime earns none.
 */
export function shouldWriteOffsetCredit(
  offsetMinutes: number,
  treatment: ExtraHoursTreatment,
): boolean {
  assertWholeMinutes(offsetMinutes);
  if (offsetMinutes < 0) throw new RangeError('A timesheet’s offset total is never below zero.');
  return offsetMinutes > 0 || treatment === 'offset';
}

/**
 * The listener's adjustment for an approved timesheet: the DTR's offset total now less what was
 * credited so far. 0 means nothing to write, so a second run adds nothing.
 */
export function offsetReconcileDifference(
  targetMinutes: number,
  timesheetEntries: Iterable<OffsetEntryMinutes>,
): number {
  assertWholeMinutes(targetMinutes);
  return targetMinutes - creditedOffsetMinutes(timesheetEntries);
}

/** The adjustment's reason: "Holiday changed: 2026-11-30" (the dates joined by commas). */
export function holidayChangedReason(dates: readonly BusinessDate[]): string {
  return `Holiday changed: ${[...new Set(dates)].sort().join(', ')}`;
}

/** An offset entry's audit label: "<employee number> · <YYYY-MM-DD>". */
export function offsetEntryAuditLabel(employeeNumber: string, effectiveOn: BusinessDate): string {
  return `${employeeNumber} · ${effectiveOn}`;
}

/** Signed hours: 480 → "+8.0 h", −480 → "−8.0 h", 0 → "0.0 h". */
export function formatSignedHours(minutes: number): string {
  assertWholeMinutes(minutes);
  if (minutes === 0) return formatHours(0);
  return `${minutes > 0 ? '+' : '−'}${formatHours(Math.abs(minutes))}`;
}

/**
 * `talent.offsetAdjusted`'s message: "Your offset balance changed by +8.0 h: the holidays on Nov 30
 * changed".
 */
export function offsetAdjustedMessage(minutes: number, dates: readonly BusinessDate[]): string {
  const days = [...new Set(dates)].sort().map(formatShortDay).join(', ');
  return `Your offset balance changed by ${formatSignedHours(minutes)}: the holidays on ${days} changed`;
}

/** `talent.offsetAdjusted`'s link: the timesheet whose credit changed. */
export function offsetAdjustedHref(employeeId: string, periodStart: BusinessDate): string {
  return timesheetHref(employeeId, periodStart);
}
