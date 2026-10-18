// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Leave
// entries", "Time off requests", "Approval"; decisions 303, 309, 313 and 314 in
// docs/BUILD_PLAN.md) and docs/DATA_MODEL.md (`leaveEntries`, `timeOffRequests`) — the fixed sets
// of step 2.8, their labels, the record and approval types, the number prefixes and the links.
// Pure code, safe in the browser.

/** A leave entry's kind (`leaveEntries.kind`). The balance of a type is the sum of its entries. */
export const LEAVE_ENTRY_KINDS = ['opening', 'credit', 'carryOver', 'usage', 'adjustment'] as const;
export type LeaveEntryKind = (typeof LEAVE_ENTRY_KINDS)[number];

export const LEAVE_ENTRY_KIND_LABELS: Record<LeaveEntryKind, string> = {
  opening: 'Opening balance',
  credit: 'Credit',
  carryOver: 'Carry-over',
  usage: 'Leave taken',
  adjustment: 'Adjustment',
};

/** The kinds that carry a `year` and are unique per employee, type and year (the credit job). */
export const YEARLY_LEAVE_ENTRY_KINDS = [
  'credit',
  'carryOver',
] as const satisfies readonly LeaveEntryKind[];

/** A request is leave or offset time off (`timeOffRequests.kind`). */
export const TIME_OFF_KINDS = ['leave', 'offset'] as const;
export type TimeOffKind = (typeof TIME_OFF_KINDS)[number];

export const TIME_OFF_KIND_LABELS: Record<TimeOffKind, string> = {
  leave: 'Leave',
  offset: 'Offset time off',
};

/**
 * The part of the day a request covers. A request over more than one day is `whole`; a single
 * day may also be a half (leave types with half days) or a `part` (offset time off only).
 */
export const TIME_OFF_PORTIONS = ['whole', 'firstHalf', 'secondHalf', 'part'] as const;
export type TimeOffPortion = (typeof TIME_OFF_PORTIONS)[number];

export const TIME_OFF_PORTION_LABELS: Record<TimeOffPortion, string> = {
  whole: 'Whole day',
  firstHalf: 'First half',
  secondHalf: 'Second half',
  part: 'Part of the day',
};

/** The two halves of a day. */
export const HALF_DAY_PORTIONS = [
  'firstHalf',
  'secondHalf',
] as const satisfies readonly TimeOffPortion[];
export type HalfDayPortion = (typeof HALF_DAY_PORTIONS)[number];

export function isHalfDayPortion(portion: TimeOffPortion): portion is HalfDayPortion {
  return portion === 'firstHalf' || portion === 'secondHalf';
}

/**
 * A request's status. `rejected` and `cancelled` are final; `approved` can still become
 * `cancelled` (before its first day).
 */
export const TIME_OFF_STATUSES = [
  'pending',
  'returned',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];

export const TIME_OFF_STATUS_LABELS: Record<TimeOffStatus, string> = {
  pending: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** The statuses that hold time: they block an overlap and count against `perYear` limits. */
export const TIME_OFF_HOLDING_STATUSES = [
  'pending',
  'approved',
] as const satisfies readonly TimeOffStatus[];

export function isTimeOffHolding(status: TimeOffStatus): boolean {
  return status === 'pending' || status === 'approved';
}

/** The final statuses: nothing moves them. */
export function isTimeOffFinal(status: TimeOffStatus): boolean {
  return status === 'rejected' || status === 'cancelled';
}

// ---------------------------------------------------------------------------------------------
// Record types, approval types, events and numbers

/** A leave entry's audit record type. */
export const LEAVE_ENTRY_TYPE = 'talent.leaveEntry';
/** A time off request's audit record type, and its attachment's file owner type. */
export const TIME_OFF_REQUEST_TYPE = 'talent.timeOffRequest';

/** The approval types, and the Approvals label of each. */
export const LEAVE_APPROVAL_TYPE = 'talent.leave';
export const OFFSET_TIME_OFF_APPROVAL_TYPE = 'talent.offsetTimeOff';
export const TIME_OFF_APPROVAL_TYPES: Record<TimeOffKind, string> = {
  leave: LEAVE_APPROVAL_TYPE,
  offset: OFFSET_TIME_OFF_APPROVAL_TYPE,
};
export const TIME_OFF_APPROVAL_TYPE_LABELS: Record<TimeOffKind, string> = {
  leave: 'Leave',
  offset: 'Offset time off',
};
/** The approval step's labels: the supervisors, or HR alone for a confidential type. */
export const TIME_OFF_APPROVAL_STEP_LABELS = { supervisor: 'Supervisor', hr: 'HR' } as const;

/** Sent to the request's approvers when an approved request is cancelled. */
export const TIME_OFF_CANCELLED_EVENT = 'talent.timeOffCancelled';
/** Sent to the employee when the holidays-changed listener changes an approved leave. */
export const LEAVE_ADJUSTED_EVENT = 'talent.leaveAdjusted';

/** The document number prefixes: `LV-YYYY-NNNN` and `OFS-YYYY-NNNN` (*Assumption*, item 177). */
export const LEAVE_REQUEST_PREFIX = 'LV';
export const OFFSET_TIME_OFF_PREFIX = 'OFS';
export const TIME_OFF_NUMBER_PREFIXES: Record<TimeOffKind, string> = {
  leave: LEAVE_REQUEST_PREFIX,
  offset: OFFSET_TIME_OFF_PREFIX,
};

// ---------------------------------------------------------------------------------------------
// Lengths

/** A request's reason: optional, up to 500 characters. */
export const TIME_OFF_REASON_MAX_LENGTH = 500;
/** A cancel's reason: up to 500 characters. */
export const TIME_OFF_CANCEL_REASON_MAX_LENGTH = 500;
/** A return's or rejection's remarks: required, up to 1,000 characters. */
export const TIME_OFF_REMARKS_MAX_LENGTH = 1000;
/** A leave entry's reason: required on HR's adjustment, up to 300 characters. */
export const LEAVE_ENTRY_REASON_MAX_LENGTH = 300;
/** A request's days are at most 366 days apart (`endDate − startDate`). */
export const TIME_OFF_MAX_SPAN_DAYS = 366;

// ---------------------------------------------------------------------------------------------
// Links

/** The employee's own time off page. */
export const OWN_TIME_OFF_HREF = '/talent/time-off';
/** My record, linked from the "add your sex" refusal. */
export const MY_RECORD_HREF = '/talent/me';

/** Someone's time off, read-only: `/talent/time-off/<employeeId>`. */
export function employeeTimeOffHref(employeeId: string): string {
  return `/talent/time-off/${employeeId}`;
}

/** A request, the approval's link: `/talent/time-off-requests/<id>`. */
export function timeOffRequestHref(requestId: string): string {
  return `/talent/time-off-requests/${requestId}`;
}
