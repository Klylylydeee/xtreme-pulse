import { describe, expect, it } from 'vitest';
import { SEED_TIMESHEET_SETTINGS } from '../server/payroll-settings/seed-data';
import {
  isTimesheetEditable,
  isTimesheetPending,
  submissionDeadlineDaysOf,
  TIMESHEET_APPROVED_MESSAGE,
  TIMESHEET_PENDING_MESSAGE,
  TIMESHEET_STATUSES,
  timesheetLockedMessage,
  timesheetSettingsSchema,
} from './schemas';
import {
  canSubmitOn,
  formatPeriodRange,
  isSubmittedLate,
  isTimesheetOverdue,
  isTimesheetsMissingDay,
  nextTimesheetStatus,
  submissionDeadline,
  submissionOpensOn,
  submitButtonLabel,
  submitOpensMessage,
  TIMESHEET_MOVES,
  timesheetApprovalSummary,
  timesheetApprovalTitle,
  timesheetBannerText,
  timesheetDueMessage,
  timesheetListFilterOf,
  timesheetReminderKind,
  timesheetReminderPeriodEnds,
  timesheetsMissingMessage,
  timesheetStatusText,
  type TimesheetSubmitFacts,
  timesheetSubmitProblemMessage,
  timesheetSubmitProblems,
} from './submission';

// The pure deadline, status and reminder rules of step 2.7 (docs/TESTING.md#timesheet-approval-
// dtr-and-offset-tests, "The deadline" and the statuses; decisions 278–284 and 293 in
// docs/BUILD_PLAN.md). The cut-off 2026-09-11 to 2026-09-25, as in the spec. Made-up names only.

const START = '2026-09-11';
const END = '2026-09-25';

describe('the submission deadline', () => {
  it('with 1 day, is due Sep 26, opens Sep 26, and a submit on Sep 27 is late', () => {
    const days = submissionDeadlineDaysOf(SEED_TIMESHEET_SETTINGS);
    expect(days).toBe(1);
    const deadline = submissionDeadline(END, days);
    expect(deadline).toBe('2026-09-26');
    expect(submissionOpensOn(END)).toBe('2026-09-26');
    expect(isSubmittedLate('2026-09-26', deadline)).toBe(false);
    expect(isSubmittedLate('2026-09-27', deadline)).toBe(true);
    // 23:59 on the deadline day in Manila is on time; 00:00 the next day is late.
    expect(isSubmittedLate(new Date('2026-09-26T23:59:00+08:00'), deadline)).toBe(false);
    expect(isSubmittedLate(new Date('2026-09-27T00:00:00+08:00'), deadline)).toBe(true);
  });

  it('reads 1 when a version has no deadline, and a version with 3 moves it', () => {
    const stored = timesheetSettingsSchema.parse({
      offsetRatio: '1',
      extraHours: { overtime: 'overtime', standard: 'offset' },
    });
    expect(submissionDeadlineDaysOf(stored)).toBe(1);
    const three = timesheetSettingsSchema.parse({ ...stored, submissionDeadlineDays: 3 });
    expect(submissionDeadline(END, submissionDeadlineDaysOf(three))).toBe('2026-09-28');
  });

  it('refuses 0, 11 and a fraction of a day', () => {
    for (const days of [0, 11, 2.5]) {
      const parsed = timesheetSettingsSchema.safeParse({
        ...SEED_TIMESHEET_SETTINGS,
        submissionDeadlineDays: days,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['submissionDeadlineDays']);
    }
    expect(
      timesheetSettingsSchema.safeParse({ ...SEED_TIMESHEET_SETTINGS, submissionDeadlineDays: 10 })
        .success,
    ).toBe(true);
  });

  it('opens the day after the cut-off ends, not on its last day', () => {
    expect(canSubmitOn(END, '2026-09-25')).toBe(false);
    expect(canSubmitOn(END, '2026-09-26')).toBe(true);
    expect(canSubmitOn(END, '2026-10-30')).toBe(true);
    expect(submitOpensMessage(END)).toBe('You can submit this timesheet from Sep 26, 2026.');
  });

  it('reads Open, then Not submitted, then Overdue', () => {
    const text = (today: string) =>
      timesheetStatusText({ status: 'open', periodEnd: END, deadline: '2026-09-26', today });
    expect(text('2026-09-25')).toBe('Open');
    expect(text('2026-09-26')).toBe('Not submitted');
    expect(text('2026-09-27')).toBe('Overdue');
    // The screens' destructive tone reads this flag, never the wording.
    const overdue = (today: string, status: 'open' | 'returned' = 'open') =>
      isTimesheetOverdue({ status, periodEnd: END, deadline: '2026-09-26', today });
    expect(overdue('2026-09-25')).toBe(false);
    expect(overdue('2026-09-26')).toBe(false);
    expect(overdue('2026-09-27')).toBe(true);
    expect(overdue('2026-09-27', 'returned')).toBe(false);
    expect(
      timesheetStatusText({
        status: 'pendingHr',
        periodEnd: END,
        deadline: '2026-09-26',
        today: '2026-09-27',
      }),
    ).toBe('Waiting for HR');
  });
});

describe('the statuses and their moves', () => {
  it('has the five statuses, and only open and returned change', () => {
    expect(TIMESHEET_STATUSES).toEqual([
      'open',
      'pendingSupervisor',
      'pendingHr',
      'returned',
      'approved',
    ]);
    expect(TIMESHEET_STATUSES.filter(isTimesheetEditable)).toEqual(['open', 'returned']);
    expect(TIMESHEET_STATUSES.filter(isTimesheetPending)).toEqual([
      'pendingSupervisor',
      'pendingHr',
    ]);
    expect(timesheetLockedMessage('open')).toBeNull();
    expect(timesheetLockedMessage('returned')).toBeNull();
    expect(timesheetLockedMessage('pendingSupervisor')).toBe(TIMESHEET_PENDING_MESSAGE);
    expect(timesheetLockedMessage('pendingHr')).toBe(TIMESHEET_PENDING_MESSAGE);
    expect(timesheetLockedMessage('approved')).toBe('This timesheet is approved and locked.');
  });

  it('allows exactly the spec’s moves', () => {
    const allowed: string[] = [];
    for (const from of TIMESHEET_STATUSES) {
      for (const move of TIMESHEET_MOVES) {
        const to = nextTimesheetStatus(from, move);
        if (to) allowed.push(`${from} -${move}-> ${to}`);
      }
    }
    expect(allowed.sort()).toEqual(
      [
        'open -submit-> pendingSupervisor',
        'returned -submit-> pendingSupervisor',
        'pendingSupervisor -supervisorApprove-> pendingHr',
        'pendingSupervisor -return-> returned',
        'pendingHr -return-> returned',
        'pendingHr -approve-> approved',
      ].sort(),
    );
  });

  it('goes straight to HR when the Supervisor step is skipped', () => {
    expect(nextTimesheetStatus('open', 'submit', { supervisorStepSkipped: true })).toBe(
      'pendingHr',
    );
    expect(nextTimesheetStatus('returned', 'submit', { supervisorStepSkipped: true })).toBe(
      'pendingHr',
    );
  });

  it('never reopens an approved timesheet', () => {
    for (const move of TIMESHEET_MOVES) expect(nextTimesheetStatus('approved', move)).toBeNull();
  });

  it('labels the submit button and the list tiles', () => {
    expect(submitButtonLabel('open')).toBe('Submit timesheet');
    expect(submitButtonLabel('returned')).toBe('Resubmit');
    expect(timesheetListFilterOf(null)).toBe('notSubmitted');
    expect(timesheetListFilterOf('open')).toBe('notSubmitted');
    expect(timesheetListFilterOf('returned')).toBe('returned');
    expect(timesheetListFilterOf('approved')).toBe('approved');
  });
});

describe('what blocks a submit', () => {
  const ready: TimesheetSubmitFacts = {
    status: 'open',
    periodEnd: END,
    today: '2026-09-26',
    openEntryDates: [],
    missingActivityDates: [],
    onboardingMissing: [],
    unclaimedLines: [],
    accountActive: true,
  };

  it('allows an empty timesheet after the cut-off ends', () => {
    expect(timesheetSubmitProblems(ready)).toEqual([]);
    expect(timesheetSubmitProblems({ ...ready, status: 'returned' })).toEqual([]);
  });

  it('names each problem, in order', () => {
    const problems = timesheetSubmitProblems({
      ...ready,
      status: 'pendingHr',
      today: END,
      accountActive: false,
      onboardingMissing: ['reportingTo'],
      openEntryDates: ['2026-09-24', '2026-09-24'],
      missingActivityDates: ['2026-09-22'],
      unclaimedLines: [{ id: 'line1', label: 'Meal, Sep 22' }],
    });
    expect(problems.map((p) => p.kind)).toEqual([
      'status',
      'cutOffNotEnded',
      'inactiveAccount',
      'onboarding',
      'openEntry',
      'missingActivity',
      'unclaimedLine',
    ]);
    const messages = problems.map(timesheetSubmitProblemMessage);
    expect(messages[0]).toBe(TIMESHEET_PENDING_MESSAGE);
    expect(messages[1]).toBe('You can submit this timesheet from Sep 26, 2026.');
    expect(messages[3]).toMatch(/^Complete this onboarding item first: /);
    expect(messages[4]).toBe('Time out first: Sep 24, 2026 has no time out.');
    expect(messages[6]).toContain('Meal, Sep 22');
  });

  it('refuses an approved timesheet with the lock message', () => {
    const [problem] = timesheetSubmitProblems({ ...ready, status: 'approved' });
    expect(problem && timesheetSubmitProblemMessage(problem)).toBe(TIMESHEET_APPROVED_MESSAGE);
  });
});

describe('the reminder days', () => {
  it('with 1 day: due today on Sep 26, overdue on Sep 27, HR told on Sep 27', () => {
    expect(timesheetReminderKind(END, 1, '2026-09-25')).toBeNull();
    expect(timesheetReminderKind(END, 1, '2026-09-26')).toBe('dueToday');
    expect(timesheetReminderKind(END, 1, '2026-09-27')).toBe('overdue');
    expect(timesheetReminderKind(END, 1, '2026-09-28')).toBeNull();
    expect(isTimesheetsMissingDay(END, 1, '2026-09-26')).toBe(false);
    expect(isTimesheetsMissingDay(END, 1, '2026-09-27')).toBe(true);
  });

  it('with 3 days: opens Sep 26, due Sep 28, overdue Sep 29', () => {
    expect(timesheetReminderKind(END, 3, '2026-09-26')).toBe('opens');
    expect(timesheetReminderKind(END, 3, '2026-09-27')).toBeNull();
    expect(timesheetReminderKind(END, 3, '2026-09-28')).toBe('dueToday');
    expect(timesheetReminderKind(END, 3, '2026-09-29')).toBe('overdue');
    expect(isTimesheetsMissingDay(END, 3, '2026-09-29')).toBe(true);
  });

  it('reads only cut-offs that ended in the last 11 days', () => {
    const window = timesheetReminderPeriodEnds('2026-10-06');
    expect(window).toEqual({ from: '2026-09-25', to: '2026-10-05' });
    // With the longest deadline, the day after it is still inside.
    expect(timesheetReminderKind(window.from, 10, '2026-10-06')).toBe('overdue');
  });

  it('words the reminders', () => {
    expect(timesheetDueMessage('opens', START, END, '2026-09-28')).toBe(
      'Your timesheet for Sep 11 – 25 is ready to submit, due Sep 28',
    );
    expect(timesheetDueMessage('dueToday', START, END, '2026-09-26')).toBe(
      'Your timesheet for Sep 11 – 25 is ready to submit, due today',
    );
    expect(timesheetsMissingMessage(3, START, END)).toBe(
      '3 timesheets not submitted for Sep 11 – 25',
    );
    expect(timesheetsMissingMessage(1, START, END)).toBe(
      '1 timesheet not submitted for Sep 11 – 25',
    );
  });
});

describe('the approval request and the banner', () => {
  it('formats a cut-off within a month, across months and across a year', () => {
    expect(formatPeriodRange(START, END)).toBe('Sep 11 – 25, 2026');
    expect(formatPeriodRange('2026-09-26', '2026-10-10')).toBe('Sep 26 – Oct 10, 2026');
    expect(formatPeriodRange('2026-12-26', '2027-01-10')).toBe('Dec 26, 2026 – Jan 10, 2027');
  });

  it('titles and summarizes the request with no sensitive field', () => {
    expect(timesheetApprovalTitle('Ellen', 'Garcia', START, END)).toBe(
      'Timesheet: Ellen Garcia · Sep 11 – 25, 2026',
    );
    expect(
      timesheetApprovalSummary({
        timesheetType: 'standard',
        treatment: 'offset',
        workedMinutes: 4800,
        extraMinutes: 275,
        manualTimeCount: 2,
        reimbursementCount: 3,
        reimbursementTotalCentavos: 125000,
        overLimitCount: 1,
      }),
    ).toBe(
      'Standard timesheet · Worked 80.0 h · Offset 4.6 h · 2 manual times · 3 reimbursements, ₱1,250.00 (1 over a limit)',
    );
  });

  it('words the banner', () => {
    expect(timesheetBannerText({ kind: 'open' })).toBeNull();
    expect(
      timesheetBannerText({ kind: 'notSubmitted', deadline: '2026-09-26', overdue: false }),
    ).toBe('Not submitted · Due Sep 26');
    expect(
      timesheetBannerText({ kind: 'notSubmitted', deadline: '2026-09-26', overdue: true }),
    ).toBe('Not submitted · Overdue');
    expect(
      timesheetBannerText({
        kind: 'pendingSupervisor',
        submittedAt: new Date('2026-09-26T09:00:00+08:00'),
        submittedLate: false,
        approverNames: ['Ramon Cruz'],
      }),
    ).toBe('Submitted Sep 26 · Waiting for supervisor');
    expect(
      timesheetBannerText({
        kind: 'returned',
        returnedAt: new Date('2026-09-27T09:00:00+08:00'),
        returnedByName: 'Ramon Cruz',
        remarks: 'Fix Sep 24',
        submittedLate: false,
      }),
    ).toBe('Returned by Ramon Cruz on Sep 27');
    expect(
      timesheetBannerText({
        kind: 'approved',
        approvedAt: new Date('2026-09-28T09:00:00+08:00'),
        approvedByName: 'Ana Reyes',
        submittedLate: true,
      }),
    ).toBe('Approved by Ana Reyes on Sep 28 · Locked');
  });
});
