import type { BusinessDate } from '@pulse/core';
import { formatPeriodRange, formatShortDay } from '../timesheets/submission';
import type { TimeOffRequestDay } from './days';
import type { LeaveEntryKind, TimeOffKind, TimeOffPortion, TimeOffStatus } from './kinds';
import type { LeaveBalanceKind, LeaveType } from './settings';
import { formatDayCount, formatLeaveDays, formatOffsetHours, formatSignedLeaveDays } from './units';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Approval", "Who may see what", "Screens"; decisions 313, 318 and 319 in docs/BUILD_PLAN.md)
// — what the services send to the pages, the approval's title and summary, the confidential
// label, and the screens' lines. Types and wording only, safe in the browser. Requests and
// balances aren't sensitive; a confidential type (VAWC) reads only "Leave" to anyone but the
// employee, HR and the System Administrator.

// ---------------------------------------------------------------------------------------------
// The confidential label

/** What a confidential type reads as to everyone else, in titles, the DTR and every list. */
export const CONFIDENTIAL_LEAVE_LABEL = 'Leave';
/** The approval title's prefix for a confidential type (*Assumption*, item 180). */
export const CONFIDENTIAL_LEAVE_TITLE = 'Leave (confidential)';

/** Who sees a confidential type's name, attachment and reason: the employee, HR and the System Administrator. */
export function canSeeConfidentialLeave(viewer: {
  isEmployee: boolean;
  isHr: boolean;
  isSystemAdministrator: boolean;
}): boolean {
  return viewer.isEmployee || viewer.isHr || viewer.isSystemAdministrator;
}

/** A request's type as a viewer reads it: the short name, or "Leave" when hidden. */
export function leaveTypeShortLabel(
  type: Pick<LeaveType, 'shortName' | 'confidential'>,
  canSeeConfidential: boolean,
): string {
  return type.confidential && !canSeeConfidential ? CONFIDENTIAL_LEAVE_LABEL : type.shortName;
}

/** A request's type name as a viewer reads it: "Vacation leave", or "Leave" when hidden. */
export function leaveTypeNameLabel(
  type: Pick<LeaveType, 'name' | 'confidential'>,
  canSeeConfidential: boolean,
): string {
  return type.confidential && !canSeeConfidential ? CONFIDENTIAL_LEAVE_LABEL : type.name;
}

// ---------------------------------------------------------------------------------------------
// Days and times

/** `"13:00"` → "1:00 PM", `"08:30"` → "8:30 AM", `"00:15"` → "12:15 AM". */
export function formatClockTime(time: string): string {
  const hours = Number(time.slice(0, 2));
  const minutes = time.slice(3, 5);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "1:00 – 5:00 PM", or "11:00 AM – 1:00 PM" across noon. */
export function formatClockRange(fromTime: string, toTime: string): string {
  const from = formatClockTime(fromTime);
  const to = formatClockTime(toTime);
  if (from.slice(-2) === to.slice(-2)) return `${from.slice(0, -3)} – ${to}`;
  return `${from} – ${to}`;
}

/** A request's days: "Nov 2, 2026", "Nov 2 – 4, 2026", "Dec 30, 2026 – Jan 2, 2027". */
export function timeOffDatesText(startDate: BusinessDate, endDate: BusinessDate): string {
  if (startDate === endDate) return `${formatShortDay(startDate)}, ${startDate.slice(0, 4)}`;
  return formatPeriodRange(startDate, endDate);
}

/** A request's days and portion: "Nov 2, 2026 (first half)", "Nov 2, 1:00 – 5:00 PM". */
export function timeOffWhenText(request: {
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  fromTime?: string | null;
  toTime?: string | null;
}): string {
  if (request.portion === 'part' && request.fromTime && request.toTime) {
    return `${formatShortDay(request.startDate)}, ${formatClockRange(request.fromTime, request.toTime)}`;
  }
  const dates = timeOffDatesText(request.startDate, request.endDate);
  if (request.portion === 'firstHalf') return `${dates} (first half)`;
  if (request.portion === 'secondHalf') return `${dates} (second half)`;
  return dates;
}

// ---------------------------------------------------------------------------------------------
// The approval request

/** "Leave: Ellen Garcia · VL · Nov 2 – 4, 2026 (3 days)"; a confidential type "Leave (confidential): Ellen Garcia · Nov 2 – 4, 2026 (3 days)". */
export function leaveApprovalTitle(input: {
  firstName: string;
  lastName: string;
  type: Pick<LeaveType, 'shortName' | 'confidential'>;
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  chargeableHalfDays: number;
}): string {
  const name = `${input.firstName} ${input.lastName}`;
  const when = `${timeOffWhenText(input)} (${formatDayCount(input.chargeableHalfDays)})`;
  if (input.type.confidential) return `${CONFIDENTIAL_LEAVE_TITLE}: ${name} · ${when}`;
  return `Leave: ${name} · ${input.type.shortName} · ${when}`;
}

/** "Offset time off: Ellen Garcia · Nov 2, 1:00 – 5:00 PM (4.0 h)". */
export function offsetApprovalTitle(input: {
  firstName: string;
  lastName: string;
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  fromTime?: string | null;
  toTime?: string | null;
  minutes: number;
}): string {
  return `Offset time off: ${input.firstName} ${input.lastName} · ${timeOffWhenText(input)} (${formatOffsetHours(input.minutes)})`;
}

/** "1 day without pay", "0.5 day without pay". */
export function withoutPayText(unpaidHalfDays: number): string {
  return `${formatDayCount(unpaidHalfDays)} without pay`;
}

/**
 * The sheet's split before submitting: "3 days: 2 covered by your VL balance, 1 day without pay
 * (deducted from pay)", "3 days, covered by your VL balance", or for another type "105 days, paid"
 * or "30 days, without pay".
 */
export function leaveSplitText(input: {
  type: Pick<LeaveType, 'shortName' | 'balance' | 'paid'>;
  chargeableHalfDays: number;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
}): string {
  const total = formatDayCount(input.chargeableHalfDays);
  if (input.type.balance !== 'credited' || input.paidHalfDays === null) {
    return `${total}, ${input.type.paid ? 'paid' : 'without pay'}`;
  }
  const unpaid = input.unpaidHalfDays ?? 0;
  if (unpaid === 0) return `${total}, covered by your ${input.type.shortName} balance`;
  if (input.paidHalfDays === 0) return `${total} without pay (deducted from pay)`;
  const paid = formatDayCount(input.paidHalfDays).replace(/ days?$/, '');
  return `${total}: ${paid} covered by your ${input.type.shortName} balance, ${withoutPayText(unpaid)} (deducted from pay)`;
}

/**
 * The approval's summary: "3 days · 2 days paid from VL, 1 day without pay · Medical certificate
 * attached". A confidential type never names its type or attachment.
 */
export function leaveApprovalSummary(input: {
  type: Pick<LeaveType, 'shortName' | 'balance' | 'paid' | 'confidential' | 'attachment'>;
  chargeableHalfDays: number;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
  hasAttachment: boolean;
}): string {
  const parts = [formatDayCount(input.chargeableHalfDays)];
  if (input.type.balance === 'credited' && input.paidHalfDays !== null) {
    const unpaid = input.unpaidHalfDays ?? 0;
    const paid = `${formatDayCount(input.paidHalfDays)} paid from ${input.type.shortName}`;
    parts.push(unpaid > 0 ? `${paid}, ${withoutPayText(unpaid)}` : paid);
  } else {
    parts.push(input.type.paid ? 'Paid' : 'Without pay');
  }
  if (input.hasAttachment && input.type.attachment && !input.type.confidential) {
    parts.push(`${input.type.attachment.label} attached`);
  }
  return parts.join(' · ');
}

/** The offset approval's summary: "4.0 h of offset time off". */
export function offsetApprovalSummary(minutes: number): string {
  return `${formatOffsetHours(minutes)} of offset time off`;
}

// ---------------------------------------------------------------------------------------------
// Audit labels and notifications

/** A leave entry's audit label: "<employee number> · <short name> · <YYYY-MM-DD>". */
export function leaveEntryAuditLabel(
  employeeNumber: string,
  shortName: string,
  effectiveOn: BusinessDate,
): string {
  return `${employeeNumber} · ${shortName} · ${effectiveOn}`;
}

/**
 * `talent.leaveAdjusted`'s message: "Your VL balance changed by +1.0 day: the holidays on Nov 30
 * changed". With no balance change (a type without a balance), "Your ML leave changed: the
 * holidays on Nov 30 changed".
 */
export function leaveAdjustedMessage(
  shortName: string,
  halfDays: number,
  dates: readonly BusinessDate[],
): string {
  const days = [...new Set(dates)].sort().map(formatShortDay).join(', ');
  if (halfDays === 0) return `Your ${shortName} leave changed: the holidays on ${days} changed`;
  return `Your ${shortName} balance changed by ${formatSignedLeaveDays(halfDays)}: the holidays on ${days} changed`;
}

/** `talent.timeOffCancelled`'s message: "Ellen Garcia cancelled approved leave: VL · Nov 2, 2026". */
export function timeOffCancelledMessage(input: {
  firstName: string;
  lastName: string;
  kind: TimeOffKind;
  /** The type's short label as the approvers read it, for leave. */
  typeLabel: string | null;
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  fromTime?: string | null;
  toTime?: string | null;
}): string {
  const what =
    input.kind === 'offset'
      ? 'approved offset time off'
      : `approved leave${input.typeLabel && input.typeLabel !== CONFIDENTIAL_LEAVE_LABEL ? `: ${input.typeLabel}` : ''}`;
  return `${input.firstName} ${input.lastName} cancelled ${what} · ${timeOffWhenText(input)}`;
}

// ---------------------------------------------------------------------------------------------
// View types

/** One leave entry (a `credited` type's). */
export interface LeaveEntryView {
  id: string;
  typeKey: string;
  kind: LeaveEntryKind;
  /** Signed whole half days. */
  halfDays: number;
  effectiveOn: BusinessDate;
  year: number | null;
  reason: string | null;
  sourceId: string | null;
  createdAt: Date;
}

/** One `credited` type's balance card ("VL 4.5 days · Available 3.5 days"). */
export interface LeaveBalanceView {
  typeKey: string;
  name: string;
  shortName: string;
  /** The sum of the entries; may be below zero. */
  balanceHalfDays: number;
  /** Less other pending requests' paid days, never counting a future credit. */
  availableHalfDays: number;
  /** The paid half days pending requests hold. */
  pendingHalfDays: number;
}

/** A `perYear` type's use this year ("SPL 2 of 7 days used in 2026"). */
export interface PerYearLeaveUsageView {
  typeKey: string;
  name: string;
  shortName: string;
  year: number;
  /** Approved and pending half days in the year. */
  usedHalfDays: number;
  limitHalfDays: number;
}

/** `getLeaveBalances`: the employee's credited balances and per-year use. */
export interface LeaveBalancesView {
  employeeId: string;
  balances: LeaveBalanceView[];
  perYear: PerYearLeaveUsageView[];
  /** A Regular employee with no regularization date: "Regularization date missing: no VL or SL credits". */
  regularizationDateMissing: boolean;
}

/** The inspector's flag for a Regular employee without a regularization date. */
export function regularizationMissingText(creditedShortNames: readonly string[]): string {
  return `Regularization date missing: no ${creditedShortNames.join(' or ')} credits`;
}

/** A request as the lists and the request page show it. */
export interface TimeOffRequestView {
  id: string;
  number: string;
  employeeId: string;
  kind: TimeOffKind;
  /** Null for offset, and for a confidential type the viewer may not see. */
  leaveTypeKey: string | null;
  /** The short name or "Leave"; null for offset. */
  typeLabel: string | null;
  balanceKind: LeaveBalanceKind | null;
  startDate: BusinessDate;
  endDate: BusinessDate;
  portion: TimeOffPortion;
  fromTime: string | null;
  toTime: string | null;
  chargeableHalfDays: number | null;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
  minutes: number | null;
  /** Null when hidden (a confidential type) or empty. */
  reason: string | null;
  /** True when an attachment exists and the viewer may open it. */
  canOpenAttachment: boolean;
  status: TimeOffStatus;
  approvalRequestId: string | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  remarks: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** The viewer's own actions. */
  canCancel: boolean;
  canEditAndResend: boolean;
}

/** The request sheet's preview: chargeable days or hours, the days left out, and the split. */
export interface TimeOffPreviewView {
  days: TimeOffRequestDay[];
  chargeableHalfDays: number | null;
  paidHalfDays: number | null;
  unpaidHalfDays: number | null;
  minutes: number | null;
  /** Problems found so far, in the server's words. */
  problems: string[];
}

/** The balance card's lines: "4.5 days", and "Available 3.5 days" when pending requests hold some. */
export function leaveBalanceLines(balance: LeaveBalanceView): {
  balance: string;
  available: string | null;
} {
  return {
    balance: formatLeaveDays(balance.balanceHalfDays),
    available:
      balance.availableHalfDays !== balance.balanceHalfDays
        ? `Available ${formatLeaveDays(balance.availableHalfDays)}`
        : null,
  };
}
