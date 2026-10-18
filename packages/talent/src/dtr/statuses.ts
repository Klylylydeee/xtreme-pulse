// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record"; decision 289 in docs/BUILD_PLAN.md),
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("On the DTR";
// decision 315) and docs/modules/talent.md#daily-time-record-dtr — the DTR's day statuses, the
// time off on a DTR day, and their labels. Pure code, safe in the browser.

import { formatHours } from '../timesheets/compute';

/**
 * A DTR day's status, in the order they are matched: the first that applies wins. The three time
 * off statuses come from approved leave and offset time off (step 2.8).
 */
export const DTR_DAY_STATUSES = [
  'holiday',
  'restDay',
  'onLeavePaid',
  'offsetPaid',
  'leaveWithoutPay',
  'present',
  'absentUnpaid',
] as const;
export type DtrDayStatus = (typeof DTR_DAY_STATUSES)[number];

export const DTR_DAY_STATUS_LABELS: Record<DtrDayStatus, string> = {
  holiday: 'Holiday',
  restDay: 'Rest day',
  onLeavePaid: 'On leave (paid)',
  offsetPaid: 'Offset (paid)',
  leaveWithoutPay: 'Leave without pay',
  present: 'Present',
  absentUnpaid: 'Absent (unpaid)',
};

/**
 * The statuses approved leave or offset time off gives a day (step 2.8). On a day with more than
 * one part, the first in this order wins (a day partly paid and partly unpaid is `onLeavePaid`).
 */
export const DTR_TIME_OFF_STATUSES = ['onLeavePaid', 'offsetPaid', 'leaveWithoutPay'] as const;
export type DtrTimeOffStatus = (typeof DTR_TIME_OFF_STATUSES)[number];

/** What the time off is: leave (paid or not) or offset time off (always `offsetPaid`). */
export const DTR_TIME_OFF_KINDS = ['leave', 'offset'] as const;
export type DtrTimeOffKind = (typeof DTR_TIME_OFF_KINDS)[number];

/**
 * How much of a day the time off covers (decisions 302 and 309): the whole day, the first half
 * (scheduled start to the break) or the second half (the end of the break to the scheduled end),
 * split at the span's midpoint when there is no break, or a part from one time to another
 * (offset time off only).
 */
export const DTR_TIME_OFF_PORTIONS = ['whole', 'firstHalf', 'secondHalf', 'part'] as const;
export type DtrTimeOffPortion = (typeof DTR_TIME_OFF_PORTIONS)[number];

/** What a time off badge needs (a `DtrTimeOffPart`). */
export interface DtrTimeOffBadgeInput {
  status: DtrTimeOffStatus;
  portion: DtrTimeOffPortion;
  /** The type's short name ("VL"), or "Leave" for a confidential type to most viewers. */
  shortName: string;
  /** The scheduled minutes the part covers. */
  minutes: number;
}

/**
 * A time off badge on a DTR day (decision 319): "On leave (paid) · VL", "Half day VL (paid)",
 * "Offset (paid) 4.0 h", "Leave without pay" and "Half day leave without pay".
 */
export function dtrTimeOffLabel(part: DtrTimeOffBadgeInput): string {
  const half = part.portion === 'firstHalf' || part.portion === 'secondHalf';
  switch (part.status) {
    case 'offsetPaid':
      return `${DTR_DAY_STATUS_LABELS.offsetPaid} ${formatHours(part.minutes)}`;
    case 'onLeavePaid':
      return half
        ? `Half day ${part.shortName} (paid)`
        : `${DTR_DAY_STATUS_LABELS.onLeavePaid} · ${part.shortName}`;
    case 'leaveWithoutPay':
      return half ? 'Half day leave without pay' : DTR_DAY_STATUS_LABELS.leaveWithoutPay;
  }
}

/** Shown on a DTR day whose timesheet isn't approved yet (a preview, not final). */
export const DTR_PREVIEW_LABEL = 'Not approved yet';
