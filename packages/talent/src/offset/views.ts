import type { BusinessDate } from '@pulse/core';
import { formatHours } from '../timesheets/compute';
import { formatShortDay } from '../timesheets/submission';
import type { OffsetEntryKind } from './entries';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("On the timesheet, the Offset card…") — what the offset service sends to the pages, and the
// Offset card's lines. Types and wording only, safe in the browser. The balance isn't sensitive:
// whoever may see the employee's timesheet sees it.

/** One offset entry. */
export interface OffsetEntryView {
  id: string;
  kind: OffsetEntryKind;
  /** Signed whole minutes. */
  minutes: number;
  effectiveOn: BusinessDate;
  timesheetId: string | null;
  /** Step 2.8: the time off request of a `usage` entry (or the listener's), else null or absent. */
  timeOffRequestId?: string | null;
  reason: string | null;
  createdAt: Date;
}

/** `getOffsetBalance`: the balance as of now, the sum of every entry. */
export interface OffsetBalanceView {
  employeeId: string;
  /** May be below zero after an adjustment. */
  balanceMinutes: number;
}

/**
 * Step 2.8: the balance with what pending offset time off holds. `availableMinutes` is the
 * balance less `pendingMinutes` (`availableOffsetMinutes`).
 */
export interface OffsetAvailableBalanceView extends OffsetBalanceView {
  pendingMinutes: number;
  availableMinutes: number;
}

/** The Offset card's second line while pending offset time off holds some: "Available 4.0 h". */
export function offsetAvailableText(
  balance: Pick<OffsetAvailableBalanceView, 'balanceMinutes' | 'availableMinutes'>,
): string | null {
  if (balance.availableMinutes === balance.balanceMinutes) return null;
  const text = formatHours(Math.abs(balance.availableMinutes));
  return `Available ${balance.availableMinutes < 0 ? '−' : ''}${text}`;
}

/** A usage entry's line: "Offset time off −8.0 h · Nov 2" (a give-back reads "+8.0 h"). */
export function offsetUsageText(entry: Pick<OffsetEntryView, 'minutes' | 'effectiveOn'>): string {
  const sign = entry.minutes < 0 ? '−' : '+';
  return `Offset time off ${sign}${formatHours(Math.abs(entry.minutes))} · ${formatShortDay(entry.effectiveOn)}`;
}

/** A timesheet's credit, once HR approved it: "Credited +4.6 h on Sep 28". */
export interface OffsetCreditView {
  /** The credit plus any later adjustments for the timesheet. */
  minutes: number;
  /** The day of the credit (HR's approval day). */
  creditedOn: BusinessDate;
}

/** "Balance 12.5 h" (a negative balance reads "Balance −1.0 h"). */
export function offsetBalanceText(balanceMinutes: number): string {
  const text = formatHours(Math.abs(balanceMinutes));
  return `Balance ${balanceMinutes < 0 ? '−' : ''}${text}`;
}

/** Before approval: "+2.0 h this cut-off, credited when HR approves your timesheet". */
export function offsetPendingCreditText(thisCutOffMinutes: number): string {
  return `+${formatHours(thisCutOffMinutes)} this cut-off, credited when HR approves your timesheet`;
}

/** After approval: "Credited +4.6 h on Sep 28". */
export function offsetCreditedText(credit: OffsetCreditView): string {
  const sign = credit.minutes < 0 ? '−' : '+';
  return `Credited ${sign}${formatHours(Math.abs(credit.minutes))} on ${formatShortDay(credit.creditedOn)}`;
}
