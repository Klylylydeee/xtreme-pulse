import { describe, expect, it } from 'vitest';
import type { PayrollSettings } from '../payroll/schemas';
import type { TimesheetHoliday } from '../timesheets/compute';
import type { WorkSchedule } from '../timesheets/schemas';
import { offsetBalanceMinutes } from '../offset/entries';
import {
  availableLeaveHalfDays,
  carryOverHalfDays,
  leaveBalanceHalfDays,
  plannedLeaveCredits,
  reconcileLeaveSplit,
  reconcileOffsetMinutes,
  regularizationCreditHalfDays,
  regularizationCreditMonths,
} from './balance';
import {
  endDateForCalendarDays,
  firstOverlapDay,
  halvesOfDay,
  type TimeOffDayContext,
  timeOffRequestDays,
} from './days';
import { TIME_OFF_NUMBER_PREFIXES } from './kinds';
import { previewLeaveRequest, previewOffsetTimeOff } from './preview';
import {
  canCancelTimeOff,
  nextTimeOffStatus,
  firstDayFilingDeadline,
  leaveAttachmentProblems,
  leaveEligibilityProblems,
  leaveFilingWindowProblems,
  leaveFilingWindowText,
  leaveLimitProblems,
  offsetTimeOffProblems,
  type TimeOffProblem,
  timeOffProblemMessage,
  timeOffSpanProblems,
  workedLeaveProblems,
} from './rules';
import {
  leaveOpeningInputSchema,
  offsetAdjustmentInputSchema,
  offsetOpeningInputSchema,
  timeOffRequestInputSchema,
} from './schemas';
import {
  type LeaveSettings,
  type LeaveType,
  leaveSettingsSchema,
  leaveSettingsVersionProblems,
  SEED_LEAVE_SETTINGS,
} from './settings';
import { formatDayCount, formatLeaveDays, minutesOfHoursText, parseDaysText } from './units';
import {
  leaveApprovalSummary,
  leaveApprovalTitle,
  leaveSplitText,
  offsetApprovalTitle,
} from './views';

// The pure leave and offset time off rules of step 2.8 (docs/TESTING.md#leave-and-time-off-tests;
// the hand-checked cases in docs/modules/talent.md#leave-offset-time-off-and-opening-balances-
// build-step-28). The seeded schedule (Monday to Friday, 08:00–17:00, break 12:00–13:00), the
// seeded leave types, "today" Monday 2026-10-19 10:00 Manila, and 2026-11-30 a confirmed regular
// holiday. The stored requests, approval and the DTR are tested on the server and in `dtr/`.

const TODAY = '2026-10-19';
const FILED_AT = new Date('2026-10-19T10:00:00+08:00');

const SCHEDULE: WorkSchedule = {
  workDays: [1, 2, 3, 4, 5],
  start: '08:00',
  end: '17:00',
  breakStart: '12:00',
  breakMinutes: 60,
  graceMinutes: 15,
};
const HOLIDAYS: TimesheetHoliday[] = [
  { date: '2026-11-30', name: 'Bonifacio Day', type: 'regular', scope: 'nationwide' },
];
const CONTEXT: TimeOffDayContext = {
  schedules: { defaultVersions: [{ effectiveFrom: '2000-01-01', value: SCHEDULE }] },
  holidays: HOLIDAYS,
  dateHired: '2024-01-15',
};
const PAYROLL: { effectiveFrom: string; value: Pick<PayrollSettings, 'cutOffs'> }[] = [
  {
    effectiveFrom: '2000-01-01',
    value: {
      cutOffs: [
        { key: 'midMonth', startDay: 26, endDay: 10, payDay: 15 },
        { key: 'endOfMonth', startDay: 11, endDay: 25, payDay: 30 },
      ],
    },
  },
];

const settings: LeaveSettings = leaveSettingsSchema.parse(SEED_LEAVE_SETTINGS);
function type(key: string): LeaveType {
  const found = settings.types.find((candidate) => candidate.key === key);
  if (!found) throw new Error(key);
  return found;
}
const VL = type('vacation');
const SL = type('sick');
const ML = type('maternity');

const messages = (problems: TimeOffProblem[]) => problems.map(timeOffProblemMessage);

function vlWindow(startDate: string, endDate = startDate) {
  return leaveFilingWindowProblems({
    type: VL,
    startDate,
    endDate,
    today: TODAY,
    firstDayDeadline: null,
  });
}

describe('the settings', () => {
  it('seeds the ten types, and parses its own seed unchanged', () => {
    expect(settings.types.map((t) => t.key)).toEqual([
      'vacation',
      'sick',
      'maternity',
      'maternitySoloParent',
      'maternityMiscarriage',
      'maternityExtension',
      'paternity',
      'soloParent',
      'vawc',
      'specialLeaveWomen',
    ]);
    expect(settings).toEqual(SEED_LEAVE_SETTINGS);
    expect(settings.goLiveDate).toBeNull();
    expect(settings.offsetTimeOff).toEqual({ minimumMinutes: 60, stepMinutes: 30 });
    expect(type('vawc').confidential).toBe(true);
    expect(type('maternityExtension').paid).toBe(false);
  });

  it('refuses a duplicate key, crediting on a non-credited type, a third of a day and minutes out of range', () => {
    const base = structuredClone(SEED_LEAVE_SETTINGS) as LeaveSettings;
    const duplicate = { ...base, types: [...base.types, { ...VL }] };
    expect(leaveSettingsSchema.safeParse(duplicate).success).toBe(false);
    const crediting = {
      ...base,
      types: base.types.map((t) => (t.key === 'maternity' ? { ...t, crediting: VL.crediting } : t)),
    };
    expect(leaveSettingsSchema.safeParse(crediting).success).toBe(false);
    const third = {
      ...base,
      types: base.types.map((t) => (t.key === 'vacation' ? { ...t, days: '2.3' } : t)),
    };
    expect(leaveSettingsSchema.safeParse(third).success).toBe(false);
    const half = {
      ...base,
      types: base.types.map((t) => (t.key === 'vacation' ? { ...t, days: 2.5 } : t)),
    };
    expect(leaveSettingsSchema.parse(half).types[0]?.days).toBe('2.5');
    for (const minutes of [10, 481]) {
      const offset = { ...base, offsetTimeOff: { minimumMinutes: minutes, stepMinutes: 30 } };
      expect(leaveSettingsSchema.safeParse(offset).success).toBe(false);
    }
  });

  it('refuses a dropped key, and a new go-live date once an opening entry exists', () => {
    const next = { ...settings, types: settings.types.slice(1) };
    expect(leaveSettingsVersionProblems(settings, next, { openingEntryExists: false })).toEqual([
      { kind: 'removedKeys', keys: ['vacation'] },
    ]);
    const live = { ...settings, goLiveDate: '2026-11-01' };
    expect(leaveSettingsVersionProblems(settings, live, { openingEntryExists: false })).toEqual([]);
    expect(leaveSettingsVersionProblems(live, settings, { openingEntryExists: true })).toEqual([
      { kind: 'goLiveLocked', goLiveDate: '2026-11-01' },
    ]);
  });
});

describe('units', () => {
  it('counts half days and formats them with one decimal', () => {
    expect(parseDaysText('2.5')).toBe(5);
    expect(parseDaysText('5.0')).toBe(10);
    expect(parseDaysText('2.3')).toBeNull();
    expect(formatLeaveDays(9)).toBe('4.5 days');
    expect(formatLeaveDays(2)).toBe('1.0 day');
    expect(formatLeaveDays(-1)).toBe('−0.5 day');
    expect(formatDayCount(6)).toBe('3 days');
    expect(formatDayCount(1)).toBe('0.5 day');
  });

  it('reads typed offset hours into whole minutes, half up', () => {
    expect(minutesOfHoursText('1.25')).toBe(75);
    expect(minutesOfHoursText('0.01')).toBe(1);
    expect(minutesOfHoursText('8')).toBe(480);
    expect(minutesOfHoursText('-0.5')).toBe(-30);
    expect(minutesOfHoursText('1.234')).toBeNull();
    expect(offsetOpeningInputSchema.parse({ employeeId: 'a'.repeat(24), minutes: '10' })).toEqual({
      employeeId: 'a'.repeat(24),
      minutes: 600,
    });
    expect(
      offsetOpeningInputSchema.safeParse({ employeeId: 'a'.repeat(24), minutes: '-1' }).success,
    ).toBe(false);
    expect(
      offsetAdjustmentInputSchema.safeParse({
        employeeId: 'a'.repeat(24),
        minutes: '1',
        reason: '',
      }).success,
    ).toBe(false);
    expect(
      leaveOpeningInputSchema.parse({
        employeeId: 'a'.repeat(24),
        typeKey: 'vacation',
        halfDays: '2.5',
      }).halfDays,
    ).toBe(5);
    expect(
      leaveOpeningInputSchema.safeParse({
        employeeId: 'a'.repeat(24),
        typeKey: 'vacation',
        halfDays: '366',
      }).success,
    ).toBe(false);
  });
});

describe('filing leave', () => {
  it('L1: refuses VL filed 10 days ahead, by Oct 15 for Oct 29', () => {
    expect(messages(vlWindow('2026-10-29'))).toEqual([
      'Vacation leave must be filed at least 14 days before the first day, so by Oct 15 for Oct 29.',
    ]);
    expect(leaveFilingWindowText(VL, '2026-10-29')).toBe('File VL by Oct 15 for Oct 29');
  });

  it('L2: accepts VL 14 days ahead for one paid day, and the balance falls to 4.0', () => {
    expect(vlWindow('2026-11-02')).toEqual([]);
    const { days, split } = previewLeaveRequest({
      type: VL,
      span: { startDate: '2026-11-02', endDate: '2026-11-02', portion: 'whole' },
      context: CONTEXT,
      availableHalfDays: 10,
    });
    expect(split).toEqual({ chargeableHalfDays: 2, paidHalfDays: 2, unpaidHalfDays: 0 });
    expect(leaveLimitProblems({ type: VL, days })).toEqual([]);
    expect(formatLeaveDays(leaveBalanceHalfDays([{ halfDays: 10 }, { halfDays: -2 }]))).toBe(
      '4.0 days',
    );
  });

  it('L3: VL Fri Nov 6 – Tue Nov 10 charges 3 days, the weekend left out', () => {
    const { days, split } = previewLeaveRequest({
      type: VL,
      span: { startDate: '2026-11-06', endDate: '2026-11-10', portion: 'whole' },
      context: CONTEXT,
      availableHalfDays: 10,
    });
    expect(split.chargeableHalfDays).toBe(6);
    expect(days.filter((day) => !day.chargeable).map((day) => [day.date, day.excluded])).toEqual([
      ['2026-11-07', 'restDay'],
      ['2026-11-08', 'restDay'],
    ]);
  });

  it('L4: VL Nov 30 – Dec 1 charges 1 day, the holiday left out', () => {
    const days = timeOffRequestDays(
      { startDate: '2026-11-30', endDate: '2026-12-01', portion: 'whole' },
      'workDays',
      CONTEXT,
    );
    expect(days.map((day) => [day.date, day.chargeable, day.excluded, day.holiday])).toEqual([
      ['2026-11-30', false, 'holiday', true],
      ['2026-12-01', true, null, false],
    ]);
    expect(days[1]?.intervals).toEqual([
      { from: 480, to: 720 },
      { from: 780, to: 1020 },
    ]);
    expect(days[1]?.minutes).toBe(480);
  });

  it('L5: 3 days on a 2.0 balance: 2 paid, the last day without pay', () => {
    const { days, split } = previewLeaveRequest({
      type: VL,
      span: { startDate: '2026-11-03', endDate: '2026-11-05', portion: 'whole' },
      context: CONTEXT,
      availableHalfDays: 4,
    });
    expect(split).toEqual({ chargeableHalfDays: 6, paidHalfDays: 4, unpaidHalfDays: 2 });
    expect(days.map((day) => [day.date, day.paidHalfDays, day.unpaidHalfDays])).toEqual([
      ['2026-11-03', 2, 0],
      ['2026-11-04', 2, 0],
      ['2026-11-05', 0, 2],
    ]);
    expect(leaveSplitText({ type: VL, ...split })).toBe(
      '3 days: 2 covered by your VL balance, 1 day without pay (deducted from pay)',
    );
  });

  it('holds pending requests and never counts a future credit in the available balance', () => {
    expect(
      availableLeaveHalfDays({
        entries: [
          { kind: 'opening', halfDays: 10, effectiveOn: '2026-11-01' },
          { kind: 'credit', halfDays: 10, effectiveOn: '2027-01-01' },
          { kind: 'usage', halfDays: -2, effectiveOn: '2026-10-01' },
        ],
        today: TODAY,
        pendingPaidHalfDays: [3],
      }),
    ).toBe(5);
  });

  it('L6–L8: the halves of a day are the morning and the afternoon around the break', () => {
    expect(halvesOfDay(SCHEDULE)).toEqual({
      firstHalf: { from: 480, to: 720 },
      secondHalf: { from: 780, to: 1020 },
    });
    expect(halvesOfDay({ ...SCHEDULE, breakMinutes: 0, end: '16:59' })).toEqual({
      firstHalf: { from: 480, to: 749 },
      secondHalf: { from: 749, to: 1019 },
    });
    const [first] = timeOffRequestDays(
      { startDate: '2026-11-02', endDate: '2026-11-02', portion: 'firstHalf' },
      'workDays',
      CONTEXT,
    );
    expect(first).toMatchObject({ halfDays: 1, minutes: 240, intervals: [{ from: 480, to: 720 }] });
    // L6: the balance after a half day of VL.
    expect(formatLeaveDays(leaveBalanceHalfDays([{ halfDays: 0 }, { halfDays: -1 }]))).toBe(
      '−0.5 day',
    );
  });

  it('allows a half day only on one day of a type with half days, and a part only for offset', () => {
    const span = { kind: 'leave' as const, startDate: '2026-11-02', endDate: '2026-11-02' };
    expect(timeOffSpanProblems({ ...span, portion: 'firstHalf', halfDaysAllowed: true })).toEqual(
      [],
    );
    expect(
      timeOffSpanProblems({ ...span, portion: 'firstHalf', halfDaysAllowed: false }),
    ).toHaveLength(1);
    expect(
      timeOffSpanProblems({
        ...span,
        endDate: '2026-11-03',
        portion: 'secondHalf',
        halfDaysAllowed: true,
      }),
    ).toHaveLength(1);
    expect(timeOffSpanProblems({ ...span, portion: 'part' })).toHaveLength(1);
    expect(timeOffSpanProblems({ ...span, kind: 'offset', portion: 'part' })).toEqual([]);
    expect(
      messages(timeOffSpanProblems({ ...span, endDate: '2026-11-01', portion: 'whole' })),
    ).toEqual(['The last day can’t be before the first day.']);
    expect(
      timeOffSpanProblems({ ...span, endDate: '2027-11-04', portion: 'whole' }).map((p) => p.kind),
    ).toEqual(['tooLong']);
  });

  it('L9: refuses VL and SL to a Probationary employee', () => {
    for (const leave of [VL, SL]) {
      const problems = leaveEligibilityProblems({
        type: leave,
        employmentStatus: 'Probationary',
        sex: 'female',
        dateHired: '2026-08-01',
        today: TODAY,
        approvedRequestCount: 0,
        allTypes: settings.types,
      });
      expect(messages(problems)).toEqual([
        'Probationary employees can’t use VL or SL. Any absence during probation is unpaid.',
      ]);
    }
    // A statutory leave is open to every status.
    expect(
      leaveEligibilityProblems({
        type: ML,
        employmentStatus: 'Probationary',
        sex: 'female',
        dateHired: '2026-08-01',
        today: TODAY,
        approvedRequestCount: 0,
      }),
    ).toEqual([]);
  });

  it('checks sex, service months and the most requests', () => {
    const base = {
      employmentStatus: 'Regular' as const,
      dateHired: '2026-06-01',
      today: TODAY,
      approvedRequestCount: 0,
    };
    expect(leaveEligibilityProblems({ ...base, type: ML, sex: null })).toEqual([
      { kind: 'sexMissing', typeName: 'Maternity leave', href: '/talent/me' },
    ]);
    expect(messages(leaveEligibilityProblems({ ...base, type: ML, sex: 'male' }))).toEqual([
      'Maternity leave is for female employees.',
    ]);
    expect(
      messages(leaveEligibilityProblems({ ...base, type: type('soloParent'), sex: 'male' })),
    ).toEqual([
      'Solo parent leave needs 6 months of service since your date hired, so from Dec 1, 2026.',
    ]);
    expect(
      leaveEligibilityProblems({
        ...base,
        type: type('paternity'),
        sex: 'male',
        approvedRequestCount: 4,
      }).map((p) => p.kind),
    ).toEqual(['maxRequests']);
    expect(
      leaveEligibilityProblems({ ...base, type: { ...VL, active: false }, sex: 'male' }).map(
        (p) => p.kind,
      ),
    ).toEqual(['typeInactive']);
  });

  it('L10: SL for tomorrow is refused; last Friday needs the certificate, until its cut-off’s deadline', () => {
    const deadline = firstDayFilingDeadline('2026-10-16', PAYROLL, 1);
    expect(deadline).toBe('2026-10-26');
    const window = (startDate: string, today = TODAY) =>
      leaveFilingWindowProblems({
        type: SL,
        startDate,
        endDate: startDate,
        today,
        firstDayDeadline: firstDayFilingDeadline(startDate, PAYROLL, 1),
      });
    expect(messages(window('2026-10-20'))).toEqual([
      'Sick leave is filed on or after the sick day.',
    ]);
    expect(window('2026-10-16')).toEqual([]);
    expect(messages(leaveAttachmentProblems(SL, false))).toEqual([
      'Attach the medical certificate.',
    ]);
    expect(leaveAttachmentProblems(SL, true)).toEqual([]);
    expect(messages(window('2026-10-16', '2026-10-27'))).toEqual([
      'The timesheet deadline for that cut-off has passed. Ask HR.',
    ]);
    // Statutory leave may be filed ahead with no notice, and VL never for a past day.
    expect(
      leaveFilingWindowProblems({
        type: ML,
        startDate: '2026-10-20',
        endDate: '2027-02-01',
        today: TODAY,
        firstDayDeadline: null,
      }),
    ).toEqual([]);
    expect(vlWindow('2026-10-16').map((p) => p.kind)).toEqual(['notice', 'past']);
  });

  it('L13: maternity from Nov 2 for 105 calendar days ends Feb 14; 106 days is refused', () => {
    const endDate = endDateForCalendarDays('2026-11-02', 105);
    expect(endDate).toBe('2027-02-14');
    const { days, split } = previewLeaveRequest({
      type: ML,
      span: { startDate: '2026-11-02', endDate, portion: 'whole' },
      context: CONTEXT,
      availableHalfDays: 0,
    });
    expect(split).toEqual({ chargeableHalfDays: 210, paidHalfDays: null, unpaidHalfDays: null });
    expect(days.every((day) => day.chargeable && day.paidHalfDays === 2)).toBe(true);
    expect(days.find((day) => day.date === '2026-11-30')).toMatchObject({
      holiday: true,
      chargeable: true,
    });
    expect(days.find((day) => day.date === '2026-11-07')).toMatchObject({
      restDay: true,
      intervals: [],
    });
    expect(leaveLimitProblems({ type: ML, days })).toEqual([]);
    const longer = timeOffRequestDays(
      { startDate: '2026-11-02', endDate: '2027-02-15', portion: 'whole' },
      'calendarDays',
      CONTEXT,
    );
    expect(messages(leaveLimitProblems({ type: ML, days: longer }))).toEqual([
      'Maternity leave covers up to 105 days per request.',
    ]);
  });

  it('refuses days that are all rest days or holidays, and a per-year limit counting other requests', () => {
    const weekend = timeOffRequestDays(
      { startDate: '2026-11-07', endDate: '2026-11-08', portion: 'whole' },
      'workDays',
      CONTEXT,
    );
    expect(messages(leaveLimitProblems({ type: VL, days: weekend }))).toEqual([
      'These days are all rest days or holidays.',
    ]);
    const week = timeOffRequestDays(
      { startDate: '2026-11-02', endDate: '2026-11-04', portion: 'whole' },
      'workDays',
      CONTEXT,
    );
    const spl = type('soloParent');
    expect(
      leaveLimitProblems({ type: spl, days: week, otherHalfDaysByYear: new Map([[2026, 8]]) }),
    ).toEqual([]);
    expect(
      messages(
        leaveLimitProblems({ type: spl, days: week, otherHalfDaysByYear: new Map([[2026, 10]]) }),
      ),
    ).toEqual(['Solo parent leave covers up to 7 days a year. You have 2 days left for 2026.']);
  });

  it('a whole day overlaps anything that day; the two halves of a day sit side by side', () => {
    const day = (portion: 'whole' | 'firstHalf' | 'secondHalf') =>
      timeOffRequestDays(
        { startDate: '2026-11-02', endDate: '2026-11-02', portion },
        'workDays',
        CONTEXT,
      );
    expect(firstOverlapDay(day('firstHalf'), day('secondHalf'))).toBeNull();
    expect(firstOverlapDay(day('firstHalf'), day('firstHalf'))).toBe('2026-11-02');
    expect(firstOverlapDay(day('whole'), day('secondHalf'))).toBe('2026-11-02');
  });

  it('refuses leave over worked time in its portion', () => {
    const [first] = timeOffRequestDays(
      { startDate: '2026-10-16', endDate: '2026-10-16', portion: 'firstHalf' },
      'workDays',
      CONTEXT,
    );
    const afternoon = {
      timeIn: new Date('2026-10-16T13:00:00+08:00'),
      timeOut: new Date('2026-10-16T17:00:00+08:00'),
    };
    expect(workedLeaveProblems(first ? [first] : [], [afternoon])).toEqual([]);
    const whole = timeOffRequestDays(
      { startDate: '2026-10-16', endDate: '2026-10-16', portion: 'whole' },
      'workDays',
      CONTEXT,
    );
    expect(messages(workedLeaveProblems(whole, [afternoon]))).toEqual([
      'You worked on Oct 16. Leave can’t cover a day with time entries.',
    ]);
  });
});

describe('crediting', () => {
  it('L11: regularized April 10 earns 4.0 days, April 20 3.5 days', () => {
    expect(regularizationCreditMonths('2026-04-10')).toBe(9);
    expect(regularizationCreditHalfDays(VL, '2026-04-10')).toBe(8);
    expect(regularizationCreditHalfDays(VL, '2026-04-20')).toBe(7);
    expect(regularizationCreditHalfDays(VL, '2026-04-15')).toBe(8);
    expect(regularizationCreditHalfDays(VL, '2026-04-16')).toBe(7);
    expect(regularizationCreditHalfDays(VL, '2026-01-01')).toBe(10);
    const facts = {
      today: '2026-04-10',
      goLiveDate: '2026-01-01',
      type: VL,
      employmentStatus: 'Regular' as const,
      regularizationDate: '2026-04-10',
      active: true,
    };
    expect(plannedLeaveCredits(facts)).toEqual([
      { kind: 'credit', year: 2026, effectiveOn: '2026-04-10', halfDays: 8 },
    ]);
  });

  it('credits nothing without a go-live date, before it, or to anyone not Regular with a regularization date', () => {
    const facts = {
      today: '2026-10-19',
      goLiveDate: '2026-01-01' as string | null,
      type: VL,
      employmentStatus: 'Regular' as const,
      regularizationDate: '2026-04-10' as string | null,
      active: true,
    };
    expect(plannedLeaveCredits({ ...facts, goLiveDate: null })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, goLiveDate: '2026-05-01' })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, employmentStatus: 'Probationary' })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, employmentStatus: 'Contractual' })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, regularizationDate: null })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, active: false })).toEqual([]);
    expect(plannedLeaveCredits({ ...facts, type: { ...VL, active: false } })).toEqual([]);
    // Regularized in an earlier year with the credit date before the go-live date: no back-fill.
    expect(
      plannedLeaveCredits({ ...facts, regularizationDate: '2025-04-10', goLiveDate: '2026-03-01' }),
    ).toEqual([]);
  });

  it('L12: the January 1 carry-over and credit, with no cap and with a cap of 2 days', () => {
    const facts = {
      today: '2027-01-01',
      goLiveDate: '2026-01-01',
      type: VL,
      employmentStatus: 'Regular' as const,
      regularizationDate: '2026-04-10',
      active: true,
    };
    expect(plannedLeaveCredits(facts)).toEqual([
      { kind: 'carryOver', year: 2027, effectiveOn: '2027-01-01', halfDays: null },
      { kind: 'credit', year: 2027, effectiveOn: '2027-01-01', halfDays: 10 },
    ]);
    const before = 7; // 3.5 days at the end of 2026
    const noCap = carryOverHalfDays(VL, before);
    expect(noCap).toBe(0);
    expect(formatLeaveDays(before + noCap + 10)).toBe('8.5 days');
    const capped = {
      crediting: {
        annualCreditOn: '01-01',
        prorateFromRegularization: true,
        carryOverCapDays: '2',
      },
    };
    const carry = carryOverHalfDays(capped, before);
    expect(carry).toBe(-3);
    expect(formatLeaveDays(before + carry + 10)).toBe('7.0 days');
    expect(carryOverHalfDays(capped, -2)).toBe(0);
  });
});

describe('offset time off', () => {
  const offset = (
    span: {
      startDate: string;
      endDate: string;
      portion: 'whole' | 'part';
      fromTime?: string;
      toTime?: string;
    },
    availableMinutes: number,
    filedAt = FILED_AT,
  ) => {
    const { days, minutes } = previewOffsetTimeOff({ span, context: CONTEXT });
    return {
      minutes,
      problems: offsetTimeOffProblems({
        settings,
        portion: span.portion,
        days,
        fromTime: span.fromTime ?? null,
        filedAt,
        availableMinutes,
      }),
    };
  };
  const nov2 = { startDate: '2026-11-02', endDate: '2026-11-02' };

  it('O1: 13:00–17:00 covers 240 minutes, leaving 35 of 275', () => {
    const { minutes, problems } = offset(
      { ...nov2, portion: 'part', fromTime: '13:00', toTime: '17:00' },
      275,
    );
    expect(minutes).toBe(240);
    expect(problems).toEqual([]);
    expect(offsetBalanceMinutes([{ minutes: 275 }, { minutes: -minutes }])).toBe(35);
  });

  it('O2: a whole day with 35 minutes available is refused', () => {
    const { minutes, problems } = offset({ ...nov2, portion: 'whole' }, 35);
    expect(minutes).toBe(480);
    expect(messages(problems)).toEqual([
      'This needs 8.0 h, more than your available offset balance of 0.6 h.',
    ]);
    expect(messages(offset({ ...nov2, portion: 'whole' }, 0).problems)).toEqual([
      'You have no offset hours available.',
    ]);
  });

  it('O3: 13:00–13:45 is not a 30-minute step; 13:00–13:30 is below 60 minutes', () => {
    const step = offset({ ...nov2, portion: 'part', fromTime: '13:00', toTime: '13:45' }, 600);
    expect(step.problems[0]?.kind).toBe('offsetStep');
    expect(messages(step.problems)[0]).toBe('Offset time off is taken in 30-minute steps.');
    const short = offset({ ...nov2, portion: 'part', fromTime: '13:00', toTime: '13:30' }, 600);
    expect(messages(short.problems)).toEqual(['Offset time off is at least 1.0 h.']);
    // The break covers nothing: 11:00–14:00 is 2 scheduled hours.
    expect(
      offset({ ...nov2, portion: 'part', fromTime: '11:00', toTime: '14:00' }, 600).minutes,
    ).toBe(120);
    expect(
      offset({ ...nov2, portion: 'part', fromTime: '07:00', toTime: '09:00' }, 600).problems.map(
        (p) => p.kind,
      ),
    ).toEqual(['partOutsideSchedule']);
  });

  it('O4: today from 08:00, filed at 10:00, is refused; this afternoon is fine; whole days from tomorrow', () => {
    const today = { startDate: TODAY, endDate: TODAY };
    expect(
      messages(
        offset({ ...today, portion: 'part', fromTime: '08:00', toTime: '12:00' }, 600).problems,
      ),
    ).toEqual([
      'Offset time off must start after you file it. It can’t cover an absence, a late or undertime.',
    ]);
    expect(
      offset({ ...today, portion: 'part', fromTime: '13:00', toTime: '17:00' }, 600).problems,
    ).toEqual([]);
    expect(offset({ ...today, portion: 'whole' }, 600).problems.map((p) => p.kind)).toEqual([
      'offsetStarted',
    ]);
    expect(
      offset({ startDate: '2026-10-20', endDate: '2026-10-20', portion: 'whole' }, 600).problems,
    ).toEqual([]);
  });

  it('O5: a whole day on a 600-minute balance charges 480, leaving 120', () => {
    const { minutes, problems } = offset({ ...nov2, portion: 'whole' }, 600);
    expect(problems).toEqual([]);
    expect(minutes).toBe(480);
    expect(offsetBalanceMinutes([{ minutes: 600 }, { minutes: -minutes }])).toBe(120);
  });

  it('a rest day or holiday alone covers nothing', () => {
    const holiday = offset(
      { startDate: '2026-11-30', endDate: '2026-11-30', portion: 'whole' },
      600,
    );
    expect(messages(holiday.problems)).toEqual(['These days are all rest days or holidays.']);
  });
});

describe('approval, cancelling and the listener', () => {
  it('moves the status: approve, return, reject, send again and cancel; no withdraw', () => {
    expect(nextTimeOffStatus('pending', 'approve')).toBe('approved');
    expect(nextTimeOffStatus('pending', 'cancel')).toBeNull();
    expect(nextTimeOffStatus('returned', 'resend')).toBe('pending');
    expect(nextTimeOffStatus('rejected', 'resend')).toBeNull();
    expect(nextTimeOffStatus('approved', 'cancel')).toBe('cancelled');
    expect(canCancelTimeOff({ status: 'approved', startDate: '2026-11-02' }, TODAY)).toBe(true);
    expect(canCancelTimeOff({ status: 'approved', startDate: TODAY }, TODAY)).toBe(false);
    expect(TIME_OFF_NUMBER_PREFIXES).toEqual({ leave: 'LV', offset: 'OFS' });
  });

  it('H1: a holiday confirmed inside an approved VL gives a day back; deleting it charges again', () => {
    const charged = { chargeableHalfDays: 4, paidHalfDays: 4, unpaidHalfDays: 0 };
    const confirmed = reconcileLeaveSplit(charged, 2, 6);
    expect(confirmed).toEqual({
      split: { chargeableHalfDays: 2, paidHalfDays: 2, unpaidHalfDays: 0 },
      balanceChangeHalfDays: 2,
    });
    expect(reconcileLeaveSplit(confirmed.split, 2, 8).balanceChangeHalfDays).toBe(0);
    expect(reconcileLeaveSplit(confirmed.split, 4, 8).balanceChangeHalfDays).toBe(-2);
    expect(reconcileLeaveSplit(confirmed.split, 4, 1)).toEqual({
      split: { chargeableHalfDays: 4, paidHalfDays: 3, unpaidHalfDays: 1 },
      balanceChangeHalfDays: -1,
    });
    // A fall takes the unpaid days first.
    expect(
      reconcileLeaveSplit({ chargeableHalfDays: 6, paidHalfDays: 4, unpaidHalfDays: 2 }, 4, 0),
    ).toEqual({
      split: { chargeableHalfDays: 4, paidHalfDays: 4, unpaidHalfDays: 0 },
      balanceChangeHalfDays: 0,
    });
    expect(reconcileOffsetMinutes(960, 480)).toBe(480);
    expect(reconcileOffsetMinutes(480, 960)).toBe(-480);
  });

  it('titles and summarizes the approval, hiding a confidential type', () => {
    const base = {
      firstName: 'Ellen',
      lastName: 'Garcia',
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      portion: 'whole' as const,
      chargeableHalfDays: 6,
    };
    expect(leaveApprovalTitle({ ...base, type: VL })).toBe(
      'Leave: Ellen Garcia · VL · Nov 2 – 4, 2026 (3 days)',
    );
    expect(leaveApprovalTitle({ ...base, type: type('vawc') })).toBe(
      'Leave (confidential): Ellen Garcia · Nov 2 – 4, 2026 (3 days)',
    );
    expect(
      offsetApprovalTitle({
        ...base,
        endDate: '2026-11-02',
        portion: 'part',
        fromTime: '13:00',
        toTime: '17:00',
        minutes: 240,
      }),
    ).toBe('Offset time off: Ellen Garcia · Nov 2, 1:00 – 5:00 PM (4.0 h)');
    expect(
      leaveApprovalSummary({
        type: SL,
        chargeableHalfDays: 6,
        paidHalfDays: 4,
        unpaidHalfDays: 2,
        hasAttachment: true,
      }),
    ).toBe('3 days · 2 days paid from SL, 1 day without pay · Medical certificate attached');
    expect(
      leaveApprovalSummary({
        type: type('vawc'),
        chargeableHalfDays: 4,
        paidHalfDays: null,
        unpaidHalfDays: null,
        hasAttachment: true,
      }),
    ).toBe('2 days · Paid');
  });

  it('parses the request sheet by kind', () => {
    const offsetInput = timeOffRequestInputSchema.parse({
      kind: 'offset',
      startDate: '2026-11-02',
      endDate: '2026-11-02',
      portion: 'whole',
      reason: '',
      fromTime: '13:00',
      toTime: '',
    });
    expect(offsetInput).toMatchObject({
      kind: 'offset',
      fromTime: null,
      toTime: null,
      reason: null,
    });
    expect(
      timeOffRequestInputSchema.safeParse({
        kind: 'leave',
        leaveTypeKey: 'vacation',
        startDate: '2026-11-02',
        endDate: '2026-11-02',
        portion: 'part',
      }).success,
    ).toBe(false);
  });
});
