// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("The Daily Time Record"; decision 289 in docs/BUILD_PLAN.md) and
// docs/modules/talent.md#daily-time-record-dtr — the DTR's day statuses and their labels. Pure
// code, safe in the browser.

/**
 * A DTR day's status, in the order they are matched: the first that applies wins. The three time
 * off statuses come from approved leave and offset time off (step 2.8) and are never produced in
 * step 2.7.
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

/** The statuses approved leave or offset time off gives a day (step 2.8). */
export const DTR_TIME_OFF_STATUSES = ['onLeavePaid', 'offsetPaid', 'leaveWithoutPay'] as const;
export type DtrTimeOffStatus = (typeof DTR_TIME_OFF_STATUSES)[number];

/** Shown on a DTR day whose timesheet isn't approved yet (a preview, not final). */
export const DTR_PREVIEW_LABEL = 'Not approved yet';
