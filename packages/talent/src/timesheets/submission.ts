import {
  addDays,
  type BusinessDate,
  type Centavos,
  compareBusinessDates,
  formatDate,
  formatPeso,
  toBusinessDate,
  type TimesheetType,
} from '@pulse/core';
import { onboardingGateMessage } from '../onboarding/gates';
import type { OnboardingItemKey } from '../onboarding/items';
import { formatHours } from './compute';
import {
  type ExtraHoursTreatment,
  isTimesheetEditable,
  SUBMISSION_DEADLINE_DAYS_MAX,
  TIMESHEET_PENDING_MESSAGE,
  TIMESHEET_STATUS_LABELS,
  type TimesheetStatus,
  timesheetLockedMessage,
} from './schemas';
import { TIMESHEET_TYPE_TITLES, type TimesheetStatusBannerView } from './views';

// Spec: docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27
// ("Statuses", "The submission deadline", "Submitting", "Approval", "Reminders and the missing
// list", "Screens"; decisions 278–284 and 293 in docs/BUILD_PLAN.md) — the pure rules of a
// timesheet's submission: the deadline and the opening day, "Submitted late", the allowed status
// moves, what blocks a submit, the reminder days, and the wording the services and screens share.
// Pure code with no database, safe in the browser. Days are Manila business dates.

// ---------------------------------------------------------------------------------------------
// Days

/** "Sep 26": a Manila day without its year. */
export function formatShortDay(day: BusinessDate): string {
  return formatDate(day).replace(/,\s*\d{4}$/, '');
}

/**
 * A cut-off as people read it: "Sep 11 – 25, 2026", "Sep 26 – Oct 10, 2026", or across a year
 * "Dec 26, 2026 – Jan 10, 2027". With `{ year: false }`, "Sep 11 – 25" (the reminders).
 */
export function formatPeriodRange(
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  { year = true }: { year?: boolean } = {},
): string {
  const sameYear = periodStart.slice(0, 4) === periodEnd.slice(0, 4);
  const sameMonth = sameYear && periodStart.slice(5, 7) === periodEnd.slice(5, 7);
  const start = formatShortDay(periodStart);
  const end = sameMonth ? String(Number(periodEnd.slice(8, 10))) : formatShortDay(periodEnd);
  if (!year) return `${start} – ${end}`;
  if (!sameYear) return `${formatDate(periodStart)} – ${formatDate(periodEnd)}`;
  return `${start} – ${end}, ${periodEnd.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------------------------
// The deadline and the opening day

/**
 * The deadline: the Manila day `periodEnd + deadlineDays`, due by its end. `deadlineDays` comes
 * from `submissionDeadlineDaysOf` on the `talent.timesheetSettings` version in effect on the
 * period end. A period shortened by a new pay schedule uses its own end.
 */
export function submissionDeadline(periodEnd: BusinessDate, deadlineDays: number): BusinessDate {
  return addDays(periodEnd, deadlineDays);
}

/** Submission opens on the Manila day after the cut-off ends, and stays open after the deadline. */
export function submissionOpensOn(periodEnd: BusinessDate): BusinessDate {
  return addDays(periodEnd, 1);
}

/** True once the cut-off has ended: today is after the period end. */
export function canSubmitOn(periodEnd: BusinessDate, today: BusinessDate): boolean {
  return compareBusinessDates(today, periodEnd) > 0;
}

/** The refusal before the cut-off ends: "You can submit this timesheet from Sep 26, 2026." */
export function submitOpensMessage(periodEnd: BusinessDate): string {
  return `You can submit this timesheet from ${formatDate(submissionOpensOn(periodEnd))}.`;
}

/** True when today is after the deadline day: an `open` timesheet then reads "Overdue". */
export function isPastDeadline(today: BusinessDate, deadline: BusinessDate): boolean {
  return compareBusinessDates(today, deadline) > 0;
}

/** "Submitted late": submitted on a Manila day after the deadline. */
export function isSubmittedLate(submittedAt: Date | BusinessDate, deadline: BusinessDate): boolean {
  const day = typeof submittedAt === 'string' ? submittedAt : toBusinessDate(submittedAt);
  return isPastDeadline(day, deadline);
}

/** The "Submitted late" text badge. */
export const SUBMITTED_LATE_LABEL = 'Submitted late';

/** What a timesheet's status reads from on a day. */
export interface TimesheetStatusOnDay {
  status: TimesheetStatus;
  periodEnd: BusinessDate;
  deadline: BusinessDate;
  today: BusinessDate;
}

/**
 * True when an `open` timesheet is overdue: its cut-off has ended and today is after the deadline.
 * The screens use this flag, never the "Overdue" wording, to pick the destructive tone.
 */
export function isTimesheetOverdue(input: TimesheetStatusOnDay): boolean {
  return (
    input.status === 'open' &&
    canSubmitOn(input.periodEnd, input.today) &&
    isPastDeadline(input.today, input.deadline)
  );
}

/**
 * The status as it reads on a day: `open` is "Open" until the cut-off ends, then "Not submitted",
 * and "Overdue" after the deadline. The other statuses read their label.
 */
export function timesheetStatusText(input: TimesheetStatusOnDay): string {
  if (input.status !== 'open') return TIMESHEET_STATUS_LABELS[input.status];
  if (!canSubmitOn(input.periodEnd, input.today)) return TIMESHEET_STATUS_LABELS.open;
  return isTimesheetOverdue(input) ? 'Overdue' : 'Not submitted';
}

// ---------------------------------------------------------------------------------------------
// Status moves

/**
 * What moves a status (decision 283): the employee's submit (or resubmit), a supervisor's
 * approval, a return at either step, and HR's approval. Nothing else moves one: no withdraw, no
 * reopen.
 */
export const TIMESHEET_MOVES = ['submit', 'supervisorApprove', 'return', 'approve'] as const;
export type TimesheetMove = (typeof TIMESHEET_MOVES)[number];

/**
 * The status after `move` from `from`, or null when the move isn't allowed. A submit goes to
 * `pendingHr` when the Supervisor step is skipped (no active supervisor), else `pendingSupervisor`.
 */
export function nextTimesheetStatus(
  from: TimesheetStatus,
  move: TimesheetMove,
  { supervisorStepSkipped = false }: { supervisorStepSkipped?: boolean } = {},
): TimesheetStatus | null {
  switch (move) {
    case 'submit':
      if (!isTimesheetEditable(from)) return null;
      return supervisorStepSkipped ? 'pendingHr' : 'pendingSupervisor';
    case 'supervisorApprove':
      return from === 'pendingSupervisor' ? 'pendingHr' : null;
    case 'return':
      return from === 'pendingSupervisor' || from === 'pendingHr' ? 'returned' : null;
    case 'approve':
      return from === 'pendingHr' ? 'approved' : null;
  }
}

/** The submit button: "Submit timesheet", or "Resubmit" on a returned timesheet. */
export function submitButtonLabel(status: TimesheetStatus): string {
  return status === 'returned' ? 'Resubmit' : 'Submit timesheet';
}

/** The submit audit entry's reason: "Submitted" or "Resubmitted". */
export function submitAuditReason(status: TimesheetStatus): string {
  return status === 'returned' ? 'Resubmitted' : 'Submitted';
}

/** The audit reasons of the approval hooks' moves (a return's reason is its remarks). */
export const TIMESHEET_AUDIT_REASONS = {
  supervisorApproved: 'Approved by supervisor',
  approved: 'Approved',
} as const;

/** The timesheet's audit label: "<employee number> · <period start>". */
export function timesheetAuditLabel(employeeNumber: string, periodStart: BusinessDate): string {
  return `${employeeNumber} · ${periodStart}`;
}

// ---------------------------------------------------------------------------------------------
// What blocks a submit

/** Plain facts about a timesheet the service gathers before a submit. */
export interface TimesheetSubmitFacts {
  status: TimesheetStatus;
  periodEnd: BusinessDate;
  today: BusinessDate;
  /** The Manila days of entries still open (no time out). */
  openEntryDates: readonly BusinessDate[];
  /** The Manila days of closed entries with no activity. */
  missingActivityDates: readonly BusinessDate[];
  /** The `fileTimeRequest` gate's missing items (`checkOnboardingGate`). */
  onboardingMissing: readonly OnboardingItemKey[];
  /** Live reimbursement lines whose live claim in `receiptClaims` is missing or another's. */
  unclaimedLines: readonly { id: string; label: string }[];
  accountActive: boolean;
}

/** One reason a submit is refused, in the order they are checked. */
export type TimesheetSubmitProblem =
  | { kind: 'status'; status: TimesheetStatus }
  | { kind: 'cutOffNotEnded'; opensOn: BusinessDate }
  | { kind: 'inactiveAccount' }
  | { kind: 'onboarding'; items: OnboardingItemKey[] }
  | { kind: 'openEntry'; date: BusinessDate }
  | { kind: 'missingActivity'; date: BusinessDate }
  | { kind: 'unclaimedLine'; lineId: string; label: string };

/** Everything that blocks the submit, empty when it may go ahead. An empty timesheet may. */
export function timesheetSubmitProblems(facts: TimesheetSubmitFacts): TimesheetSubmitProblem[] {
  const problems: TimesheetSubmitProblem[] = [];
  if (!isTimesheetEditable(facts.status)) problems.push({ kind: 'status', status: facts.status });
  if (!canSubmitOn(facts.periodEnd, facts.today)) {
    problems.push({ kind: 'cutOffNotEnded', opensOn: submissionOpensOn(facts.periodEnd) });
  }
  if (!facts.accountActive) problems.push({ kind: 'inactiveAccount' });
  if (facts.onboardingMissing.length > 0) {
    problems.push({ kind: 'onboarding', items: [...facts.onboardingMissing] });
  }
  for (const date of [...new Set(facts.openEntryDates)].sort()) {
    problems.push({ kind: 'openEntry', date });
  }
  for (const date of [...new Set(facts.missingActivityDates)].sort()) {
    problems.push({ kind: 'missingActivity', date });
  }
  for (const line of facts.unclaimedLines) {
    problems.push({ kind: 'unclaimedLine', lineId: line.id, label: line.label });
  }
  return problems;
}

/** The refusal of one problem, as the service throws it and the confirmation sheet lists it. */
export function timesheetSubmitProblemMessage(problem: TimesheetSubmitProblem): string {
  switch (problem.kind) {
    case 'status':
      return timesheetLockedMessage(problem.status) ?? TIMESHEET_PENDING_MESSAGE;
    case 'cutOffNotEnded':
      return `You can submit this timesheet from ${formatDate(problem.opensOn)}.`;
    case 'inactiveAccount':
      return 'Your account is inactive, so this timesheet can’t be submitted. Ask HR.';
    case 'onboarding':
      return onboardingGateMessage(problem.items);
    case 'openEntry':
      return `Time out first: ${formatDate(problem.date)} has no time out.`;
    case 'missingActivity':
      return `Add the activity first: ${formatDate(problem.date)} has an entry with no activity.`;
    case 'unclaimedLine':
      return `Save this reimbursement line again: ${problem.label}. Its receipt is no longer held for it.`;
  }
}

/** The confirmation sheet's notice. */
export const SUBMIT_LOCK_NOTICE = 'You can’t change it while it’s waiting for approval.';
/** The confirmation sheet's warning on a timesheet with no entries (*Assumption*, item 131). */
export const EMPTY_TIMESHEET_WARNING =
  'This timesheet has no entries. Every scheduled day will show as absent.';

// ---------------------------------------------------------------------------------------------
// The approval request (`talent.timesheet`)

/** The approval type's key, and the record type of its audit entries. */
export const TIMESHEET_APPROVAL_TYPE = 'talent.timesheet';
/** The approval steps' labels. */
export const TIMESHEET_APPROVAL_STEP_LABELS = { supervisor: 'Supervisor', hr: 'HR' } as const;

/** The approval's title: "Timesheet: Ellen Garcia · Sep 11 – 25, 2026". */
export function timesheetApprovalTitle(
  firstName: string,
  lastName: string,
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
): string {
  return `Timesheet: ${firstName} ${lastName} · ${formatPeriodRange(periodStart, periodEnd)}`;
}

/** What the approval's summary reads. No sensitive field. */
export interface TimesheetApprovalSummaryInput {
  timesheetType: TimesheetType;
  treatment: ExtraHoursTreatment;
  workedMinutes: number;
  /** The total overtime (Overtime treatment) or offset (Offset treatment) minutes. */
  extraMinutes: number;
  manualTimeCount: number;
  reimbursementCount: number;
  reimbursementTotalCentavos: Centavos;
  overLimitCount: number;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * "Standard timesheet · Worked 80.0 h · Offset 4.6 h · 2 manual times · 3 reimbursements,
 * ₱1,250.00 (1 over a limit)".
 */
export function timesheetApprovalSummary(input: TimesheetApprovalSummaryInput): string {
  const parts = [
    TIMESHEET_TYPE_TITLES[input.timesheetType],
    `Worked ${formatHours(input.workedMinutes)}`,
    `${input.treatment === 'offset' ? 'Offset' : 'Overtime'} ${formatHours(input.extraMinutes)}`,
    plural(input.manualTimeCount, 'manual time', 'manual times'),
  ];
  if (input.reimbursementCount === 0) {
    parts.push('No reimbursements');
  } else {
    const over = input.overLimitCount > 0 ? ` (${input.overLimitCount} over a limit)` : '';
    parts.push(
      `${plural(input.reimbursementCount, 'reimbursement', 'reimbursements')}, ${formatPeso(
        input.reimbursementTotalCentavos,
      )}${over}`,
    );
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Links

/** The employee's own timesheet for a cut-off: `/talent/timesheet?cutOff=<period start>`. */
export function ownTimesheetHref(periodStart: BusinessDate): string {
  return `/talent/timesheet?cutOff=${periodStart}`;
}

/** Someone's timesheet, the approval's link: `/talent/timesheets/<id>?cutOff=<period start>`. */
export function timesheetHref(employeeId: string, periodStart: BusinessDate): string {
  return `/talent/timesheets/${employeeId}?cutOff=${periodStart}`;
}

/** The approver's "Open in Approvals": `/approvals?request=<id>`. */
export function approvalRequestHref(requestId: string): string {
  return `/approvals?request=${requestId}`;
}

// ---------------------------------------------------------------------------------------------
// The status banner

/** The banner's main line. Dates read "Sep 26"; the approvers' names show beside it. */
export function timesheetBannerText(banner: TimesheetStatusBannerView): string | null {
  switch (banner.kind) {
    case 'open':
      return null;
    case 'notSubmitted':
      return banner.overdue
        ? 'Not submitted · Overdue'
        : `Not submitted · Due ${formatShortDay(banner.deadline)}`;
    case 'pendingSupervisor':
      return `Submitted ${formatShortDay(toBusinessDate(banner.submittedAt))} · Waiting for supervisor`;
    case 'pendingHr':
      return `Submitted ${formatShortDay(toBusinessDate(banner.submittedAt))} · Waiting for HR`;
    case 'returned':
      return `Returned by ${banner.returnedByName ?? 'an approver'} on ${formatShortDay(
        toBusinessDate(banner.returnedAt),
      )}`;
    case 'approved':
      return `Approved by ${banner.approvedByName ?? 'HR'} on ${formatShortDay(
        toBusinessDate(banner.approvedAt),
      )} · Locked`;
  }
}

// ---------------------------------------------------------------------------------------------
// Reminders (`talent.timesheetReminders`)

/**
 * The employee's reminder of an `open` or `returned` timesheet: on the day submission opens, the
 * deadline day and the day after (*Assumption*, item 134). With a 1-day deadline the opening day
 * is the deadline day, which reads "due today".
 */
export const TIMESHEET_REMINDER_KINDS = ['opens', 'dueToday', 'overdue'] as const;
export type TimesheetReminderKind = (typeof TIMESHEET_REMINDER_KINDS)[number];

/** Today's reminder of a timesheet, or null when today isn't one of its reminder days. */
export function timesheetReminderKind(
  periodEnd: BusinessDate,
  deadlineDays: number,
  today: BusinessDate,
): TimesheetReminderKind | null {
  const deadline = submissionDeadline(periodEnd, deadlineDays);
  if (today === deadline) return 'dueToday';
  if (today === submissionOpensOn(periodEnd)) return 'opens';
  if (today === addDays(deadline, 1)) return 'overdue';
  return null;
}

/** HR's `talent.timesheetsMissing` goes out on the day after the deadline. */
export function isTimesheetsMissingDay(
  periodEnd: BusinessDate,
  deadlineDays: number,
  today: BusinessDate,
): boolean {
  return today === addDays(submissionDeadline(periodEnd, deadlineDays), 1);
}

/**
 * The period ends the reminder job reads on `today`: from `today − 11` to `today − 1`, so a
 * timesheet with a reminder day today is inside under any deadline (1 to 10 days), and an older
 * cut-off is never read. Filter each with `timesheetReminderKind` and `isTimesheetsMissingDay`
 * (*Assumption*, item 139: the spec's "deadline yesterday, today or tomorrow" misses the opening
 * day when the deadline is 3 days or more).
 */
export function timesheetReminderPeriodEnds(today: BusinessDate): {
  from: BusinessDate;
  to: BusinessDate;
} {
  return { from: addDays(today, -(SUBMISSION_DEADLINE_DAYS_MAX + 1)), to: addDays(today, -1) };
}

/** `talent.timesheetDue`'s message: "Your timesheet for Sep 11 – 25 is ready to submit, due Sep 28". */
export function timesheetDueMessage(
  kind: TimesheetReminderKind,
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  deadline: BusinessDate,
): string {
  const period = formatPeriodRange(periodStart, periodEnd, { year: false });
  switch (kind) {
    case 'opens':
      return `Your timesheet for ${period} is ready to submit, due ${formatShortDay(deadline)}`;
    case 'dueToday':
      return `Your timesheet for ${period} is ready to submit, due today`;
    case 'overdue':
      return `Your timesheet for ${period} is overdue. Submit it now`;
  }
}

/** `talent.timesheetDue`'s dedupe key: once per timesheet per Manila day. */
export function timesheetDueDedupeKey(timesheetId: string, day: BusinessDate): string {
  return `talent.timesheetDue:${timesheetId}:${day}`;
}

/** `talent.timesheetsMissing`'s message: "3 timesheets not submitted for Sep 11 – 25". */
export function timesheetsMissingMessage(
  count: number,
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
): string {
  return `${plural(count, 'timesheet', 'timesheets')} not submitted for ${formatPeriodRange(
    periodStart,
    periodEnd,
    { year: false },
  )}`;
}

/** `talent.timesheetsMissing`'s dedupe key: once per period. */
export function timesheetsMissingDedupeKey(periodStart: BusinessDate): string {
  return `talent.timesheetsMissing:${periodStart}`;
}

/** The timesheets list for a cut-off, optionally filtered: `/talent/timesheets?cutOff=…&status=…`. */
export function timesheetsListHref(
  periodStart: BusinessDate,
  filter?: TimesheetListFilter,
): string {
  return `/talent/timesheets?cutOff=${periodStart}${filter ? `&status=${filter}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// The timesheets list's filters

/** The list's tiles, each a `?status=` filter. "Not submitted" is `open`, or no timesheet yet. */
export const TIMESHEET_LIST_FILTERS = [
  'notSubmitted',
  'pendingSupervisor',
  'pendingHr',
  'returned',
  'approved',
] as const;
export type TimesheetListFilter = (typeof TIMESHEET_LIST_FILTERS)[number];

export const TIMESHEET_LIST_FILTER_LABELS: Record<TimesheetListFilter, string> = {
  notSubmitted: 'Not submitted',
  pendingSupervisor: 'Waiting for supervisor',
  pendingHr: 'Waiting for HR',
  returned: 'Returned',
  approved: 'Approved',
};

/** The tile a timesheet counts under; null (no timesheet created yet) is "Not submitted". */
export function timesheetListFilterOf(status: TimesheetStatus | null): TimesheetListFilter {
  return status === null || status === 'open' ? 'notSubmitted' : status;
}
